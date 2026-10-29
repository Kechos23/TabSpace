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
  resolve(root, `artifacts/sidebar-drop-${Date.now()}`),
  {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1100 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  },
);
const results = [],
  errors = [];
try {
  await context.route("https://sidebar.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Sidebar fixture</title>Test",
    }),
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `chrome-extension://${worker.url().split("/")[2]}/index.html`,
  );
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const rpc = async (message) => {
    const response = await page.evaluate(
      (message) => chrome.runtime.sendMessage(message),
      message,
    );
    assert(response.ok, response.error);
    return response.value;
  };
  const load = () => rpc({ type: "load" });
  const read = async (id) =>
    (await load()).entities.find((item) => item.id === id);
  const create = (item) =>
    rpc({
      type: "command",
      command: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: item,
      },
    });
  const collection = entity("sidebar", "Projects"),
    saved = entity("space", "Saved root");
  await create(collection);
  await create(saved);
  const row = (id) =>
    page.locator(`.space-tree[data-space-id="${id}"] > .space-row`);
  const folder = page.locator(`[data-collection-id="${collection.id}"]`);
  const savedTarget = page.locator("[data-drop-saved]");
  const drop = async (id, target) => {
    const transfer = await page.evaluateHandle((id) => {
      const data = new DataTransfer();
      data.setData(
        "application/tabspace",
        JSON.stringify({ type: "entity", id }),
      );
      return data;
    }, id);
    await target.dispatchEvent("dragover", { dataTransfer: transfer });
    await target.dispatchEvent("drop", { dataTransfer: transfer });
    await transfer.dispose();
  };
  await expect(row(saved.id)).toBeVisible();
  await row(saved.id).dragTo(folder.locator(".collection-row"));
  await expect
    .poll(async () => (await read(saved.id)).sidebarId)
    .toBe(collection.id);
  await row(saved.id).dragTo(savedTarget);
  await expect
    .poll(async () => (await read(saved.id)).sidebarId)
    .toBeUndefined();
  results.push(
    "Saved Spaces move into a collection and back to the Saved heading without a collection",
  );
  const first = await worker.evaluate(() =>
    chrome.windows.create({
      url: "https://sidebar.test/first",
      focused: false,
    }),
  );
  await expect
    .poll(async () =>
      (await load()).sessions.some((item) => item.windowId === first.id),
    )
    .toBe(true);
  const unsavedId = (await load()).sessions.find(
    (item) => item.windowId === first.id,
  ).spaceId;
  await expect(row(unsavedId)).toBeVisible();
  assert(
    (await page.locator(".unsaved-heading").boundingBox()).y <
      (await savedTarget.boundingBox()).y,
  );
  await row(unsavedId).locator(".space-menu").click();
  const menu = page.getByRole("dialog");
  assert.equal(
    await menu.locator(".action-grid > button").first().innerText(),
    "Save Space",
  );
  await menu.getByRole("button", { name: "Save Space", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByLabel("Collection", { exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert((await read(unsavedId)).temporary);
  results.push(
    "Unsaved appears above Saved; Save Space is the first menu action; cancellation preserves the Unsaved",
  );
  await drop(unsavedId, folder);
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Collection", { exact: true })).toHaveValue(
    collection.id,
  );
  assert((await read(unsavedId)).temporary);
  assert.equal((await read(unsavedId)).sidebarId, undefined);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await drop(unsavedId, folder);
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Promoted project");
  await dialog.getByRole("button", { name: "Save Space", exact: true }).click();
  await expect.poll(async () => (await read(unsavedId)).temporary).toBe(false);
  assert.equal((await read(unsavedId)).sidebarId, collection.id);
  assert.equal((await read(unsavedId)).name, "Promoted project");
  results.push(
    "Dropping Unsaved onto a collection preselects that destination; only confirmation promotes the same Space ID",
  );
  const second = await worker.evaluate(() =>
    chrome.windows.create({
      url: "https://sidebar.test/second",
      focused: false,
    }),
  );
  await expect
    .poll(async () =>
      (await load()).sessions.some((item) => item.windowId === second.id),
    )
    .toBe(true);
  const secondId = (await load()).sessions.find(
    (item) => item.windowId === second.id,
  ).spaceId;
  await expect(row(secondId)).toBeVisible();
  // A child Space is also a destination, so the whole collection tree works.
  await drop(secondId, row(unsavedId));
  await expect(
    page.getByRole("dialog").getByLabel("Collection", { exact: true }),
  ).toHaveValue(collection.id);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await drop(secondId, savedTarget);
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Collection", { exact: true })).toHaveValue(
    "",
  );
  await dialog.getByLabel("Name", { exact: true }).fill("Independent saved");
  await dialog.getByRole("button", { name: "Save Space", exact: true }).click();
  await expect.poll(async () => (await read(secondId)).temporary).toBe(false);
  assert.equal((await read(secondId)).sidebarId, undefined);
  await drop(unsavedId, row(secondId));
  await expect
    .poll(async () => (await read(unsavedId)).sidebarId)
    .toBeUndefined();
  await page.reload();
  await expect(row(unsavedId)).toBeVisible();
  assert.equal((await read(unsavedId)).sidebarId, undefined);
  results.push(
    "Unsaved drops onto Saved or collection children use the correct preselected destination; saved-to-saved drops remove collection membership and persist after reload",
  );
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: resolve(root, "artifacts/sidebar-space-drop.png"),
    fullPage: true,
  });
  await writeFile(
    resolve(root, "docs/VALIDATION_SIDEBAR_DROP.json"),
    JSON.stringify(
      { version: APP_VERSION, extension, results, pageErrors: errors },
      null,
      2,
    ),
  );
  console.log(results.join("\n"));
} finally {
  await context.close();
}
