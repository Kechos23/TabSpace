import { resolve } from "node:path";
import assert from "node:assert/strict";
import { entity, defaults } from "../packages/domain/model.ts";
import { APP_VERSION } from "../packages/domain/version.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const ext = resolve(root, "dist/core");
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/import-coordination-${Date.now()}`),
  {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  },
);
try {
  await context.route("https://import.test/**", (r) =>
    r.fulfill({
      body: "<title>Import fixture</title>",
      contentType: "text/html",
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
  const rpc = (m) =>
    page.evaluate(async (m) => {
      const r = await chrome.runtime.sendMessage(m);
      if (!r.ok) throw Error(r.error);
      return r.value;
    }, m);
  const view = () => rpc({ type: "view", force: false, recovery: false });
  const inbox = entity("space", "Imported Inbox");
  const saved = entity("space", "Imported project");
  const fixture = Buffer.from(
    JSON.stringify({
      app: "TabSpace",
      appVersion: APP_VERSION,
      schemaVersion: 1,
      exportId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      inboxId: inbox.id,
      entities: [inbox, saved],
      attachments: [],
      settings: defaults,
      snapshots: [],
      drafts: [],
      revisions: [],
      sessions: [],
    }),
  );
  const preview = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByLabel("Import backup file")
      .setInputFiles({
        name: "backup.json",
        mimeType: "application/json",
        buffer: fixture,
      });
    await page.getByRole("dialog", { name: "Review backup import" }).waitFor();
  };
  await preview();
  await page
    .getByRole("button", { name: "Replace after backup", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect.poll(async () => (await view()).inboxId).toBe(inbox.id);
  const after = await view();
  assert(after.browser && Array.isArray(after.spaceTabs[saved.id]));
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.equal(after.browsingUnresolved.length, 0);
  console.log(
    "PASS real UI Replace returns a usable projection immediately and clears old restore identities",
  );

  const target = entity("space", "Queue target");
  const tab = entity("savedTab", "Blocked incoming tab", {
    spaceId: target.id,
    url: "https://import.test/blocked",
  });
  for (const row of [target, tab])
    await rpc({
      type: "command",
      command: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: row,
      },
    });
  const windowId = await page.evaluate(
    async () => (await chrome.tabs.getCurrent()).windowId,
  );
  await worker.evaluate(() => {
    const original = chrome.tabs.create.bind(chrome.tabs);
    globalThis.__importGate = {};
    chrome.tabs.create = async (options) => {
      if (options.url === "https://import.test/blocked") {
        globalThis.__importGate.entered = true;
        await new Promise((resolve) => {
          globalThis.__importGate.release = resolve;
        });
      }
      return original(options);
    };
  });
  // Preview before blocking the worker's browser queue, just as an already-open
  // import confirmation in another view can coexist with a pending switch.
  await preview();
  const activating = rpc({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "activateSession",
    payload: { spaceId: target.id, windowId },
  });
  await expect
    .poll(() => worker.evaluate(() => !!globalThis.__importGate.entered))
    .toBe(true);
  await page
    .getByRole("button", { name: "Merge as new records", exact: true })
    .click();
  await expect
    .poll(() =>
      worker.evaluate(
        () =>
          new Promise((resolve) => {
            const req = indexedDB.open("TabSpace-v1");
            req.onsuccess = () => {
              const db = req.result;
              const q = db.transaction("meta").objectStore("meta").getAllKeys();
              q.onsuccess = () => {
                db.close();
                resolve(q.result.some((k) => k.startsWith("pending-import:")));
              };
            };
          }),
      ),
    )
    .toBe(true);
  assert.equal(
    await worker.evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open("TabSpace-v1");
          req.onsuccess = () => {
            const db = req.result;
            const q = db
              .transaction("entities")
              .objectStore("entities")
              .getAll();
            q.onsuccess = () => {
              db.close();
              resolve(
                q.result.filter((e) => e.name === "Imported project").length,
              );
            };
          };
        }),
    ),
    1,
  );
  await worker.evaluate(() => globalThis.__importGate.release());
  await activating;
  await expect
    .poll(
      async () =>
        (await view()).entities.filter((e) => e.name === "Imported project")
          .length,
    )
    .toBe(2);
  assert.equal((await view()).sessionInterrupted, false);
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS import waits for an in-flight Space switch; merge keeps live browsing and publishes both independent copies",
  );
} finally {
  await context.close();
}
