import { beforeEach, expect, test, vi } from "vitest";
const f = vi.hoisted(() => ({
  options: null as any,
  setting: true,
  automatic: false,
  operation: false,
  parked: false,
  bind: vi.fn(),
  sync: vi.fn(),
  group: vi.fn(async () => 42),
}));
vi.mock("../apps/drag-group/extension/lifecycle.js", () => ({
  startDragGroupWorker: (o: any) => {
    f.options = o;
    return {
      invalidate: async () => {},
      reconcile: async () => {},
      ensureWindow: async () => {},
    };
  },
}));
vi.mock("../packages/persistence/repository", () => ({
  repository: {
    initialize: async () => {},
    settings: async () => ({
      dragGroupEnabled: f.setting,
      autoOpenManager: f.automatic,
    }),
    setSettings: async (s: any) => {
      f.setting = s.dragGroupEnabled;
    },
    patchSettings: async (s: any) => {
      f.setting = s.dragGroupEnabled;
    },
    db: { meta: { get: async () => (f.operation ? {} : undefined) } },
  },
}));
vi.mock("../apps/extension/src/background/sessions", () => ({
  sessionStatus: async () => (f.parked ? [{ windowId: 1, parked: true }] : []),
  syncSessions: f.sync,
}));
vi.mock("../apps/extension/src/background/browser", () => ({
  live: async () => ({
    tabs: [
      { id: 2, spaceId: "space" },
      { id: 3, spaceId: "space" },
    ],
  }),
  bindDragGroup: f.bind,
  registerManagerLifecycle: vi.fn(),
}));
import { createDragGroupIntegration } from "../apps/extension/src/background/drag-group";
let integration: ReturnType<typeof createDragGroupIntegration>;
const tabs = () => [
  { id: 1, index: 0, pinned: true, groupId: -1, highlighted: false },
  { id: 2, index: 1, pinned: false, groupId: -1, highlighted: true },
  { id: 3, index: 2, pinned: false, groupId: -1, highlighted: false },
];
const sender = {
  id: "test",
  url: "chrome-extension://test/index.html",
  tab: { id: 1, windowId: 1 },
};
const browserTabs = () =>
  tabs().map((t) => ({ ...t, url: t.id === 1 ? sender.url : undefined }));
const context = { type: "context", windowId: 1, beaconId: 1 };
async function gesture() {
  const { epoch } = await f.options.onContext(context, sender);
  return {
    type: "gesture",
    intent: {
      protocolVersion: 1,
      type: "gesture",
      session: crypto.randomUUID(),
      mapId: "map",
      windowId: 1,
      sourceId: 2,
      targetId: 3,
    },
    capture: {
      windowId: 1,
      beaconId: 1,
      tabs: tabs(),
      epoch,
      mapId: "map",
      capturedAt: Date.now(),
    },
  };
}
beforeEach(async () => {
  vi.clearAllMocks();
  f.setting = true;
  f.automatic = false;
  f.operation = false;
  f.parked = false;
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      getURL: (p: string) => "chrome-extension://test/" + p,
    },
    permissions: { contains: async () => true },
    storage: { local: { set: async () => {} } },
    tabs: {
      get: async () => ({ pinned: true, windowId: 1, url: sender.url }),
      query: async () => browserTabs(),
      group: f.group,
    },
    windows: {
      get: async () => ({ type: "normal", incognito: false, focused: true }),
    },
  });
  integration = createDragGroupIntegration(
    (job) => job(),
    () => {},
  );
  await integration.initialize();
});
test("automatic manager does not need native permission but still excludes parked/busy windows", async () => {
  f.setting = false;
  f.automatic = true;
  chrome.permissions.contains = vi.fn(async () => false);
  expect(await f.options.eligible(1)).toBe(true);
  await expect(f.options.onContext(context, sender)).rejects.toThrow("paused");
  f.parked = true;
  expect(await f.options.eligible(1)).toBe(false);
  f.parked = false;
  f.operation = true;
  expect(await f.options.eligible(1)).toBe(false);
  f.operation = false;
  f.automatic = false;
  expect(await f.options.eligible(1)).toBe(false);
});

test("groups through the shared validator and persists canonical Space ownership", async () => {
  const m = await gesture();
  expect(await f.options.onGesture(m, sender)).toEqual({ groupId: 42 });
  expect(f.bind).toHaveBeenCalledWith(42, "space");
  expect(f.sync).toHaveBeenCalled();
  await expect(f.options.onGesture(m, sender)).rejects.toThrow("consumed");
});
test("rejects stale gestures after Space action invalidates the epoch", async () => {
  const m = await gesture();
  integration.invalidate();
  await expect(f.options.onGesture(m, sender)).rejects.toThrow("changed");
  expect(f.group).not.toHaveBeenCalled();
});
test("rejects PWA, preserved windows, session mutation and unverified controller", async () => {
  f.parked = true;
  await expect(gesture()).rejects.toThrow("Preserved");
  f.parked = false;
  f.operation = true;
  await expect(gesture()).rejects.toThrow("session");
  f.operation = false;
  chrome.windows.get = vi.fn(async () => ({ type: "popup" })) as any;
  await expect(gesture()).rejects.toThrow("normal");
  await expect(
    f.options.onContext(context, {
      ...sender,
      url: "chrome-extension://test/manager.html",
    }),
  ).rejects.toThrow("Unverified");
  expect(f.group).not.toHaveBeenCalled();
});
test("revalidates after ownership reads and cancels if tabs changed", async () => {
  const m = await gesture();
  let reads = 0;
  chrome.tabs.query = vi.fn(async () =>
    ++reads < 5 ? browserTabs() : browserTabs().slice(0, 2),
  ) as any;
  await expect(f.options.onGesture(m, sender)).rejects.toThrow("membership");
  expect(f.group).not.toHaveBeenCalled();
});
test("pause during a queued operation cancels before Chrome mutation", async () => {
  let pending: any;
  integration = createDragGroupIntegration(
    (job) =>
      new Promise((resolve) => {
        pending = () => resolve(job());
      }),
    () => {},
  );
  await integration.initialize();
  const m = await gesture();
  const result = f.options.onGesture(m, sender);
  await new Promise((r) => setTimeout(r, 0));
  integration.invalidate();
  pending();
  await expect(result).rejects.toThrow("Disabled");
  expect(f.group).not.toHaveBeenCalled();
});

test("migration retires only the old dedicated controller if a manager exists", async () => {
  const legacy = {
    id: 8,
    windowId: 1,
    pinned: true,
    url: "chrome-extension://test/drag-group/controller.html",
  };
  chrome.tabs.query = vi.fn(async () => [...browserTabs(), legacy]) as any;
  chrome.tabs.remove = vi.fn(async () => {}) as any;
  chrome.tabs.update = vi.fn(async () => {}) as any;
  await integration.initialize();
  expect(chrome.tabs.remove).toHaveBeenCalledWith(8);
  expect(chrome.tabs.update).not.toHaveBeenCalled();
});
test("migration converts a lone legacy controller in place", async () => {
  const legacy = {
    id: 8,
    windowId: 2,
    pinned: true,
    url: "chrome-extension://test/drag-group/controller.html",
  };
  chrome.tabs.query = vi.fn(async () => [legacy]) as any;
  chrome.tabs.remove = vi.fn(async () => {}) as any;
  chrome.tabs.update = vi.fn(async () => {}) as any;
  await integration.initialize();
  expect(chrome.tabs.update).toHaveBeenCalledWith(8, {
    url: "chrome-extension://test/index.html",
  });
  expect(chrome.tabs.remove).not.toHaveBeenCalled();
});
