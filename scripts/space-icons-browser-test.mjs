import "./development-maintenance.mjs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { entity } from "../packages/domain/model.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const extension = resolve(root, "dist/core");
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/space-icons-profile-${Date.now()}`),
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
try {
  await context.route("https://space-icons.test/**", (route) =>
    route.fulfill({
      body: "<title>Space icon fixture</title>",
      contentType: "text/html",
    }),
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    `chrome-extension://${worker.url().split("/")[2]}/index.html`,
  );
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const rpc = (m) =>
    page.evaluate(async (message) => {
      const result = await chrome.runtime.sendMessage(message);
      if (!result.ok) throw Error(result.error);
      return result.value;
    }, m);
  const initial = await rpc({ type: "view", recovery: false, force: false });
  const collection = entity("sidebar", "Projects");
  const draft = entity("space", "Draft project", {
    temporary: false,
    icon: "◌",
    color: "orange",
    view: "tabs",
  });
  const saved = entity("space", "Legacy saved", {
    icon: "◌",
    sidebarId: collection.id,
    view: "tabs",
  });
  const tab = entity("savedTab", "Fixture", {
    spaceId: draft.id,
    url: "https://space-icons.test/one",
  });
  for (const row of [collection, draft, saved, tab])
    await rpc({
      type: "command",
      command: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: row,
      },
    });
  await rpc({
    type: "command",
    command: {
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "create",
      entity: entity("resource", "Fixture content", {
        spaceId: draft.id,
        url: "https://space-icons.test/resource",
      }),
    },
  });
  const fixtureState = await rpc({
    type: "view",
    recovery: false,
    force: false,
  });
  await rpc({
    type: "command",
    command: {
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "update",
      id: draft.id,
      expectedRevision: fixtureState.entities.find((e) => e.id === draft.id)
        .revision,
      patch: { temporary: true, browsingClosedAt: new Date().toISOString() },
    },
  });
  const tree = (id) => page.locator(`.sidebar [data-space-id="${id}"]`).first();
  const upper = (scope) => scope.locator('[data-layer="upper"]').first();
  await expect(tree(draft.id).locator(".space-state-icon")).toHaveAttribute(
    "data-space-state",
    "unsaved",
  );
  await expect(upper(tree(draft.id))).toHaveAttribute("fill", "none");
  await expect(upper(tree(draft.id))).toHaveAttribute(
    "stroke-dasharray",
    "3 2.5",
  );
  await expect(upper(tree(saved.id))).toHaveAttribute("fill", "currentColor");
  const color = await tree(draft.id)
    .locator(".space-icon")
    .evaluate((e) => getComputedStyle(e).color);
  await expect(
    page.locator(`.home-card[data-space-id="${draft.id}"] .space-state-icon`),
  ).toHaveAttribute("data-space-state", "unsaved");
  if (!(await tree(draft.id).locator(".space-row").isVisible())) {
    await page
      .locator(".sidebar summary")
      .filter({ hasText: "Recently closed" })
      .click();
  }
  await tree(draft.id).locator(".space-row .space-menu").click();
  await page.getByRole("button", { name: "View Space", exact: true }).click();
  await expect(page.locator(".space-header .space-state-icon")).toHaveAttribute(
    "data-space-state",
    "unsaved",
  );
  await tree(draft.id).locator(".space-row .space-menu").click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save Space", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Save Space", exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill("Saved project");
  await dialog.getByRole("button", { name: "Save Space", exact: true }).click();
  await expect(tree(draft.id).locator(".space-state-icon")).toHaveAttribute(
    "data-space-state",
    "saved",
  );
  await expect(upper(tree(draft.id))).toHaveAttribute("fill", "currentColor");
  assert.equal(
    await upper(tree(draft.id)).getAttribute("stroke-dasharray"),
    null,
  );
  assert.equal(
    await tree(draft.id)
      .locator(".space-icon")
      .evaluate((e) => getComputedStyle(e).color),
    color,
  );
  await expect(page.locator(".space-header .space-state-icon")).toHaveAttribute(
    "data-space-state",
    "saved",
  );
  await rpc({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "activateSession",
    payload: { spaceId: draft.id, windowId: initial.currentWindowId },
  });
  const badge = tree(draft.id).locator(".current-space-badge");
  await expect(badge).toBeVisible();
  assert.equal(await badge.textContent(), "");
  await expect(badge).toHaveAttribute(
    "aria-label",
    "Current Space in this window",
  );
  await tree(saved.id)
    .getByRole("button", { name: `Settings for ${saved.name}` })
    .click();
  await page.getByRole("button", { name: "View Space", exact: true }).click();
  await expect(tree(saved.id).locator(".space-row")).toHaveClass(/active/);
  await expect(tree(draft.id).locator(".space-row")).toHaveClass(/is-current/);
  await expect(tree(saved.id).locator(".current-space-badge")).toHaveCount(0);
  assert.equal(
    await tree(saved.id)
      .locator(".space-row")
      .evaluate((e) => getComputedStyle(e).borderTopColor),
    "rgba(0, 0, 0, 0)",
  );
  await page.getByRole("button", { name: "Back to Home", exact: true }).click();
  await expect(
    page.locator(`.home-card[data-space-id="${draft.id}"] .space-state-icon`),
  ).toHaveAttribute("data-space-state", "saved");
  await tree(saved.id).locator(".space-link").click();
  const collectionBadge = page.locator(
    `[data-collection-id="${collection.id}"] .collection-row .current-space-badge`,
  );
  await expect(collectionBadge).toBeVisible();
  await tree(draft.id)
    .getByRole("button", { name: "Settings for Saved project" })
    .click();
  await page.getByRole("button", { name: "View Space", exact: true }).click();
  await expect(collectionBadge).toBeVisible();
  await expect(tree(saved.id).locator(".current-space-badge")).toBeVisible();
  for (const theme of ["light", "dark"]) {
    const state = await rpc({ type: "view", recovery: false, force: false });
    await rpc({ type: "settings", value: { ...state.settings, theme } });
    await page.waitForFunction(
      (t) => document.documentElement.dataset.theme === t,
      theme,
    );
    await page.screenshot({
      animations: "disabled",
      path: resolve(root, `artifacts/space-icons-${theme}.png`),
    });
  }
  await page.setViewportSize({ width: 760, height: 900 });
  const sidebar = page.locator(".sidebar");
  assert(await sidebar.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
  const state = await rpc({ type: "view", recovery: false, force: false });
  assert.equal(state.entities.find((e) => e.id === draft.id).temporary, false);
  assert.equal(state.entities.find((e) => e.id === draft.id).color, "orange");
  assert.deepEqual(errors, []);
  console.log(
    "Passed: unsaved/saved SVGs, legacy saved glyph, actual Save transition across sidebar/header/Home, preserved identity/color, tick-only badge, active versus viewed distinction, collection badge, light/dark/narrow layout.",
  );
} finally {
  await context.close();
}
