import { expect, it } from "vitest";
import { entity, type Snapshot } from "../packages/domain/model";
import { savedSessionData } from "../packages/domain/saved-session";
import { spaceTabTree } from "../packages/domain/space-tabs";

it("identifies duplicate occurrences by snapshot and original index, including pinned gaps", () => {
  const space = entity("space", "A");
  const tab = {
    url: "https://example.test/same",
    title: "Same",
    pinned: false,
    muted: false,
  };
  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    reason: "test",
    protected: false,
    tabs: [{ ...tab, pinned: true }, tab, tab],
    groups: [],
  };
  const data = savedSessionData(space.id, [], { snapshot });
  expect(data.entries.map((e) => e.key)).toEqual([
    `${snapshot.id}:1`,
    `${snapshot.id}:2`,
  ]);
  const updated = savedSessionData(space.id, [], {
    snapshot: { ...snapshot, id: crypto.randomUUID() },
  });
  expect(updated.entries[0].key).not.toBe(data.entries[0].key);
});
it("uses record ID and revision for legacy saved tabs and respects authoritative empty checkpoints", () => {
  const space = entity("space", "A"),
    a = entity("savedTab", "One", {
      spaceId: space.id,
      url: "https://example.test/same",
      order: 1,
    }),
    b = entity("savedTab", "Two", {
      spaceId: space.id,
      url: "https://example.test/same",
      order: 2,
    });
  const data = savedSessionData(space.id, [b, a], undefined);
  expect(data.entries.map((e) => e.key)).toEqual([
    `entity:${a.id}:${a.revision}`,
    `entity:${b.id}:${b.revision}`,
  ]);
  const empty = savedSessionData(space.id, [a, b], {
    snapshot: { ...data.snapshot, tabs: [] },
  });
  expect(empty.entries).toEqual([]);
});
it("retains closed locks by occurrence while ordinary closed tabs stay out of the session", () => {
  const space = entity("space", "Saved");
  const a = entity("savedTab", "A", {
    order: 1,
    spaceId: space.id,
    url: "https://same.test/",
    locked: true,
  });
  const b = entity("savedTab", "B", {
    order: 2,
    spaceId: space.id,
    url: a.url,
    locked: true,
  });
  const ordinary = entity("savedTab", "Closed ordinary", {
    spaceId: space.id,
    url: "https://ordinary.test/",
  });
  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    reason: "empty",
    protected: false,
    tabs: [],
    groups: [],
  };
  const data = savedSessionData(space.id, [a, b, ordinary], { snapshot });
  expect(data.entries.map((entry) => entry.tab.lockId)).toEqual([a.id, b.id]);
  const tree = spaceTabTree(
    [space, a, b, ordinary],
    {
      id: "browser",
      generation: "test",
      updatedAt: new Date().toISOString(),
      groups: [],
      tabs: [
        {
          id: 1,
          windowId: 1,
          index: 0,
          groupId: -1,
          title: "A",
          url: a.url!,
          active: true,
          pinned: false,
          audible: false,
          discarded: false,
          autoDiscardable: true,
          muted: false,
          spaceId: space.id,
          lockId: a.id,
        },
      ],
    },
    [{ id: `session:checkpoint:${space.id}`, value: { snapshot } }],
  );
  expect(tree[space.id].map((tab) => [tab.lockId, tab.live])).toEqual([
    [a.id, true],
    [b.id, false],
  ]);
});
