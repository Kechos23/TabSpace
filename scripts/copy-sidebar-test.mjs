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
const profile = resolve(root, `artifacts/copy-sidebar-profile-${Date.now()}`);
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
  const button = page.getByRole("button", {
    name: `View Space ${name}`,
    exact: true,
    includeHidden: true,
  });
  if (!(await button.isVisible())) {
    const recent = page.locator(".home-recent-unsaved");
    if ((await recent.getAttribute("open")) === null)
      await recent.locator("summary").click();
  }
  await button.click();
};
const urls = (state) =>
  Object.fromEntries(
    Object.entries(state.spaceTabs).map(([id, tabs]) => [
      id,
      tabs.map((t) => t.url),
    ]),
  );
const drag = async (row, id, copy = true) => {
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await row.dispatchEvent("dragstart", { dataTransfer: transfer });
  const tree = page.locator(`.space-tree[data-space-id="${id}"]`);
  const toggle = tree.locator(".space-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  const target = (await tree
    .locator('.space-tabs button[title*="Click to"]')
    .count())
    ? tree.locator('.space-tabs button[title*="Click to"]').first()
    : tree.locator(".empty-tree");
  await target.dispatchEvent("dragover", {
    dataTransfer: transfer,
    ctrlKey: !copy,
  });
  await target.dispatchEvent("dragover", {
    dataTransfer: transfer,
    ctrlKey: copy,
  });
  assert.equal(
    await tree.evaluate((el) => el.classList.contains("drop-copy")),
    copy,
  );
  await tree
    .locator(copy ? ".drop-copy-label" : ".drop-move-label")
    .waitFor({ state: "visible" });
  await page.screenshot({ path: resolve(root, "artifacts/copy-drag.png") });
  await target.dispatchEvent("drop", { dataTransfer: transfer, ctrlKey: copy });
  await page
    .locator("body")
    .dispatchEvent("dragend", { dataTransfer: transfer });
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
  const B = await create("Closed B"),
    C = await create("Active C");
  await api({
    type: "settings",
    value: { ...(await load()).settings, preserveLiveTabs: false },
  });
  const windowId = await page.evaluate(
    async () => (await chrome.windows.getCurrent()).id,
  );
  for (const [i, path] of ["same", "same", "third"].entries()) {
    const tab = await context.newPage();
    await tab.goto(`https://tab-actions.test/${path}`);
    await tab.evaluate((i) => (document.title = `Tab ${i}`), i);
  }
  const initialBrowsing = await settle(
    load,
    (s) =>
      s.browser.tabs.filter(
        (t) =>
          t.windowId === windowId &&
          t.spaceId &&
          /^https:\/\/tab-actions\.test\//.test(t.url),
      ).length === 3,
  );
  const A = initialBrowsing.sessions.find(
    (binding) => binding.windowId === windowId && !binding.parked,
  ).spaceId;
  const source = initialBrowsing.entities.find((item) => item.id === A);
  assert(source.temporary);
  await api({
    type: "command",
    command: {
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "update",
      id: A,
      expectedRevision: source.revision,
      patch: { name: "Temporary A", view: "tabs" },
    },
  });
  await page.evaluate(async () => {
    const blank = (await chrome.tabs.query({})).filter(
      (tab) => !tab.pinned && /^chrome:\/\/newtab\/?$/.test(tab.url ?? ""),
    );
    if (blank.length) await chrome.tabs.remove(blank.map((tab) => tab.id));
  });
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
  await refresh();
  await view("Temporary A");
  await page.locator(".tab-row input").nth(0).check();
  await page.locator(".tab-row input").nth(1).check();
  await drag(page.locator(".tab-row").nth(1), B);
  let state = await settle(load, (s) => s.spaceTabs[B].length === 2);
  assert.deepEqual(
    state.browser.tabs.filter((t) => t.spaceId === A).map((t) => t.id),
    groupIds,
  );
  assert.deepEqual(
    state.spaceTabs[B].map((t) => t.url),
    ["https://tab-actions.test/same", "https://tab-actions.test/same"],
  );
  assert.equal(
    state.sessions.some((s) => s.spaceId === B),
    false,
  );
  results.push(
    "Ctrl+drag copies a multi-selection of live duplicate URLs into a closed Space while keeping all original tab IDs",
  );
  await action("activateSession", { spaceId: C, windowId });
  await refresh();
  await view("Temporary A");
  const sourceBefore = (await load()).spaceTabs[A];
  await drag(page.locator(".saved-session-tab").first(), B);
  state = await settle(load, (s) => s.spaceTabs[B].length === 3);
  assert.deepEqual(state.spaceTabs[A], sourceBefore);
  await drag(page.locator(".saved-session-tab").last(), C);
  state = await settle(
    load,
    (s) => s.browser.tabs.filter((t) => t.spaceId === C).length === 1,
  );
  assert.deepEqual(state.spaceTabs[A], sourceBefore);
  const copied = state.browser.tabs.find((t) => t.spaceId === C);
  assert(copied.muted);
  assert.equal(
    state.browser.groups.find((g) => g.id === copied.groupId)?.title,
    "Research",
  );
  results.push(
    "Saved Ctrl+drag copies to closed/open destinations without changing source refs, preserving groups and mute state",
  );
  const sourceTree = page.locator(`.space-tree[data-space-id="${A}"]`);
  if (!(await sourceTree.isVisible()))
    await page.locator(".recent-unsaved > summary").click();
  if (
    (await sourceTree
      .locator(".space-toggle")
      .getAttribute("aria-expanded")) === "false"
  )
    await sourceTree.locator(".space-toggle").click();
  const sessions = JSON.stringify((await load()).sessions);
  await sourceTree
    .locator('.space-tabs button[title*="Click to"]')
    .first()
    .click();
  state = await settle(
    load,
    (s) => s.browser.tabs.filter((t) => t.spaceId === C).length === 2,
  );
  assert.equal(JSON.stringify(state.sessions), sessions);
  assert.equal(state.spaceTabs[A].length, 3);
  const activeBefore = await page.evaluate(async () =>
    (await chrome.tabs.query({ active: true }))
      .map((t) => [t.windowId, t.id])
      .sort(),
  );
  await sourceTree
    .locator('.space-tabs button[title*="Click to"]')
    .nth(1)
    .click({ button: "middle" });
  state = await settle(
    load,
    (s) => s.browser.tabs.filter((t) => t.spaceId === C).length === 3,
  );
  assert.deepEqual(
    await page.evaluate(async () =>
      (await chrome.tabs.query({ active: true }))
        .map((t) => [t.windowId, t.id])
        .sort(),
    ),
    activeBefore,
  );
  assert.equal(JSON.stringify(state.sessions), sessions);
  assert.equal(state.spaceTabs[A].length, 3);
  results.push(
    "Sidebar left-click opens one saved tab without switching sessions; real middle-click opens one background copy and keeps the active tab",
  );
  const currentTree = page.locator(`.space-tree[data-space-id="${C}"]`);
  if (
    (await currentTree
      .locator(".space-toggle")
      .getAttribute("aria-expanded")) === "false"
  )
    await currentTree.locator(".space-toggle").click();
  await currentTree
    .locator('.space-tabs button[title*="Click to"]')
    .first()
    .click();
  assert.equal(
    (await load()).browser.tabs.filter((t) => t.spaceId === C).length,
    3,
  );
  const focused = await page.evaluate(async () =>
    (await chrome.tabs.query({ active: true }))
      .map((t) => [t.windowId, t.id])
      .sort(),
  );
  await currentTree
    .locator('.space-tabs button[title*="Click to"]')
    .first()
    .click({ button: "middle" });
  await settle(
    load,
    (s) => s.browser.tabs.filter((t) => t.spaceId === C).length === 4,
  );
  assert.deepEqual(
    await page.evaluate(async () =>
      (await chrome.tabs.query({ active: true }))
        .map((t) => [t.windowId, t.id])
        .sort(),
    ),
    focused,
  );
  results.push(
    "Sidebar live left-click focuses the existing tab and middle-click creates a background copy",
  );
  await refresh();
  await view("Active C");
  await drag(page.locator(".tab-row").first(), B, true);
  await settle(load, (s) => s.spaceTabs[B].length === 4);
  assert.equal(
    (await load()).browser.tabs.filter((t) => t.spaceId === C).length,
    4,
  );
  await drag(page.locator(".tab-row").first(), B, false);
  state = await settle(
    load,
    (s) =>
      s.spaceTabs[B].length === 5 &&
      s.browser.tabs.filter((t) => t.spaceId === C).length === 3,
  );
  results.push(
    "Releasing Ctrl changes Copy to Move; ordinary drag still transfers and removes the source tab",
  );
  const kept = state.browser.tabs
    .filter((t) => t.spaceId === C)
    .map((t) => t.id);
  await refresh();
  await view("Active C");
  await drag(page.locator(".tab-row").first(), C, true);
  state = await settle(
    load,
    (s) => s.browser.tabs.filter((t) => t.spaceId === C).length === 4,
  );
  assert(
    kept.every((id) =>
      state.browser.tabs.some((t) => t.id === id && t.spaceId === C),
    ),
  );
  results.push(
    "Live copying into an open destination keeps every existing tab and adds only a new copy",
  );
  const expected = state.spaceTabs[B].map((t) => t.url);
  await context.close();
  context = await launch();
  await setup();
  state = await load();
  assert.deepEqual(
    state.spaceTabs[B].map((t) => t.url),
    expected,
  );
  assert.equal(state.spaceTabs[A].length, 3);
  assert.deepEqual(errors, []);
  results.push(
    "Copied destination entries and original saved source survive a browser restart",
  );
  await writeFile(
    resolve(root, "docs/VALIDATION_COPY_SIDEBAR.json"),
    JSON.stringify({ extension, results }, null, 2),
  );
  console.log(results.map((r) => `PASS ${r}`).join("\n"));
} finally {
  await context.close();
}
