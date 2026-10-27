import { resolve } from "node:path";
import assert from "node:assert/strict";
import { entity } from "../packages/domain/model.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const extension = resolve(root, "dist/core");
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/sidepanel-profile-${Date.now()}`),
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
  await context.route("https://panel.test/**", (route) =>
    route.fulfill({
      body: "<title>Panel fixture</title>",
      contentType: "text/html",
    }),
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const base = `chrome-extension://${worker.url().split("/")[2]}/`;
  const manager = await context.newPage();
  await manager.goto(`${base}index.html`);
  await manager.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const rpc = (m) =>
    manager.evaluate(async (message) => {
      const reply = await chrome.runtime.sendMessage(message);
      if (!reply.ok) throw Error(reply.error);
      return reply.value;
    }, m);
  const load = () => rpc({ type: "view", recovery: false, force: false });
  const initial = await load();
  const collection = entity("sidebar", "Projects");
  const alpha = entity("space", "Active project", { view: "resources" });
  const activeTab = entity("savedTab", "Active panel tab", {
    spaceId: alpha.id,
    url: "https://panel.test/active",
  });
  const beta = entity("space", "Research project", {
    view: "notes",
    rightView: "tasks",
    split: true,
    sidebarId: collection.id,
  });
  const savedTab = entity("savedTab", "Saved panel tab", {
    spaceId: beta.id,
    url: "https://panel.test/saved",
  });
  const resource = entity("resource", "Useful reference", {
    spaceId: beta.id,
    url: "https://panel.test/reference",
  });
  const task = entity("task", "Review findings", { spaceId: beta.id });
  const note = entity("note", "Research notes", { spaceId: beta.id });
  for (const row of [
    collection,
    alpha,
    activeTab,
    beta,
    savedTab,
    resource,
    task,
    note,
  ])
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
    type: "browser",
    action: "activateSession",
    commandId: crypto.randomUUID(),
    payload: { spaceId: alpha.id, windowId: initial.currentWindowId },
  });
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 380, height: 900 });
  const errors = [];
  panel.on("pageerror", (e) => errors.push(e.message));
  await panel.goto(`${base}sidepanel.html`);
  const tree = (id) => panel.locator(`[data-space-id="${id}"]`).first();
  await expect(panel.locator(".app")).toHaveClass(/panel-tree/);
  await expect(tree(alpha.id)).toBeVisible();
  await expect(panel.locator("#main")).toHaveCount(0);
  await expect(
    panel.getByRole("separator", { name: "Sidebar width" }),
  ).toHaveCount(0);
  assert(
    await panel
      .locator(".sidebar")
      .evaluate((e) => e.getBoundingClientRect().width >= 370),
  );
  await expect(
    panel.getByRole("button", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  await tree(beta.id)
    .getByRole("button", { name: `Tabs in ${beta.name}`, exact: true })
    .click();
  await expect(
    tree(beta.id)
      .getByRole("button", { name: /Saved panel tab/ })
      .first(),
  ).toBeVisible();
  const before = await load();
  assert(
    before.browser.tabs.some(
      (t) => t.url === "https://panel.test/active" && t.spaceId === alpha.id,
    ),
  );
  await tree(beta.id)
    .getByRole("button", { name: `View Space ${beta.name}`, exact: true })
    .click();
  await expect(panel.locator(".app")).toHaveClass(/panel-detail/);
  await expect(panel.locator(".sidebar")).toBeHidden();
  await expect(
    panel.getByRole("heading", { name: beta.name, exact: true }),
  ).toBeVisible();
  await expect(panel.locator(".pane")).toHaveCount(1);
  await expect(
    panel.getByRole("button", { name: "Split view", exact: true }),
  ).toHaveCount(0);
  assert.deepEqual(
    // Extension/blank fixture pages may finish reconciling asynchronously. The
    // read-only navigation contract concerns the actual owned website tabs.
    (await load()).browser.tabs
      .filter((t) => /^https?:/.test(t.url))
      .map((t) => [t.id, t.spaceId]),
    before.browser.tabs
      .filter((t) => /^https?:/.test(t.url))
      .map((t) => [t.id, t.spaceId]),
  );
  const viewNav = panel.getByRole("navigation", { name: "Space views" });
  await viewNav.getByRole("button", { name: "Resources", exact: true }).click();
  await expect(
    panel.getByText("Useful reference", { exact: true }),
  ).toBeVisible();
  await viewNav.getByRole("button", { name: "Notes" }).click();
  await expect(panel.getByPlaceholder("Title", { exact: true })).toHaveCount(1);
  await viewNav.getByRole("button", { name: "Tasks" }).click();
  await expect(
    panel.getByRole("textbox", {
      name: "Task title: Review findings",
      exact: true,
    }),
  ).toBeVisible();
  const unchanged = (await load()).entities.find((e) => e.id === beta.id);
  assert.equal(unchanged.view, "notes");
  assert.equal(unchanged.split, true);
  assert.equal(unchanged.rightView, "tasks");
  for (const width of [320, 380, 500]) {
    await panel.setViewportSize({ width, height: 900 });
    for (const name of ["Tabs", "Resources", "Notes", "Tasks"]) {
      await viewNav.getByRole("button", { name: new RegExp(name) }).click();
      assert(
        await panel.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `${name} overflows at ${width}`,
      );
      assert(
        await panel
          .locator("#main")
          .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
        `${name} main overflows at ${width}`,
      );
    }
  }
  await panel.setViewportSize({ width: 380, height: 900 });
  await panel
    .locator(".panel-toolbar")
    .getByRole("button", { name: "Spaces", exact: true })
    .click();
  await expect(panel.locator("#main")).toHaveCount(0);
  await expect(
    tree(beta.id)
      .getByRole("button", { name: /Saved panel tab/ })
      .first(),
  ).toBeVisible();
  // Clicking the Space name keeps the existing activation behavior, independently of View Space.
  await tree(beta.id).locator(".space-link").click();
  await expect(tree(beta.id).locator(".space-row")).toHaveAttribute(
    "data-current",
    "true",
  );
  await expect(panel.locator(".app")).toHaveClass(/panel-tree/);
  await expect(
    tree(beta.id)
      .locator('.space-tabs button[title*="https://panel.test/saved"]')
      .first(),
  ).toBeVisible();
  await panel.screenshot({
    path: resolve(root, "artifacts/sidepanel-tree.png"),
    animations: "disabled",
  });
  await tree(beta.id)
    .getByRole("button", { name: `View Space ${beta.name}`, exact: true })
    .click();
  await viewNav.getByRole("button", { name: "Resources", exact: true }).click();
  await panel.screenshot({
    path: resolve(root, "artifacts/sidepanel-detail.png"),
    animations: "disabled",
  });
  const count = await manager.evaluate(
    async () =>
      (await chrome.tabs.query({})).filter((t) =>
        t.url?.includes("/index.html"),
      ).length,
  );
  await expect(
    panel
      .locator(".sidebar-footer")
      .getByRole("button", { name: "Open full manager", exact: true }),
  ).toHaveCount(0);
  await panel
    .getByRole("button", { name: "Open full manager", exact: true })
    .click();
  assert.equal(
    await manager.evaluate(
      async () =>
        (await chrome.tabs.query({})).filter((t) =>
          t.url?.includes("/index.html"),
        ).length,
    ),
    count,
  );
  await expect(manager.locator(".sidebar")).toBeVisible();
  await expect(manager.locator("#main")).toBeVisible();
  await expect(
    manager.getByRole("separator", { name: "Sidebar width" }),
  ).toBeVisible();
  await panel.reload();
  await expect(panel.locator(".app")).toHaveClass(/panel-tree/);
  assert.deepEqual(errors, []);
  console.log(
    "Passed: navigator default, full width, grouped tree reuse, read-only View Space, four local views, independent manager split/view, 320/380/500 widths, preserved tree expansion, Space activation, manager reuse, reload default, unchanged manager layout.",
  );
} finally {
  await context.close();
}
