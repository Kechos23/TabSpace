import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  entity,
  blankDoc,
  validDate,
  safeUrl,
  documentText,
} from "../packages/domain/model";
import { Repository, TabSpaceDB } from "../packages/persistence/repository";
import {
  exportBackup,
  importBackup,
  parseBackup,
} from "../packages/persistence/backup";
import { SearchIndex } from "../packages/search/index";
let repo: Repository;
beforeEach(async () => {
  repo = new Repository(new TabSpaceDB(`test-${crypto.randomUUID()}`));
  await repo.initialize();
});
afterEach(async () => {
  await repo.db.delete();
});
const create = async (e: ReturnType<typeof entity>) =>
  repo.execute({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    type: "create",
    entity: e,
  });
describe("durable commands and ownership", () => {
  it("persists presentation preferences without scanning the collection, with revision checks and idempotence", async () => {
    const space = entity("space", "Fast view");
    await create(space);
    const command = {
      schemaVersion: 1 as const,
      commandId: crypto.randomUUID(),
      type: "presentation" as const,
      id: space.id,
      expectedRevision: 1,
      patch: { view: "resources" as const, split: true },
    };
    const list = repo.list;
    repo.list = async () => {
      throw new Error("Unexpected collection scan");
    };
    try {
      const [saved] = await repo.execute(command);
      expect(saved.view).toBe("resources");
      expect(saved.revision).toBe(2);
      expect(await repo.execute(command)).toEqual([saved]);
      await expect(
        repo.execute({ ...command, commandId: crypto.randomUUID() }),
      ).rejects.toThrow();
      expect((await repo.db.entities.get(space.id))?.view).toBe("resources");
    } finally {
      repo.list = list;
    }
  });
  it("rejects structural, invalid and quarantined presentation writes atomically", async () => {
    const space = entity("space", "Protected view");
    await create(space);
    const command = {
      schemaVersion: 1 as const,
      commandId: crypto.randomUUID(),
      type: "presentation" as const,
      id: space.id,
      expectedRevision: 1,
      patch: { name: "Unsafe rename" },
    };
    await expect(repo.execute(command)).rejects.toThrow("Only presentation");
    await expect(
      repo.execute({ ...command, patch: { splitRatio: 99 } }),
    ).rejects.toThrow();
    await repo.db.meta.put({ id: "quarantine:bad", value: { invalid: true } });
    await expect(
      repo.execute({ ...command, patch: { view: "tasks" } }),
    ).rejects.toThrow("paused");
    expect((await repo.db.entities.get(space.id))?.revision).toBe(1);
    expect(await repo.db.journal.get(command.commandId)).toBeUndefined();
  });
  it("refreshes search filters and result entities after metadata-only edits", () => {
    const index = new SearchIndex();
    const task = entity("task", "Alpha task", { spaceId: crypto.randomUUID() });
    index.update([task], []);
    expect(index.search("Alpha", { taskState: "open" })).toHaveLength(1);
    const changed = {
      ...task,
      completedAt: new Date().toISOString(),
      spaceId: crypto.randomUUID(),
      starred: true,
      dueDate: "2026-10-22",
      revision: 2,
    };
    index.update([changed], []);
    expect(index.search("Alpha", { taskState: "open" })).toHaveLength(0);
    expect(index.search("Alpha", { spaceId: task.spaceId })).toHaveLength(0);
    expect(
      index.search("Alpha", {
        taskState: "completed",
        spaceId: changed.spaceId,
        dueFrom: "2026-10-21",
      })[0].entity,
    ).toBe(changed);
    index.update([{ ...changed, name: "Beta task" }], []);
    expect(index.search("Alpha")).toHaveLength(0);
    expect(index.search("Beta")).toHaveLength(1);
  });
  it("empties all Trash atomically, preserving active/archive content and recovery data", async () => {
    const space = entity("space", "Discarded project");
    const note = entity("note", "Discarded note", {
      spaceId: space.id,
      doc: blankDoc(),
    });
    const archived = entity("space", "Archived project", {
      archivedAt: new Date().toISOString(),
    });
    await create(space);
    await create(note);
    await create(archived);
    await repo.saveDraft({
      id: crypto.randomUUID(),
      noteId: note.id,
      baseRevision: 1,
      doc: blankDoc(),
      text: "draft",
      updatedAt: new Date().toISOString(),
    });
    await repo.db.revisions.add({
      id: crypto.randomUUID(),
      noteId: note.id,
      revision: 1,
      doc: blankDoc(),
      text: "previous",
      createdAt: new Date().toISOString(),
    });
    const attachment = await repo.attachment(new Blob(["kept"]), "kept.txt");
    await repo.snapshot({
      id: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      reason: "Protected recovery",
      protected: true,
      tabs: [],
      groups: [],
    });
    await repo.execute({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "trash",
      id: space.id,
      expectedRevision: 1,
    });
    const retained = (await repo.list()).filter((e) => !e.deletedAt);
    const command = {
      schemaVersion: 1 as const,
      commandId: crypto.randomUUID(),
      type: "emptyTrash" as const,
    };
    await repo.execute(command);
    await repo.execute(command);
    expect(await repo.list()).toEqual(retained);
    expect(await repo.db.drafts.where("noteId").equals(note.id).count()).toBe(
      0,
    );
    expect(
      await repo.db.revisions.where("noteId").equals(note.id).count(),
    ).toBe(0);
    expect(await repo.db.attachments.get(attachment.id)).toBeDefined();
    expect(await repo.db.snapshots.count()).toBe(1);
    await repo.execute({ ...command, commandId: crypto.randomUUID() });
    expect(await repo.list()).toEqual(retained);
  });
  it("rolls back empty Trash if removal would leave live content without its parent", async () => {
    const space = entity("space", "Parent");
    const task = entity("task", "Keep live", { spaceId: space.id });
    await create(space);
    await create(task);
    await repo.db.entities.put({
      ...space,
      deletedAt: new Date().toISOString(),
    });
    const before = await repo.list();
    const commandId = crypto.randomUUID();
    await expect(
      repo.execute({ schemaVersion: 1, commandId, type: "emptyTrash" }),
    ).rejects.toThrow("Missing content parent");
    expect(await repo.list()).toEqual(before);
    expect(await repo.db.journal.get(commandId)).toBeUndefined();
  });

  it("keeps rich task descriptions, drafts and document revisions in portable backups", async () => {
    const task = entity("task", "Rich task", {
      spaceId: await repo.inbox(),
      doc: blankDoc(),
    });
    await create(task);
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Structured task evidence",
              marks: [{ type: "bold" }],
            },
          ],
        },
      ],
    } as const;
    await repo.saveDraft({
      id: `${task.id}:fixture`,
      noteId: task.id,
      baseRevision: 1,
      doc: JSON.parse(JSON.stringify(doc)),
      text: "Structured task evidence",
      updatedAt: new Date().toISOString(),
    });
    await repo.execute({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "update",
      id: task.id,
      expectedRevision: 1,
      patch: {
        doc: JSON.parse(JSON.stringify(doc)),
        description: "Structured task evidence",
      },
    });
    const backup = await parseBackup(await exportBackup(repo, "zip"));
    expect(backup.data.entities.find((e) => e.id === task.id)?.doc).toEqual(
      doc,
    );
    expect(backup.data.drafts.some((d) => d.noteId === task.id)).toBe(true);
    expect(backup.data.revisions.some((d) => d.noteId === task.id)).toBe(true);
  });
  it("copies a content section and its children into another Space with fresh intact parents", async () => {
    const from = await repo.inbox(),
      to = entity("space", "Destination");
    await create(to);
    const section = entity("section", "Evidence", {
      spaceId: from,
      sectionKind: "resources",
    });
    await create(section);
    const link = entity("resource", "Source", {
      spaceId: from,
      sectionId: section.id,
      url: "https://example.org",
    });
    await create(link);
    const result = await repo.execute({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "duplicate",
      id: section.id,
      expectedRevision: section.revision,
      targetSpaceId: to.id,
    });
    expect(result).toHaveLength(2);
    expect(result[0].spaceId).toBe(to.id);
    expect(result[1].sectionId).toBe(result[0].id);
    expect(result[1].spaceId).toBe(to.id);
    expect((await repo.db.entities.get(link.id))?.sectionId).toBe(section.id);
  });
  it("quarantines malformed records without overwriting them and preserves them before replacement", async () => {
    const damaged = { id: crypto.randomUUID(), kind: "note", name: "damaged" };
    await repo.db.entities.put(damaged as never);
    expect((await repo.list()).some((e) => e.id === damaged.id)).toBe(false);
    expect(
      (await repo.db.meta.get(`quarantine:${damaged.id}`))?.value,
    ).toMatchObject({ record: damaged });
    await expect(create(entity("space", "Blocked mutation"))).rejects.toThrow(
      "Editing is paused",
    );
    expect(await repo.db.entities.get(damaged.id)).toEqual(damaged);
    const good = new Repository(new TabSpaceDB(`good-${crypto.randomUUID()}`));
    try {
      await good.initialize();
      await importBackup(
        repo,
        await parseBackup(await exportBackup(good, "zip")),
        "replace",
      );
      const preserved = (await repo.db.meta.toArray()).find((m) =>
        m.id.startsWith("before-import:"),
      )?.value as { rawEntities: unknown[] };
      expect(preserved.rawEntities).toContainEqual(damaged);
      expect(
        await repo.db.meta.where("id").startsWith("quarantine:").count(),
      ).toBe(0);
    } finally {
      await good.db.delete();
    }
  });

  it("patches one field without resetting defaults and clears fields over JSON messages", async () => {
    const e = entity("space", "Keep", {
      description: "Preserved description",
      view: "notes",
      favorite: true,
      archivedAt: new Date().toISOString(),
    });
    await create(e);
    const result = await repo.execute(
      JSON.parse(
        JSON.stringify({
          schemaVersion: 1,
          commandId: crypto.randomUUID(),
          type: "update",
          id: e.id,
          expectedRevision: 1,
          patch: { split: true, archivedAt: null },
        }),
      ),
    );
    expect(result[0].description).toBe("Preserved description");
    expect(result[0].view).toBe("notes");
    expect(result[0].favorite).toBe(true);
    expect(result[0].archivedAt).toBeUndefined();
  });
  it("retries committed commands without creating duplicate entities after reopening", async () => {
    const e = entity("space", "Δοκιμή");
    const command = {
      schemaVersion: 1 as const,
      commandId: crypto.randomUUID(),
      type: "create" as const,
      entity: e,
    };
    await repo.execute(command);
    repo.db.close();
    await repo.db.open();
    await repo.execute(command);
    expect((await repo.list()).filter((x) => x.id === e.id)).toHaveLength(1);
  });
  it("rejects stale revisions without overwriting a note or its persisted draft", async () => {
    const e = entity("note", "Notes", {
      spaceId: await repo.inbox(),
      doc: blankDoc(),
    });
    await create(e);
    await repo.saveDraft({
      id: "draft",
      noteId: e.id,
      baseRevision: 1,
      doc: blankDoc(),
      text: "local",
      updatedAt: new Date().toISOString(),
    });
    await repo.execute({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "update",
      id: e.id,
      expectedRevision: 1,
      patch: { name: "Changed" },
    });
    await expect(
      repo.execute({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "update",
        id: e.id,
        expectedRevision: 1,
        patch: { name: "Stale" },
      }),
    ).rejects.toThrow("another TabSpace view");
    expect((await repo.db.entities.get(e.id))?.name).toBe("Changed");
    expect(await repo.db.drafts.get("draft")).toBeDefined();
  });
  it("rolls back invalid graph commands atomically", async () => {
    const e = entity("task", "Orphan", { spaceId: crypto.randomUUID() });
    const commandId = crypto.randomUUID();
    await expect(
      repo.execute({ schemaVersion: 1, commandId, type: "create", entity: e }),
    ).rejects.toThrow("parent");
    expect(await repo.db.entities.get(e.id)).toBeUndefined();
    expect(await repo.db.journal.get(commandId)).toBeUndefined();
  });
  it("moves a section and all child ownership together", async () => {
    const space = entity("space", "Target");
    await create(space);
    const section = entity("section", "Read", {
      spaceId: await repo.inbox(),
      sectionKind: "resources",
    });
    await create(section);
    const resource = entity("resource", "Read me", {
      spaceId: section.spaceId,
      sectionId: section.id,
      url: "https://example.org/?doc=1#part",
    });
    await create(resource);
    await repo.execute({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "move",
      id: section.id,
      expectedRevision: 1,
      targetSpaceId: space.id,
    });
    expect((await repo.db.entities.get(resource.id))?.spaceId).toBe(space.id);
  });
  it("restores only children trashed in the same cascade", async () => {
    const space = entity("space", "Project");
    await create(space);
    const a = entity("task", "A", { spaceId: space.id }),
      b = entity("task", "B", { spaceId: space.id });
    await create(a);
    await create(b);
    await repo.execute({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "trash",
      id: a.id,
      expectedRevision: 1,
    });
    await new Promise((r) => setTimeout(r, 5));
    await repo.execute({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "trash",
      id: space.id,
      expectedRevision: 1,
    });
    await repo.execute({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "restore",
      id: space.id,
      expectedRevision: 2,
    });
    expect((await repo.db.entities.get(a.id))?.deletedAt).toBeDefined();
    expect((await repo.db.entities.get(b.id))?.deletedAt).toBeUndefined();
  });
});
describe("backup integrity", () => {
  it.each(["json", "zip"] as const)(
    "round trips %s including blobs, notes and references",
    async (format) => {
      const a = await repo.attachment(
        new Blob(["Hello attachment"], { type: "text/plain" }),
        "notes.txt",
      );
      const note = entity("note", "Saved", {
        spaceId: await repo.inbox(),
        doc: blankDoc(),
        attachmentIds: [a.id],
      });
      await create(note);
      const exported = await exportBackup(repo, format),
        parsed = await parseBackup(exported);
      const fresh = new Repository(
        new TabSpaceDB(`fresh-${crypto.randomUUID()}`),
      );
      try {
        await fresh.initialize();
        await importBackup(fresh, parsed, "replace");
        expect((await fresh.db.entities.get(note.id))?.attachmentIds).toEqual([
          a.id,
        ]);
        expect(await (await fresh.db.attachments.get(a.id))!.blob.text()).toBe(
          "Hello attachment",
        );
        expect(await fresh.inbox()).toBe(await repo.inbox());
        expect(
          (await fresh.db.meta.toArray()).some((m) =>
            m.id.startsWith("before-import:"),
          ),
        ).toBe(true);
      } finally {
        await fresh.db.delete();
      }
    },
  );
  it("merges with fresh IDs and intact attachment ownership", async () => {
    const a = await repo.attachment(new Blob(["a"]), "a.txt");
    await create(
      entity("resource", "File", {
        spaceId: await repo.inbox(),
        attachmentIds: [a.id],
      }),
    );
    const original = await repo.list();
    await importBackup(
      repo,
      await parseBackup(await exportBackup(repo, "zip")),
      "merge",
    );
    expect((await repo.list()).length).toBe(original.length * 2);
    expect((await repo.db.attachments.toArray()).length).toBe(2);
  });
  it("rejects malicious URL imports and bad checksums before changes", async () => {
    const e = entity("resource", "Link", {
      spaceId: await repo.inbox(),
      url: "https://example.org",
    });
    await create(e);
    const parsed = JSON.parse(await (await exportBackup(repo, "json")).text());
    parsed.entities.find((x: { id: string }) => x.id === e.id).url =
      "javascript:alert(1)";
    const count = await repo.db.entities.count();
    await expect(
      parseBackup(new Blob([JSON.stringify(parsed)])),
    ).rejects.toThrow();
    expect(await repo.db.entities.count()).toBe(count);
  });
});
describe("calendar and local search", () => {
  it("validates calendar dates without timezone conversion", () => {
    expect(validDate("2024-02-29")).toBe(true);
    expect(validDate("2026-02-29")).toBe(false);
    expect(validDate("2026-03-29")).toBe(true);
    expect(validDate("2026-13-01")).toBe(false);
    expect(() => safeUrl("data:text/html,test")).toThrow();
    expect(safeUrl("https://example.org/a?q=one#two")).toBe(
      "https://example.org/a?q=one#two",
    );
  });
  it("indexes Greek accents and final sigma and updates deletions", () => {
    const e = entity("note", "Εργασίες", {
      text: "Σημειώσεις για το έργο",
      spaceId: crypto.randomUUID(),
    });
    const index = new SearchIndex();
    index.update([e], []);
    expect(index.search("εργασιες")).toHaveLength(1);
    expect(index.search("σημειωσεις")).toHaveLength(1);
    index.update([{ ...e, deletedAt: new Date().toISOString() }], []);
    expect(index.search("εργασιες")).toHaveLength(0);
  });
});
