import "./development-maintenance.mjs";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const extension = resolve(
  process.env.TABSPACE_EXTENSION_DIR || resolve(root, "dist/core"),
);
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/home-profile-${Date.now()}`),
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
const results = [];
const passed = (name) => {
  results.push(name);
  console.log("PASS", name);
};
try {
  await context.route("https://home.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Home fixture</title><input id=draft>",
    }),
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const base = `chrome-extension://${worker.url().split("/")[2]}`;
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const home = () => page.getByRole("heading", { name: "Home", exact: true });
  const api = async (message) => {
    const response = await page.evaluate(
      (m) => chrome.runtime.sendMessage(m),
      message,
    );
    assert(response?.ok, response?.error || JSON.stringify(response));
    return response.value;
  };
  const load = () => api({ type: "load" });
  const action = (action, payload) =>
    api({ type: "browser", commandId: crypto.randomUUID(), action, payload });
  await page.goto(`${base}/index.html`);
  await home().waitFor();
  assert.equal((await load()).sessions.length, 0);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("recentSpaces")),
    null,
  );
  passed(
    "Plain manager opens Home without activating a Space or inventing recent visits",
  );
  const inbox = (await load()).entities.find(
    (e) => e.kind === "space" && e.name === "Inbox",
  );
  await page.evaluate((id) => localStorage.setItem("lastSpace", id), inbox.id);
  await page.reload();
  await home().waitFor();
  passed("Remembered last Space does not override the manager Home entry");
  await page
    .getByRole("button", { name: "Open Space Inbox", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Inbox", exact: true, level: 1 })
    .waitFor();
  const fixture = await context.newPage();
  await fixture.goto("https://home.test/working");
  await fixture.locator("#draft").fill("Keep this unsaved text");
  await page
    .getByRole("button", { name: "Refresh browser state", exact: true })
    .click();
  const before = await load();
  assert(before.sessions.some((s) => s.spaceId === inbox.id && !s.parked));
  const tabsBefore = await page.evaluate(async () =>
    (await chrome.tabs.query({}))
      .map((t) => [t.id, t.windowId, t.url, t.active])
      .sort(),
  );
  assert.equal(
    await page.getByText("Recent Spaces", { exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "Back to Home", exact: true }).click();
  await home().waitFor();
  await page.getByText("Active in this window", { exact: true }).waitFor();
  assert.deepEqual((await load()).sessions, before.sessions);
  assert.deepEqual(
    await page.evaluate(async () =>
      (await chrome.tabs.query({}))
        .map((t) => [t.id, t.windowId, t.url, t.active])
        .sort(),
    ),
    tabsBefore,
  );
  assert.equal(
    await fixture.locator("#draft").inputValue(),
    "Keep this unsaved text",
  );
  passed(
    "Returning Home preserves tab identities, windows, active session and unsaved page state",
  );
  await page.reload();
  await home().waitFor();
  await page.getByText("Active in this window", { exact: true }).waitFor();
  await page.getByRole("button", { name: "View Space →", exact: true }).click();
  await page
    .getByRole("heading", { name: "Inbox", exact: true, level: 1 })
    .waitFor();
  passed("Reload returns Home; Continue reopens the active Space view");
  await page.getByRole("button", { name: "Back to Home", exact: true }).click();
  const stableSessions = (await load()).sessions;
  const stableTabs = await page.evaluate(async () =>
    (await chrome.tabs.query({}))
      .map((t) => [t.id, t.windowId, t.url, t.active])
      .sort(),
  );
  await page
    .getByRole("button", { name: "View Space Inbox", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Inbox", exact: true, level: 1 })
    .waitFor();
  assert.deepEqual((await load()).sessions, stableSessions);
  assert.deepEqual(
    await page.evaluate(async () =>
      (await chrome.tabs.query({}))
        .map((t) => [t.id, t.windowId, t.url, t.active])
        .sort(),
    ),
    stableTabs,
  );
  await page
    .getByRole("button", { name: "Settings for Inbox", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "View Space",
      exact: true,
    })
    .click();
  assert.deepEqual((await load()).sessions, stableSessions);
  assert.deepEqual(
    await page.evaluate(async () =>
      (await chrome.tabs.query({}))
        .map((t) => [t.id, t.windowId, t.url, t.active])
        .sort(),
    ),
    stableTabs,
  );
  assert.equal(
    await fixture.locator("#draft").inputValue(),
    "Keep this unsaved text",
  );
  passed(
    "Home card and sidebar View Space action preserve browser tabs, windows, sessions and unsaved page state",
  );
  await page.goto(`${base}/index.html?space=${inbox.id}`);
  await page
    .getByRole("heading", { name: "Inbox", exact: true, level: 1 })
    .waitFor();
  assert(
    (await page.locator(".current-view-title").textContent()).includes("Inbox"),
  );
  assert.equal(await page.locator(".home-return").innerText(), "Back to Home");
  await page.screenshot({
    animations: "disabled",
    path: resolve(root, "docs/screenshots/space-navigation.png"),
  });
  await page.setViewportSize({ width: 400, height: 900 });
  assert(
    await page
      .locator(".topbar")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await page.screenshot({
    animations: "disabled",
    path: resolve(root, "docs/screenshots/space-navigation-narrow.png"),
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  passed("Explicit Space links still open the Space rather than Home");
  await action("activateSession", { spaceId: inbox.id, newWindow: true });
  await page.goto(`${base}/index.html`);
  await home().waitFor();
  await page.getByText("Open in another window", { exact: true }).waitFor();
  await page
    .getByRole("heading", { name: "No Space active yet", exact: true })
    .waitFor();
  passed(
    "Home distinguishes Spaces in another window from this window's active Space",
  );
  await page
    .getByRole("searchbox", { name: "Filter Spaces" })
    .fill("No such project");
  await page.getByRole("heading", { name: "No matching Spaces" }).waitFor();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Space Inbox", exact: true })
    .waitFor();
  passed("Space filter has an accessible label and recoverable empty state");
  await page
    .locator(".home")
    .getByRole("button", { name: "+ New Space", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Research");
  await page.getByRole("button", { name: "Create Space", exact: true }).click();
  await page
    .getByRole("heading", { name: "Research", exact: true, level: 1 })
    .waitFor();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await home().waitFor();
  await page.getByText("Active in this window", { exact: true }).waitFor();
  passed("New Space from Home opens its session and appears in the overview");
  await page
    .getByRole("button", { name: "New collection", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Projects");
  await page
    .getByRole("button", { name: "Create collection", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Settings for Research", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Move to collection", exact: true })
    .click();
  const project = (await load()).entities.find(
    (e) => e.kind === "sidebar" && e.name === "Projects",
  );
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Collection", exact: true })
    .selectOption(project.id);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Move", exact: true })
    .click();
  await page
    .locator(".home-collection-badge")
    .getByText("Projects", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator(`.home-card[data-space-id="${inbox.id}"] .home-collection-badge`)
      .count(),
    0,
  );
  const inboxLink = page.locator(".space-link").filter({ hasText: "Inbox" });
  await inboxLink.click();
  await page
    .getByRole("heading", { name: "Inbox", exact: true, level: 1 })
    .waitFor();
  await page.getByRole("button", { name: "Back to Home", exact: true }).click();
  const previewState = await load();
  const previewSessions = previewState.sessions;
  const currentId = previewSessions.find(
    (s) => s.windowId === previewState.currentWindowId && !s.parked,
  )?.spaceId;
  const inactive = previewState.entities.find(
    (e) =>
      e.kind === "space" && !e.deletedAt && !e.archivedAt && e.id !== currentId,
  );
  assert(inactive);

  const previewTabs = await page.evaluate(async () =>
    (await chrome.tabs.query({}))
      .map((t) => [t.id, t.windowId, t.url, t.active])
      .sort(),
  );
  await page
    .getByRole("button", { name: `View Space ${inactive.name}`, exact: true })
    .click();
  await page
    .getByRole("heading", { name: inactive.name, exact: true, level: 1 })
    .waitFor();
  await page
    .getByRole("button", { name: `Settings for ${inactive.name}`, exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "View Space",
      exact: true,
    })
    .click();
  assert.deepEqual((await load()).sessions, previewSessions);
  assert.deepEqual(
    await page.evaluate(async () =>
      (await chrome.tabs.query({}))
        .map((t) => [t.id, t.windowId, t.url, t.active])
        .sort(),
    ),
    previewTabs,
  );
  passed(
    "Inactive Space preview leaves the current session untouched; sidebar click still activates; Collection badge shows membership only",
  );
  await page.getByRole("button", { name: "Back to Home", exact: true }).click();
  const card = page.locator(`.home-card[data-space-id="${inactive.id}"]`);
  await card.locator(".home-card-view").hover();
  assert(
    await card.evaluate(
      (el) => getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)",
    ),
  );
  await card.locator(".home-open-space").hover();
  assert.notEqual(
    await card
      .locator(".home-open-space")
      .evaluate((el) => getComputedStyle(el).boxShadow),
    "none",
  );
  const group = page.locator(`[data-home-collection-id="${project.id}"]`);
  await group
    .getByRole("button", {
      name: "View Space Research in collection Projects",
      exact: true,
    })
    .waitFor();
  await group
    .getByRole("button", {
      name: "Collapse Home collection Projects",
      exact: true,
    })
    .click();
  assert.equal(
    await group
      .getByRole("button", {
        name: "View Space Research in collection Projects",
        exact: true,
      })
      .count(),
    0,
  );
  await group
    .getByRole("button", {
      name: "Expand Home collection Projects",
      exact: true,
    })
    .click();
  const groupedSessions = (await load()).sessions;
  const groupedTabs = await page.evaluate(async () =>
    (await chrome.tabs.query({}))
      .map((t) => [t.id, t.windowId, t.url, t.active])
      .sort(),
  );
  await group
    .getByRole("button", {
      name: "View Space Research in collection Projects",
      exact: true,
    })
    .click();
  await page
    .getByRole("heading", { name: "Research", exact: true, level: 1 })
    .waitFor();
  assert.deepEqual((await load()).sessions, groupedSessions);
  assert.deepEqual(
    await page.evaluate(async () =>
      (await chrome.tabs.query({}))
        .map((t) => [t.id, t.windowId, t.url, t.active])
        .sort(),
    ),
    groupedTabs,
  );
  await page.getByRole("button", { name: "Back to Home", exact: true }).click();
  await page.getByRole("searchbox", { name: "Filter Spaces" }).fill("Projects");
  assert.equal(await page.locator(".home-card").count(), 1);
  await group
    .getByRole("button", {
      name: "Open Space Research from collection Projects",
      exact: true,
    })
    .click();
  await page
    .getByRole("heading", { name: "Research", exact: true, level: 1 })
    .waitFor();
  assert(
    (await load()).sessions.some((s) => s.spaceId !== inbox.id && !s.parked),
  );
  await page.getByRole("button", { name: "Back to Home", exact: true }).click();
  passed(
    "Collections repeat grouped Spaces as compact collapsible rows; search matches Collection names; viewing preserves tabs and Open Space activates the session",
  );
  await mkdir(resolve(root, "docs/screenshots"), { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: resolve(root, "docs/screenshots/home.png"),
  });
  await page.getByRole("button", { name: "Toggle light/dark theme" }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await page
    .locator(".save-status")
    .filter({ hasText: "Saved locally" })
    .waitFor();
  await page.screenshot({
    animations: "disabled",
    path: resolve(root, "docs/screenshots/home-dark.png"),
  });
  await page.setViewportSize({ width: 400, height: 900 });
  assert(
    await page
      .locator(".home")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await page.screenshot({
    animations: "disabled",
    path: resolve(root, "docs/screenshots/home-narrow.png"),
  });
  await page.locator(".home-collections").scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: "disabled",
    path: resolve(root, "docs/screenshots/home-collections-narrow.png"),
  });
  assert.deepEqual(errors, []);
  passed(
    "Home renders in both themes and at 400px without horizontal content overflow or page errors",
  );
  await writeFile(
    resolve(root, "docs/VALIDATION_HOME.json"),
    JSON.stringify(
      { date: new Date().toISOString(), extension, results },
      null,
      2,
    ),
  );
} finally {
  await context.close();
}
