import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Repository, TabSpaceDB } from "../packages/persistence/repository";
import {
  maintainHistory,
  storageInfo,
  cleanUnusedFiles,
  trimImportCopies,
} from "../packages/persistence/maintenance";
import {
  exportBackup,
  parseBackup,
  importBackup,
} from "../packages/persistence/backup";
import { entity, blankDoc, type Journal } from "../packages/domain/model";

let repo: Repository;
const now = Date.parse("2026-10-23T12:00:00Z");
const ago = (days: number) => new Date(now - days * 86400000).toISOString();
beforeEach(async () => {
  repo = new Repository(new TabSpaceDB(`maintenance-${crypto.randomUUID()}`));
  await repo.initialize();
});
afterEach(async () => {
  await repo.db.delete();
});

it("migrates version 1 indexes without losing existing records", async () => {
  const name = `old-${crypto.randomUUID()}`;
  const old = new Dexie(name);
  old.version(1).stores({
    entities: "id,kind,spaceId,sectionId,order,updatedAt",
    attachments: "id,hash",
    drafts: "id,noteId",
    revisions: "id,noteId,createdAt",
    journal: "id,state,createdAt",
    snapshots: "id,capturedAt",
    meta: "id",
    browser: "id",
  });
  const note = entity("note", "Keep me");
  await old.table("entities").put(note);
  await old.table("revisions").put({
    id: "old-revision",
    noteId: note.id,
    createdAt: ago(1),
    revision: 1,
    doc: blankDoc(),
    text: "Keep revision",
  });
  old.close();
  const upgraded = new TabSpaceDB(name);
  try {
    expect(await upgraded.entities.get(note.id)).toEqual(note);
    expect(
      await upgraded.revisions
        .where("[noteId+createdAt]")
        .between([note.id, Dexie.minKey], [note.id, Dexie.maxKey])
        .count(),
    ).toBe(1);
  } finally {
    await upgraded.delete();
  }
});

it("prunes only completed journals older than seven days in bounded batches", async () => {
  const states: Journal["state"][] = [
    "committed",
    "applied",
    "failed",
    "uncertain",
    "planned",
    "executing",
  ];
  await repo.db.journal.bulkPut(
    states.map((state) => ({
      id: state,
      state,
      createdAt: ago(8),
      intent: "test",
    })),
  );
  await repo.db.journal.put({
    id: "boundary",
    state: "applied",
    createdAt: ago(7),
    intent: "test",
  });
  await repo.db.journal.bulkPut(
    Array.from({ length: 300 }, (_, i) => ({
      id: `old-${i}`,
      state: "committed" as const,
      createdAt: ago(9),
      intent: "test",
    })),
  );
  await maintainHistory(repo, 90, now);
  expect(await repo.db.journal.where("state").equals("committed").count()).toBe(
    51,
  );
  for (const id of ["failed", "uncertain", "planned", "executing", "boundary"])
    expect(await repo.db.journal.get(id)).toBeDefined();
  await maintainHistory(repo, 90, now);
  expect(await repo.db.journal.where("state").equals("committed").count()).toBe(
    0,
  );
});

it("caps revisions per note, preserves ten newest even when old, and leaves drafts and checkpoints intact", async () => {
  const first = entity("note", "First");
  const second = entity("note", "Second");
  await repo.db.entities.bulkPut([first, second]);
  for (const [note, count, age] of [
    [first, 125, 1],
    [second, 15, 200],
  ] as const) {
    await repo.db.revisions.bulkPut(
      Array.from({ length: count }, (_, i) => ({
        id: crypto.randomUUID(),
        noteId: note.id,
        revision: i,
        doc: blankDoc(),
        text: `${i}`,
        createdAt: new Date(Date.parse(ago(age)) + i * 1000).toISOString(),
      })),
    );
  }
  const draft = {
    id: crypto.randomUUID(),
    noteId: first.id,
    baseRevision: 1,
    doc: blankDoc(),
    text: "Draft",
    updatedAt: ago(200),
  };
  await repo.db.drafts.put(draft);
  const checkpoint = {
    id: crypto.randomUUID(),
    capturedAt: ago(300),
    reason: "protected",
    protected: true,
    tabs: [],
    groups: [],
  };
  await repo.db.snapshots.put(checkpoint);
  await maintainHistory(repo, 90, now);
  expect(await repo.db.revisions.where("noteId").equals(first.id).count()).toBe(
    100,
  );
  expect(
    (await repo.db.revisions.where("noteId").equals(second.id).toArray())
      .map((r) => r.revision)
      .sort((a, b) => a - b),
  ).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  expect(await repo.db.drafts.get(draft.id)).toEqual(draft);
  expect(await repo.db.snapshots.get(checkpoint.id)).toEqual(checkpoint);
  expect(await repo.db.entities.get(first.id)).toEqual(first);
});

