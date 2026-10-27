import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const lifecycleSource = await readFile(
  new URL("../apps/drag-group/extension/lifecycle.js", import.meta.url),
  "utf8",
);
const source =
  lifecycleSource.replace(
    "export function startDragGroupWorker",
    "function startDragGroupWorker",
  ) + "\nstartDragGroupWorker(__options);";
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function harness(failures = 1, options = {}) {
  const event = () => ({
    listeners: [],
    addListener(fn) {
      this.listeners.push(fn);
    },
    fire(...args) {
      for (const listener of this.listeners) listener(...args);
    },
  });
  const timers = [],
    session = {},
    tabs = new Map();
  const state = {
    enabled: false,
    alive: true,
    calls: 0,
    failures,
    contexts: [],
    removed: [],
    messages: [],
  };
  const chrome = {
    runtime: {
      id: "test",
      sendMessage: async (message) => {
        state.messages.push(message);
        return {};
      },
      getURL: (path) => "chrome-extension://test/" + path,
      getContexts: async (filter) =>
        state.contexts.filter(
          (c) => !filter.windowIds || filter.windowIds.includes(c.windowId),
        ),
      getManifest: () => ({ version: "test" }),
      onMessage: event(),
      onInstalled: event(),
      onStartup: event(),
    },
    storage: {
      local: { get: async () => ({ enabled: state.enabled }) },
      session: {
        get: async (key) => ({ [key]: session[key] }),
        set: async (values) => Object.assign(session, values),
        remove: async (key) => {
          delete session[key];
        },
      },
    },
    windows: {
      get: async (id) => {
        if (!state.alive) throw new Error("No window");
        return { id, type: "normal", incognito: false };
      },
      getAll: async () => [],
      onCreated: event(),
      onRemoved: event(),
      onFocusChanged: event(),
      onBoundsChanged: event(),
    },
    tabs: {
      onCreated: event(),
      update: async (id, patch) => {
        const t = tabs.get(id);
        if (!t) throw Error("No tab");
        Object.assign(t, patch);
        return t;
      },
      query: async ({ windowId }) =>
        [...tabs.values()].filter((tab) => tab.windowId === windowId),
      remove: async (ids) => {
        if (state.removeFailures) {
          state.removeFailures--;
          throw new Error("Tab edits locked");
        }
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          state.removed.push(id);
          tabs.delete(id);
        }
      },
      get: async (id) => {
        if (!tabs.has(id)) throw new Error("No tab");
        return tabs.get(id);
      },
      create: async (options) => {
        state.calls++;
        if (state.calls <= state.failures)
          throw new Error(
            "Tabs cannot be edited right now (user may be dragging a tab).",
          );
        const tab = { id: 100, windowId: options.windowId, ...options };
        tabs.set(tab.id, tab);
        return tab;
      },
      onRemoved: event(),
      onDetached: event(),
      onAttached: event(),
      onActivated: event(),
      onUpdated: event(),
    },
  };
  vm.runInNewContext(source, {
    __options: options,
    chrome,
    setTimeout: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimeout: (callback) => {
      const index = timers.indexOf(callback);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  await settle();
  state.enabled = true;
  return {
    state,
    session,
    tabs,
    chrome,
    timers,
    async step() {
      const callback = timers.shift();
      if (callback) callback();
      await settle();
    },
    async start() {
      chrome.windows.onCreated.fire({ id: 7, type: "normal" });
      await settle();
    },
  };
}
test("detached-window startup retries a transient Chrome tab-edit lock without another event", async () => {
  const h = await harness(2);
  await h.start();
  assert.equal(h.state.calls, 1);
  for (let i = 0; i < 10 && h.state.calls < 3; i++) await h.step();
  assert.equal(h.state.calls, 3);
  assert.equal(h.timers.length, 0);
});
test("pausing while detached-window creation is waiting stops retries", async () => {
  const h = await harness(2);
  await h.start();
  h.state.enabled = false;
  await h.step();
  assert.equal(h.state.calls, 1);
});
test("a closed destination window stops pending creation", async () => {
  const h = await harness(2);
  await h.start();
  h.state.alive = false;
  await h.step();
  assert.equal(h.state.calls, 1);
});
test("created, attached and bounds events share one pending creation", async () => {
  const h = await harness(1);
  await h.start();
  h.chrome.tabs.onAttached.fire(12, { newWindowId: 7 });
  h.chrome.windows.onBoundsChanged.fire({ id: 7, type: "normal" });
  await settle();
  await h.step();
  await settle();
  assert.equal(h.state.calls, 2);
  assert.equal(h.timers.length, 0);
});
test("a permanent tab-edit failure has bounded retries", async () => {
  const h = await harness(Infinity);
  await h.start();
  for (let i = 0; i < 20; i++) await h.step();
  assert(h.state.calls > 1 && h.state.calls <= 10);
  assert.equal(h.timers.length, 0);
});

async function emptyTearOut() {
  const h = await harness(0);
  h.session["tearout:7"] = true;
  h.tabs.set(100, { id: 100, windowId: 7, pinned: true });
  h.state.contexts.push({
    documentUrl: "chrome-extension://test/controller.html",
    tabId: 100,
    windowId: 7,
  });
  return h;
}
test("empty proven tear-out removes only its owned controller and never recreates it", async () => {
  const h = await emptyTearOut();
  h.chrome.tabs.onRemoved.fire(12, { windowId: 7, isWindowClosing: false });
  await settle();
  assert.deepEqual(h.state.removed, [100]);
  assert.equal(h.state.calls, 0);
});
test("another pinned browsing tab keeps a tear-out window alive", async () => {
  const h = await emptyTearOut();
  h.tabs.set(101, { id: 101, windowId: 7, pinned: true });
  h.chrome.tabs.onRemoved.fire(12, { windowId: 7 });
  await settle();
  assert.deepEqual(h.state.removed, []);
});
test("an ordinary controller-only window is preserved", async () => {
  const h = await emptyTearOut();
  delete h.session["tearout:7"];
  h.chrome.tabs.onRemoved.fire(12, { windowId: 7 });
  await settle();
  assert.deepEqual(h.state.removed, []);
});
test("a new user tab between membership reads cancels retirement", async () => {
  const h = await emptyTearOut();
  const query = h.chrome.tabs.query;
  let reads = 0;
  h.chrome.tabs.query = async (filter) => {
    if (++reads === 2) h.tabs.set(101, { id: 101, windowId: 7 });
    return query(filter);
  };
  h.chrome.tabs.onRemoved.fire(12, { windowId: 7 });
  await settle();
  assert.deepEqual(h.state.removed, []);
});
test("retirement retries a Chrome edit lock while globally paused", async () => {
  const h = await emptyTearOut();
  h.state.enabled = false;
  h.state.removeFailures = 1;
  h.chrome.tabs.onRemoved.fire(12, { windowId: 7 });
  await settle();
  await h.step();
  assert.deepEqual(h.state.removed, [100]);
  assert.equal(h.state.calls, 0);
});
for (const order of ["created-first", "attached-first"]) {
  test(`tear-out provenance correlates exact tab IDs (${order})`, async () => {
    const h = await harness(0);
    h.state.enabled = false;
    h.tabs.set(12, { id: 12, windowId: 7 });
    h.chrome.tabs.onDetached.fire(12, { oldWindowId: 1 });
    if (order === "created-first") {
      h.chrome.windows.onCreated.fire({ id: 7, type: "normal" });
      h.chrome.tabs.onAttached.fire(12, { newWindowId: 7 });
    } else {
      h.chrome.tabs.onAttached.fire(12, { newWindowId: 7 });
      h.chrome.windows.onCreated.fire({ id: 7, type: "normal" });
    }
    await settle();
    assert.equal(h.session["tearout:7"], true);
  });
}
test("tear-out provenance survives a manager created before its context loads", async () => {
  const h = await harness(0, { reusePages: true, controllerPath: "index.html" });
  h.tabs.set(12, { id: 12, windowId: 7, url: "https://example.test/" });
  // Focus can create the manager before the queued window-birth handler runs.
  h.chrome.windows.onFocusChanged.fire(7);
  await settle();
  assert.equal(h.state.calls, 1);
  assert.equal(h.state.contexts.length, 0);
  h.chrome.tabs.onDetached.fire(12, { oldWindowId: 1 });
  h.chrome.windows.onCreated.fire({ id: 7, type: "normal" });
  h.chrome.tabs.onAttached.fire(12, { newWindowId: 7 });
  await settle();
  assert.equal(h.session["tearout:7"], true);
  assert.equal(h.state.removed.length, 0);
});

test("a manager appearing between candidate and birth reads cannot mask a tear-out", async () => {
  const h = await harness(0, { reusePages: true, controllerPath: "index.html" });
  h.tabs.set(12, { id: 12, windowId: 7, url: "https://example.test/" });
  const query = h.chrome.tabs.query;
  let reads = 0;
  h.chrome.tabs.query = async filter => {
    if (++reads === 2) h.tabs.set(100, { id: 100, windowId: 7, pinned: true, pendingUrl: "chrome-extension://test/index.html" });
    return query(filter);
  };
  h.chrome.tabs.onDetached.fire(12, { oldWindowId: 1 });
  h.chrome.windows.onCreated.fire({ id: 7, type: "normal" });
  h.chrome.tabs.onAttached.fire(12, { newWindowId: 7 });
  await settle();
  assert.equal(h.session["tearout:7"], true);
  assert.equal(h.state.removed.length, 0);
});

test("moving a tab into an ordinary newly opened window does not mark it as a tear-out", async () => {
  const h = await harness(0);
  h.state.enabled = false;
  h.tabs.set(20, { id: 20, windowId: 7 });
  h.chrome.windows.onCreated.fire({ id: 7, type: "normal" });
  await settle();
  h.chrome.tabs.onDetached.fire(12, { oldWindowId: 1 });
  h.tabs.set(12, { id: 12, windowId: 7 });
  h.chrome.tabs.onAttached.fire(12, { newWindowId: 7 });
  await settle();
  assert.equal(h.session["tearout:7"], undefined);
});
test("detaching our controller cannot make its destination eligible for cleanup", async () => {
  const h = await harness(0);
  h.state.enabled = false;
  h.session["owned:12"] = true;
  h.tabs.set(12, { id: 12, windowId: 7 });
  h.chrome.tabs.onDetached.fire(12, { oldWindowId: 1 });
  h.chrome.windows.onCreated.fire({ id: 7, type: "normal" });
  h.chrome.tabs.onAttached.fire(12, { newWindowId: 7 });
  await settle();
  assert.equal(h.session["tearout:7"], undefined);
});

test("manager reuse pins an existing view without opening or activating another tab", async () => {
  const h = await harness(0, {
    controllerPath: "index.html",
    reusePages: true,
  });
  h.tabs.set(12, {
    id: 12,
    windowId: 7,
    url: "chrome-extension://test/index.html?space=example#tabs",
    pinned: false,
    active: false,
  });
  await h.start();
  assert.equal(h.state.calls, 0);
  assert.equal(h.tabs.get(12).pinned, true);
  assert.equal(h.tabs.get(12).active, false);
});
test("manager registration preserves secondary views and elects the pinned primary", async () => {
  const h = await harness(0, {
    controllerPath: "index.html",
    reusePages: true,
  });
  for (const [id, pinned] of [
    [12, false],
    [20, true],
  ])
    h.tabs.set(id, {
      id,
      windowId: 7,
      url: "chrome-extension://test/index.html",
      pinned,
    });
  const reply = await new Promise((resolve) =>
    h.chrome.runtime.onMessage.listeners[0](
      { type: "controllerReady" },
      {
        id: "test",
        url: "chrome-extension://test/index.html",
        tab: h.tabs.get(12),
      },
      resolve,
    ),
  );
  assert.equal(reply.primary, false);
  assert.equal(h.tabs.size, 2);
  assert.deepEqual(h.state.removed, []);
  assert.equal(h.session["owned:12"], undefined);
});
for (const automatic of [false, true])
  test(`empty tear-out ${automatic ? "retires automatic manager" : "preserves user-opened manager"}`, async () => {
    const h = await harness(0, {
      controllerPath: "index.html",
      reusePages: true,
    });
    h.session["tearout:7"] = true;
    if (automatic) h.session["owned:12"] = true;
    h.state.contexts = [
      {
        tabId: 12,
        windowId: 7,
        documentUrl: "chrome-extension://test/index.html",
      },
    ];
    h.tabs.set(12, {
      id: 12,
      windowId: 7,
      url: "chrome-extension://test/index.html",
      pinned: true,
    });
    await h.start();
    assert.deepEqual(h.state.removed, automatic ? [12] : []);
    assert.equal(h.state.calls, 0);
  });

for (const automatic of [false, true])
  for (const drag of [false, true])
    test(`manager lifetime uses auto=${automatic} OR drag=${drag}, while controller permission stays drag-only`, async () => {
      const h = await harness(0, {
        controllerPath: "index.html",
        reusePages: true,
        keepPages: async () => automatic,
      });
      h.state.enabled = drag;
      await h.start();
      assert.equal(h.state.calls, automatic || drag ? 1 : 0);
      if (!automatic && !drag) return;
      h.chrome.tabs.onActivated.fire({ windowId: 7 });
      h.chrome.tabs.onCreated.fire(h.tabs.get(100));
      await settle();
      assert.equal(h.state.calls, 1);
      const reply = await new Promise((resolve) =>
        h.chrome.runtime.onMessage.listeners[0](
          { type: "controllerReady" },
          {
            id: "test",
            url: "chrome-extension://test/index.html",
            tab: h.tabs.get(100),
          },
          resolve,
        ),
      );
      assert.equal(reply.enabled, drag);
    });

test("turning off automatic manager stops pending creation retries when Drag Group is paused", async () => {
  let automatic = true;
  const h = await harness(2, {
    controllerPath: "index.html",
    reusePages: true,
    keepPages: async () => automatic,
  });
  h.state.enabled = false;
  await h.start();
  assert.equal(h.state.calls, 1);
  automatic = false;
  await h.step();
  assert.equal(h.state.calls, 1);
});

test("standalone ignores manager-only lifetime policy", async () => {
  const h = await harness(0, { keepPages: async () => true });
  h.state.enabled = false;
  await h.start();
  assert.equal(h.state.calls, 0);
});

test("session-preserved automatic manager is not retired during a Space operation", async () => {
  const h = await harness(0, {
    controllerPath: "index.html",
    reusePages: true,
    eligible: async () => false,
  });
  h.session["tearout:7"] = true;
  h.session["owned:12"] = true;
  h.state.contexts = [
    {
      tabId: 12,
      windowId: 7,
      documentUrl: "chrome-extension://test/index.html",
    },
  ];
  h.tabs.set(12, {
    id: 12,
    windowId: 7,
    url: "chrome-extension://test/index.html",
    pinned: true,
  });
  await h.start();
  assert.deepEqual(h.state.removed, []);
  assert.equal(h.state.calls, 0);
});
