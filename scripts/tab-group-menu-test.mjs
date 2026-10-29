import "./development-maintenance.mjs";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const extension = resolve(
  process.env.TABSPACE_EXTENSION_DIR || resolve(root, "dist/core"),
);
const profile = resolve(root, `artifacts/tab-group-profile-${Date.now()}`);
const launch = () =>
  chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
let context = await launch(),
  page;
const results = [],
  errors = [];
const api = async (message) => {
  const r = await page.evaluate((m) => chrome.runtime.sendMessage(m), message);
  assert(r?.ok, r?.error);
  return r.value;
};
const load = () => api({ type: "load" });
const action = (action, payload) =>
  api({ type: "browser", commandId: crypto.randomUUID(), action, payload });
const settle = async (read, check) => {
  for (let i = 0; i < 60; i++) {
    const value = await read();
    if (check(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Fixture did not settle");
};
const setup = async () => {
  await context.route("https://tab-actions.test/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<title>Action fixture</title>",
    }),
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    `chrome-extension://${worker.url().split("/")[2]}/index.html`,
  );
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
};
const refresh = () =>
  page
    .getByRole("button", { name: "Refresh browser state", exact: true })
    .click();
const view = async (name) => {
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page
    .getByRole("button", { name: `View Space ${name}`, exact: true })
    .click();
};
const urls = (state) =>
  Object.fromEntries(
    Object.entries(state.spaceTabs).map(([id, tabs]) => [
      id,
      tabs.map((t) => t.url),
    ]),
  );
const drag = async (row, id) => {
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await row.dispatchEvent("dragstart", { dataTransfer: transfer });
  const target = page.locator(`.space-tree[data-space-id="${id}"] .space-row`);
  await target.dispatchEvent("dragover", { dataTransfer: transfer });
  await target.dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
};
try {
  await setup();
  const create = async (name, temporary = false) =>
    (
      await api({
        type: "command",
        command: {
          schemaVersion: 1,
          commandId: crypto.randomUUID(),
          type: "create",
          entity: {
            id: crypto.randomUUID(),
            kind: "space",
            name,
            temporary,
            view: "tabs",
            order: Date.now(),
            revision: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      })
    )[0].id;
  const A = await create("Temporary A", true),
    B = await create("Closed B"),
    C = await create("Active C");
  await api({
    type: "settings",
    value: { ...(await load()).settings, preserveLiveTabs: false },
  });
  const windowId = await page.evaluate(
    async () => (await chrome.windows.getCurrent()).id,
  );
  await action("activateSession", { spaceId: A, windowId });
  for (const [i, path] of ["same", "same", "third"].entries()) {
    const tab = await context.newPage();
    await tab.goto(`https://tab-actions.test/${path}`);
    await tab.evaluate((i) => (document.title = `Tab ${i}`), i);
  }
  await settle(
    load,
    (s) => s.browser.tabs.filter((t) => t.spaceId === A).length === 3,
  );

  await refresh();
  await view("Temporary A");
  const bar = page.locator(".selection-bar");
  const selectFirstTwo = async () => {
    await page.locator(".tab-row input").nth(0).check();
    await page.locator(".tab-row input").nth(1).check();
  };
  const group = () =>
    bar.getByRole("button", { name: /^Group(?: selected tabs)?$/ });
  const ungroup = () =>
    bar.getByRole("button", { name: "Ungroup", exact: true });
  await selectFirstTwo();
  await ungroup().waitFor({ state: "hidden" });
  await group().click();
  await ungroup().waitFor();
  await group().waitFor({ state: "hidden" });
  await page.locator(".tab-row input").nth(2).check();
  await group().waitFor();
  await ungroup().waitFor();
  await ungroup().click();
  await group().waitFor();
  await ungroup().waitFor({ state: "hidden" });
  await group().click();
  await ungroup().waitFor();
  results.push(
    "Live selection switches between Group, Ungroup and mixed-selection actions",
  );
  const liveBefore = (await load()).browser.tabs
    .filter((t) => t.spaceId === A)
    .map((t) => t.id);
  const row = page.locator(".tab-row").last();
  const boxBefore = await row.boundingBox();
  await row.getByRole("button", { name: /More actions/ }).click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  assert.equal((await row.boundingBox()).height, boxBefore.height);
  await menu.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  let state = await settle(
    load,
    (s) => s.browser.tabs.filter((t) => t.spaceId === A).length === 4,
  );
  const duplicate = state.browser.tabs.find(
    (t) => t.spaceId === A && !liveBefore.includes(t.id),
  );
  await action("close", { ids: [duplicate.id] });
  await action("activateSession", { spaceId: C, windowId });
  await refresh();
  await view("Temporary A");
  await selectFirstTwo();
  await ungroup().waitFor();
  await group().waitFor({ state: "hidden" });
  await ungroup().click();
  await group().waitFor();
  await ungroup().waitFor({ state: "hidden" });
  await group().click();
  await ungroup().waitFor();
  // A fresh selection spanning groups exposes both actions.
  const thirdKey = (await load()).spaceTabs[A][2].savedKey;
  await action("ungroupSavedTabs", { sourceSpaceId: A, savedKeys: [thirdKey] });
  await refresh();
  // External edits invalidate old selection refs; reselect explicitly.
  for (let i = 0; i < 3; i++)
    await page.locator(".tab-row input").nth(i).uncheck();
  await selectFirstTwo();
  await page.locator(".tab-row input").nth(2).check();
  await group().waitFor();
  await ungroup().waitFor();
  await group().click();
  await ungroup().waitFor();
  await group().waitFor({ state: "hidden" });
  assert.equal((await load()).spaceTabs[A].length, 3);
  results.push(
    "Saved grouping/ungrouping preserves selection, order and duplicate URLs without opening a session",
  );
  const savedRow = page.locator(".tab-row").last();
  const savedBox = await savedRow.boundingBox();
  await savedRow.getByRole("button", { name: /More actions/ }).click();
  await menu.waitFor();
  assert.equal((await savedRow.boundingBox()).height, savedBox.height);
  const bounds = await menu.boundingBox();
  const viewport = page.viewportSize();
  assert(
    bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.x + bounds.width <= viewport.width &&
      bounds.y + bounds.height <= viewport.height,
  );
  await page.keyboard.press("ArrowDown");
  assert(
    await menu
      .getByRole("menuitem", { name: "Move to Space", exact: true })
      .evaluate((el) => el === document.activeElement),
  );
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".tab-row input:checked").count(), 3);
  await savedRow.getByRole("button", { name: /More actions/ }).click();
  await menu.waitFor();
  await page
    .getByRole("heading", { name: "Temporary A", level: 1, exact: true })
    .click();
  await menu.waitFor({ state: "hidden" });
  await savedRow.getByRole("button", { name: /More actions/ }).click();
  await menu.waitFor();
  await page.screenshot({
    path: resolve(root, "artifacts/tab-group-menu.png"),
  });
  await page.getByRole("button", { name: "Toggle light/dark theme" }).click();
  await menu.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await savedRow.getByRole("button", { name: /More actions/ }).click();
  await menu.waitFor();
  assert.notEqual(
    await menu
      .getByRole("menuitem", { name: "Remove from Space", exact: true })
      .evaluate((el) => getComputedStyle(el).color),
    await menu
      .getByRole("menuitem", { name: "Duplicate", exact: true })
      .evaluate((el) => getComputedStyle(el).color),
  );
  await page.screenshot({
    path: resolve(root, "artifacts/tab-group-menu-dark.png"),
  });
  await menu.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  state = await settle(load, (s) => s.spaceTabs[A].length === 4);
  assert.deepEqual(
    state.spaceTabs[A].map((t) => t.url),
    [
      "https://tab-actions.test/same",
      "https://tab-actions.test/same",
      "https://tab-actions.test/third",
      "https://tab-actions.test/third",
    ],
  );
  assert(state.spaceTabs[A].every((t) => t.group === "Temporary A"));
  assert.equal(state.browser.tabs.filter((t) => t.spaceId === A).length, 0);
  results.push(
    "Row popup stays in viewport without resizing rows, supports arrows/Escape/outside dismissal and Duplicate for live/saved tabs",
  );
  const expected = state.spaceTabs[A].map((t) => t.url);
  await context.close();
  context = await launch();
  await setup();
  state = await load();
  assert.deepEqual(
    state.spaceTabs[A].map((t) => t.url),
    expected,
  );
  assert(state.spaceTabs[A].every((t) => t.group === "Temporary A"));
  await action("activateSession", {
    spaceId: A,
    windowId: state.currentWindowId,
  });
  state = await load();
  const restored = state.browser.tabs.filter(
    (t) => t.spaceId === A && !t.pinned,
  );
  assert.equal(restored.length, 4);
  assert.equal(new Set(restored.map((t) => t.groupId)).size, 1);
  assert(restored[0].groupId >= 0);
  results.push(
    "Saved group and duplicates survive browser restart and restore into one native Chrome group",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(root, "docs/VALIDATION_TAB_GROUP_MENU.json"),
    JSON.stringify({ extension, results }, null, 2),
  );
  console.log(results.map((r) => `PASS ${r}`).join("\n"));
} finally {
  await context.close();
}