const file = async (name: string) =>
  repo.attachment(new File([name], name, { type: "text/plain" }), name);

it("manual cleanup protects Trash, background and retained journal references", async () => {
  const [trash, background, history, unused] = await Promise.all([
    file("trash"),
    file("background"),
    file("history"),
    file("unused"),
  ]);
  await repo.db.entities.put(
    entity("resource", "Trashed", {
      spaceId: await repo.inbox(),
      attachmentIds: [trash.id],
      deletedAt: ago(2),
    }),
  );
  await repo.patchSettings({ backgroundAttachmentId: background.id });
  await repo.db.journal.put({
    id: "history",
    state: "failed",
    intent: "test",
    createdAt: ago(200),
    result: [entity("resource", "History", { attachmentIds: [history.id] })],
  });
  const preview = await storageInfo(repo);
  expect(preview.unusedIds).toEqual([unused.id]);
  const result = await cleanUnusedFiles(repo, preview.unusedIds);
  expect(result.fileCount).toBe(3);
  expect(result.unusedCount).toBe(0);
});

it("rechecks references and never deletes newly unused files outside the confirmed preview", async () => {
  const first = await file("first");
  const preview = await storageInfo(repo);
  await repo.db.entities.put(
    entity("resource", "Now attached", { attachmentIds: [first.id] }),
  );
  const later = await file("later");
  await cleanUnusedFiles(repo, preview.unusedIds);
  expect(await repo.db.attachments.get(first.id)).toBeDefined();
  expect(await repo.db.attachments.get(later.id)).toBeDefined();
});

it("blocks cleanup for invalid or quarantined records", async () => {
  await file("unused");
  await repo.db.meta.put({
    id: "quarantine:unknown",
    value: { attachmentIds: ["unknown"] },
  });
  expect((await storageInfo(repo)).cleanupBlocked).toBe(true);
  await expect(
    cleanUnusedFiles(repo, (await storageInfo(repo)).unusedIds),
  ).rejects.toThrow("invalid records");
  await repo.db.meta.delete("quarantine:unknown");
  await repo.db.entities.put({
    id: crypto.randomUUID(),
    kind: "unknown",
  } as any);
  expect((await storageInfo(repo)).cleanupBlocked).toBe(true);
  expect(await repo.db.attachments.count()).toBe(1);
});

it("blocks file cleanup if retained sync references cannot be validated", async () => {
  const stored = await file("protected-by-invalid-sync-record");
  await repo.db.meta.put({
    id: "sync:recovery:invalid",
    value: { malformed: true },
  });
  expect((await storageInfo(repo)).cleanupBlocked).toBe(true);
  await expect(cleanUnusedFiles(repo, [stored.id])).rejects.toThrow(
    "invalid records",
  );
  expect(await repo.db.attachments.get(stored.id)).toBeDefined();
});

it("keeps three newest import copies and rolls the new safety copy back on import failure", async () => {
  const original = await file("backup file");
  const parsed = await parseBackup(await exportBackup(repo, "json"));
  for (let i = 0; i < 4; i++) await importBackup(repo, parsed, "replace");
  const copies = await repo.db.meta
    .where("id")
    .startsWith("before-import:")
    .toArray();
  expect(copies).toHaveLength(3);
  expect((copies[0].value as any).attachments[0].blob).toBeInstanceOf(Blob);
  expect((copies[0].value as any).attachments[0].id).toBe(original.id);
  const put = repo.db.meta.put.bind(repo.db.meta);
  repo.db.meta.put = (async (row: any) => {
    if (row.id === "indexRevision") throw new Error("Simulated import failure");
    return put(row);
  }) as typeof repo.db.meta.put;
  await expect(importBackup(repo, parsed, "replace")).rejects.toThrow(
    "Simulated import failure",
  );
  expect(
    await repo.db.meta.where("id").startsWith("before-import:").primaryKeys(),
  ).toEqual(copies.map((r) => r.id));
});

it("retains the new safety copy on timestamp ties and rolls back an interrupted trim", async () => {
  for (const id of ["a", "b", "c", "d"])
    await repo.db.meta.put({
      id: `before-import:${id}`,
      value: { createdAt: ago(1) },
    });
  const keys = () =>
    repo.db.meta.where("id").startsWith("before-import:").primaryKeys();
  await expect(
    repo.db.transaction("rw", repo.db.meta, async () => {
      await trimImportCopies(repo, "before-import:a");
      expect(await keys()).toHaveLength(3);
      throw new Error("Interrupted trim");
    }),
  ).rejects.toThrow("Interrupted trim");
  expect(await keys()).toHaveLength(4);
  await repo.db.transaction("rw", repo.db.meta, () =>
    trimImportCopies(repo, "before-import:a"),
  );
  expect(await keys()).toEqual([
    "before-import:a",
    "before-import:c",
    "before-import:d",
  ]);
});
