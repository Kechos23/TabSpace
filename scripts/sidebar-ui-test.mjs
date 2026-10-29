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
  resolve(root, `artifacts/sidebar-profile-${Date.now()}`),
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
const passed = [];
try {
  await context.route("https://sidebar.test/**", (route) =>
    route.fulfill({
      body: "<title>Sidebar fixture tab</title><p>Local fixture</p>",
      contentType: "text/html",
    }),
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `chrome-extension://${worker.url().split("/")[2]}/index.html`,
  );
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const rpc = (message) =>
    page.evaluate(async (m) => {
      const r = await chrome.runtime.sendMessage(m);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    }, message);
  const initial = await rpc({ type: "view", recovery: false, force: false });
  const group = entity("sidebar", "Projects");
  const alpha = entity("space", "Alpha space");
  const beta = entity("space", "Collection space", { sidebarId: group.id });
  for (const row of [group, alpha, beta])
    await rpc({
      type: "command",
      command: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: row,
      },
    });
  const row = (id) =>
    page.locator(`[data-space-id="${id}"] .space-row`).first();
  await row(alpha.id).waitFor();
  const footer = page.getByRole("navigation", {
    name: "Library and settings",
    exact: true,
  });
  await footer.getByText("Designed by kechos", { exact: true }).waitFor();
  const archive = footer.getByRole("button", { name: "Archive", exact: true });
  const trash = footer.getByRole("button", { name: "Trash", exact: true });
  assert.notEqual(
    await archive.locator("svg path").first().getAttribute("d"),
    await trash.locator("svg path").first().getAttribute("d"),
  );
  assert(
    await footer.evaluate(
      (e) => parseFloat(getComputedStyle(e).borderTopWidth) > 0,
    ),
  );
  assert.notEqual(
    await footer.evaluate((e) => getComputedStyle(e).backgroundColor),
    await page
      .locator(".sidebar")
      .evaluate((e) => getComputedStyle(e).backgroundColor),
  );
  passed.push(
    "Archive/Trash have distinct SVG icons; the utility area has its own divider and background",
  );
  const unmanaged = await context.newPage();
  await unmanaged.goto("https://sidebar.test/unmanaged");
  await rpc({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "activateSession",
    payload: { spaceId: alpha.id, windowId: initial.currentWindowId },
  });
  await expect(row(alpha.id)).toHaveClass(/active/);
  await expect(row(alpha.id).locator(".space-link")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await footer.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await expect(row(alpha.id)).toHaveClass(/active/);
  await expect(row(alpha.id)).toHaveAttribute("data-current", "true");
  passed.push(
    "The current window's Space remains highlighted in Home and Settings",
  );
  const section = page.locator(".sidebar-section:not(.collection)").first();
  const background = (locator) =>
    locator.evaluate((e) => getComputedStyle(e).backgroundColor);
  await page.mouse.move(1200, 50);
  const sectionBackground = await background(section),
    before = await background(row(beta.id));
  await row(beta.id).hover();
  await expect.poll(() => background(row(beta.id))).not.toBe(before);
  assert.equal(await background(section), sectionBackground);
  assert.equal(
    await row(beta.id).evaluate((e) => getComputedStyle(e).borderTopColor),
    "rgba(0, 0, 0, 0)",
  );
  const home = page.locator(".sidebar .home-link");
  await home.hover();
  assert.equal(
    await home.evaluate((e) => getComputedStyle(e).borderTopColor),
    "rgba(0, 0, 0, 0)",
  );
  assert.notEqual(
    await row(alpha.id).evaluate((e) => getComputedStyle(e).borderTopColor),
    "rgba(0, 0, 0, 0)",
  );
  const collection = page.locator(
    `[data-collection-id="${group.id}"] .collection-row`,
  );
  const collectionBefore = await background(collection);
  await collection.hover();
  await expect.poll(() => background(collection)).not.toBe(collectionBefore);
  const website = await context.newPage();
  await website.goto("https://sidebar.test/managed");
  const tab = page
    .locator(`[data-space-id="${alpha.id}"] .space-tabs button`)
    .filter({ hasText: "Sidebar fixture tab" })
    .first();
  await tab.waitFor();
  await page.mouse.move(1200, 50);
  const tabBefore = await background(tab);
  await tab.hover();
  await expect.poll(() => background(tab)).not.toBe(tabBefore);
  passed.push(
    "Hover stays subtle and borderless while the active Space retains its outline",
  );
  const current = await rpc({ type: "view", recovery: false, force: false });
  const temporary = current.entities.find(
    (e) => e.kind === "space" && e.temporary,
  );
  assert(temporary);
  await row(temporary.id).locator(".space-link").click();
  await expect(row(temporary.id)).toHaveClass(/active/);
  await expect(row(temporary.id)).toHaveAttribute("data-current", "true");
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await expect(row(temporary.id)).toHaveClass(/active/);
  passed.push(
    "Temporary Spaces receive the same persistent current-Space highlight",
  );
  await row(beta.id).locator(".space-link").click();
  await expect(collection).toHaveClass(/contains-current/);
  await collection
    .getByRole("button", { name: "Collapse collection Projects", exact: true })
    .click();
  await expect(collection).toHaveClass(/contains-current/);
  await page.screenshot({
    path: resolve(root, "artifacts/sidebar-0.5.3-light.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Toggle light/dark theme", exact: true })
    .click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await page
    .locator(".save-status")
    .filter({ hasText: "Saved locally" })
    .waitFor();
  await page.screenshot({
    path: resolve(root, "artifacts/sidebar-0.5.3-dark.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 400, height: 900 });
  assert(await footer.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
  await page.screenshot({
    path: resolve(root, "artifacts/sidebar-0.5.3-narrow.png"),
    animations: "disabled",
  });
  const stored = await rpc({ type: "load" });
  assert(stored.entities.some((e) => e.id === alpha.id));
  assert(stored.entities.some((e) => e.id === beta.id));
  assert.deepEqual(errors, []);
  passed.push(
    "Collapsed Collections retain a current-Space indicator; light/dark/narrow layouts remain usable",
  );
  await writeFile(
    resolve(root, "docs/VALIDATION_SIDEBAR_UI.json"),
    JSON.stringify(
      { version: APP_VERSION, extension, passed, pageErrors: errors },
      null,
      2,
    ),
  );
  console.log(
    `Sidebar smoke check passed (${passed.length} focused scenarios)`,
  );
} finally {
  await context.close();
}
