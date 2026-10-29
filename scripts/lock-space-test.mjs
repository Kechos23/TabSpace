import "./development-maintenance.mjs";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { entity } from "../packages/domain/model.ts";
import { APP_VERSION } from "../packages/domain/version.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const extension = resolve(
  process.env.TABSPACE_EXTENSION_DIR || resolve(root, "dist/core"),
);
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/lock-space-${Date.now()}`),
  {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  },
);
const results = [],
  errors = [];
try {
  await context.route("https://locks.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<title>${route.request().url().split("/").at(-1)}</title>Fixture`,
    }),
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const origin = `chrome-extension://${worker.url().split("/")[2]}`;
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/index.html`);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const rpc = async (message) => {
    const response = await page.evaluate(
      (message) => chrome.runtime.sendMessage(message),
      message,
    );
    assert(response.ok, response.error);
    return response.value;
  };
  const load = () => rpc({ type: "load" });
  const browser = (action, payload) =>
    rpc({ type: "browser", commandId: crypto.randomUUID(), action, payload });
  const state = await load();
  assert.equal(state.settings.lockTabsByDefault, false);
  const window = await worker.evaluate(() =>
    chrome.windows.create({
      url: [
        "https://locks.test/same",
        "https://locks.test/same",
        "https://locks.test/beta",
      ],
      focused: false,
    }),
  );
  await expect
    .poll(async () =>
      (await load()).sessions.some((binding) => binding.windowId === window.id),
    )
    .toBe(true);
  const id = (await load()).sessions.find(
    (binding) => binding.windowId === window.id,
  ).spaceId;
  const tabs = async () =>
    (await load()).browser.tabs.filter((tab) => tab.spaceId === id);
  const locks = async () =>
    (await load()).entities.filter(
      (item) =>
        item.spaceId === id &&
        item.kind === "savedTab" &&
        item.locked &&
        !item.deletedAt,
    );
  await page.goto(`${origin}/index.html?space=${id}`);
  await expect(page.locator(".tab-row")).toHaveCount(3);
  assert.equal(await page.locator(".tab-row .tab-lock").count(), 0);
  const rejected = await page.evaluate(
    (spaceId) =>
      chrome.runtime.sendMessage({
        type: "browser",
        commandId: crypto.randomUUID(),
        action: "setTabLock",
        payload: { spaceId, all: true, locked: true },
      }),
    id,
  );
  assert.equal(rejected.ok, false);
  results.push("Lock defaults off and is absent/rejected for Unsaved browsing");
  await page.getByRole("button", { name: "Save Space", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByLabel("Lock current tabs in Space", { exact: true }),
  ).not.toBeChecked();
  await dialog.getByLabel("Name", { exact: true }).fill("Locked project");
  await dialog
    .getByLabel("Lock current tabs in Space", { exact: true })
    .check();
  await dialog.getByRole("button", { name: "Save Space", exact: true }).click();
  await expect.poll(async () => (await locks()).length).toBe(3);
  await expect(
    page.locator(".tab-row .tab-lock[aria-pressed=true]"),
  ).toHaveCount(3);
  assert.equal(new Set((await tabs()).map((tab) => tab.lockId)).size, 3);
  results.push(
    "Save Space checkbox locks all three original occurrences in place, including duplicate URLs, with visible per-tab controls",
  );
  const original = await tabs();
  const same = original.find((tab) => tab.url.endsWith("/same"));
  await worker.evaluate((id) => chrome.tabs.remove(id), same.id);
  await expect
    .poll(
      async () =>
        (await load()).spaceTabs[id].filter((tab) => !tab.live && tab.lockId)
          .length,
    )
    .toBe(1);
  await expect(page.locator(".tab-row.saved-session-tab")).toHaveCount(1);
  await expect(
    page.getByText("locks.test · Closed · Locked in Space", { exact: true }),
  ).toBeVisible();
  const expanded = page.locator(`[data-space-id="${id}"]`);
  if (
    !(
      (await expanded
        .locator(".space-toggle")
        .getAttribute("aria-expanded")) === "true"
    )
  )
    await expanded.locator(".space-toggle").click();
  await expect(expanded.locator(".tab-lock[aria-pressed=true]")).toHaveCount(3);
  await page.screenshot({
    path: resolve(root, "artifacts/lock-space-manager.png"),
    fullPage: true,
  });
  const closed = (await load()).spaceTabs[id].find(
    (tab) => !tab.live && tab.lockId,
  );
  await browser("openSavedTabs", {
    sourceSpaceId: id,
    savedKeys: [closed.savedKey],
  });
  await expect
    .poll(
      async () =>
        (await tabs()).filter((tab) => tab.lockId === same.lockId).length,
    )
    .toBe(1);
  assert.equal((await tabs()).length, 3);
  results.push(
    "Manually closing a locked tab retains a Closed · Locked row in manager/sidebar; reopening reuses its identity without duplicating the occurrence",
  );
  const betaRow = page
    .locator(".tab-row")
    .filter({ has: page.locator(".item-name", { hasText: /^beta$/ }) });
  await betaRow.locator(".tab-lock").click();
  await expect(betaRow.locator(".tab-lock")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const beta = (await tabs()).find((tab) => tab.url.endsWith("/beta"));
  await worker.evaluate((id) => chrome.tabs.remove(id), beta.id);
  await expect
    .poll(async () =>
      (await load()).spaceTabs[id].some((tab) => tab.url.endsWith("/beta")),
    )
    .toBe(false);
  results.push(
    "Unlocking a live tab keeps it open; subsequent manual close removes it from the active Space",
  );
  await browser("closeSession", { spaceId: id });
  assert.equal((await load()).spaceTabs[id].length, 2);
  await browser("activateSession", { spaceId: id, windowId: window.id });
  await expect.poll(async () => (await tabs()).length).toBe(2);
  assert.equal(new Set((await tabs()).map((tab) => tab.lockId)).size, 2);
  const both = await tabs();
  await worker.evaluate((id) => chrome.tabs.remove(id), both[0].id);
  await expect
    .poll(async () => (await load()).spaceTabs[id].some((tab) => !tab.live))
    .toBe(true);
  await browser("closeSession", { spaceId: id });
  await browser("activateSession", { spaceId: id, windowId: window.id });
  await expect.poll(async () => (await tabs()).length).toBe(2);
  results.push(
    "Actual Space restoration includes both last-session and closed locked tabs exactly once",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("checkbox", {
      name: "Lock tabs in Saved Spaces by default",
      exact: true,
    })
    .check();
  await expect
    .poll(async () => (await load()).settings.lockTabsByDefault)
    .toBe(true);
  const fresh = await worker.evaluate(
    (windowId) =>
      chrome.tabs.create({
        windowId,
        url: "https://locks.test/future",
        active: true,
      }),
    window.id,
  );
  await expect
    .poll(async () => (await tabs()).find((tab) => tab.id === fresh.id)?.lockId)
    .toBeTruthy();
  await browser("setTabLock", { spaceId: id, ids: [fresh.id], locked: false });
  await expect
    .poll(async () => (await tabs()).find((tab) => tab.id === fresh.id)?.lockId)
    .toBeUndefined();
  await browser("closeSession", { spaceId: id });
  await browser("activateSession", { spaceId: id, windowId: window.id });
  let future = (await tabs()).find((tab) => tab.url.endsWith("/future"));
  assert(
    future && !future.lockId,
    "Individual unlock persists across restore even while default locking stays on",
  );
  results.push(
    "Global default locks existing/future Saved tabs, while an individual unlock survives restoration",
  );
  await browser("closeSession", { spaceId: id });
  const closedFuture = (await load()).spaceTabs[id].find((tab) =>
    tab.url.endsWith("/future"),
  );
  await browser("setTabLock", {
    spaceId: id,
    savedKeys: [closedFuture.savedKey],
    locked: true,
  });
  await browser("activateSession", { spaceId: id, windowId: window.id });
  future = (await tabs()).find((tab) => tab.url.endsWith("/future"));
  assert(future.lockId);
  assert.equal(
    (await tabs()).filter((tab) => tab.url.endsWith("/future")).length,
    1,
  );
  await browser("setTabLock", { spaceId: id, ids: [future.id], locked: false });
  results.push(
    "Locking a previously ordinary closed session tab reuses its retained occurrence on restore without a second copy",
  );
  const popup = await context.newPage();
  await popup.goto(`${origin}/popup.html`);
  await popup.evaluate(async () => {
    const tab = await chrome.tabs.getCurrent();
    await chrome.windows.create({
      tabId: tab.id,
      type: "popup",
      focused: false,
    });
  });
  await worker.evaluate(
    async ({ windowId, tabId }) => {
      await chrome.windows.update(windowId, { focused: true });
      await chrome.tabs.update(tabId, { active: true });
    },
    { windowId: window.id, tabId: future.id },
  );
  await popup.reload();
  await popup
    .getByRole("button", { name: "Lock in Space", exact: true })
    .click();
  await expect(
    popup.getByRole("button", { name: "Unlock in Space", exact: true }),
  ).toBeVisible();
  await popup.screenshot({
    path: resolve(root, "artifacts/lock-space-popup.png"),
  });
  await popup
    .getByRole("button", { name: "Unlock in Space", exact: true })
    .click();
  await expect(
    popup.getByRole("button", { name: "Lock in Space", exact: true }),
  ).toBeVisible();
  await popup.close();
  results.push(
    "Popup toggles the current tab in its actual Saved Space independently of the resource destination selector",
  );
  await page
    .getByRole("checkbox", {
      name: "Lock tabs in Saved Spaces by default",
      exact: true,
    })
    .uncheck();
  await expect
    .poll(async () => (await load()).settings.lockTabsByDefault)
    .toBe(false);
  assert.equal((await locks()).length, 2);
  const kept = (await tabs()).find((tab) => tab.lockId);
  await worker.evaluate((id) => chrome.tabs.remove(id), kept.id);
  await expect
    .poll(async () =>
      (await load()).spaceTabs[id].some(
        (tab) => tab.lockId === kept.lockId && !tab.live,
      ),
    )
    .toBe(true);
  await page.goto(`${origin}/index.html?space=${id}`);
  const tree = page.locator(`[data-space-id="${id}"]`);
  if (
    (await tree.locator(".space-toggle").getAttribute("aria-expanded")) !==
    "true"
  )
    await tree.locator(".space-toggle").click();
  await tree
    .locator("li")
    .filter({ has: page.locator(".saved-tab") })
    .getByRole("button", { name: /Unlock .* in Space/ })
    .click();
  await expect
    .poll(async () =>
      (await load()).spaceTabs[id].some((tab) => tab.lockId === kept.lockId),
    )
    .toBe(false);
  results.push(
    "Disabling the default retains existing locks; sidebar unlock of a closed locked tab removes its retained entry",
  );
  const destination = entity("space", "Destination");
  await rpc({
    type: "command",
    command: {
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "create",
      entity: destination,
    },
  });
  const moved = (await tabs()).find((tab) => tab.lockId);
  await worker.evaluate((id) => chrome.tabs.remove(id), moved.id);
  await expect
    .poll(async () =>
      (await load()).spaceTabs[id].some(
        (tab) => tab.lockId === moved.lockId && !tab.live,
      ),
    )
    .toBe(true);
  const movedRow = (await load()).spaceTabs[id].find(
    (tab) => tab.lockId === moved.lockId,
  );
  await browser("moveSavedTabs", {
    sourceSpaceId: id,
    savedKeys: [movedRow.savedKey],
    spaceId: destination.id,
  });
  assert(
    !(await load()).spaceTabs[id].some((tab) => tab.lockId === moved.lockId),
  );
  assert(
    (await load()).spaceTabs[destination.id].some(
      (tab) => tab.lockId === moved.lockId,
    ),
  );
  results.push(
    "Moving a retained locked tab to a different Saved Space moves the lock and never resurrects it in the source",
  );
  const only = (await tabs())[0];
  await browser("setTabLock", { spaceId: id, ids: [only.id], locked: true });
  const finalLock = (await tabs()).find((tab) => tab.id === only.id).lockId;
  await worker.evaluate(
    (windowId) =>
      chrome.tabs.create({
        windowId,
        url: "https://locks.test/native",
        active: true,
      }),
    window.id,
  );
  await worker.evaluate(
    async ({ windowId, tabId }) => {
      const groupId = await chrome.tabs.group({
        tabIds: (await chrome.tabs.query({ windowId }))
          .filter((tab) => !tab.pinned)
          .map((tab) => tab.id),
      });
      await chrome.tabGroups.update(groupId, {
        title: "Lock group",
        color: "blue",
      });
      await chrome.tabs.update(tabId, { muted: true });
    },
    { windowId: window.id, tabId: only.id },
  );
  await expect
    .poll(
      async () => (await locks()).find((item) => item.id === finalLock)?.muted,
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await locks()).find((item) => item.id === finalLock)?.groupId,
    )
    .toBeTruthy();
  await worker.evaluate((tabId) => chrome.tabs.remove(tabId), only.id);
  await expect
    .poll(async () =>
      (await load()).spaceTabs[id].some(
        (tab) => tab.lockId === finalLock && !tab.live,
      ),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const tab = await chrome.tabs.getCurrent();
    await chrome.windows.create({ tabId: tab.id, type: "popup" });
  });
  await page.waitForTimeout(2900);
  await worker.evaluate(async () => {
    for (const window of await chrome.windows.getAll({
      windowTypes: ["normal"],
    }))
      await chrome.windows.remove(window.id);
  });
  const meta = (key) =>
    worker.evaluate(
      (key) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("TabSpace-v1");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const read = db.transaction("meta").objectStore("meta").get(key);
            read.onsuccess = () => {
              resolve(read.result?.value);
              db.close();
            };
          };
        }),
      key,
    );
  await expect
    .poll(async () => (await meta("browsing:lifecycle"))?.open)
    .toBe(false);
  await worker.evaluate(async () => {
    const window = await chrome.windows.create({
      url: "https://locks.test/native",
    });
    const [tab] = await chrome.tabs.query({ windowId: window.id });
    const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, {
      title: "Lock group",
      color: "blue",
    });
  });
  await expect
    .poll(
      async () =>
        (await meta("browsing:last-startup"))?.reconnected.includes(id),
      { timeout: 15000 },
    )
    .toBe(true);
  assert.equal(
    (await tabs()).filter((tab) => tab.lockId === finalLock).length,
    1,
  );
  assert.equal(
    (await tabs()).filter((tab) => tab.url === "https://locks.test/native")
      .length,
    1,
  );
  results.push(
    "Native-style startup reconnection adds a previously closed locked tab once while reusing the existing ordinary tab",
  );
  const grouped = await tabs();
  assert.equal(new Set(grouped.map((tab) => tab.groupId)).size, 1);
  assert(grouped.every((tab) => tab.groupId >= 0));
  assert(grouped.find((tab) => tab.lockId === finalLock).muted);
  results.push(
    "A locked tab rejoins its existing native-restored group and keeps its mute state",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(root, "docs/VALIDATION_LOCK_SPACE.json"),
    JSON.stringify(
      { version: APP_VERSION, extension, results, pageErrors: errors },
      null,
      2,
    ),
  );
  console.log(results.join("\n"));
} catch (error) {
  console.error("Page errors", errors);
  throw error;
} finally {
  await context.close();
}
