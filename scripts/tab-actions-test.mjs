import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const extension = resolve(
  process.env.TABSPACE_EXTENSION_DIR || resolve(root, "dist/core"),
);
const profile = resolve(root, `artifacts/tab-actions-profile-${Date.now()}`);
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
  const tree = page.locator(`.space-tree[data-space-id="${id}"]`);
  const toggle = tree.locator(".space-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  const target = (await tree.locator(".space-tabs button").count())
    ? tree.locator(".space-tabs button").first()
    : tree.locator(".empty-tree");
  await tree
    .locator(".space-row")
    .dispatchEvent("dragover", { dataTransfer: transfer });
  await tree.locator(".space-row").dispatchEvent("dragleave", {
    dataTransfer: transfer,
    relatedTarget: await target.elementHandle(),
  });
  assert(await tree.evaluate((el) => el.classList.contains("drop-target")));
  await target.dispatchEvent("dragover", { dataTransfer: transfer });
  assert(await tree.locator(".space-drop-hint").isVisible());
  await page.screenshot({
    path: resolve(root, "artifacts/space-drop-target.png"),
  });
  await target.dispatchEvent("drop", { dataTransfer: transfer });
  assert.equal(
    await tree.evaluate((el) => el.classList.contains("drop-target")),
    false,
  );
  await page
    .locator("body")
    .dispatchEvent("dragend", { dataTransfer: transfer });
  assert.equal(
    await page.evaluate(() =>
      document.body.classList.contains("tabspace-dragging"),
    ),
    false,
  );
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
  const groupIds = (await load()).browser.tabs
    .filter((t) => t.spaceId === A)
    .map((t) => t.id);
  await action("group", {
    ids: groupIds,
    name: "Research",
    color: "blue",
    spaceId: A,
  });
  await action("mute", { ids: [groupIds[2]] });
  await action("activateSession", { spaceId: C, windowId });
  await refresh();
  await view("Temporary A");
  await page.locator(".saved-session-tab").nth(2).waitFor();
  await page.getByRole("button", { name: "Toggle light/dark theme" }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await page.screenshot({
    path: resolve(root, "artifacts/tab-actions-saved.png"),
  });
  assert.equal(await page.locator(".tab-row .tab-favicon").count(), 3);
  assert.equal(await page.getByText("Sort title", { exact: true }).count(), 0);
  const before = await load();
  const windowsBefore = await page.evaluate(
    async () => (await chrome.windows.getAll()).length,
  );
  const staleKey = before.spaceTabs[A][0].savedKey;
  await drag(page.locator(".saved-session-tab").nth(1), B);
  await settle(
    load,
    (s) => s.spaceTabs[A].length === 2 && s.spaceTabs[B].length === 1,
  );
  let state = await load();
  assert.deepEqual(
    state.spaceTabs[A].map((t) => t.title),
    ["Tab 0", "Tab 2"],
  );
  assert.deepEqual(
    state.spaceTabs[B].map((t) => t.title),
    ["Tab 1"],
  );
  assert.equal(state.spaceTabs[B][0].group, "Research");
  assert.equal(
    await page.evaluate(async () => (await chrome.windows.getAll()).length),
    windowsBefore,
  );
  const stale = await page.evaluate(
    ({ A, B, staleKey }) =>
      chrome.runtime.sendMessage({
        type: "browser",
        commandId: crypto.randomUUID(),
        action: "moveSavedTabs",
        payload: { sourceSpaceId: A, spaceId: B, savedKeys: [staleKey] },
      }),
    { A, B, staleKey },
  );
  assert.equal(stale.ok, false);
  results.push(
    "Drop onto sidebar child rows or empty tab lists moves one duplicate occurrence atomically to a closed Space; stale selections are rejected without opening windows",
  );
  await refresh();
  await view("Temporary A");
  const sessions = JSON.stringify((await load()).sessions);
  await page.locator(".saved-session-tab .item-name").first().click();
  state = await settle(load, (s) =>
    s.browser.tabs.some((t) => t.spaceId === C && t.url.endsWith("/same")),
  );
  assert.equal(state.spaceTabs[A].length, 2);
  assert.equal(JSON.stringify(state.sessions), sessions);
  results.push(
    "Single saved-title click opens only that URL in the current active Space and keeps its source saved session",
  );
  await refresh();
  await view("Temporary A");
  await drag(page.locator(".saved-session-tab").last(), C);
  state = await settle(
    load,
    (s) =>
      s.spaceTabs[A].length === 1 &&
      s.browser.tabs.some((t) => t.spaceId === C && t.url.endsWith("/third")),
  );
  results.push(
    "Saved drag/drop into an open Space opens only the moved entry and removes it from its source",
  );
  const moved = state.browser.tabs.find(
    (t) => t.spaceId === C && t.url.endsWith("/third"),
  );
  assert.equal(moved.muted, true);
  assert.equal(
    state.browser.groups.find((g) => g.id === moved.groupId)?.title,
    "Research",
  );
  await refresh();
  await view("Active C");
  await page.locator(".tab-row").nth(1).waitFor();
  await page.screenshot({
    path: resolve(root, "artifacts/tab-actions-live.png"),
  });
  assert.equal(await page.locator(".tab-row .tab-favicon").count(), 2);
  const liveRow = page.locator(".tab-row").filter({
    has: page.getByRole("button", { name: "Action fixture", exact: true }),
  });
  await drag(liveRow, B);
  state = await settle(
    load,
    (s) =>
      s.spaceTabs[B].length === 2 &&
      s.browser.tabs.filter((t) => t.spaceId === C).length === 1,
  );
  assert.equal(
    state.sessions.some((s) => s.spaceId === B),
    false,
  );
  assert.equal(
    await page.evaluate(async () => (await chrome.windows.getAll()).length),
    windowsBefore,
  );
  results.push(
    "Live drag/drop to a closed Space appends to its saved session without restoring it or opening a window",
  );
  await refresh();
  await view("Temporary A");
  await page.locator(".saved-session-tab input[type=checkbox]").check();
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Save links", exact: true })
    .click();
  await settle(load, (s) =>
    s.entities.some((e) => e.kind === "resource" && e.spaceId === A),
  );
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Add tasks", exact: true })
    .click();
  await settle(load, (s) =>
    s.entities.some((e) => e.kind === "task" && e.spaceId === A),
  );
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Remove from Space", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await settle(load, (s) => s.spaceTabs[A].length === 0);
  results.push(
    "Saved checkboxes support bulk Save links, Add tasks and confirmed removal without resurrecting fallback records",
  );
  const expected = urls(await load());
  await page.screenshot({ path: resolve(root, "artifacts/tab-actions.png") });
  assert.deepEqual(errors, []);
  await context.close();
  context = await launch();
  await setup();
  state = await load();
  assert.deepEqual(
    state.spaceTabs[B].map((t) => t.url),
    expected[B],
  );
  assert.deepEqual(state.spaceTabs[A], []);
  await action("activateSession", {
    spaceId: B,
    windowId: state.currentWindowId,
  });
  state = await settle(
    load,
    (s) =>
      JSON.stringify(
        s.browser.tabs
          .filter((t) => t.spaceId === B && !t.pinned)
          .sort((a, b) => a.index - b.index)
          .map((t) => t.url),
      ) === JSON.stringify(expected[B]),
  );
  assert.deepEqual(
    state.browser.tabs
      .filter((t) => t.spaceId === B && !t.pinned)
      .sort((a, b) => a.index - b.index)
      .map((t) => t.url),
    expected[B],
  );
  results.push(
    "Moved entries and empty source survive a full browser restart; opening the destination restores the edited session",
  );
  await writeFile(
    resolve(root, "docs/VALIDATION_TAB_ACTIONS.json"),
    JSON.stringify({ extension, results }, null, 2),
  );
  console.log(results.map((r) => `PASS ${r}`).join("\n"));
} finally {
  await context.close();
}
