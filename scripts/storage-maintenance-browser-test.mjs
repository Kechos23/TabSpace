import { resolve } from "node:path";
import assert from "node:assert/strict";
import { entity } from "../packages/domain/model.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const ext = resolve(root, "dist/core");
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/storage-maintenance-${Date.now()}`),
  {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  },
);
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(worker.url().replace("worker.js", "index.html"));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const rpc = (m) =>
    page.evaluate(async (m) => {
      const r = await chrome.runtime.sendMessage(m);
      if (!r.ok) throw Error(r.error);
      return r.value;
    }, m);
  const insert = (ids) =>
    page.evaluate(async (ids) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("TabSpace-v1");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction("attachments", "readwrite");
          for (const id of ids)
            tx.objectStore("attachments").put({
              id,
              filename: "unused.txt",
              mediaType: "text/plain",
              size: 4,
              hash: "fixture",
              blob: new Blob(["test"]),
              createdAt: new Date().toISOString(),
            });
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    }, ids);
  const kept = crypto.randomUUID(),
    removed = crypto.randomUUID(),
    later = crypto.randomUUID();
  await insert([kept, removed]);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByText("2 files · 8 B · 2 unused (8 B)", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clean unused files", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Clean unused files" });
  await expect(dialog).toContainText("2 unused files (8 B)");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await rpc({ type: "storageInfo" })).fileCount, 2);
  await page
    .getByRole("button", { name: "Clean unused files", exact: true })
    .click();
  const view = await rpc({ type: "view", force: false, recovery: false });
  await rpc({
    type: "command",
    command: {
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "create",
      entity: entity("resource", "Attached during confirmation", {
        spaceId: view.inboxId,
        attachmentIds: [kept],
      }),
    },
  });
  await insert([later]);
  await dialog
    .getByRole("button", { name: "Delete unused files", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const result = await rpc({ type: "storageInfo" });
  assert.equal(result.fileCount, 2);
  assert.deepEqual(result.unusedIds, [later]);
  assert(!result.unusedIds.includes(removed));
  assert.deepEqual(errors, []);
  console.log(
    "PASS Settings file preview/cancel/confirmation, worker cleanup, concurrent attachment protection and preview boundary",
  );
} finally {
  await context.close();
}
