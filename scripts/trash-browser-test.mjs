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
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/trash-profile-${Date.now()}`),
  {
    channel: "chromium",
    headless: true,
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
  const api = async (message) => {
    const response = await page.evaluate(
      (m) => chrome.runtime.sendMessage(m),
      message,
    );
    assert(response?.ok, response?.error || JSON.stringify(response));
    return response.value;
  };
  const command = (args) =>
    api({
      type: "command",
      command: { schemaVersion: 1, commandId: crypto.randomUUID(), ...args },
    });
  const load = () => api({ type: "load" });
  const create = async (kind, name, props = {}) => {
    const now = new Date().toISOString();
    return (
      await command({
        type: "create",
        entity: {
          id: crypto.randomUUID(),
          kind,
          name,
          revision: 1,
          order: 0,
          createdAt: now,
          updatedAt: now,
          ...props,
        },
      })
    )[0];
  };
  const parent = await create("space", "Trashed project");
  await create("resource", "Child website", {
    spaceId: parent.id,
    url: "https://trash.test/child",
  });
  const separate = await create("task", "Separate task", {
    spaceId: (await load()).inboxId,
  });
  await create("space", "Keep archived", {
    archivedAt: new Date().toISOString(),
  });
  for (const item of [parent, separate])
    await command({
      type: "trash",
      id: item.id,
      expectedRevision: item.revision,
    });
  const before = await load();
  assert.equal(before.entities.filter((e) => e.deletedAt).length, 3);
  await page.getByRole("button", { name: "Refresh browser state" }).click();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await page.getByRole("button", { name: "Empty Trash", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Empty Trash permanently?" })
    .waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual((await load()).entities, before.entities);
  await page.screenshot({
    animations: "disabled",
    path: resolve(root, "docs/screenshots/trash-actions.png"),
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
    path: resolve(root, "docs/screenshots/trash-actions-dark.png"),
  });
  passed("Empty Trash asks for confirmation; Cancel preserves all content");
  await page.getByRole("button", { name: "Empty Trash", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await page.getByText("Trash is empty.", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Remove permanently", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Empty Trash", exact: true })
      .isDisabled(),
    true,
  );
  const retained = before.entities.filter((e) => !e.deletedAt);
  assert.deepEqual((await load()).entities, retained);
  passed(
    "Confirm removes all trashed types and descendants, preserves live/archive content and disables the empty action",
  );
  await page.reload();
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await page.getByText("Trash is empty.", { exact: true }).waitFor();
  assert.deepEqual((await load()).entities, retained);
  assert.deepEqual(errors, []);
  passed("Empty Trash persists after manager reload without page errors");
  await writeFile(
    resolve(root, "docs/VALIDATION_TRASH.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        browser: context.browser()?.version(),
        extension,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
}
