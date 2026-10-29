import "./development-maintenance.mjs";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { APP_VERSION } from "../packages/domain/version.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const extension = resolve(
  process.env.TABSPACE_EXTENSION_DIR || resolve(root, "dist/core"),
);
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/recovery-profile-${Date.now()}`),
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
const results = [],
  metrics = {};
const passed = (name) => {
  results.push(name);
  console.log("PASS", name);
};
try {
  await context.route("https://recovery.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Recovered fixture</title><p>Offline fixture</p>",
    }),
  );
  await context.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    globalThis.__recoveryCalls = [];
    chrome.runtime.sendMessage = async (message, ...args) => {
      globalThis.__recoveryCalls.push({
        type: message.type,
        recovery: message.recovery,
        id: message.id,
      });
      if (message.type === "recoveryList" && globalThis.__recoveryDelay) {
        const delay = globalThis.__recoveryDelay;
        globalThis.__recoveryDelay = 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (message.type === "recoveryList" && globalThis.__rejectRecovery) {
        globalThis.__rejectRecovery = false;
        return { ok: false, error: "Synthetic recovery read failure" };
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
  const initial = await rpc({ type: "view", recovery: false, force: false });
  assert.equal(
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "Recovery", exact: false })
      .count(),
    0,
  );
  assert.equal(
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "Archive", exact: false })
      .count(),
    1,
  );
  passed(
    "Archive stays in the sidebar; Recovery is removed from everyday navigation",
  );
  const fixture = await page.evaluate(async (inboxId) => {
    const request = indexedDB.open("TabSpace-v1");
    const db = await new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const tabs = Array.from({ length: 400 }, (_, i) => ({
      url: `https://recovery.test/${i}`,
      title: `Recovery page ${i}`,
      pinned: false,
      muted: false,
      spaceId: inboxId,
      groupKey: "fixture",
      windowKey: "fixture-window",
    }));
    const groups = [
      {
        key: "fixture",
        title: "Recovery fixture",
        color: "blue",
        collapsed: false,
        spaceId: inboxId,
        windowKey: "fixture-window",
      },
    ];
    const snapshots = Array.from({ length: 300 }, (_, i) => ({
      id: crypto.randomUUID(),
      capturedAt: new Date(Date.now() - i * 1000).toISOString(),
      reason: `Recovery checkpoint ${i}`,
      protected: true,
      tabs,
      groups,
    }));
    const noteId = crypto.randomUUID();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["snapshots", "drafts"], "readwrite");
      tx.objectStore("snapshots").clear();
      tx.objectStore("drafts").clear();
      for (const snapshot of snapshots)
        tx.objectStore("snapshots").put(snapshot);
      for (let i = 0; i < 45; i++)
        tx.objectStore("drafts").put({
          id: `recovery-draft-${String(i).padStart(3, "0")}`,
          noteId,
          baseRevision: 1,
          doc: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: `Unsaved recovery draft ${i}` },
                ],
              },
            ],
          },
          text: `Unsaved recovery draft ${i}`,
          updatedAt: new Date().toISOString(),
        });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return {
      firstId: snapshots[0].id,
      lastId: snapshots.at(-1).id,
      snapshotCount: 300,
      draftCount: 45,
      fullHistoryBytes: new Blob([JSON.stringify(snapshots)]).size,
    };
  }, initial.inboxId);
  const listStarted = performance.now();
  const summaries = await rpc({
    type: "recoveryList",
    offset: 0,
    draftOffset: 0,
  });
  metrics.summaryMessageMs = +(performance.now() - listStarted).toFixed(2);
  metrics.fullHistoryBytes = fixture.fullHistoryBytes;
  metrics.summaryBytes = Buffer.byteLength(JSON.stringify(summaries));
  assert.equal(summaries.snapshots.length, 20);
  assert.equal(summaries.drafts.length, 20);
  assert.equal(summaries.snapshotCount, 300);
  assert.equal(summaries.draftCount, 45);
  assert(metrics.summaryBytes < 20000);
  assert(!JSON.stringify(summaries).includes("https://recovery.test"));
  assert(!("doc" in summaries.drafts[0]));
  passed(
    "300 checkpoints / 120,000 tab blueprints return only 20 small summaries and draft previews",
  );
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  const recovery = () =>
    page.getByRole("button", { name: "Open Recovery", exact: true }).click();
  const ready = () => page.locator(".recovery .snapshot").first().waitFor();
  await page.evaluate(() => {
    globalThis.__recoveryDelay = 1200;
    globalThis.__recoveryCalls = [];
  });
  let started = performance.now();
  await recovery();
  await page.getByRole("heading", { name: "Recovery", exact: true }).waitFor();
  metrics.delayedHeadingMs = +(performance.now() - started).toFixed(2);
  assert(metrics.delayedHeadingMs < 1000);
  await page
    .getByRole("status")
    .filter({ hasText: "Loading recovery summaries" })
    .waitFor();
  await page
    .getByRole("button", { name: "Back to Settings", exact: false })
    .click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  passed(
    "Recovery paints its loading state immediately; navigating away works during a delayed read",
  );
  started = performance.now();
  await recovery();
  await ready();
  metrics.readyMs = +(performance.now() - started).toFixed(2);
  assert.equal(await page.locator(".recovery .snapshot").count(), 20);
  assert.equal(await page.locator(".recovered-draft").count(), 20);
  assert(
    !(await page.evaluate(() => globalThis.__recoveryCalls)).some(
      (call) => call.type === "view" && call.recovery,
    ),
  );
  passed(
    "Opening Recovery uses its bounded endpoint without reloading the whole collection/history",
  );
  await page
    .getByRole("button", { name: "Next checkpoints", exact: true })
    .click();
  await ready();
  await page
    .getByRole("heading", { name: "Recovery checkpoint 20", exact: true })
    .waitFor();
  assert.equal(await page.locator(".snapshot").count(), 20);
  await page.getByRole("button", { name: "Next drafts", exact: true }).click();
  await ready();
  await page
    .locator(".recovered-draft")
    .first()
    .getByText("Unsaved recovery draft 20", { exact: true })
    .waitFor();
  passed("Checkpoint and draft pages advance independently with a bounded DOM");
  await page
    .locator(".snapshot")
    .first()
    .getByRole("button", { name: "Unprotect", exact: true })
    .click();
  await page
    .locator(".snapshot")
    .first()
    .getByRole("button", { name: "Protect", exact: true })
    .waitFor();
  assert.equal(
    (await rpc({ type: "recoverySnapshot", id: summaries.snapshots[0].id }))
      .tabs.length,
    400,
  );
  passed("Changing checkpoint protection preserves its complete tab blueprint");
  await page
    .getByRole("button", { name: "Previous checkpoints", exact: true })
    .click();
  await ready();
  await page
    .getByRole("heading", { name: "Recovery checkpoint 0", exact: true })
    .waitFor();
  await page.evaluate(() => {
    globalThis.__recoveryCalls = [];
  });
  await page
    .locator(".snapshot")
    .first()
    .getByRole("button", { name: "Preview / restore", exact: true })
    .click();
  const modal = page.getByRole("dialog", {
    name: "Restore session additively",
    exact: true,
  });
  await modal.locator(".restore-tab").first().waitFor();
  assert.equal(await modal.locator(".restore-tab").count(), 50);
  const detailCalls = await page.evaluate(() =>
    globalThis.__recoveryCalls.filter(
      (call) => call.type === "recoverySnapshot",
    ),
  );
  assert.deepEqual(
    detailCalls.map((call) => call.id),
    [fixture.firstId],
  );
  await modal.getByRole("button", { name: "Next tabs", exact: true }).click();
  await modal
    .locator(".restore-tab")
    .first()
    .filter({ hasText: "Recovery page 50" })
    .waitFor();
  await modal
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await modal.locator(".restore-tab input").nth(2).check();
  await modal
    .getByRole("button", { name: "Restore in new window", exact: true })
    .click();
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  const restored = await worker.evaluate(async () =>
    (await chrome.tabs.query({})).filter((tab) =>
      tab.url?.startsWith("https://recovery.test/"),
    ),
  );
  assert.deepEqual(
    restored.map((tab) => tab.url),
    ["https://recovery.test/52"],
  );
  passed(
    "Preview loads one checkpoint, renders 50 rows and restores the correct selection across pages",
  );
  await ready();
  await page
    .locator(".recovered-draft")
    .first()
    .getByRole("button", { name: "Recover as separate item", exact: true })
    .click();
  await expect
    .poll(async () =>
      (
        await rpc({ type: "view", recovery: false, force: false })
      ).entities.some((row) => row.name === "Recovered draft"),
    )
    .toBe(true);
  const recovered = (
    await rpc({ type: "view", recovery: false, force: false })
  ).entities.find((row) => row.name === "Recovered draft");
  assert(recovered.text.includes("Unsaved recovery draft 20"));
  assert.equal(
    (await rpc({ type: "recoveryDraft", id: "recovery-draft-020" })).text,
    "Unsaved recovery draft 20",
  );
  passed(
    "Recovering a draft fetches its full document on demand and preserves the original draft",
  );
  await page
    .getByRole("button", { name: "Back to Settings", exact: false })
    .click();
  await page.evaluate(() => {
    globalThis.__rejectRecovery = true;
  });
  await recovery();
  await page
    .getByRole("alert")
    .filter({ hasText: "Synthetic recovery read failure" })
    .waitFor();
  await page
    .getByRole("button", { name: "Retry recovery", exact: true })
    .click();
  await ready();
  passed(
    "A failed recovery read shows an error and can be retried without blocking navigation",
  );
  const vanishing = (
    await rpc({ type: "recoveryList", offset: 0, draftOffset: 0 })
  ).snapshots[0];
  await page.evaluate(async (id) => {
    const request = indexedDB.open("TabSpace-v1");
    const db = await new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise((resolve) => {
      const tx = db.transaction("snapshots", "readwrite");
      tx.objectStore("snapshots").delete(id);
      tx.oncomplete = resolve;
    });
    db.close();
  }, vanishing.id);
  await page
    .locator(".snapshot")
    .first()
    .getByRole("button", { name: "Preview / restore", exact: true })
    .click();
  await modal
    .getByRole("alert")
    .filter({ hasText: "no longer available" })
    .waitFor();
  assert(
    await modal
      .getByRole("button", { name: "Restore in new window", exact: true })
      .isDisabled(),
  );
  await modal
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  passed(
    "A checkpoint removed after listing shows an error with restore disabled",
  );
  await page
    .getByRole("button", { name: "Back to Settings", exact: false })
    .click();
  await page.evaluate(async () => {
    const request = indexedDB.open("TabSpace-v1");
    const db = await new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise((resolve) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put({
        id: "quarantine:fixture",
        value: { reason: "Test preserved record" },
      });
      tx.oncomplete = resolve;
    });
    db.close();
  });
  await page
    .getByRole("button", { name: "Refresh", exact: false })
    .filter({ hasText: "↻" })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "invalid local records" })
    .waitFor();
  await page
    .getByRole("alert")
    .filter({ hasText: "invalid local records" })
    .getByRole("button", { name: "Open Recovery", exact: true })
    .click();
  await ready();
  await page
    .getByRole("button", {
      name: "Export preserved invalid records (sensitive)",
      exact: true,
    })
    .waitFor();
  passed(
    "A preserved-record problem exposes a direct Recovery shortcut outside Settings",
  );
  await page.screenshot({
    path: resolve(root, "artifacts/recovery-0.5.1.png"),
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
  await ready();
  await page.screenshot({
    path: resolve(root, "artifacts/recovery-0.5.1-dark.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 400, height: 900 });
  await page.getByRole("heading", { name: "Recovery", exact: true }).waitFor();
  assert(
    await page
      .locator(".recovery")
      .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  );
  await page.screenshot({
    path: resolve(root, "artifacts/recovery-0.5.1-narrow.png"),
    animations: "disabled",
  });
  passed(
    "Recovery renders in light/dark and at 400px without horizontal content overflow",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(root, "docs/VALIDATION_RECOVERY.json"),
    JSON.stringify(
      {
        version: APP_VERSION,
        extension,
        browser: context.browser()?.version(),
        fixture,
        metrics,
        passed: results,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log("Recovery metrics", JSON.stringify(metrics));
} finally {
  await context.close();
}
