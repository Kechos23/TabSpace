import "fake-indexeddb/auto";
import { beforeEach, expect, it } from "vitest";
import { entity, type Snapshot } from "../packages/domain/model";
import { repository as repo } from "../packages/persistence/repository";
import {
  exportBackup,
  importBackup,
  parseBackup,
} from "../packages/persistence/backup";
import { sessionTab } from "../apps/extension/src/background/sessions";

beforeEach(async () => {
  await repo.db.delete();
  await repo.db.open();
  await repo.initialize();
});
const checkpoint = (spaceId: string, empty = false): Snapshot => ({
  id: crypto.randomUUID(),
  capturedAt: new Date().toISOString(),
  reason: `Space session: ${spaceId}`,
  protected: false,
  tabs: empty
    ? []
    : [
        {
          url: "https://example.org/live",
          title: "Live",
          pinned: false,
          muted: false,
          spaceId,
        },
      ],
  groups: [],
});
it("excludes pinned and privileged pages from session movements", () => {
  for (const url of [
    "chrome://extensions/",
    "chrome-extension://other/controller.html",
    "file:///private.txt",
    "about:blank",
  ])
    expect(sessionTab({ pinned: false, url })).toBe(false);
  expect(sessionTab({ pinned: true, url: "https://example.org/" })).toBe(false);
  expect(sessionTab({ pinned: false, url: "chrome://newtab/" })).toBe(true);
  expect(sessionTab({ pinned: false, url: "https://example.org/" })).toBe(true);
});
it("exports empty latest sessions and never exports live window bindings", async () => {
  const spaceId = await repo.inbox();
  await repo.db.meta.bulkPut([
    {
      id: `session:checkpoint:${spaceId}`,
      value: { snapshot: checkpoint(spaceId, true), activeIndex: 0 },
    },
    {
      id: "session:registry",
      value: {
        generation: "private-generation",
        bindings: [{ windowId: 123, spaceId, parked: true }],
      },
    },
  ]);
  const parsed = await parseBackup(await exportBackup(repo, "zip"));
  expect(parsed.data.sessions).toHaveLength(1);
  expect(parsed.data.sessions[0].snapshot.tabs).toEqual([]);
  expect(JSON.stringify(parsed.data)).not.toContain("private-generation");
});
it("remaps session owners on merge and keeps the original independent", async () => {
  const space = entity("space", "Session source");
  await repo.execute({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    type: "create",
    entity: space,
  });
  await repo.db.meta.put({
    id: `session:checkpoint:${space.id}`,
    value: { snapshot: checkpoint(space.id), activeIndex: 0 },
  });
  const parsed = await parseBackup(await exportBackup(repo, "json"));
  await importBackup(repo, parsed, "merge");
  const imported = (await repo.list()).find(
    (e) => e.name === space.name && e.id !== space.id,
  )!;
  const copy = (await repo.db.meta.get(`session:checkpoint:${imported.id}`))!
    .value as { snapshot: Snapshot };
  expect(copy.snapshot.tabs[0].spaceId).toBe(imported.id);
  expect(copy.snapshot.id).not.toBe(parsed.data.sessions[0].snapshot.id);
  expect(
    await repo.db.meta.get(`session:checkpoint:${space.id}`),
  ).toBeDefined();
});
it("keeps lock identity separate when a session backup is merged", async () => {
  const space = entity("space", "Locked backup");
  const tab = entity("savedTab", "Kept", {
    spaceId: space.id,
    url: "https://locks.test/",
    locked: true,
  });
  for (const item of [space, tab])
    await repo.execute({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "create",
      entity: item,
    });
  const snapshot = checkpoint(space.id);
  snapshot.tabs[0] = {
    ...snapshot.tabs[0],
    url: tab.url!,
    lockId: tab.id,
    recordId: tab.id,
  };
  await repo.db.meta.put({
    id: `session:checkpoint:${space.id}`,
    value: { snapshot, activeIndex: 0 },
  });
  await importBackup(
    repo,
    await parseBackup(await exportBackup(repo, "zip")),
    "merge",
  );
  const copied = (await repo.list()).find(
    (item) =>
      item.kind === "space" && item.name === space.name && item.id !== space.id,
  )!;
  const record = (await repo.list()).find(
    (item) => item.spaceId === copied.id && item.locked,
  )!;
  const saved = (await repo.db.meta.get(`session:checkpoint:${copied.id}`))!
    .value as { snapshot: Snapshot };
  expect(record.id).not.toBe(tab.id);
  expect(saved.snapshot.tabs[0].lockId).toBe(record.id);
  expect(saved.snapshot.tabs[0].recordId).toBe(record.id);
});
it("replace clears stale live/session bindings and restores the exported empty session", async () => {
  const id = await repo.inbox();
  await repo.db.meta.put({
    id: `session:checkpoint:${id}`,
    value: { snapshot: checkpoint(id, true), activeIndex: 0 },
  });
  const parsed = await parseBackup(await exportBackup(repo, "zip"));
  await repo.db.meta.put({
    id: "session:registry",
    value: { generation: "old", bindings: [] },
  });
  await repo.db.meta.put({ id: "session:operation", value: { spaceId: id } });
  await repo.db.meta.bulkPut([
    { id: "browsing:last-session", value: { windows: [{ spaceId: id }] } },
    { id: "browsing:lifecycle", value: { open: true } },
    { id: "browsing:unresolved", value: [id] },
  ]);
  await importBackup(repo, parsed, "replace");
  expect(await repo.db.meta.where("id").startsWith("browsing:").count()).toBe(
    0,
  );
  expect(await repo.db.meta.get("session:registry")).toBeUndefined();
  expect(await repo.db.meta.get("session:operation")).toBeUndefined();
  expect(
    (
      (await repo.db.meta.get(`session:checkpoint:${id}`))!.value as {
        snapshot: Snapshot;
      }
    ).snapshot.tabs,
  ).toEqual([]);
});
it("accepts older backups without session metadata", async () => {
  const data = JSON.parse(await (await exportBackup(repo, "json")).text());
  delete data.sessions;
  data.appVersion = "0.1.1";
  const parsed = await parseBackup(new Blob([JSON.stringify(data)]));
  expect(parsed.data.sessions).toEqual([]);
});
it("rejects sessions assigned to a missing Space before import", async () => {
  const data = JSON.parse(await (await exportBackup(repo, "json")).text());
  const missing = crypto.randomUUID();
  data.sessions = [
    { spaceId: missing, snapshot: checkpoint(missing), activeIndex: 0 },
  ];
  await expect(parseBackup(new Blob([JSON.stringify(data)]))).rejects.toThrow(
    "ownership",
  );
});
