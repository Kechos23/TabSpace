import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { entity } from "../packages/domain/model.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const extension = resolve(
  process.env.TABSPACE_EXTENSION_DIR || resolve(root, "dist/core"),
);
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/performance-profile-${Date.now()}`),
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
  await context.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    globalThis.__calls = [];
    chrome.runtime.sendMessage = async (message, ...args) => {
      globalThis.__calls.push({
        type: message.type,
        command: message.command?.type,
      });
      if (message.type === "view" && globalThis.__viewDelay) {
        const delay = globalThis.__viewDelay;
        globalThis.__viewDelay = 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (message.command?.type === "presentation") {
        const delay = globalThis.__presentationDelay || 0;
        globalThis.__presentationDelay = 0;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (globalThis.__rejectPresentation) {
          globalThis.__rejectPresentation = false;
          return { ok: false, error: "Synthetic preference failure" };
        }
      }
      return send(message, ...args);
    };
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const base = `chrome-extension://${worker.url().split("/")[2]}`;
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/index.html`);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const rpc = (message) =>
    page.evaluate(async (message) => {
      const response = await chrome.runtime.sendMessage(message);
      if (!response.ok) throw new Error(response.error);
      return response.value;
    }, message);
  await rpc({ type: "load" });
  const fixture = entity("space", "Performance project", { view: "tabs" });
  await rpc({
    type: "command",
    command: {
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "create",
      entity: fixture,
    },
  });
  const id = fixture.id;
  await page.goto(`${base}/index.html?space=${id}`);
  await page
    .getByRole("heading", { name: fixture.name, exact: true, level: 1 })
    .waitFor();
  const select = (label) =>
    page
      .locator(".view-nav")
      .getByRole("button", { name: new RegExp(`${label}$`) })
      .click();
  const active = (label) =>
    page
      .locator(".view-nav button.active")
      .filter({ hasText: label })
      .waitFor();
  const saved = () =>
    page.locator(".save-status").filter({ hasText: "Saved locally" }).waitFor();
  const stored = () =>
    page.evaluate(async (id) => {
      const request = indexedDB.open("TabSpace-v1");
      const db = await new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
      const row = await new Promise((resolve) => {
        const request = db
          .transaction("entities")
          .objectStore("entities")
          .get(id);
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      return row;
    }, id);
  await select("Tabs");
  await saved();
  await page.evaluate(() => {
    globalThis.__presentationDelay = 1500;
    globalThis.__calls = [];
  });
  const start = performance.now();
  await select("Resources");
  await active("Resources");
  assert(
    performance.now() - start < 1000,
    "View must render before delayed persistence",
  );
  assert.equal((await stored()).view, "tabs");
  await saved();
  assert.equal((await stored()).view, "resources");
  passed("Category renders before delayed persistence and then saves durably");
  await page.evaluate(() => {
    globalThis.__presentationDelay = 1000;
    globalThis.__calls = [];
  });
  for (const label of ["Tasks", "Notes", "Tabs"]) {
    await select(label);
    await active(label);
  }
  await saved();
  assert.equal((await stored()).view, "tabs");
  const calls = await page.evaluate(() => globalThis.__calls);
  assert.equal(calls.filter((c) => c.command === "presentation").length, 3);
  assert.equal(
    calls.filter((c) => c.type === "load" || c.type === "view").length,
    0,
  );
  await page.reload();
  await active("Tabs");
  passed(
    "Rapid preferences retain the last choice after reload, with no full view loads",
  );
  await page.evaluate(() => {
    globalThis.__presentationDelay = 500;
    globalThis.__rejectPresentation = true;
  });
  await select("Resources");
  await active("Resources");
  await page
    .getByRole("alert")
    .filter({ hasText: "Synthetic preference failure" })
    .waitFor();
  await active("Tabs");
  assert.equal((await stored()).view, "tabs");
  passed(
    "A failed preference rolls back to confirmed state and shows its error",
  );
  const other = await context.newPage();
  other.on("pageerror", (error) => errors.push(error.message));
  await other.goto(`${base}/index.html?space=${id}`);
  await other
    .locator(".view-nav button.active")
    .filter({ hasText: "Tabs" })
    .waitFor();
  await select("Resources");
  await saved();
  await other
    .locator(".view-nav button.active")
    .filter({ hasText: "Resources" })
    .waitFor();
  passed("A second manager receives the confirmed preference delta");
  await page.evaluate(() => {
    globalThis.__calls = [];
    globalThis.__viewDelay = 700;
  });
  await other.evaluate(() => {
    for (let i = 0; i < 10; i++)
      void chrome.runtime
        .sendMessage({ type: "tabspace:changed" })
        .catch(() => {});
  });
  await page.waitForFunction(() =>
    globalThis.__calls.some((c) => c.type === "view"),
  );
  await other.evaluate(() => {
    for (let i = 0; i < 10; i++)
      void chrome.runtime
        .sendMessage({ type: "tabspace:changed" })
        .catch(() => {});
  });
  await page.waitForFunction(
    () => globalThis.__calls.filter((c) => c.type === "view").length === 2,
  );
  assert.equal(
    (await page.evaluate(() => globalThis.__calls)).filter(
      (c) => c.type === "view",
    ).length,
    2,
  );
  passed(
    "A burst of notifications coalesces into one read and one follow-up for changes received in flight",
  );
  await rpc({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "checkpoint",
    payload: {},
  });
  const light = await rpc({ type: "view", recovery: false, force: false });
  assert.equal(light.snapshots.length, 0);
  assert.equal(light.drafts.length, 0);
  assert(light.snapshotCount > 0);
  const history = await rpc({ type: "view", recovery: true, force: false });
  assert.equal(history.snapshots.length, history.snapshotCount);
  assert(history.recoveryLoaded);
  passed(
    "Normal reads omit history payloads; Recovery loads all checkpoints on demand",
  );
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open Recovery", exact: true })
    .click();
  await page.locator(".snapshot").first().waitFor();
  passed("Recovery UI requests and displays its deferred checkpoints");
  const latest = await rpc({ type: "view", recovery: false, force: false });
  const unchanged = await rpc({
    type: "view",
    recovery: false,
    force: false,
    knownVersion: latest.viewVersion,
  });
  assert.deepEqual(unchanged, { unchanged: true });
  passed(
    "An unchanged view returns a small acknowledgement instead of the collection",
  );
  await page.evaluate(async () => {
    const request = indexedDB.open("TabSpace-v1");
    const db = await new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise((resolve) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put({
        id: "collectionGeneration",
        value: crypto.randomUUID(),
      });
      tx.oncomplete = resolve;
    });
    db.close();
  });
  const imported = await rpc({
    type: "view",
    recovery: false,
    force: false,
    knownVersion: latest.viewVersion,
  });
  assert(imported.entities?.length);
  assert.notEqual(imported.viewVersion, latest.viewVersion);
  passed("Replacing collection generation invalidates the cached view");
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(root, "docs/VALIDATION_PERFORMANCE_BROWSER.json"),
    JSON.stringify({ extension, passed: results, pageErrors: errors }, null, 2),
  );
} finally {
  await context.close();
}
