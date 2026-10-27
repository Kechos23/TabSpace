import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { entity, type Snapshot } from "../packages/domain/model";
import { savedSessionData } from "../packages/domain/saved-session";
import { Repository, TabSpaceDB } from "../packages/persistence/repository";
let repo: Repository;
beforeEach(async () => {
  repo = new Repository(new TabSpaceDB(`duplicate-${crypto.randomUUID()}`));
  await repo.initialize();
});
afterEach(async () => {
  await repo.db.delete();
});
const create = (item: ReturnType<typeof entity>) =>
  repo.execute({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    type: "create",
    entity: item,
  });
it("copies current occurrence order, groups, locks and active index without resurrecting closed ordinary tabs", async () => {
  const space = entity("space", "Original");
  const group = entity("group", "Research", {
    spaceId: space.id,
    color: "red",
    collapsed: true,
  });
  const closed = entity("savedTab", "Closed", {
    spaceId: space.id,
    url: "https://copy.test/closed",
  });
  const a = entity("savedTab", "First duplicate", {
    spaceId: space.id,
    url: "https://copy.test/same",
    groupId: group.id,
    muted: true,
  });
  const b = entity("savedTab", "Locked duplicate", {
    spaceId: space.id,
    url: a.url,
    groupId: group.id,
    locked: true,
  });
  const note = entity("note", "Notes", { spaceId: space.id });
  for (const item of [space, group, closed, a, b, note]) await create(item);
  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    reason: "Current",
    protected: false,
    tabs: [
      {
        url: b.url!,
        title: b.name,
        spaceId: space.id,
        pinned: false,
        muted: false,
        recordId: b.id,
        lockId: b.id,
        groupKey: "native-blueprint",
      },
      {
        url: a.url!,
        title: a.name,
        spaceId: space.id,
        pinned: false,
        muted: true,
        recordId: a.id,
        groupKey: "native-blueprint",
      },
    ],
    groups: [
      {
        key: "native-blueprint",
        title: "Research",
        color: "red",
        collapsed: true,
      },
    ],
  };
  await repo.db.meta.put({
    id: `session:checkpoint:${space.id}`,
    value: { snapshot, activeIndex: 1 },
  });
  const command = {
    schemaVersion: 1 as const,
    commandId: crypto.randomUUID(),
    type: "duplicate" as const,
    id: space.id,
    expectedRevision: space.revision,
  };
  const rows = await repo.execute(command),
    copy = rows.find((e) => e.kind === "space")!;
  const data = (await repo.db.meta.get(`session:checkpoint:${copy.id}`))!
    .value as { snapshot: Snapshot; activeIndex: number };
  const tabs = savedSessionData(copy.id, await repo.list(), data).entries;
  expect(tabs.map((e) => e.tab.title)).toEqual([b.name, a.name]);
  expect(tabs.map((e) => e.tab.url)).toEqual([a.url, a.url]);
  expect(rows.some((e) => e.name === "Closed")).toBe(false);
  expect(rows.some((e) => e.name === "Notes")).toBe(true);
  expect(data.activeIndex).toBe(1);
  expect(data.snapshot.id).not.toBe(snapshot.id);
  expect(tabs.every((e) => e.tab.spaceId === copy.id)).toBe(true);
  const copiedLock = rows.find((e) => e.name === b.name)!;
  expect(tabs[0].tab.lockId).toBe(copiedLock.id);
  expect(copiedLock.groupId).toBe(rows.find((e) => e.kind === "group")!.id);
  expect(tabs[0].tab.groupKey).toBe(data.snapshot.groups[0].key);
  expect(tabs[0].tab.groupKey).not.toBe("native-blueprint");
  expect(tabs[1].tab.muted).toBe(true);
  expect(await repo.execute(command)).toEqual(rows);
  expect(
    (await repo.db.meta.get(`session:checkpoint:${space.id}`))!.value,
  ).toEqual({ snapshot, activeIndex: 1 });
});
it("preserves an authoritative empty Space instead of falling back to old tab records", async () => {
  const space = entity("space", "Empty");
  await create(space);
  await create(
    entity("savedTab", "Old", {
      spaceId: space.id,
      url: "https://copy.test/old",
    }),
  );
  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    reason: "Empty",
    protected: false,
    tabs: [],
    groups: [],
  };
  await repo.db.meta.put({
    id: `session:checkpoint:${space.id}`,
    value: { snapshot, activeIndex: 0 },
  });
  const rows = await repo.execute({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    type: "duplicate",
    id: space.id,
    expectedRevision: 1,
  });
  const copy = rows.find((e) => e.kind === "space")!;
  const data = (await repo.db.meta.get(`session:checkpoint:${copy.id}`))!.value;
  expect(
    savedSessionData(copy.id, await repo.list(), data).entries,
  ).toHaveLength(0);
  expect(rows.filter((e) => e.kind === "savedTab")).toHaveLength(0);
});
