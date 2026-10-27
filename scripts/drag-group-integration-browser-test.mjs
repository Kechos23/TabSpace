import { resolve } from "node:path";
import assert from "node:assert/strict";
import { entity } from "../packages/domain/model.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const extension = resolve(
  root,
  process.env.TABSPACE_EXTENSION_DIR || "dist/core",
);
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/drag-integration-${Date.now()}`),
  {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  },
);
try {
  await context.addInitScript(() => {
    if (!location.pathname.endsWith("index.html")) return;
    window.dragFixture = { connections: 0, snapshots: 0, live: 0 };
    chrome.runtime.connectNative = () => {
      const f = window.dragFixture;
      f.connections++;
      f.live++;
      const listeners = [];
      let closed = false;
      const emit = (m) =>
        queueMicrotask(() => {
          if (!closed) for (const listener of listeners) listener(m);
        });
      return {
        onMessage: { addListener: (l) => listeners.push(l) },
        onDisconnect: { addListener: () => {} },
        disconnect: () => {
          if (!closed) {
            closed = true;
            f.live--;
          }
        },
        postMessage: (m) => {
          if (m.type === "hello")
            emit({
              protocolVersion: 1,
              type: "challenge",
              session: m.session,
              build: "0.1.21",
              nonce: "0123456789abcdef0123456789abcdef",
            });
          if (m.type === "snapshot") {
            f.snapshots++;
            emit({
              protocolVersion: 1,
              type: "status",
              session: m.session,
              message: "Ready — browser fixture",
            });
          }
        },
      };
    };
  });
  await context.route("https://drag.test/**", (r) =>
    r.fulfill({
      body: "<title>Drag fixture</title>",
      contentType: "text/html",
    }),
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const base = worker.url().replace("worker.js", "");
  let manager = await context.newPage();
  await manager.goto(base + "index.html");
  const rpc = (m) =>
    manager.evaluate(async (m) => {
      const r = await chrome.runtime.sendMessage(m);
      if (!r.ok) throw Error(r.error);
      return r.value;
    }, m);
  await rpc({ type: "load" });
  assert.equal(
    (
      await manager.evaluate(() =>
        chrome.runtime.sendMessage({ type: "dragGroup:getState" }),
      )
    ).enabled,
    false,
  );
  assert.equal(
    context
      .pages()
      .filter((p) => p.url().includes("/drag-group/controller.html")).length,
    0,
  );
  // Isolated developer profile: mock permission availability, not native gestures or Chrome grouping.
  await worker.evaluate(() => {
    chrome.permissions.contains = async () => true;
  });
  const a = await context.newPage();
  await a.goto("https://drag.test/a");
  const b = await context.newPage();
  await b.goto("https://drag.test/b");
  const space = entity("space", "Drag integration fixture");
  await rpc({
    type: "command",
    command: {
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "create",
      entity: space,
    },
  });
  const ids = await manager.evaluate(() =>
    chrome.tabs
      .query({ url: "https://drag.test/*" })
      .then((ts) => ts.map((t) => t.id)),
  );
  await rpc({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "adopt",
    payload: { ids, spaceId: space.id },
  });
  await rpc({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "ungroup",
    payload: { ids },
  });
  const managersBefore = context
    .pages()
    .filter((p) => p.url().startsWith(base + "index.html")).length;
  const enabled = await manager.evaluate(() =>
    chrome.runtime.sendMessage({ type: "dragGroup:setEnabled", enabled: true }),
  );
  assert.equal(enabled.enabled, true);
  const controller = manager;
  assert.equal(
    context.pages().filter((p) => p.url().startsWith(base + "index.html"))
      .length,
    managersBefore,
  );
  assert.equal(
    context
      .pages()
      .filter((p) => p.url().includes("/drag-group/controller.html")).length,
    0,
  );
  await controller.waitForLoadState();
  await expect
    .poll(() => manager.evaluate(() => window.dragFixture.snapshots))
    .toBeGreaterThan(0);
  assert((await manager.title()).startsWith("TabSpace · DG:"));
  const result = await controller.evaluate(async (ids) => {
    const tab = await chrome.tabs.getCurrent();
    await chrome.tabs.update(ids[0], { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    const gate = await chrome.runtime.sendMessage({
      type: "dragGroup:context",
      windowId: tab.windowId,
      beaconId: tab.id,
    });
    if (gate.error) throw Error(gate.error);
    const tabs = (await chrome.tabs.query({ windowId: tab.windowId }))
      .sort((a, b) => a.index - b.index)
      .map((t) => ({
        id: t.id,
        index: t.index,
        pinned: t.pinned,
        groupId: t.groupId,
        highlighted: t.highlighted,
      }));
    const intent = {
      protocolVersion: 1,
      type: "gesture",
      session: crypto.randomUUID(),
      mapId: "browser-fixture",
      windowId: tab.windowId,
      sourceId: ids[0],
      targetId: ids[1],
    };
    return chrome.runtime.sendMessage({
      type: "dragGroup:gesture",
      intent,
      capture: {
        windowId: tab.windowId,
        beaconId: tab.id,
        tabs,
        epoch: gate.epoch,
        mapId: intent.mapId,
        capturedAt: Date.now(),
      },
    });
  }, ids);
  assert(!result.error, result.error);
  assert(Number.isInteger(result.groupId));
  const state = await rpc({ type: "load" });
  assert(
    state.entities.some((e) => e.kind === "group" && e.spaceId === space.id),
  );
  const native = await manager.evaluate(
    (id) => chrome.tabs.query({ groupId: id }),
    result.groupId,
  );
  assert.deepEqual(native.map((t) => t.id).sort(), ids.sort());
  const blocked = await manager.evaluate(() =>
    chrome.runtime.sendMessage({
      type: "dragGroup:context",
      windowId: 1,
      beaconId: 0,
    }),
  );
  assert(blocked.error);
  await manager.evaluate(() =>
    chrome.runtime.sendMessage({
      type: "dragGroup:setEnabled",
      enabled: false,
    }),
  );
  assert.equal(
    (
      await manager.evaluate(() =>
        chrome.runtime.sendMessage({ type: "dragGroup:getState" }),
      )
    ).enabled,
    false,
  );
  await expect.poll(() => manager.title()).toBe("TabSpace");
  // Two manager views are legitimate; only the pinned primary hosts the helper.
  const duplicate = await context.newPage();
  await duplicate.goto(base + "index.html?space=" + space.id);
  await manager.evaluate(() =>
    chrome.runtime.sendMessage({ type: "dragGroup:setEnabled", enabled: true }),
  );
  await expect
    .poll(() => manager.evaluate(() => window.dragFixture.live))
    .toBe(1);
  await expect
    .poll(() => duplicate.evaluate(() => window.dragFixture.live))
    .toBe(0);
  await manager.close();
  manager = duplicate;
  await expect
    .poll(() => manager.evaluate(() => window.dragFixture.snapshots))
    .toBeGreaterThan(0);
  assert.equal(
    await manager.evaluate(async () => (await chrome.tabs.getCurrent()).pinned),
    true,
  );
  // A real tab tear-out must get an auto-created manager and retire it when empty.
  let releaseUI;
  const uiGate = new Promise((resolve) => {
    releaseUI = resolve;
  });
  const delayUI = async (route) => {
    await uiGate;
    await route.continue();
  };
  await context.route("**/assets/*.js", delayUI);
  const detached = await manager.evaluate(async () => {
    const tab = await chrome.tabs.create({
      url: "https://drag.test/detached",
      active: false,
    });
    const w = await chrome.windows.create({ tabId: tab.id, focused: false });
    return { windowId: w.id, tabId: tab.id };
  });
  await expect
    .poll(() =>
      manager.evaluate(
        async (id) =>
          (await chrome.tabs.query({ windowId: id })).filter((t) =>
            t.url?.startsWith(chrome.runtime.getURL("index.html")),
          ).length,
        detached.windowId,
      ),
    )
    .toBe(1);
  const automatic = context
    .pages()
    .find((p) => p !== manager && p.url().startsWith(base + "index.html"));
  assert(automatic);
  await expect
    .poll(() => automatic.evaluate(() => window.dragFixture?.snapshots ?? 0))
    .toBeGreaterThan(0);
  assert.equal(await automatic.locator("#root").textContent(), "");
  releaseUI();
  await context.unroute("**/assets/*.js", delayUI);
  await manager.evaluate((id) => chrome.tabs.remove(id), detached.tabId);
  await expect
    .poll(() =>
      manager.evaluate(async (id) => {
        try {
          await chrome.windows.get(id);
          return false;
        } catch {
          return true;
        }
      }, detached.windowId),
    )
    .toBe(true).catch(async error => {
      console.log('Tear-out failure diagnostics', JSON.stringify(await manager.evaluate(async id => ({
        markers: Object.fromEntries(Object.entries(await chrome.storage.session.get(null)).filter(([key])=>/^(born|attached|tearout|creating|owned):/.test(key))),
        tabs: (await chrome.tabs.query({windowId:id}).catch(()=>[])).map(tab=>({id:tab.id,pinned:tab.pinned,manager:tab.url?.startsWith(chrome.runtime.getURL('index.html'))})),
        contexts: await chrome.runtime.getContexts({contextTypes:['TAB'],windowIds:[id]}),
        state: await chrome.runtime.sendMessage({type:'dragGroup:getState'}),
      }),detached.windowId)));
      throw error;
    });
  assert.deepEqual(
    (
      await manager.evaluate(
        async () => (await chrome.runtime.sendMessage({ type: "load" })).value,
      )
    ).settings.dragGroupEnabled,
    true,
  );
  await manager.evaluate(() =>
    chrome.runtime.sendMessage({
      type: "dragGroup:setEnabled",
      enabled: false,
    }),
  );
  console.log(
    "Isolated Chrome: manager reuse, one helper per window, secondary views/promotion, real tear-out retirement, controller startup while UI is blocked, verified sender, native grouping and Space binding passed. Helper protocol/gesture input were simulated.",
  );
} finally {
  await context.close();
}
