import { resolve } from "node:path";
import assert from "node:assert/strict";
import { entity } from "../packages/domain/model.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/space-details-${Date.now()}`),
  {
    channel: "chromium",
    headless: true,
    viewport: { width: 1360, height: 1000 },
    args: [
      `--disable-extensions-except=${resolve(root, "dist/core")}`,
      `--load-extension=${resolve(root, "dist/core")}`,
    ],
  },
);
try {
  await context.route("https://details.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Details fixture</title>",
    }),
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const base = worker.url().replace("worker.js", "");
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "index.html");
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const rpc = (message) =>
    page.evaluate(async (message) => {
      const r = await chrome.runtime.sendMessage(message);
      if (!r.ok) throw Error(r.error);
      return r.value;
    }, message);
  const create = (record) =>
    rpc({
      type: "command",
      command: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: record,
      },
    });
  const load = () => rpc({ type: "load" });
  const collection = entity("sidebar", "Test collection");
  await create(collection);
  const windowId = await page.evaluate(async () => {
    const tab = await chrome.tabs.getCurrent();
    for (let i = 0; i < 2; i++)
      await chrome.tabs.create({
        windowId: tab.windowId,
        url: `https://details.test/${i}`,
        active: false,
      });
    return tab.windowId;
  });
  await expect
    .poll(() =>
      page.evaluate(
        async (windowId) =>
          (await chrome.tabs.query({ windowId })).filter((tab) =>
            tab.url?.startsWith("https://details.test/"),
          ).length,
        windowId,
      ),
    )
    .toBe(2);
  await rpc({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "checkpoint",
    payload: {},
  });
  const initial = await load(),
    binding = initial.sessions.find(
      (session) => session.windowId === windowId && !session.parked,
    );
  let draft = initial.entities.find((item) => item.id === binding.spaceId);
  [draft] = await rpc({
    type: "command",
    command: {
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "update",
      id: draft.id,
      expectedRevision: draft.revision,
      patch: { name: "Draft details" },
    },
  });
  await page.reload();
  await page.locator(".app").waitFor();
  const openActions = async (name) => {
    await page
      .getByRole("button", { name: `Settings for ${name}`, exact: true })
      .click();
  };
  const color = async (name) => {
    await page
      .getByRole("button", { name: "Space color", exact: true })
      .click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  };
  let dialog = page.getByRole("dialog");
  await openActions(draft.name);
  await dialog.getByRole("button", { name: "Save Space", exact: true }).click();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
    draft.name,
  );
  await dialog.getByLabel("Name", { exact: true }).fill("Saved details");
  await color("Purple");
  await dialog
    .getByLabel("Collection", { exact: true })
    .selectOption(collection.id);
  await dialog.getByLabel("Lock current tabs in Space").check();
  await dialog.getByRole("button", { name: "Save Space", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  let stored = await load(),
    saved = stored.entities.find((e) => e.id === draft.id);
  assert(!saved.temporary);
  assert.equal(saved.color, "purple");
  assert.equal(saved.sidebarId, collection.id);
  assert.equal(
    stored.spaceTabs[saved.id].filter((tab) => tab.lockId).length,
    2,
  );
  await openActions(saved.name);
  await dialog
    .getByRole("button", { name: "Edit details", exact: true })
    .click();
  await expect(dialog.getByLabel("Lock current tabs in Space")).toBeChecked();
  await expect(dialog.getByLabel("Collection", { exact: true })).toHaveValue(
    collection.id,
  );
  await color("Orange");
  await dialog.getByLabel("Collection", { exact: true }).selectOption("");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  stored = await load();
  saved = stored.entities.find((e) => e.id === draft.id);
  assert.equal(saved.color, "orange");
  assert.equal(saved.sidebarId, undefined);
  assert.equal(
    stored.spaceTabs[saved.id].filter((tab) => tab.lockId).length,
    2,
  );
  await rpc({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "setTabLock",
    payload: {
      spaceId: saved.id,
      ids: [
        stored.browser.tabs.find(
          (tab) => tab.spaceId === saved.id && !tab.pinned,
        ).id,
      ],
      locked: false,
    },
  });
  await page.reload();
  await page.locator(".app").waitFor();
  await openActions(saved.name);
  await dialog
    .getByRole("button", { name: "Edit details", exact: true })
    .click();
  await expect
    .poll(() =>
      dialog
        .getByLabel("Lock current tabs in Space")
        .evaluate((input) => input.indeterminate),
    )
    .toBe(true);
  await dialog.getByLabel("Name", { exact: true }).fill("Renamed details");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  stored = await load();
  assert.equal(
    stored.entities.filter(
      (e) =>
        e.kind === "savedTab" &&
        e.spaceId === saved.id &&
        !e.deletedAt &&
        e.locked,
    ).length,
    1,
  );
  await openActions("Renamed details");
  await dialog
    .getByRole("button", { name: "Edit details", exact: true })
    .click();
  const lock = dialog.getByLabel("Lock current tabs in Space");
  await lock.check();
  await lock.uncheck();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  stored = await load();
  assert.equal(
    stored.entities.filter(
      (e) =>
        e.kind === "savedTab" &&
        e.spaceId === saved.id &&
        !e.deletedAt &&
        e.locked,
    ).length,
    0,
  );
  await page.getByRole("button", { name: "New Space", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Created details");
  await color("Cyan");
  await dialog
    .getByLabel("Collection", { exact: true })
    .selectOption(collection.id);
  await dialog
    .getByRole("button", { name: "Create Space", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  stored = await load();
  const created = stored.entities.find(
    (e) => e.kind === "space" && e.name === "Created details",
  );
  assert.equal(created.color, "cyan");
  assert.equal(created.sidebarId, collection.id);
  await expect(page.locator(".sidebar-workspace-separator")).toBeVisible();
  const layout = await page.evaluate(() => {
    const heading = document.querySelector(".sidebar-heading"),
      plus = heading.querySelector("button"),
      menu = document.querySelector(".space-menu");
    return {
      font: parseFloat(getComputedStyle(heading).fontSize),
      plus: plus.getBoundingClientRect().right,
      menu: menu.getBoundingClientRect().right,
    };
  });
  assert(layout.font >= 11);
  assert(Math.abs(layout.plus - layout.menu) <= 6, JSON.stringify(layout));
  await page.screenshot({
    path: resolve(root, "artifacts/space-details-sidebar-0.17.12.png"),
  });
  await openActions(created.name);
  await dialog
    .getByRole("button", { name: "Edit details", exact: true })
    .click();
  await page.getByRole("button", { name: "Space color", exact: true }).click();
  await page.screenshot({
    path: resolve(root, "artifacts/space-details-edit-0.17.12.png"),
  });
  assert.deepEqual(errors, []);
  console.log(
    "Passed: shared Save/Edit/Create fields, all-color picker, collection persistence, locked and mixed-lock preservation, explicit mass unlock, sidebar separator/headings/alignment.",
  );
} finally {
  await context.close();
}
