import test from "node:test";
import assert from "node:assert/strict";
import {
  sameMembers,
  sameOrder,
  validateIntent,
} from "../apps/drag-group/extension/policy.js";
import { applyGesture } from "../apps/drag-group/extension/grouping.js";
const tabs = [
  { id: 1, index: 0, pinned: true, groupId: -1, highlighted: false },
  { id: 2, index: 1, pinned: false, groupId: -1, highlighted: true },
  { id: 3, index: 2, pinned: false, groupId: -1, highlighted: false },
  { id: 4, index: 3, pinned: false, groupId: -1, highlighted: false },
];
const captured = {
  mapId: "map",
  windowId: 7,
  beaconId: 1,
  capturedAt: 1000,
  tabs,
};
const intent = { mapId: "map", windowId: 7, sourceId: 2, targetId: 3 };
test("one-source reordering is allowed and preserves the exact source/target IDs", () => {
  const current = {
    ...captured,
    tabs: [
      tabs[0],
      { ...tabs[2], index: 1 },
      { ...tabs[1], index: 2 },
      tabs[3],
    ],
  };
  assert(validateIntent(intent, captured, current, true, 1500));
  assert(sameMembers(tabs, current.tabs));
  assert(!sameOrder(tabs, current.tabs));
});
test("the second mapping acknowledgment requires identical API order", () => {
  assert(sameOrder(tabs, structuredClone(tabs)));
  assert(!sameOrder(tabs, [tabs[0], tabs[2], tabs[1], tabs[3]]));
});
for (const [name, change] of [
  [
    "wrong window",
    () => [{ ...intent, windowId: 8 }, captured, captured, true, 1500],
  ],
  [
    "wrong map",
    () => [{ ...intent, mapId: "obsolete" }, captured, captured, true, 1500],
  ],
  ["focus loss", () => [intent, captured, captured, false, 1500]],
  ["stale map", () => [intent, captured, captured, true, 42000]],
  [
    "closed target",
    () => [
      intent,
      captured,
      { ...captured, tabs: tabs.filter((t) => t.id !== 3) },
      true,
      1500,
    ],
  ],
  [
    "same source/target",
    () => [{ ...intent, targetId: 2 }, captured, captured, true, 1500],
  ],
  [
    "pinned target",
    () => [{ ...intent, targetId: 1 }, captured, captured, true, 1500],
  ],
  [
    "already grouped source",
    () => [
      intent,
      captured,
      {
        ...captured,
        tabs: tabs.map((t) => (t.id === 2 ? { ...t, groupId: 9 } : t)),
      },
      true,
      1500,
    ],
  ],
  [
    "multiple selected tabs",
    () => [
      intent,
      captured,
      {
        ...captured,
        tabs: tabs.map((t) => (t.id === 3 ? { ...t, highlighted: true } : t)),
      },
      true,
      1500,
    ],
  ],
  [
    "source no longer selected",
    () => [
      intent,
      captured,
      {
        ...captured,
        tabs: tabs.map((t) => (t.id === 2 ? { ...t, highlighted: false } : t)),
      },
      true,
      1500,
    ],
  ],
  [
    "another tab reordered",
    () => [
      intent,
      captured,
      { ...captured, tabs: [tabs[0], tabs[1], tabs[3], tabs[2]] },
      true,
      1500,
    ],
  ],
])
  test(`rejects ${name}`, () =>
    assert.throws(() => validateIntent(...change())));
test("browser executor retries only transient drag failures and rechecks every attempt", async () => {
  let calls = 0,
    reads = 0;
  const capture = { ...captured, capturedAt: Date.now() };
  const value = await applyGesture(intent, capture, {
    enabled: () => true,
    snapshot: async () => {
      reads++;
      return captured;
    },
    focused: async () => true,
    createGroup: async () => {
      if (calls++ === 0)
        throw new Error(
          "Tabs cannot be edited right now (user may be dragging a tab).",
        );
      return 9;
    },
  });
  assert.equal(value, 9);
  assert.equal(calls, 2);
  assert.equal(reads, 2);
});
test("browser executor cancels after disabling during its state read", async () => {
  let enabled = true,
    calls = 0;
  await assert.rejects(
    applyGesture(
      intent,
      { ...captured, capturedAt: Date.now() },
      {
        enabled: () => enabled,
        snapshot: async () => {
          enabled = false;
          return captured;
        },
        focused: async () => true,
        createGroup: async () => {
          calls++;
          return 9;
        },
      },
    ),
  );
  assert.equal(calls, 0);
});
test("browser executor never retries an unrelated Chrome error", async () => {
  let calls = 0;
  await assert.rejects(
    applyGesture(
      intent,
      { ...captured, capturedAt: Date.now() },
      {
        enabled: () => true,
        snapshot: async () => captured,
        focused: async () => true,
        createGroup: async () => {
          calls++;
          throw new Error("Permission denied");
        },
      },
    ),
    /Permission denied/,
  );
  assert.equal(calls, 1);
});

test("a 30s hold fits the bounded 40s map lease with release margin", () => {
  assert(
    validateIntent(
      intent,
      captured,
      captured,
      true,
      captured.capturedAt + 33000,
    ),
  );
  assert.throws(() =>
    validateIntent(
      intent,
      captured,
      captured,
      true,
      captured.capturedAt + 40001,
    ),
  );
  assert.throws(() =>
    validateIntent(intent, captured, captured, true, captured.capturedAt - 1),
  );
});
