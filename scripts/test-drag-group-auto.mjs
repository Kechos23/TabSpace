import "./development-maintenance.mjs";
import { resolve } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const extension = resolve(root, "artifacts/drag-group/extension");
const { extensionId } = JSON.parse(
  await readFile(resolve(root, "artifacts/drag-group/identity.json"), "utf8"),
);
const url = `chrome-extension://${extensionId}/`,
  profile = resolve(root, `artifacts/drag-group-auto-profile-${Date.now()}`);
const report = {
  version: JSON.parse(
    await readFile(resolve(extension, "manifest.json"), "utf8"),
  ).version,
  profile,
  checks: [],
  errors: [],
  nativeMouseGesture: false,
};
let context, worker;
async function until(predicate, label) {
  for (let i = 0; i < 60; i++) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${label}`);
}
const check = (name) => {
  report.checks.push(name);
  console.log(`PASS ${name}`);
};
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: false,
    viewport: null,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--no-first-run",
      "--restore-last-session",
      "--window-size=1100,780",
    ],
  });
  worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  context.on("weberror", (error) => report.errors.push(error.error().message));
}
const controllers = () =>
  worker.evaluate(async () => {
    const target = chrome.runtime.getURL("controller.html");
    return (await chrome.runtime.getContexts({ contextTypes: ["TAB"] })).filter(
      (c) => c.documentUrl?.split("?")[0] === target,
    );
  });
const windows = () =>
  worker.evaluate(() => chrome.windows.getAll({ windowTypes: ["normal"] }));
async function controlPage(windowId) {
  await until(
    async () => (await controllers()).some((c) => c.windowId === windowId),
    "controller context",
  );
  return until(async () => {
    for (const page of context
      .pages()
      .filter((p) => p.url().split("?")[0] === url + "controller.html")) {
      try {
        if (
          await page.evaluate(
            async (id) => (await chrome.tabs.getCurrent())?.windowId === id,
            windowId,
          )
        )
          return page;
      } catch {}
    }
  }, "controller page");
}
async function ready(page) {
  await until(
    async () =>
      !page.isClosed() &&
      (await page.locator("#status").textContent()).startsWith("Ready"),
    "native Ready",
  );
}
async function fixturePair(windowId) {
  await worker.evaluate(async (id) => {
    for (const name of ["A", "B"])
      await chrome.tabs.create({
        windowId: id,
        url: chrome.runtime.getURL(`fixture.html?name=${name}`),
        active: false,
      });
  }, windowId);
}
async function popup(windowId) {
  // Render the real action-popup document in an extension tab for browser tests.
  // This does not claim a native toolbar mouse interaction.
  const tab = await worker.evaluate(
    (id) =>
      chrome.tabs.create({
        windowId: id,
        url: chrome.runtime.getURL("popup.html"),
        active: false,
      }),
    windowId,
  );
  return until(async () => {
    for (const page of context
      .pages()
      .filter((p) => p.url() === url + "popup.html")) {
      try {
        if (
          await page.evaluate(
            async (id) => (await chrome.tabs.getCurrent())?.id === id,
            tab.id,
          )
        )
          return page;
      } catch {}
    }
  }, "popup document");
}
try {
  await launch();
  const first = (await windows())[0];
  let primary = await controlPage(first.id);
  await fixturePair(first.id);
  await ready(primary);
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.action.default_popup, "popup.html");
  const own = await primary.evaluate(() => chrome.tabs.getCurrent());
  assert.equal(own.pinned, true);
  assert.equal(own.active, false);
  check(
    "default auto-enable creates one inactive pinned controller and reaches native Ready",
  );
  const panel = await popup(first.id);
  await until(
    async () =>
      (await panel.locator("#summary").textContent()).startsWith("Ενεργό"),
    "popup state",
  );
  await mkdir(resolve(root, "docs/screenshots"), { recursive: true });
  await panel.screenshot({
    path: resolve(root, "docs/screenshots/drag-group-popup.png"),
    clip: { x: 0, y: 0, width: 340, height: 320 },
  });
  check("popup reports background state without an Enable click");
  await panel.locator("#enabled").uncheck();
  await until(
    async () =>
      (await primary.locator("#status").textContent()).startsWith("Paused"),
    "global pause",
  );
  assert.equal(
    (await worker.evaluate(() => chrome.storage.local.get("enabled"))).enabled,
    false,
  );
  const second = await worker.evaluate(() =>
    chrome.windows.create({
      url: chrome.runtime.getURL("fixture.html?name=A"),
      focused: false,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert(!(await controllers()).some((c) => c.windowId === second.id));
  check(
    "global pause persists and prevents controller creation in new windows",
  );
  await primary.evaluate(() => {
    globalThis.testConnections = [];
    const connect = chrome.runtime.connectNative.bind(chrome.runtime);
    chrome.runtime.connectNative = (...args) => {
      const port = connect(...args);
      port.onMessage.addListener((message) => {
        if (message.type === "challenge")
          globalThis.testConnections.push({ port, session: message.session });
      });
      return port;
    };
  });
  await panel.locator("#enabled").check();
  const secondary = await controlPage(second.id);
  await fixturePair(second.id);
  await ready(primary);
  await ready(secondary);
  check("global resume starts both windows, including the unfocused window");
  await primary.evaluate(() => {
    const connection = globalThis.testConnections[0];
    connection.port.postMessage({
      protocolVersion: 1,
      type: "shutdown",
      session: connection.session,
    });
  });
  await until(
    () => primary.evaluate(() => globalThis.testConnections.length >= 2),
    "automatic helper reconnect",
  );
  await ready(primary);
  check(
    "unexpected helper exit reconnects automatically without a popup or Enable click",
  );
  const detached = await worker.evaluate(async (source) => {
    const tab = await chrome.tabs.create({
      windowId: source,
      url: chrome.runtime.getURL("fixture.html?name=detached"),
      active: false,
    });
    const create = chrome.tabs.create.bind(chrome.tabs),
      controller = chrome.runtime.getURL("controller.html");
    globalThis.detachRetryFixture = { calls: 0, rejected: 0 };
    chrome.tabs.create = async (options) => {
      if (options.url === controller && options.windowId !== source) {
        globalThis.detachRetryFixture.calls++;
        if (globalThis.detachRetryFixture.rejected < 2) {
          globalThis.detachRetryFixture.rejected++;
          throw new Error(
            "Tabs cannot be edited right now (user may be dragging a tab).",
          );
        }
      }
      return create(options);
    };
    const window = await chrome.windows.create({
      tabId: tab.id,
      focused: false,
    });
    return { windowId: window.id, tabId: tab.id };
  }, first.id);
  const detachedPage = await controlPage(detached.windowId);
  await fixturePair(detached.windowId);
  await ready(detachedPage);
  const retryProof = await worker.evaluate(() => globalThis.detachRetryFixture);
  assert.equal(retryProof.rejected, 2);
  assert(retryProof.calls >= 3);
  assert.equal(
    (await worker.evaluate((id) => chrome.tabs.get(id), detached.tabId))
      .windowId,
    detached.windowId,
  );
  assert.equal(
    (await controllers()).filter((c) => c.windowId === detached.windowId)
      .length,
    1,
  );
  report.detachedWindow = {
    ...retryProof,
    automaticReady: true,
    physicalDrag: false,
  };
  check(
    "detaching an existing tab auto-starts its new window after two injected tab-edit locks without opening the popup",
  );
  async function singleTearOut() {
    const result = await worker.evaluate(async (source) => {
      const tab = await chrome.tabs.create({
        windowId: source,
        url: chrome.runtime.getURL("fixture.html?name=cleanup"),
        active: false,
      });
      const window = await chrome.windows.create({
        tabId: tab.id,
        focused: false,
      });
      return { windowId: window.id, tabId: tab.id };
    }, first.id);
    await controlPage(result.windowId);
    await until(
      () =>
        worker.evaluate(
          async (id) =>
            (await chrome.storage.session.get(`tearout:${id}`))[
              `tearout:${id}`
            ],
          result.windowId,
        ),
      "tear-out provenance",
    );
    return result;
  }
  const closedTearOut = await singleTearOut();
  await worker.evaluate((id) => chrome.tabs.remove(id), closedTearOut.tabId);
  await until(
    async () => !(await windows()).some((w) => w.id === closedTearOut.windowId),
    "empty tear-out closes",
  );
  check(
    "closing the last browsing tab retires only the owned controller and closes its tear-out window",
  );
  const movedTearOut = await singleTearOut();
  await worker.evaluate(
    ({ tabId, windowId }) => chrome.tabs.move(tabId, { windowId, index: -1 }),
    { tabId: movedTearOut.tabId, windowId: first.id },
  );
  await until(
    async () => !(await windows()).some((w) => w.id === movedTearOut.windowId),
    "returned tab closes empty tear-out",
  );
  assert.equal(
    (await worker.evaluate((id) => chrome.tabs.get(id), movedTearOut.tabId))
      .windowId,
    first.id,
  );
  check(
    "moving the browsing tab back preserves it and closes the empty tear-out without controller recreation",
  );
  const pinnedTearOut = await singleTearOut();
  const otherPinned = await worker.evaluate(
    (id) =>
      chrome.tabs.create({
        windowId: id,
        url: chrome.runtime.getURL("fixture.html?name=other-pinned"),
        pinned: true,
        active: false,
      }),
    pinnedTearOut.windowId,
  );
  await worker.evaluate((id) => chrome.tabs.remove(id), pinnedTearOut.tabId);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert((await windows()).some((w) => w.id === pinnedTearOut.windowId));
  assert.equal(
    (await worker.evaluate((id) => chrome.tabs.get(id), otherPinned.id)).pinned,
    true,
  );
  await worker.evaluate((id) => chrome.tabs.remove(id), otherPinned.id);
  await until(
    async () => !(await windows()).some((w) => w.id === pinnedTearOut.windowId),
    "last pinned browsing tab removed",
  );
  check(
    "another pinned user tab prevents cleanup until that tab is also removed",
  );
  const ordinary = await worker.evaluate(() =>
    chrome.windows.create({ url: "about:blank", focused: false }),
  );
  await controlPage(ordinary.id);
  await worker.evaluate(async (id) => {
    const own = new Set(
      (
        await chrome.runtime.getContexts({
          contextTypes: ["TAB"],
          windowIds: [id],
        })
      )
        .filter(
          (c) =>
            c.documentUrl?.split("?")[0] ===
            chrome.runtime.getURL("controller.html"),
        )
        .map((c) => c.tabId),
    );
    for (const tab of await chrome.tabs.query({ windowId: id }))
      if (!own.has(tab.id)) await chrome.tabs.remove(tab.id);
  }, ordinary.id);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert((await windows()).some((w) => w.id === ordinary.id));
  await worker.evaluate((id) => chrome.windows.remove(id), ordinary.id);
  check(
    "ordinary controller-only windows are preserved by the scoped cleanup rule",
  );
  const third = await worker.evaluate(() =>
    chrome.windows.create({
      url: chrome.runtime.getURL("fixture.html?name=A"),
      focused: false,
    }),
  );
  const thirdPage = await controlPage(third.id);
  await fixturePair(third.id);
  await ready(thirdPage);
  check("a new unfocused normal window automatically reaches Ready");
  const excluded = await worker.evaluate(() =>
    chrome.windows.create({
      type: "popup",
      url: chrome.runtime.getURL("fixture.html?name=A"),
      focused: false,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert(!(await controllers()).some((c) => c.windowId === excluded.id));
  await worker.evaluate((id) => chrome.windows.remove(id), excluded.id);
  check("non-normal popup windows are excluded");
  await worker.evaluate(
    (id) =>
      chrome.tabs.create({
        windowId: id,
        url: chrome.runtime.getURL("controller.html"),
        pinned: true,
        active: false,
      }),
    first.id,
  );
  await until(
    async () =>
      (await controllers()).filter((c) => c.windowId === first.id).length === 1,
    "duplicate cleanup",
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(
    (await controllers()).filter((c) => c.windowId === first.id).length,
    1,
  );
  check(
    "duplicate/restored controller context is removed without touching browsing tabs",
  );
  const old = (await controllers()).find((c) => c.windowId === third.id).tabId;
  await worker.evaluate((id) => chrome.tabs.remove(id), old);
  await until(
    async () =>
      (await controllers()).some(
        (c) => c.windowId === third.id && c.tabId !== old,
      ),
    "closed controller replacement",
  );
  await ready(await controlPage(third.id));
  check("closing a controller recreates it automatically while enabled");
  await context.close();
  context = undefined;
  await launch();
  await until(async () => {
    const normal = await windows(),
      all = await controllers();
    return (
      normal.length > 0 &&
      normal.every((w) => all.filter((c) => c.windowId === w.id).length === 1)
    );
  }, "restart controllers");
  assert.equal(
    (await worker.evaluate(() => chrome.storage.local.get("enabled"))).enabled,
    true,
  );
  for (const window of await windows()) {
    const page = await controlPage(window.id);
    await fixturePair(window.id);
    await ready(page);
  }
  report.restoredWindows = (await windows()).length;
  check(
    "browser restart/session restore auto-enables exactly one controller per normal window",
  );
  const restored = (await windows())[0];
  const restoredPanel = await popup(restored.id);
  await until(
    () => restoredPanel.locator("#enabled").isChecked(),
    "restored popup",
  );
  await restoredPanel.locator("#enabled").uncheck();
  await until(
    async () =>
      (
        await Promise.all(
          context
            .pages()
            .filter((p) => p.url().split("?")[0] === url + "controller.html")
            .map((p) => p.locator("#status").textContent()),
        )
      ).every((s) => s.startsWith("Paused")),
    "all paused",
  );
  await context.close();
  context = undefined;
  await launch();
  assert.equal(
    (await worker.evaluate(() => chrome.storage.local.get("enabled"))).enabled,
    false,
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  for (const page of context
    .pages()
    .filter((p) => p.url().split("?")[0] === url + "controller.html"))
    assert((await page.locator("#status").textContent()).startsWith("Paused"));
  check("global pause remains off after a second browser restart");
  const pausedSource = (await windows())[0];
  const pausedDetached = await worker.evaluate(async (source) => {
    const tab = await chrome.tabs.create({
      windowId: source,
      url: chrome.runtime.getURL("fixture.html?name=paused-detach"),
      active: false,
    });
    return (await chrome.windows.create({ tabId: tab.id, focused: false })).id;
  }, pausedSource.id);
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert(!(await controllers()).some((c) => c.windowId === pausedDetached));
  check("detaching a tab while globally paused does not start a controller");
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  if (context) await context.close();
  await mkdir(profile, { recursive: true });
  await writeFile(
    resolve(profile, "validation.json"),
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    resolve(root, "docs/DRAG_GROUP_AUTO.json"),
    JSON.stringify(report, null, 2),
  );
}
