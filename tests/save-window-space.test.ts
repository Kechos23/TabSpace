import "fake-indexeddb/auto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { entity } from "../packages/domain/model";
import { repository as repo } from "../packages/persistence/repository";
import { saveWindowAsSpace } from "../apps/extension/src/background/sessions";

const generation = "window-save-test";
let source: ReturnType<typeof entity>, other: ReturnType<typeof entity>;
let records: ReturnType<typeof entity>[];
let tabs: object[];
let navigation: ReturnType<typeof vi.fn>,
  notifications: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  await repo.db.delete();
  await repo.db.open();
  await repo.initialize();
  source = entity("space", "Unsaved 1", { temporary: true });
  other = entity("space", "Other window", { temporary: true });
  const group = entity("group", "Research", {
    spaceId: source.id,
    color: "purple",
  });
  records = [0, 1].map((order) =>
    entity("savedTab", "Same URL", {
      spaceId: source.id,
      url: "https://example.test/same",
      groupId: group.id,
      order,
    }),
  );
  await repo.db.entities.bulkAdd([
    source,
    other,
    group,
    ...records,
    entity("note", "Keep my note", { spaceId: source.id }),
  ]);
  await repo.db.meta.bulkPut([
    {
      id: "session:registry",
      value: {
        generation,
        bindings: [
          { windowId: 1, spaceId: source.id, parked: false },
          { windowId: 2, spaceId: other.id, parked: false },
        ],
      },
    },
    {
      id: `owner:${generation}:group:7`,
      value: { spaceId: source.id, logicalId: group.id },
    },
    ...records.flatMap((record, index) => [
      { id: `tab:${generation}:${11 + index}`, value: record.id },
      {
        id: `owner:${generation}:tab:${11 + index}`,
        value: { spaceId: source.id },
      },
    ]),
  ]);
  tabs = [
    {
      id: 13,
      windowId: 1,
      index: 0,
      pinned: true,
      groupId: -1,
      url: "https://example.test/same",
      title: "Global pin",
    },
    ...records.map((record, i) => ({
      id: 11 + i,
      windowId: 1,
      index: i + 1,
      groupId: 7,
      url: record.url,
      title: "Live title " + i,
      pinned: false,
      active: i === 0,
      mutedInfo: { muted: i === 1 },
    })),
    {
      id: 21,
      windowId: 2,
      index: 0,
      groupId: -1,
      url: "https://example.test/other",
      title: "Other window",
    },
  ];
  navigation = vi.fn(() => {
    throw Error("Saving must not navigate or recreate tabs");
  });
  notifications = vi.fn(async () => undefined);
  vi.stubGlobal("chrome", {
    storage: {
      session: { get: async () => ({ browserGeneration: generation }) },
    },
    runtime: {
      getURL: (p: string) => "chrome-extension://test/" + p,
      sendMessage: notifications,
    },
    windows: {
      get: async (id: number) => ({ id, type: "normal" }),
      getAll: async () => [{ id: 1 }, { id: 2 }],
      create: navigation,
      update: navigation,
    },
    tabs: {
      query: async () => structuredClone(tabs),
      create: navigation,
      update: navigation,
      remove: navigation,
      move: navigation,
      reload: navigation,
      group: navigation,
    },
    tabGroups: {
      query: async () => [
        {
          id: 7,
          windowId: 1,
          title: "Research",
          color: "purple",
          collapsed: false,
        },
      ],
      update: navigation,
      move: navigation,
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it.each([false, true])(
  "promotes the current Unsaved in place with locked=%s and distinct duplicate occurrences",
  async (locked) => {
    const requested = crypto.randomUUID();
    const id = await saveWindowAsSpace(
      1,
      requested,
      "Saved now",
      locked,
      "orange",
    );
    expect(id).toBe(source.id);
    expect(await repo.db.entities.get(requested)).toBeUndefined();
    expect(await repo.db.entities.get(source.id)).toMatchObject({
      temporary: false,
      name: "Saved now",
      color: "orange",
    });
    expect(
      (await repo.list()).find((e) => e.name === "Keep my note")?.spaceId,
    ).toBe(source.id);
    const mapped = await repo.db.meta.bulkGet(
      records.map((_, i) => `tab:${generation}:${11 + i}`),
    );
    expect(mapped.map((m) => m?.value)).toEqual(records.map((r) => r.id));
    for (const [i, record] of records.entries())
      expect(await repo.db.entities.get(record.id)).toMatchObject({
        locked,
        name: "Live title " + i,
      });
    expect(
      await repo.db.meta.get(`owner:${generation}:tab:13`),
    ).toBeUndefined();
    const bindings = (await repo.db.meta.get("session:registry"))!.value as {
      bindings: object[];
    };
    expect(bindings.bindings).toContainEqual({
      windowId: 1,
      spaceId: source.id,
      parked: false,
    });
    expect(bindings.bindings).toContainEqual({
      windowId: 2,
      spaceId: other.id,
      parked: false,
    });
    expect(await repo.db.entities.get(other.id)).toEqual(other);
    expect(notifications).toHaveBeenCalledWith({
      type: "tabspace:iconChanged",
    });
    expect(navigation).not.toHaveBeenCalled();
  },
);
it("creates and immediately binds a Space for an unbound window", async () => {
  await repo.db.meta.delete("session:registry");
  const requested = crypto.randomUUID();
  expect(await saveWindowAsSpace(1, requested, "New Space", false, "red")).toBe(
    requested,
  );
  expect((await repo.db.meta.get("session:registry"))!.value).toMatchObject({
    bindings: [{ windowId: 1, spaceId: requested, parked: false }],
  });
  expect(navigation).not.toHaveBeenCalled();
});
it("invalid collections leave the Unsaved, records and binding untouched", async () => {
  const before = await repo.db.meta.get("session:registry");
  await expect(
    saveWindowAsSpace(
      1,
      crypto.randomUUID(),
      "Rejected",
      true,
      "red",
      crypto.randomUUID(),
    ),
  ).rejects.toThrow("collection");
  expect(await repo.db.entities.get(source.id)).toEqual(source);
  expect(await repo.db.meta.get("session:registry")).toEqual(before);
  expect(await repo.db.entities.bulkGet(records.map((r) => r.id))).toEqual(
    records,
  );
  expect(notifications).not.toHaveBeenCalled();
});
it("rejects stale saves on an already Saved window rather than replacing its session", async () => {
  await repo.db.entities.put({ ...source, temporary: false });
  await expect(
    saveWindowAsSpace(1, crypto.randomUUID(), "Duplicate", false),
  ).rejects.toThrow("already belongs");
  expect(navigation).not.toHaveBeenCalled();
  expect(notifications).not.toHaveBeenCalled();
});
