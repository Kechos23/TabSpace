import { resolve } from "node:path";
import assert from "node:assert/strict";
import { entity } from "../packages/domain/model.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const extension = resolve(root, "dist/core");
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/groups-profile-${Date.now()}`),
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
  await context.route("https://groups.test/**", (route) =>
    route.fulfill({
      body: "<title>Group fixture</title>",
      contentType: "text/html",
    }),
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const mouseBack = async () => {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 800,
      y: 80,
      button: "back",
      buttons: 8,
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 800,
      y: 80,
      button: "back",
      buttons: 0,
      clickCount: 1,
    });
  };
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
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
  const space = entity("space", "Grouped project", { view: "tabs" });
  const a = entity("group", "Research", { spaceId: space.id, color: "blue" });
  const b = entity("group", "Research", { spaceId: space.id, color: "red" });
  const unnamed = entity("group", " ", { spaceId: space.id, color: "green" });
  const tabs = [a, a, b, unnamed, undefined].map((g, i) =>
    entity("savedTab", `Fixture ${i}`, {
      spaceId: space.id,
      groupId: g?.id,
      url: `https://groups.test/${i}`,
      order: i,
    }),
  );
  for (const row of [space, a, b, unnamed, ...tabs])
    await rpc({
      type: "command",
      command: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: row,
      },
    });
  const tree = page.locator(`[data-space-id="${space.id}"]`).first();
  await tree
    .getByRole("button", { name: `Tabs in ${space.name}`, exact: true })
    .click();
  await tree
    .getByRole("button", { name: `Settings for ${space.name}` })
    .click();
  await page.getByRole("button", { name: "View Space", exact: true }).click();
  const groups = page.locator(".manager-tab-group");
  await expect(groups).toHaveCount(3);
  await expect(tree.locator(".sidebar-tab-group")).toHaveCount(3);
  await expect(groups.first().locator(".tab-row")).toHaveCount(2);
  await expect(groups.nth(2).locator(".tab-group-name")).toHaveText(
    "Unnamed group",
  );
  assert.notEqual(
    await groups.nth(0).getAttribute("style"),
    await groups.nth(1).getAttribute("style"),
  );
  await groups.first().locator(".tab-group-heading").click();
  await expect(groups.first().locator(".tab-group-children")).toBeHidden();
  await expect(
    tree.locator(".sidebar-tab-group").first().locator(".tab-group-children"),
  ).toBeVisible();
  await tree
    .locator(".sidebar-tab-group")
    .first()
    .locator(".tab-group-heading")
    .click();
  await expect(
    tree.locator(".sidebar-tab-group").first().locator(".tab-group-children"),
  ).toBeHidden();
  // A real browser Back mouse event, not an artificial DOM event.
  const before = await rpc({ type: "view", recovery: false, force: false });
  await mouseBack();
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const after = await rpc({ type: "view", recovery: false, force: false });
  assert.deepEqual(
    after.browser.tabs.map((t) => [t.id, t.url, t.spaceId]),
    before.browser.tabs.map((t) => [t.id, t.url, t.spaceId]),
  );
  // Direct Space URL must also provide a Home entry.
  await page.goto(
    `chrome-extension://${worker.url().split("/")[2]}/index.html?space=${space.id}`,
  );
  await expect(page.locator(".manager-tab-group")).toHaveCount(3);
  await mouseBack();
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await rpc({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "activateSession",
    payload: {
      spaceId: space.id,
      windowId: initial.currentWindowId,
    },
  });
  await tree
    .getByRole("button", { name: `Settings for ${space.name}` })
    .click();
  await page.getByRole("button", { name: "View Space", exact: true }).click();
  await expect(page.locator(".manager-tab-group")).toHaveCount(3);
  await expect(
    page.locator(".manager-tab-group .tab-row[data-tab-id]"),
  ).toHaveCount(4);
  await expect(tree.locator(".sidebar-tab-group")).toHaveCount(3);
  if (
    await page.evaluate(() => document.documentElement.dataset.theme !== "dark")
  ) {
    await page
      .getByRole("button", { name: "Toggle light/dark theme", exact: true })
      .click();
  }
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await page.screenshot({
    path: resolve(root, "artifacts/grouped-tabs-dark.png"),
  });
  await page
    .getByRole("button", { name: "Toggle light/dark theme", exact: true })
    .click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  await page.screenshot({
    path: resolve(root, "artifacts/grouped-tabs-light.png"),
  });
  assert.deepEqual(errors, []);
  console.log(
    "Passed: saved/live groups, duplicate names, unnamed group, independent collapse, mouse Back, direct URL Back, unchanged browser tabs, light/dark render.",
  );
} finally {
  await context.close();
}
