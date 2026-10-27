import "fake-indexeddb/auto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  entity,
  settingsSchema,
  defaults,
  type BrowserState,
  type Snapshot,
} from "../packages/domain/model";
import { spaceTabTree } from "../packages/domain/space-tabs";
import { repository as repo } from "../packages/persistence/repository";
import {
  ensureTemporarySession,
  labelTemporarySpaces,
} from "../apps/extension/src/background/sessions";
beforeEach(async () => {
  await repo.db.delete();
  await repo.db.open();
  await repo.initialize();
  vi.stubGlobal("chrome", {
    storage: {
      session: { get: async () => ({ browserGeneration: "test-gen" }) },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
const browser: BrowserState = {
  id: "browser",
  generation: "test-gen",
  tabs: [],
  groups: [],
  updatedAt: new Date().toISOString(),
};
it("uses current live tabs instead of stale saved tabs and excludes pinned pages", () => {
  const space = entity("space", "Project"),
    saved = entity("savedTab", "Stale", {
      spaceId: space.id,
      url: "https://example.org/stale",
    });
  const tab = {
    id: 1,
    spaceId: space.id,
    url: "https://example.org/current",
    title: "Current",
    windowId: 1,
    index: 0,
    groupId: -1,
    pinned: false,
    active: true,
    audible: false,
    discarded: false,
    autoDiscardable: true,
    muted: false,
  };
  const tree = spaceTabTree(
    [space, saved],
    { ...browser, tabs: [tab, { ...tab, id: 2, pinned: true }] },
    [],
  );
  expect(tree[space.id]).toEqual([
    { id: 1, url: tab.url, title: "Current", live: true, group: undefined },
  ]);
});
it("respects a latest empty checkpoint instead of resurrecting stale saved tabs", () => {
  const space = entity("space", "Project"),
    saved = entity("savedTab", "Stale", {
      spaceId: space.id,
      url: "https://example.org/stale",
    });
  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    reason: "latest",
    protected: false,
    tabs: [],
    groups: [],
  };
  expect(
    spaceTabTree([space, saved], browser, [
      {
        id: `session:checkpoint:${space.id}`,
        value: { snapshot, activeIndex: 0 },
      },
    ])[space.id],
  ).toEqual([]);
});
it("creates one temporary session for repeated/reordered reports of the same tab batch", async () => {
  const first = await ensureTemporarySession(1, [1, 2]);
  expect(await ensureTemporarySession(1, [2, 1])).toBe(first);
  const second = await ensureTemporarySession(1, [3]);
  expect(second).not.toBe(first);
  const names = (await repo.list())
    .filter((e) => e.kind === "space" && e.temporary)
    .map((e) => e.name);
  expect(new Set(names).size).toBe(2);
});
it("disambiguates legacy temporary names while retaining both Spaces and their content", async () => {
  const a = entity("space", "Temporary browsing", { temporary: true }),
    b = entity("space", "Temporary browsing", { temporary: true });
  const resource = entity("resource", "Keep me", {
    spaceId: a.id,
    url: "https://example.org/",
  });
  await repo.db.entities.bulkPut([a, b, resource]);
  await labelTemporarySpaces();
  expect((await repo.db.entities.get(a.id))!.name).not.toBe(
    (await repo.db.entities.get(b.id))!.name,
  );
  expect(await repo.db.entities.get(resource.id)).toEqual(resource);
});
it("defaults old settings to live preservation and persists explicit close-on-switch preference", () => {
  const { preserveLiveTabs, ...legacy } = defaults;
  expect(settingsSchema.parse(legacy).preserveLiveTabs).toBe(true);
  expect(
    settingsSchema.parse({ ...legacy, preserveLiveTabs: false })
      .preserveLiveTabs,
  ).toBe(false);
});
it("keeps Recovery available when invalid records pause automatic temporary-label repair", async () => {
  const a = entity("space", "Temporary browsing", { temporary: true }),
    b = entity("space", "Temporary browsing", { temporary: true });
  await repo.db.entities.bulkPut([a, b]);
  await repo.db.meta.put({
    id: "quarantine:fixture",
    value: { reason: "Preserved invalid record" },
  });
  await expect(labelTemporarySpaces()).resolves.toBeUndefined();
  expect((await repo.db.entities.get(a.id))!.name).toBe(a.name);
});

it("keeps a closed locked tab in its live logical group despite old checkpoint keys", () => {
  const space = entity("space", "Project");
  const group = entity("group", "Research", {
    spaceId: space.id,
    color: "blue",
  });
  const locked = entity("savedTab", "Closed", {
    spaceId: space.id,
    groupId: group.id,
    locked: true,
    url: "https://example.org/closed",
  });
  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    reason: "test",
    protected: false,
    tabs: [
      {
        title: locked.name,
        url: locked.url!,
        pinned: false,
        muted: false,
        lockId: locked.id,
        groupKey: "old-native-key",
      },
    ],
    groups: [
      {
        key: "old-native-key",
        title: "Old name",
        color: "red",
        collapsed: false,
      },
    ],
  };
  const tree = spaceTabTree(
    [space, group, locked],
    {
      ...browser,
      tabs: [
        {
          id: 1,
          spaceId: space.id,
          url: "https://example.org/open",
          title: "Open",
          windowId: 1,
          index: 0,
          groupId: 5,
          pinned: false,
          active: true,
          audible: false,
          discarded: false,
          autoDiscardable: true,
          muted: false,
        },
      ],
      groups: [
        {
          id: 5,
          windowId: 1,
          title: "Research",
          color: "blue",
          collapsed: false,
          spaceId: space.id,
          logicalId: group.id,
        },
      ],
    },
    [{ id: `session:checkpoint:${space.id}`, value: { snapshot } }],
  )[space.id];
  expect(tree).toHaveLength(2);
  expect(tree.map((t) => [t.groupKey, t.group, t.groupColor])).toEqual([
    [group.id, "Research", "blue"],
    [group.id, "Research", "blue"],
  ]);
  expect(
    spaceTabTree([space, group, locked], browser, [
      { id: `session:checkpoint:${space.id}`, value: { snapshot } },
    ])[space.id][0],
  ).toMatchObject({
    groupKey: "old-native-key",
    group: "Old name",
    groupColor: "red",
  });
});
