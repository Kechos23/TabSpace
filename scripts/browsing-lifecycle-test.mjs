import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { APP_VERSION } from "../packages/domain/version.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright"),
  { expect } = await import("@playwright/test");
const extension = resolve(
  process.env.TABSPACE_EXTENSION_DIR || resolve(root, "dist/core"),
);
const profile = resolve(root, `artifacts/browsing-profile-${Date.now()}`),
  results = [],
  errors = [];
let context, page, worker, origin;
const rpc = async (message) => {
  const response = await page.evaluate(
    (m) => chrome.runtime.sendMessage(m),
    message,
  );
  assert(response?.ok, response?.error);
  return response.value;
};
const load = () => rpc({ type: "load" });
const browser = (action, payload = {}) =>
  rpc({ type: "browser", commandId: crypto.randomUUID(), action, payload });
const settings = async (patch) =>
  rpc({ type: "settings", value: { ...(await load()).settings, ...patch } });
const meta = (key) =>
  worker.evaluate(
    (key) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("TabSpace-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            read = db.transaction("meta").objectStore("meta").get(key);
          read.onsuccess = () => {
            resolve(read.result?.value);
            db.close();
          };
          read.onerror = () => reject(read.error);
        };
      }),
    key,
  );
const windows = () =>
  worker.evaluate(async () =>
    (
      await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] })
    ).filter((window) => !window.incognito),
  );
const openWindow = (url) =>
  worker.evaluate((url) => chrome.windows.create({ url, focused: false }), url);
const readEntity = async (id) =>
  (await load()).entities.find((item) => item.id === id);
const bindingFor = async (windowId) =>
  (await load()).sessions.find((binding) => binding.windowId === windowId);
