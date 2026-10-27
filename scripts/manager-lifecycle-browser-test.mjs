import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const extension = resolve(
  root,
  process.env.TABSPACE_EXTENSION_DIR || "dist/core",
);
const profile = resolve(root, `artifacts/manager-lifecycle-${Date.now()}`);
let context;
const results = [];
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1200, height: 900 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  await context.route("https://manager.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Browsing fixture</title><p>Local manager lifecycle fixture</p>",
    }),
  );
  await context.addInitScript(() => {
    if (!location.pathname.endsWith("/index.html")) return;
    window.helperAttempts = 0;
    // No registered helper or OS hooks are launched by this test.
    chrome.runtime.connectNative = () => {
      window.helperAttempts++;
      throw Error("Isolated helper fixture");
    };
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const base = `chrome-extension://${worker.url().split("/")[2]}/`;
  const control = await context.newPage();
  await control.goto(base + "popup.html");
  const rpc = async (message) => {
    const reply = await control.evaluate(
      (message) => chrome.runtime.sendMessage(message),
      message,
    );
    assert(reply?.ok, reply?.error);
    return reply.value;
  };
  await rpc({ type: "load" });
  const managers = (windowId) =>
    control.evaluate(
      async ({ windowId, base }) =>
        (
          await chrome.tabs.query(windowId === undefined ? {} : { windowId })
        ).filter(
          (tab) =>
            tab.url?.split(/[?#]/)[0] === base + "index.html" ||
            tab.pendingUrl?.split(/[?#]/)[0] === base + "index.html",
        ),
      { windowId, base },
    );
  const closeManager = async (windowId) => {
    const [manager] = await managers(windowId);
    assert(manager);
    await control.evaluate((id) => chrome.tabs.remove(id), manager.id);
    return manager.id;
  };
  const patch = (patch) => rpc({ type: "settingsPatch", patch });
  return { worker, base, control, rpc, managers, closeManager, patch };
}
try {
  let f = await launch();
  assert.equal((await f.rpc({ type: "load" })).settings.autoOpenManager, false);
  const first = await f.control.evaluate(() =>
    chrome.windows.create({
      url: "https://manager.test/project",
      focused: false,
    }),
  );
  assert.equal((await f.managers(first.id)).length, 0);
  const manager = await context.newPage();
  await manager.goto(f.base + "index.html");
  await manager.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = manager.getByRole("checkbox", {
    name: "Keep a pinned manager in every window",
    exact: true,
  });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect.poll(async () => (await f.managers(first.id)).length).toBe(1);
  const [initial] = await f.managers(first.id);
  assert(initial.pinned);
  const active = await f.control.evaluate(
    (id) => chrome.tabs.query({ windowId: id, active: true }),
    first.id,
  );
  assert(
    active[0].url.startsWith("https://manager.test/"),
    "Automatic manager must not steal focus",
  );
  await manager.screenshot({
    path: resolve(root, "artifacts/manager-lifecycle-settings.png"),
  });
  await f.control.evaluate(
    (id) => chrome.tabs.update(id, { pinned: false }),
    initial.id,
  );
  await expect
    .poll(async () => (await f.managers(first.id))[0]?.pinned)
    .toBe(true);
  const old = await f.closeManager(first.id);
  await expect
    .poll(async () =>
      (await f.managers(first.id)).some((tab) => tab.id !== old),
    )
    .toBe(true);
  assert.equal((await f.managers(first.id)).length, 1);
  for (const page of context
    .pages()
    .filter((page) => page.url().startsWith(f.base + "index.html")))
    assert.equal(await page.evaluate(() => window.helperAttempts), 0);
  const app = await f.control.evaluate(() =>
    chrome.windows.create({
      type: "popup",
      url: "https://manager.test/app",
      focused: false,
    }),
  );
  assert.equal((await f.managers(app.id)).length, 0);
  results.push(
    "Automatic manager works without native permission/helper, preserves browsing focus, re-pins/recreates one manager and excludes popup windows",
  );

  await f.worker.evaluate(() => {
    chrome.permissions.contains = async () => true;
  });
  await f.patch({ dragGroupEnabled: true });
  await expect
    .poll(async () => {
      let count = 0;
      for (const page of context
        .pages()
        .filter((page) => page.url().startsWith(f.base + "index.html")))
        count += await page.evaluate(() => window.helperAttempts ?? 0);
      return count;
    })
    .toBeGreaterThan(0);
  assert.equal((await f.managers(first.id)).length, 1);
  await f.patch({ autoOpenManager: false });
  const dragOld = await f.closeManager(first.id);
  await expect
    .poll(async () =>
      (await f.managers(first.id)).some((tab) => tab.id !== dragOld),
    )
    .toBe(true);
  assert.equal((await f.managers(first.id)).length, 1);
  await f.patch({ autoOpenManager: true, dragGroupEnabled: false });
  const pausedOld = await f.closeManager(first.id);
  await expect
    .poll(async () =>
      (await f.managers(first.id)).some((tab) => tab.id !== pausedOld),
    )
    .toBe(true);
  await expect
    .poll(() =>
      f.control.evaluate(() =>
        chrome.runtime.sendMessage({ type: "dragGroup:getState" }),
      ),
    )
    .toMatchObject({ enabled: false });
  results.push(
    "Auto-only, both enabled, Drag Group-only and pausing Drag Group share one manager and preserve the other preference",
  );

  // Concurrent explicit opening participates in the same per-window creation.
  const [anchored] = await f.managers(first.id);
  await f.control.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), {
    id: anchored.id,
    url: f.base + "index.html#workspace",
  });
  await expect
    .poll(async () => (await f.managers(first.id))[0]?.url)
    .toContain("#workspace");
  await f.worker.evaluate(() => {
    globalThis.savedLastFocused = chrome.windows.getLastFocused;
  });
  await f.worker.evaluate((id) => {
    chrome.windows.getLastFocused = () => chrome.windows.get(id);
  }, first.id);
  await Promise.all([
    f.rpc({
      type: "browser",
      commandId: crypto.randomUUID(),
      action: "manager",
      payload: {},
    }),
    f.rpc({
      type: "browser",
      commandId: crypto.randomUUID(),
      action: "manager",
      payload: {},
    }),
  ]);
  assert.equal((await f.managers(first.id)).length, 1);
  await f.worker.evaluate(() => {
    chrome.windows.getLastFocused = globalThis.savedLastFocused;
  });
  await f.patch({ autoOpenManager: false });
  await f.closeManager(first.id);
  await f.control.evaluate(
    (id) => chrome.windows.update(id, { focused: true }),
    first.id,
  );
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal((await f.managers(first.id)).length, 0);
  results.push(
    "Explicit Open manager reuses the automatic page; disabling both preferences stops recreation and preserves other tabs",
  );

  await f.patch({ autoOpenManager: true });
  await expect.poll(async () => (await f.managers(first.id)).length).toBe(1);
  const detached = await f.control.evaluate(async (id) => {
    const [tab] = await chrome.tabs.query({
      windowId: id,
      url: "https://manager.test/project",
    });
    const window = await chrome.windows.create({ tabId: tab.id });
    return { windowId: window.id, tabId: tab.id };
  }, first.id);
  await expect
    .poll(async () => (await f.managers(detached.windowId)).length)
    .toBe(1);
  await f.control.evaluate((id) => chrome.tabs.remove(id), detached.tabId);
  await expect
    .poll(() =>
      f.control.evaluate(async (id) => {
        try {
          await chrome.windows.get(id);
          return false;
        } catch {
          return true;
        }
      }, detached.windowId),
    )
    .toBe(true);
  results.push(
    "Auto-only tear-out cleanup retires its owned manager when the final browsing tab leaves",
  );

  await f.patch({ restoreBrowsing: false });
  await context.close();
  f = await launch();
  assert.equal((await f.rpc({ type: "load" })).settings.autoOpenManager, true);
  assert.equal(
    (await f.rpc({ type: "load" })).settings.dragGroupEnabled,
    false,
  );
  const restarted = await f.control.evaluate(() =>
    chrome.windows.create({
      url: "https://manager.test/restarted",
      focused: false,
    }),
  );
  await expect
    .poll(async () => (await f.managers(restarted.id)).length)
    .toBe(1);
  for (const page of context
    .pages()
    .filter((page) => page.url().startsWith(f.base + "index.html")))
    assert.equal(await page.evaluate(() => window.helperAttempts), 0);
  results.push(
    "Browser restart retains independent automatic-manager preference with Drag Group off and no helper connections",
  );
  await writeFile(
    resolve(root, "docs/VALIDATION_MANAGER_LIFECYCLE.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        version: "0.18.4",
        results,
        nativeHelper: "Never launched; connection attempts stubbed",
        personalChromeModified: false,
      },
      null,
      2,
    ),
  );
  results.forEach((result) => console.log("PASS", result));
} finally {
  await context?.close();
}
