import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { entity } from "../packages/domain/model.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const ext = resolve(
  process.env.TABSPACE_EXTENSION_DIR || resolve(root, "dist/core"),
);
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/popup-profile-${Date.now()}`),
  {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  },
);
const results = [];
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = worker.url().split("/")[2];
  let releaseScripts;
  const gate = new Promise((resolve) => {
    releaseScripts = resolve;
  });
  await context.route("**/assets/*.js", async (route) => {
    await gate;
    await route.continue();
  });
  const popup = await context.newPage();
  const errors = [];
  popup.on("pageerror", (error) => errors.push(error.message));
  await popup.goto(`chrome-extension://${id}/popup.html`, {
    waitUntil: "commit",
  });
  await popup.locator(".popup-shell").waitFor();
  const early = await popup.evaluate(() => ({
    width: document.documentElement.getBoundingClientRect().width,
    height: document.body.getBoundingClientRect().height,
  }));
  assert.equal(early.width, 380);
  assert(early.height >= 340);
  results.push(
    "Popup has 380px width and compact minimum height before any JavaScript executes",
  );
  releaseScripts();
  await popup.getByRole("status").filter({ hasText: "Ready" }).waitFor();
  const ready = await popup.evaluate(() => ({
    width: document.documentElement.getBoundingClientRect().width,
    height: document.body.getBoundingClientRect().height,
    contentHeight: document
      .querySelector(".popup-shell")
      .getBoundingClientRect().height,
  }));
  assert.equal(ready.width, early.width);
  assert(
    ready.contentHeight >= 340 && ready.contentHeight <= 480,
    JSON.stringify(ready),
  );
  await expect(
    popup.getByRole("heading", { name: "Your Tabs", exact: true }),
  ).toBeVisible();
  await expect(popup.locator(".popup-intro")).toHaveText("Your Workspace");
  await expect(
    popup.locator(".popup-shell > .quick-grid > button").first(),
  ).toHaveText("Save window as Space");
  assert.equal(
    await popup.getByRole("button", { name: "Save current tab" }).isEnabled(),
    true,
  );
  assert.deepEqual(errors, []);
  results.push(
    "Cold popup reaches usable quick actions without page errors or width collapse",
  );
  await popup
    .locator(".popup-shell")
    .screenshot({ path: resolve(root, "artifacts/popup-0.17.9.png") });
  const dragSwitch = popup.getByRole("switch", {
    name: "Drag Group",
    exact: true,
  });
  const cloudIndicator = popup.locator(".popup-cloud-sync");
  await expect(cloudIndicator).toHaveText("Cloud sync off");
  await popup.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.cloudFixture = {
      calls: [],
      fail: false,
      value: {
        configured: true,
        hasAccess: true,
        unlocked: true,
        running: false,
        automatic: true,
        needsAttention: false,
        hasConflicts: false,
        lastSynced: "2026-10-26T08:00:00.000Z",
      },
    };
    chrome.runtime.sendMessage = async (message) => {
      const fixture = window.cloudFixture;
      if (message.type.startsWith("cloudSync"))
        fixture.calls.push(message.type);
      if (message.type === "cloudSyncSummary") {
        if (fixture.fail) throw Error("Fixture unavailable");
        return { ok: true, value: structuredClone(fixture.value) };
      }
      return send(message);
    };
  });
  await expect(cloudIndicator).toHaveText("Cloud sync ready", {
    timeout: 5000,
  });
  await expect(cloudIndicator).toHaveAttribute(
    "title",
    /Last successful sync:/,
  );
  for (const [patch, text] of [
    [{ running: true }, "Syncing…"],
    [{ running: false, unlocked: false }, "Sync locked"],
    [{ unlocked: true, hasConflicts: true }, "Sync needs review"],
    [{ hasConflicts: false, needsAttention: true }, "Sync needs attention"],
    [{ needsAttention: false, hasAccess: false }, "Sync needs access"],
  ]) {
    await popup.evaluate(
      (patch) => Object.assign(window.cloudFixture.value, patch),
      patch,
    );
    await expect(cloudIndicator).toHaveText(text, { timeout: 5000 });
  }
  await expect(cloudIndicator).toHaveAttribute("data-attention", "true");
  await popup.evaluate(() => {
    window.cloudFixture.fail = true;
  });
  await expect(cloudIndicator).toHaveText("Sync status unavailable", {
    timeout: 5000,
  });
  await expect(
    popup.getByRole("button", { name: "Save current tab" }),
  ).toBeEnabled();
  await popup.evaluate(() => {
    window.cloudFixture.fail = false;
    window.cloudFixture.value.hasAccess = true;
    document.documentElement.dataset.theme = "dark";
  });
  await expect(cloudIndicator).toHaveText("Cloud sync ready", {
    timeout: 5000,
  });
  await popup
    .locator(".popup-shell")
    .screenshot({ path: resolve(root, "artifacts/popup-cloud-sync-dark.png") });
  await popup.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await popup
    .locator(".popup-shell")
    .screenshot({
      path: resolve(root, "artifacts/popup-cloud-sync-light.png"),
    });
  assert(
    (await popup.evaluate(() => window.cloudFixture.calls)).every(
      (type) => type === "cloudSyncSummary",
    ),
  );
  results.push(
    "Cloud indicator: off, ready, running, locked, conflict, permission/error, status failure and recovery; read-only calls only; quick actions remain enabled",
  );
  await expect(dragSwitch).not.toBeChecked();
  assert.equal(
    await popup
      .locator(".popup-drag-toggle")
      .evaluate((e) => getComputedStyle(e).flexDirection),
    "row",
  );
  // UI fixture only: never launch the registered OS helper from this test.
  await popup.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.dragFixture = {
      enabled: false,
      permission: false,
      activation: false,
      status: "Ready — local fixture",
      calls: [],
    };
    chrome.permissions.request = async () => {
      window.dragFixture.activation = navigator.userActivation.isActive;
      return window.dragFixture.permission;
    };
    chrome.runtime.sendMessage = async (message) => {
      const f = window.dragFixture;
      if (message.type === "dragGroup:setEnabled") {
        f.enabled = message.enabled;
        f.calls.push(message.enabled);
      }
      if (
        message.type === "dragGroup:setEnabled" ||
        message.type === "dragGroup:getState"
      )
        return {
          enabled: f.enabled,
          windows: [
            {
              windowId: (await chrome.windows.getCurrent()).id,
              running: true,
              status: f.status,
            },
          ],
        };
      return send(message);
    };
  });
  await dragSwitch.click();
  await expect(popup.getByRole("alert")).toContainText(
    "Helper access was not granted",
  );
  await expect(dragSwitch).not.toBeChecked();
  // The error must survive the status refresh after a denied permission.
  await expect
    .poll(() => popup.evaluate(() => window.dragFixture.activation))
    .toBe(true);
  await popup.evaluate(() => {
    window.dragFixture.permission = true;
  });
  await dragSwitch.click();
  await expect(dragSwitch).toBeChecked();
  await expect(
    popup.getByRole("status").filter({ hasText: "Ready in this window" }),
  ).toBeVisible();
  await expect(popup.getByRole("alert")).toHaveCount(0);
  await popup.evaluate(() => {
    window.dragFixture.status = "Helper unavailable: fixture error";
  });
  await expect(
    popup.getByRole("status").filter({ hasText: "Helper unavailable" }),
  ).toBeVisible({ timeout: 5000 });
  await dragSwitch.click();
  await expect(dragSwitch).not.toBeChecked();
  await expect(
    popup.getByRole("status").filter({ hasText: "Paused" }),
  ).toBeVisible();
  assert.deepEqual(await popup.evaluate(() => window.dragFixture.calls), [
    true,
    false,
  ]);
  results.push(
    "Drag Group popup: global toggle, user-gesture permission, denied permission, live current-window readiness/error and pause pass (mocked helper)",
  );
  const cdp = await context.newCDPSession(popup);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await popup.reload();
  await popup.getByRole("status").filter({ hasText: "Ready" }).waitFor();
  assert.deepEqual(errors, []);
  const lightweight = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: "popup" });
    return {
      ok: response.ok,
      keys: Object.keys(response.value),
      count: response.value.spaces.length,
    };
  });
  assert(lightweight.ok);
  assert(lightweight.count > 0);
  for (const omitted of ["entities", "browser", "snapshots", "drafts"])
    assert(!lightweight.keys.includes(omitted));
  results.push(
    "Popup wakes a stopped worker and receives only quick-action data",
  );
  await context.route("https://popup.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>${"T".repeat(501)}</title><p>Local popup save fixture</p>`,
    }),
  );
  const website = await context.newPage();
  await website.goto("https://popup.test/source");
  // A page-surface test cannot be the real Chrome toolbar. Supply the actual
  // fixture tab for the popup's active-tab query; storage/commands remain real.
  await popup.addInitScript(() => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (options) =>
      options.active ? query({ url: "https://popup.test/*" }) : query(options);
  });
  await popup.reload();
  await popup.getByRole("status").filter({ hasText: "Ready" }).waitFor();
  await popup.getByRole("button", { name: "Save current tab" }).click();
  await popup.getByRole("status").filter({ hasText: "Ready" }).waitFor();
  await expect(
    popup.getByRole("button", { name: "Add task", exact: true }),
  ).toBeEnabled();
  await popup.getByRole("status").filter({ hasText: "Ready" }).waitFor();
  const saved = await popup.evaluate(
    async () =>
      (await chrome.runtime.sendMessage({ type: "load" })).value.entities,
  );
  assert(
    saved.some(
      (e) =>
        e.kind === "resource" &&
        e.url === "https://popup.test/source" &&
        e.name.length === 500,
    ),
  );
  assert.deepEqual(errors, []);
  results.push(
    "Quick actions save a real fixture link with bounded browser titles (controlled active-tab query)",
  );
  const collection = entity("sidebar", "Popup collection");
  await popup.evaluate(async (entity) => {
    const result = await chrome.runtime.sendMessage({
      type: "command",
      command: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity,
      },
    });
    if (!result.ok) throw Error(result.error);
  }, collection);
  await popup.reload();
  await popup.locator('.popup-shell[aria-busy="false"]').waitFor();
  const source = await popup.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "https://popup.test/source" });
    const duplicate = await chrome.tabs.create({
      windowId: tab.windowId,
      url: tab.url,
      active: false,
    });
    await chrome.tabs.create({
      windowId: tab.windowId,
      url: "https://popup.test/pinned",
      pinned: true,
      active: false,
    });
    const groupId = await chrome.tabs.group({ tabIds: [tab.id, duplicate.id] });
    await chrome.tabGroups.update(groupId, {
      title: "Research",
      color: "purple",
      collapsed: true,
    });
    await chrome.tabs.update(tab.id, { muted: true });
    return { windowId: tab.windowId };
  });
  await popup
    .getByRole("button", { name: "Save window as Space", exact: true })
    .click();
  await expect(popup.getByLabel("Space name")).toBeFocused();
  await popup.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(popup.getByLabel("Space name")).toHaveCount(0);
  await popup
    .getByRole("button", { name: "Save window as Space", exact: true })
    .click();
  await popup.getByLabel("Space name").fill("Window copy");
  await popup.getByRole("button", { name: "Space color", exact: true }).click();
  await expect(popup.getByRole("menuitemradio")).toHaveCount(9);
  const swatches = await popup
    .getByRole("menuitemradio")
    .locator(".popup-color-swatch")
    .evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).backgroundColor),
    );
  assert.equal(new Set(swatches).size, 9);
  assert(!swatches.includes("rgba(0, 0, 0, 0)"));
  await popup
    .getByRole("menuitemradio", { name: "Orange", exact: true })
    .click();
  await popup.getByLabel("Lock current tabs in Space").check();
  await popup
    .getByLabel("Collection", { exact: true })
    .selectOption(collection.id);
  const expanded = await popup.locator(".popup-shell").evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    overflowX: element.scrollWidth > element.clientWidth,
  }));
  assert(expanded.height <= 580 && !expanded.overflowX);
  await popup.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.colorTheme = "blue";
  });
  await popup.locator(".popup-shell").screenshot({
    path: resolve(root, "artifacts/popup-save-window-0.17.9.png"),
  });
  // Changing focused window while the popup is open must not change its target.
  const other = await worker.evaluate(
    async () =>
      (await chrome.windows.create({ url: "https://popup.test/other-window" }))
        .id,
  );
  const before = await worker.evaluate(
    async (windowId) =>
      (await chrome.tabs.query({ windowId })).map((tab) => ({
        id: tab.id,
        url: tab.url,
        pinned: tab.pinned,
        groupId: tab.groupId,
      })),
    source.windowId,
  );
  await popup.getByRole("button", { name: "Save Space", exact: true }).click();
  await expect(popup.locator(".popup-status")).toHaveText(
    "Saved as Window copy.",
  );
  const copied = await popup.evaluate(
    async () => (await chrome.runtime.sendMessage({ type: "load" })).value,
  );
  const copiedSpace = copied.entities.find(
    (item) => item.kind === "space" && item.name === "Window copy",
  );
  assert(copiedSpace && !copiedSpace.temporary);
  assert.equal(copiedSpace.color, "orange");
  assert.equal(copiedSpace.sidebarId, collection.id);
  const copiedTabs = copied.entities.filter(
    (item) => item.kind === "savedTab" && item.spaceId === copiedSpace.id,
  );
  assert.equal(copiedTabs.length, 3);
  assert.equal(
    copiedTabs.filter((tab) => tab.url === "https://popup.test/source").length,
    2,
  );
  assert(copiedTabs.every((tab) => tab.locked && !tab.pinned));
  assert.equal(copiedTabs.filter((tab) => tab.muted).length, 1);
  const copiedGroup = copied.entities.find(
    (item) => item.kind === "group" && item.spaceId === copiedSpace.id,
  );
  assert.equal(copiedGroup.name, "Research");
  assert.equal(copiedGroup.color, "purple");
  assert.equal(
    copiedTabs.filter((tab) => tab.groupId === copiedGroup.id).length,
    2,
  );
  assert.equal(copied.spaceTabs[copiedSpace.id].length, 3);
  assert(
    !copied.sessions.some((session) => session.spaceId === copiedSpace.id),
  );
  assert.deepEqual(
    await worker.evaluate(
      async (windowId) =>
        (await chrome.tabs.query({ windowId })).map((tab) => ({
          id: tab.id,
          url: tab.url,
          pinned: tab.pinned,
          groupId: tab.groupId,
        })),
      source.windowId,
    ),
    before,
  );
  const emptyCheck = await popup.evaluate(async () => {
    const blank = await chrome.windows.create({
      url: "chrome://extensions/",
      focused: false,
    });
    const spaceId = crypto.randomUUID();
    const result = await chrome.runtime.sendMessage({
      type: "browser",
      commandId: crypto.randomUUID(),
      action: "saveWindowSpace",
      payload: { windowId: blank.id, spaceId, name: "Should not exist" },
    });
    await chrome.windows.remove(blank.id);
    return { ok: result.ok, spaceId };
  });
  assert.equal(emptyCheck.ok, false);
  const after = await popup.evaluate(
    async () => (await chrome.runtime.sendMessage({ type: "load" })).value,
  );
  assert(!after.entities.some((item) => item.id === emptyCheck.spaceId));
  await popup.evaluate(
    async ({ spaceId, sourceWindow }) => {
      const result = await chrome.runtime.sendMessage({
        type: "browser",
        commandId: crypto.randomUUID(),
        action: "activateSession",
        payload: { spaceId, windowId: sourceWindow, newWindow: true },
      });
      if (!result.ok) throw Error(result.error);
    },
    { spaceId: copiedSpace.id, sourceWindow: source.windowId },
  );
  const restored = await popup.evaluate(
    async () => (await chrome.runtime.sendMessage({ type: "load" })).value,
  );
  const restoredWindow = restored.sessions.find(
    (session) => session.spaceId === copiedSpace.id,
  ).windowId;
  assert.notEqual(restoredWindow, source.windowId);
  assert.notEqual(restoredWindow, other);
  const restoredTabs = restored.browser.tabs.filter(
    (tab) => tab.windowId === restoredWindow && tab.spaceId === copiedSpace.id,
  );
  assert.equal(restoredTabs.length, 3);
  assert.equal(restoredTabs.filter((tab) => tab.groupId >= 0).length, 2);
  await worker.evaluate(async (windowId) => {
    await chrome.windows.update(windowId, { focused: true });
  }, restoredWindow);
  await popup.reload();
  await popup.locator('.popup-shell[aria-busy="false"]').waitFor();
  await expect(
    popup.getByRole("button", { name: "Save window as Space", exact: true }),
  ).toHaveCount(0);
  await expect(
    popup.locator(".popup-shell > .quick-grid > button").first(),
  ).toHaveText(/(?:Unlock|Lock) in Space/);
  await expect(
    popup.getByRole("button", { name: "Open manager", exact: true }),
  ).toBeVisible();
  await worker.evaluate(async (windowId) => {
    await chrome.windows.update(windowId, { focused: true });
  }, source.windowId);
  // Headless page surfaces do not reliably switch OS window focus. Supply the
  // real source-window binding to the popup response for this second context.
  const sourceBinding = restored.sessions.find(
    (session) => session.windowId === source.windowId,
  );
  if (sourceBinding)
    assert(
      restored.entities.find((item) => item.id === sourceBinding.spaceId)
        .temporary,
    );
  await popup.addInitScript(
    ({ windowId, activeSpaceId }) => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (message) => {
        const response = await send(message);
        if (message.type === "popup" && response?.ok) {
          response.value.windowId = windowId;
          response.value.activeSpaceId = activeSpaceId;
        }
        return response;
      };
    },
    { windowId: source.windowId, activeSpaceId: sourceBinding?.spaceId },
  );
  await popup.reload();
  await popup.locator('.popup-shell[aria-busy="false"]').waitFor();
  await popup.getByRole("combobox").selectOption(copiedSpace.id);
  await expect(
    popup.getByRole("button", { name: "Save window as Space", exact: true }),
  ).toBeVisible();
  results.push(
    "Save window appears for Unsaved/unbound windows, hides for a window bound to a Saved Space, and ignores the resource destination selector",
  );
  assert.deepEqual(errors, []);
  results.push(
    "Save window: named locked copy, source-window isolation, pinned sites, duplicates, groups/mute, untouched live tabs, empty-window rejection and actual reopening pass",
  );
  const manager = await context.newPage();
  const managerErrors = [];
  manager.on("pageerror", (error) => managerErrors.push(error.message));
  await manager.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message) => {
      const response = await send(message);
      if (message.type === "load" && response?.ok) {
        delete response.value.sessions;
        delete response.value.windows;
        delete response.value.sessionInterrupted;
      }
      return response;
    };
  });
  await manager.goto(`chrome-extension://${id}/index.html`);
  await manager.getByRole("heading", { name: "Home", exact: true }).waitFor();
  assert.deepEqual(managerErrors, []);
  results.push(
    "Manager renders a legacy load response missing sessions/windows without undefined.find errors",
  );
  await writeFile(
    resolve(root, "docs/VALIDATION_POPUP.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        extension: ext,
        browser: context.browser()?.version(),
        early,
        ready,
        results,
        limitations:
          "Isolated Chromium page surfaces; manual installed-Chrome toolbar popup acceptance remains pending.",
      },
      null,
      2,
    ),
  );
  results.forEach((name) => console.log("PASS", name));
} finally {
  await context.close();
}
