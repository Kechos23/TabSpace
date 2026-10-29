import "./development-maintenance.mjs";
import { resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { APP_VERSION } from "../packages/domain/version.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const stamp = Date.now(),
  profile = resolve(root, `artifacts/test-profile-${stamp}`),
  shots = resolve(root, "docs/screenshots");
await mkdir(shots, { recursive: true });
const ext = process.env.TABSPACE_EXTENSION_DIR
  ? resolve(process.env.TABSPACE_EXTENSION_DIR)
  : resolve(root, "dist/core");
let context;
const results = [];
const record = (name, detail = "passed") => {
  results.push({ name, detail });
  console.log(`${name}: ${detail}`);
};
const launch = () =>
  chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
try {
  context = await launch();
  await context.route("https://example.org/**", (route) =>
    route.fulfill({
      body: "<!doctype html><title>Test website</title><p>Offline fixture content</p>",
      contentType: "text/html",
    }),
  );
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const id = worker.url().split("/")[2];
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error("Extension UI error:", e.stack);
  });
  await page.goto(`chrome-extension://${id}/index.html`);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  record(
    "MV3 worker and manager load",
    `Chromium ${context.browser()?.version() ?? "persistent"}; ${id}`,
  );
  const send = (message) =>
    page.evaluate((m) => chrome.runtime.sendMessage(m), message);
  await page
    .getByRole("button", { name: "New Space", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Deep Work");
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Description" })
    .fill("Links, decisions, and the next useful step.");
  await page.getByRole("button", { name: "Create Space", exact: true }).click();
  await page.getByRole("heading", { name: "Deep Work", exact: true }).waitFor();
  let state = (await send({ type: "load" })).value;
  const space = state.entities.find((e) => e.name === "Deep Work");
  assert(space);
  record("Space CRUD via UI");
  await page
    .getByRole("button", { name: "New Space", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Temporary investigation");
  await page
    .getByRole("dialog")
    .getByLabel("Browsing session")
    .selectOption("temporary");
  await page.getByRole("button", { name: "Create Space", exact: true }).click();
  await page
    .getByRole("heading", { name: "Temporary investigation", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "+ Open URL", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Website URL")
    .fill("https://example.org/temporary");
  await page.getByRole("button", { name: "Open tab", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("dialog"));
  state = (await send({ type: "load" })).value;
  const temporary = state.entities.find(
    (e) => e.name === "Temporary investigation",
  );
  assert(temporary.temporary);
  await page.waitForFunction(async () => {
    const result = await chrome.runtime.sendMessage({ type: "load" });
    return result.value?.browser.tabs.some(
      (t) => t.url === "https://example.org/temporary",
    );
  });
  state = (await send({ type: "load" })).value;
  const tempTab = state.browser.tabs.find(
    (t) => t.url === "https://example.org/temporary",
  );
  assert.equal(tempTab.spaceId, temporary.id);
  await page.getByRole("button", { name: "Save Space", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Saved investigation");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save Space", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Saved investigation", exact: true })
    .waitFor();
  state = (await send({ type: "load" })).value;
  assert(!state.entities.find((e) => e.id === temporary.id).temporary);
  assert(
    state.entities.some(
      (e) =>
        e.kind === "savedTab" &&
        e.spaceId === temporary.id &&
        e.url === tempTab.url,
    ),
  );
  await worker.evaluate(async (id) => chrome.tabs.remove(id), tempTab.id);
  await page
    .locator(".space-list")
    .locator(".sidebar-section .space-link")
    .filter({ hasText: "Deep Work" })
    .first()
    .click();
  record(
    "Temporary Space promotion preserves owned tabs and durable recovery records",
  );
  await page
    .getByRole("button", { name: "Add resource", exact: false })
    .click();
  await page.getByRole("menuitem", { name: "Add link", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Primary source");
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "URL", exact: true })
    .fill("https://example.org/reference?q=1#section");
  await page.getByRole("button", { name: "Save link", exact: true }).click();
  await page
    .getByRole("button", { name: "Primary source", exact: true })
    .waitFor();
  await page
    .getByLabel("Attach file to Primary source", { exact: true })
    .setInputFiles({
      name: "evidence.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Independent attachment — τεκμήριο"),
    });
  await page.getByRole("button", { name: /↓ evidence\.txt/ }).waitFor();
  record("User-picked attachment persisted as a local blob");
  await page.getByRole("button", { name: "✓ Tasks", exact: true }).click();
  const taskInput = page.getByRole("textbox", {
    name: "Add task to Tasks",
    exact: true,
  });
  await taskInput.fill("Check the evidence");
  await taskInput.press("Enter");
  await page
    .getByRole("button", {
      name: "Details for Check the evidence",
      exact: true,
    })
    .click();
  const taskEditor = page.getByRole("textbox", {
    name: "Check the evidence content",
    exact: true,
  });
  await taskEditor.fill("Structured task details — τεκμήριο.");
  await taskEditor.press("Control+a");
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".editor-status")].some((e) =>
      e.textContent.startsWith("Saved · revision"),
    ),
  );
  state = (await send({ type: "load" })).value;
  const richTask = state.entities.find((e) => e.name === "Check the evidence");
  assert(richTask.description.includes("τεκμήριο"));
  assert(JSON.stringify(richTask.doc).includes('"type":"bold"'));
  record("Rich task description commits to the canonical task record");
  await page.getByRole("button", { name: "▤ Notes", exact: true }).click();
  await page.getByRole("button", { name: "Add note", exact: false }).click();
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Decision log");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const editor = page.locator(".tiptap");
  await editor.waitFor();
  await editor.fill("A durable note — Σημειώσεις και αποφάσεις.");
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".editor-status")].some((e) =>
      e.textContent.startsWith("Saved · revision 2"),
    ),
  );
  state = (await send({ type: "load" })).value;
  assert(
    state.entities
      .find((e) => e.name === "Decision log")
      .text.includes("Σημειώσεις"),
  );
  record("Resources, tasks and acknowledged rich note save");
  await page.getByRole("button", { name: "+ Property", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Name (for a new definition)")
    .fill("Review date");
  await page
    .getByRole("dialog")
    .getByLabel("Type", { exact: true })
    .selectOption("date");
  await page
    .getByRole("dialog")
    .getByLabel("Initial value (date: YYYY-MM-DD)")
    .fill("2026-10-03");
  await page.getByRole("button", { name: "Add property", exact: true }).click();
  await page.locator(".property input[type=date]").waitFor();
  assert.equal(
    await page.locator(".property input[type=date]").inputValue(),
    "2026-10-03",
  );
  record("Reusable Date property renders as a real validated calendar field");
  const native = await worker.evaluate(async () => {
    // Auto-ownership is now intentional inside an activated window. Verify the
    // unmanaged boundary in a genuinely unmanaged, independent normal window.
    const window = await chrome.windows.create({
      url: "https://example.org/a",
      focused: false,
    });
    const a = window.tabs[0];
    const b = await chrome.tabs.create({
      url: "https://example.org/b",
      windowId: window.id,
      active: false,
    });
    const unmanaged = await chrome.tabs.group({
      tabIds: [a.id, b.id],
      createProperties: { windowId: window.id },
    });
    await chrome.tabGroups.update(unmanaged, {
      title: "Manual untouched",
      color: "green",
    });
    return { a: a.id, b: b.id, group: unmanaged };
  });
  state = (await send({ type: "load" })).value;
  assert(!state.browser.groups.find((g) => g.id === native.group).spaceId);
  assert.equal(
    state.browser.groups.find((g) => g.id === native.group).title,
    "Manual untouched",
  );
  record("Unmanaged real native groups preserved");
  const adoption = await send({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "adopt",
    payload: {
      ids: [native.a, native.b],
      spaceId: space.id,
      groupId: native.group,
    },
  });
  assert(adoption.ok, adoption.error);
  await worker.evaluate(
    async (group) =>
      chrome.tabGroups.update(group, {
        title: "Manually renamed",
        color: "purple",
      }),
    native.group,
  );
  state = (await send({ type: "load" })).value;
  assert.equal(
    state.browser.groups.find((g) => g.id === native.group).title,
    "Manually renamed",
  );
  assert.equal(
    state.entities.find(
      (e) =>
        e.id ===
        state.browser.groups.find((g) => g.id === native.group).logicalId,
    ).color,
    "purple",
  );
  record(
    "Explicit native adoption and real manual rename/color reconciliation",
  );
  const snap = await send({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "checkpoint",
    payload: {},
  });
  assert(snap.ok);
  await worker.evaluate(async (id) => chrome.tabs.remove(id), native.a);
  state = (await send({ type: "load" })).value;
  assert(
    state.snapshots.some((s) =>
      s.tabs.some((t) => t.url === "https://example.org/a"),
    ),
  );
  record("Tab close retains recoverable URL snapshot");
  const recoverySnapshot = state.snapshots.find(
    (s) =>
      s.reason === "Manual checkpoint" &&
      s.tabs.some((t) => t.url === "https://example.org/a"),
  );
  assert(recoverySnapshot);
  const recovered = await send({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "restoreSession",
    payload: {
      snapshotId: recoverySnapshot.id,
      indices: [
        recoverySnapshot.tabs.findIndex(
          (t) => t.url === "https://example.org/a",
        ),
      ],
      recoveredSpaceName: "Recovered evidence",
    },
  });
  assert(recovered.ok, recovered.error);
  state = (await send({ type: "load" })).value;
  const recoveredSpace = state.entities.find(
    (e) => e.kind === "space" && e.name === "Recovered evidence",
  );
  assert.equal(recoveredSpace?.name, "Recovered evidence");
  const recoveredTab = state.browser.tabs.find(
    (t) => t.spaceId === recoveredSpace.id,
  );
  assert.equal(recoveredTab.url, "https://example.org/a");
  assert.equal(recoveredTab.spaceId, recoveredSpace.id);
  assert(
    state.browser.groups.some(
      (g) => g.id === recoveredTab.groupId && g.spaceId === recoveredSpace.id,
    ),
  );
  assert(
    state.snapshots.some(
      (s) => s.protected && s.reason === "Before session restoration",
    ),
  );
  assert(state.browser.tabs.some((t) => t.id === native.b));
  await worker.evaluate(
    async (ids) => chrome.tabs.remove(ids),
    state.browser.tabs
      .filter((t) => t.spaceId === recoveredSpace.id)
      .map((t) => t.id),
  );
  record(
    "Selective session recovery creates an owned Space/group and preserves unrelated tabs",
  );
  const resource = state.entities.find((e) => e.name === "Primary source");
  const ownedOpen = await send({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "open",
    payload: { url: resource.url, resourceId: resource.id, copy: true },
  });
  assert(ownedOpen.ok, ownedOpen.error);
  const openedState = (await send({ type: "load" })).value;
  assert(openedState.browser.tabs.some((t) => t.url === resource.url));
  const ownedClose = await send({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "closeResources",
    payload: { resourceIds: [resource.id] },
  });
  assert(ownedClose.ok, ownedClose.error);
  const afterOwnedClose = (await send({ type: "load" })).value;
  assert(!afterOwnedClose.browser.tabs.some((t) => t.url === resource.url));
  assert(afterOwnedClose.browser.tabs.some((t) => t.id === native.b));
  record("Real resource-owned tab close preserves unrelated native group");
  await page.getByRole("button", { name: "Split view", exact: true }).click();
  await page.locator(".panes.split").waitFor();
  await page.screenshot({
    path: resolve(shots, "split-notes-light.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Toggle light/dark theme" }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await page.waitForTimeout(200);
  await page.screenshot({
    path: resolve(shots, "split-notes-dark.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "My Tasks", exact: false }).click();
  await page.getByRole("heading", { name: "My Tasks", exact: true }).waitFor();
  await page.screenshot({
    path: resolve(shots, "my-tasks.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Recovery", exact: true })
    .click();
  await page.getByRole("heading", { name: "Recovery", exact: true }).waitFor();
  await page.screenshot({
    path: resolve(shots, "recovery.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export ZIP" }).click();
  const download = await downloadPromise;
  const backupPath = resolve(root, `artifacts/browser-roundtrip-${stamp}.zip`);
  await download.saveAs(backupPath);
  record("Complete external ZIP export via UI");
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByRole("heading", { name: "Keep it close." }).waitFor();
  await popup.setViewportSize({ width: 400, height: 550 });
  await popup.screenshot({ path: resolve(shots, "popup.png") });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.locator("h1").waitFor();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await panel.waitForTimeout(200);
  await panel.screenshot({ path: resolve(shots, "sidepanel-surface.png") });
  record("Shared popup and narrow side-panel page surfaces");
  assert.deepEqual(errors, []);
  await context.close();
  context = await launch();
  const newPage = await context.newPage();
  await newPage.goto(`chrome-extension://${id}/index.html?space=${space.id}`);
  await newPage
    .getByRole("heading", { name: "Deep Work", exact: true })
    .waitFor();
  state = (
    await newPage.evaluate(() => chrome.runtime.sendMessage({ type: "load" }))
  ).value;
  assert(state.entities.some((e) => e.name === "Deep Work"));
  assert(
    state.entities
      .find((e) => e.name === "Decision log")
      .text.includes("Σημειώσεις"),
  );
  record("Full browser/profile restart preserves committed content");
  const cdp = await context.newCDPSession(newPage);
  await cdp.send("ServiceWorker.enable");
  const orphanId = `fixture-${crypto.randomUUID()}`;
  await newPage.evaluate(async (id) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("TabSpace-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("journal", "readwrite");
        tx.objectStore("journal").put({
          id,
          intent: "fixture interrupted operation",
          state: "executing",
          createdAt: new Date().toISOString(),
        });
        tx.oncomplete = () => {
          db.close();
          resolve(true);
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, orphanId);
  await cdp.send("ServiceWorker.stopAllWorkers");
  const resumed = await newPage.evaluate(() =>
    chrome.runtime.sendMessage({ type: "load" }),
  );
  assert(resumed.ok);
  assert(resumed.value.entities.some((e) => e.name === "Decision log"));
  const journalState = await newPage.evaluate(
    async (id) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("TabSpace-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("journal"),
            get = tx.objectStore("journal").get(id);
          get.onsuccess = () => resolve(get.result?.state);
          tx.oncomplete = () => db.close();
        };
      }),
    orphanId,
  );
  assert.equal(journalState, "uncertain");
  record(
    "MV3 worker termination: commits survive and interrupted effects become uncertain",
  );
  await context.close();
  const freshProfile = resolve(root, `artifacts/fresh-profile-${stamp}`);
  context = await chromium.launchPersistentContext(freshProfile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const imported = await context.newPage();
  await imported.goto(`chrome-extension://${id}/index.html`);
  await imported.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await imported.getByRole("button", { name: "Settings", exact: true }).click();
  await imported
    .locator('input[type=file][accept=".json,.zip"]')
    .setInputFiles(backupPath);
  await imported
    .getByRole("heading", { name: "Review backup import" })
    .waitFor();
  await imported.getByRole("button", { name: "Merge as new records" }).click();
  await imported.waitForFunction(() => !document.querySelector("dialog"));
  const importedState = (
    await imported.evaluate(() => chrome.runtime.sendMessage({ type: "load" }))
  ).value;
  assert(importedState.entities.some((e) => e.name === "Decision log"));
  const importedResource = importedState.entities.find(
    (e) => e.name === "Primary source",
  );
  assert.equal(importedResource.attachmentIds.length, 1);
  const blobText = await imported.evaluate(
    async (id) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("TabSpace-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("attachments"),
            get = tx.objectStore("attachments").get(id);
          get.onsuccess = async () => resolve(await get.result.blob.text());
          tx.oncomplete = () => db.close();
        };
      }),
    importedResource.attachmentIds[0],
  );
  assert.equal(blobText, "Independent attachment — τεκμήριο");
  record("External ZIP import into a real fresh profile");
  await context.close();
  const variant = resolve(root, "dist/newtab");
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: [
      `--disable-extensions-except=${variant}`,
      `--load-extension=${variant}`,
    ],
  });
  const newtab = await context.newPage();
  await newtab.goto("chrome://newtab/");
  await newtab
    .getByRole("heading", { name: "Your next useful step" })
    .waitFor();
  const variantState = (
    await newtab.evaluate(() => chrome.runtime.sendMessage({ type: "load" }))
  ).value;
  assert(variantState.entities.some((e) => e.name === "Decision log"));
  await newtab.waitForTimeout(200);
  await newtab.screenshot({
    path: resolve(shots, "newtab.png"),
    fullPage: true,
  });
  record(
    "Same-ID New Tab variant genuinely overrides Chrome new tab and preserves data",
  );
  await context.close();
  context = await launch();
  const rollback = await context.newPage();
  await rollback.goto(`chrome-extension://${id}/index.html`);
  await rollback
    .getByRole("heading", { name: "Deep Work", exact: true })
    .waitFor();
  const rollbackState = (
    await rollback.evaluate(() => chrome.runtime.sendMessage({ type: "load" }))
  ).value;
  assert(rollbackState.entities.some((e) => e.name === "Decision log"));
  const chromeNewtab = await context.newPage();
  await chromeNewtab.goto("chrome://newtab/");
  await chromeNewtab.waitForLoadState("domcontentloaded");
  assert.equal(
    await chromeNewtab
      .getByRole("heading", { name: "Your next useful step" })
      .count(),
    0,
  );
  record("Core variant rollback retains data and removes the New Tab override");
  await writeFile(
    resolve(root, "docs/VALIDATION_BROWSER.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        extensionBuild: ext,
        browser: context.browser()?.version() ?? "Chromium 153.0.8010.12",
        results,
        screenshots: await import("node:fs/promises").then((fs) =>
          fs.readdir(shots),
        ),
        limitations: [
          "Installed Chrome acceptance pending",
          "Actual desktop tab-strip gestures/DPI pending",
          "Abrupt process/OS crash timing pending",
          "Screen reader and actual Chrome side-panel placement pending",
        ],
      },
      null,
      2,
    ),
  );
} catch (e) {
  await writeFile(
    resolve(root, `docs/VALIDATION_BROWSER_PARTIAL_${APP_VERSION}.json`),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        extensionBuild: ext,
        results,
        failure: e instanceof Error ? e.message : String(e),
      },
      null,
      2,
    ),
  );
  if (context) {
    for (const p of context.pages())
      if (p.url().includes("index.html")) {
        await p
          .screenshot({ path: resolve(root, "artifacts/browser-failure.png") })
          .catch(() => {});
        console.error((await p.locator("body").innerText()).slice(0, 5000));
      }
  }
  throw e;
} finally {
  await context?.close();
}