async function launch(nativeRestore = false) {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      ...(nativeRestore ? ["--restore-last-session"] : []),
    ],
  });
  await context.route("https://browsing.test/**", (route) =>
    route.fulfill({
      body: `<title>${route.request().url().split("/").at(-1)}</title><p>Offline fixture</p>`,
      contentType: "text/html",
    }),
  );
  worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  origin = `chrome-extension://${worker.url().split("/")[2]}`;
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/index.html`);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
}
try {
  await launch();
  const initial = await load();
  assert.equal(initial.settings.restoreBrowsing, true);
  assert.equal(initial.settings.unsavedLimit, 10);
  assert.equal(initial.settings.unsavedDays, 7);
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  assert.equal(
    await page
      .getByRole("navigation", { name: "Space views" })
      .getByRole("button", { name: /Tabs/ })
      .count(),
    0,
  );
  assert.equal(
    await page
      .locator(".header-actions")
      .getByRole("button", { name: "Open Space", exact: true })
      .count(),
    0,
  );
  const rejected = await page.evaluate(
    (id) =>
      chrome.runtime.sendMessage({
        type: "browser",
        commandId: crypto.randomUUID(),
        action: "activateSession",
        payload: { spaceId: id },
      }),
    initial.inboxId,
  );
  assert.equal(rejected.ok, false);
  results.push(
    "Inbox is content-only, with no Tabs/session controls and backend protection against session activation",
  );
  const a = await openWindow("https://browsing.test/alpha"),
    b = await openWindow("https://browsing.test/beta");
  await expect
    .poll(async () => !!(await bindingFor(a.id)) && !!(await bindingFor(b.id)))
    .toBe(true);
  const aId = (await bindingFor(a.id)).spaceId,
    bId = (await bindingFor(b.id)).spaceId;
  assert.notEqual(aId, bId);
  const second = await worker.evaluate(
    (windowId) =>
      chrome.tabs.create({
        windowId,
        url: "https://browsing.test/extra",
        active: false,
      }),
    a.id,
  );
  await expect.poll(async () => (await load()).spaceTabs[aId]?.length).toBe(2);
  assert.equal((await bindingFor(a.id)).spaceId, aId);
  const detached = await worker.evaluate(
    (tabId) => chrome.windows.create({ tabId, focused: false }),
    second.id,
  );
  await expect.poll(async () => !!(await bindingFor(detached.id))).toBe(true);
  const detachedId = (await bindingFor(detached.id)).spaceId;
  assert.notEqual(detachedId, aId);
  assert.notEqual(detachedId, bId);
  results.push(
    "Each new window and native tab tear-out gets one Unsaved; opening more tabs updates the same Space",
  );
  await page.goto(`${origin}/index.html?space=${aId}`);
  await page.getByRole("button", { name: "Save Space", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Saved project");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save Space", exact: true })
    .click();
  assert.equal((await readEntity(aId)).temporary, false);
  assert.equal((await readEntity(aId)).name, "Saved project");
  await expect(
    page.locator(".space-subheading").filter({ hasText: /^Saved\s*\d+$/ }),
  ).toBeVisible();
  assert(
    !(await load()).entities.some(
      (item) => item.name === "Saved project" && item.id !== aId,
    ),
  );
  await settings({ restoreBrowsing: false, unsavedLimit: 0 });
  await worker.evaluate((id) => chrome.windows.remove(id), detached.id);
  await expect
    .poll(async () => await readEntity(detachedId), { timeout: 10000 })
    .toBeUndefined();
  assert(await readEntity(aId));
  assert(await readEntity(bId));
  const retainedWindow = await openWindow("https://browsing.test/personal");
  await expect
    .poll(async () => !!(await bindingFor(retainedWindow.id)))
    .toBe(true);
  const retainedId = (await bindingFor(retainedWindow.id)).spaceId;
  await rpc({
    type: "command",
    command: {
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "create",
      entity: {
        ...(await readEntity(retainedId)),
        id: crypto.randomUUID(),
        kind: "task",
        name: "Keep personal task",
        spaceId: retainedId,
        temporary: false,
        browsingClosedAt: undefined,
      },
    },
  });
  await worker.evaluate((id) => chrome.windows.remove(id), retainedWindow.id);
  await expect
    .poll(async () => !!(await readEntity(retainedId))?.browsingClosedAt)
    .toBe(true);
  assert(await readEntity(retainedId));
  await page.getByRole("button", { name: "Back to Home", exact: true }).click();
  await page.locator(".recent-unsaved > summary").click();
  await expect(
    page
      .locator(`[data-space-id="${retainedId}"]`)
      .getByText("Keep", { exact: true }),
  ).toBeVisible();
  results.push(
    "Save promotes the same ID; a zero history limit cleans closed URL-only sessions while open sessions, Saved Spaces and closed sessions containing personal content remain",
  );
  await settings({ restoreBrowsing: true, unsavedLimit: 10, unsavedDays: 7 });
  await expect
    .poll(async () => (await meta("browsing:last-session"))?.windows.length, {
      timeout: 10000,
    })
    .toBe(2);
  const beforeQuit = await meta("browsing:last-session"),
    expectedIds = beforeQuit.windows.map((entry) => entry.spaceId).sort();
  assert(expectedIds.includes(aId) && expectedIds.includes(bId));
  await context.close();
  await launch();
  await expect
    .poll(
      async () =>
        (await load()).sessions.filter((binding) =>
          expectedIds.includes(binding.spaceId),
        ).length,
      { timeout: 15000 },
    )
    .toBe(2);
  const afterRestart = await load();
  assert.equal(
    afterRestart.browser.tabs.filter(
      (tab) => tab.url === "https://browsing.test/alpha",
    ).length,
    1,
  );
  assert.equal(
    afterRestart.browser.tabs.filter(
      (tab) => tab.url === "https://browsing.test/beta",
    ).length,
    1,
  );
  assert.equal((await readEntity(bId)).temporary, true);
  const restoredIds = expectedIds.filter((id) =>
    afterRestart.sessions.some((binding) => binding.spaceId === id),
  );
  assert.deepEqual(restoredIds.sort(), expectedIds);
  results.push(
    "A full browser/profile restart restores both Saved and Unsaved windows with their original Space IDs and no duplicated website tabs",
  );
  await settings({ restoreBrowsing: false });
  await context.close();
  await launch();
  assert.equal(
    (await load()).browser.tabs.filter((tab) =>
      /^https:\/\/browsing.test\//.test(tab.url),
    ).length,
    0,
  );
  assert(await readEntity(aId));
  assert(await readEntity(bId));
  results.push(
    "Disabling startup restore prevents opening prior website tabs while retained sessions remain available",
  );
  await settings({ restoreBrowsing: true });
  const nativeWindow = await openWindow("https://browsing.test/native");
  await expect
    .poll(async () => !!(await bindingFor(nativeWindow.id)))
    .toBe(true);
  const nativeId = (await bindingFor(nativeWindow.id)).spaceId;
  await expect
    .poll(async () =>
      (await meta("browsing:last-session"))?.windows.some(
        (entry) => entry.spaceId === nativeId,
      ),
    )
    .toBe(true);
  await context.close();
  await launch(true);
  await expect
    .poll(
      async () =>
        (await load()).sessions.some((binding) => binding.spaceId === nativeId),
      { timeout: 15000 },
    )
    .toBe(true);
  assert.equal(
    (await load()).browser.tabs.filter(
      (tab) => tab.url === "https://browsing.test/native",
    ).length,
    1,
  );
  results.push(
    "Chrome native session restore reconnects the existing window without opening duplicate tabs",
  );
  assert((await meta("browsing:last-startup")).reconnected.includes(nativeId));
  await page.goto(`${origin}/index.html`);
  await page.screenshot({
    path: resolve(root, "artifacts/browsing-home.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("checkbox", {
      name: "Restore browsing on startup",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByLabel("Closed Unsaved Spaces to keep", { exact: true }),
  ).toHaveValue("10");
  await page.screenshot({
    path: resolve(root, "artifacts/browsing-settings.png"),
    fullPage: true,
    animations: "disabled",
  });
  const tabsBeforeReset = (await windows())
    .flatMap((window) => window.tabs.map((tab) => tab.id))
    .sort();
  await page
    .getByRole("button", { name: "Reset TabSpace data", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const reset = await load();
  assert.equal(reset.entities.filter((item) => item.kind === "task").length, 0);
  assert.equal(
    reset.entities.filter(
      (item) =>
        item.kind === "space" && !item.temporary && item.id !== reset.inboxId,
    ).length,
    0,
  );
  assert.deepEqual(
    (await windows())
      .flatMap((window) => window.tabs.map((tab) => tab.id))
      .sort(),
    tabsBeforeReset,
  );
  assert.deepEqual(errors, []);
  results.push(
    "Settings expose restore/count/days; explicit Reset removes test collection data while keeping all Chrome tabs open as fresh Unsaved browsing",
  );
  await writeFile(
    resolve(root, "docs/VALIDATION_BROWSING.json"),
    JSON.stringify(
      { version: APP_VERSION, extension, results, pageErrors: errors },
      null,
      2,
    ),
  );
  console.log(results.join("\n"));
} catch (error) {
  console.error("Page errors:", errors);
  if (page && !page.isClosed())
    console.error((await page.locator("body").innerText()).slice(-1800));
  throw error;
} finally {
  if (context) await context.close();
}
