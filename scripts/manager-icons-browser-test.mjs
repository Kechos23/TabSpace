import "./development-maintenance.mjs";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { colors, entity } from "../packages/domain/model.ts";
import { savedSpaceIconPath } from "../packages/domain/manager-icons.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/manager-icons-${Date.now()}`),
  {
    channel: "chromium",
    headless: true,
    colorScheme: "dark",
    args: [
      `--disable-extensions-except=${resolve(root, "dist/core")}`,
      `--load-extension=${resolve(root, "dist/core")}`,
    ],
  },
);
try {
  const errors = [];
  await context.route("https://manager-icon.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Icon fixture</title>",
    }),
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const base = worker.url().replace("worker.js", "");
  const first = await context.newPage();
  first.on("pageerror", (error) => errors.push(error.message));
  await first.goto(base + "index.html");
  await first.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const rpc = (view, message) =>
    view.evaluate(async (message) => {
      const response = await chrome.runtime.sendMessage(message);
      if (!response.ok) throw Error(response.error);
      return response.value;
    }, message);
  const load = (view) => rpc(view, { type: "load" });
  const create = (record) =>
    rpc(first, {
      type: "command",
      command: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: record,
      },
    });
  const firstWindow = await first.evaluate(
    async () => (await chrome.tabs.getCurrent()).windowId,
  );
  let alpha = entity("space", "Icon Alpha", {
    color: "blue",
    temporary: false,
  });
  const beta = entity("space", "Icon Beta", { color: "red", temporary: false });
  const unsaved = entity("space", "Icon Unsaved", {
    color: "green",
    temporary: true,
  });
  for (const space of [alpha, beta, unsaved]) {
    await create(space);
    await create(
      entity("savedTab", space.name, {
        spaceId: space.id,
        url: `https://manager-icon.test/${space.id}`,
        order: 0,
      }),
    );
  }
  const nextPage = context.waitForEvent("page");
  const secondWindow = await first.evaluate(
    async (url) => (await chrome.windows.create({ url, focused: false })).id,
    base + "index.html",
  );
  const second = await nextPage;
  second.on("pageerror", (error) => errors.push(error.message));
  await second.getByRole("heading", { name: "Home", exact: true }).waitFor();
  for (const view of [first, second])
    await view.evaluate(async () => {
      const tab = await chrome.tabs.getCurrent();
      await chrome.tabs.update(tab.id, { pinned: true });
    });
  const activate = (spaceId, windowId) =>
    rpc(first, {
      type: "browser",
      commandId: crypto.randomUUID(),
      action: "activateSession",
      payload: { spaceId, windowId },
    });
  const favicon = (view) => view.locator('link[rel="icon"]');
  await activate(alpha.id, firstWindow);
  await activate(beta.id, secondWindow);
  await expect(favicon(first)).toHaveAttribute(
    "href",
    base + savedSpaceIconPath("blue", "dark"),
  );
  await expect(favicon(second)).toHaveAttribute(
    "href",
    base + savedSpaceIconPath("red", "dark"),
  );
  for (const [view, color] of [
    [first, "blue"],
    [second, "red"],
  ])
    await expect
      .poll(() =>
        view.evaluate(async () => {
          const tab = await chrome.tabs.getCurrent();
          return (await chrome.tabs.get(tab.id)).favIconUrl;
        }),
      )
      .toBe(base + savedSpaceIconPath(color, "dark"));
  const initial = await load(first);
  let releaseAssets;
  const assetsGate = new Promise((resolve) => {
    releaseAssets = resolve;
  });
  await context.route("**/assets/*.js", async (route) => {
    // Existing views are already loaded. A new frame can still report about:blank
    // when its module request arrives, so its current URL cannot select the gate.
    await assetsGate;
    await route.continue();
  });
  const started = Date.now(),
    newManager = context.waitForEvent("page");
  await first.evaluate(
    async ({ url, windowId }) => {
      await chrome.tabs.create({ url, windowId, active: false });
    },
    { url: base + "index.html?icon-fast-test=1", windowId: firstWindow },
  );
  const blocked = await newManager;
  blocked.on("pageerror", (error) => errors.push(error.message));
  await blocked.waitForURL("**/index.html?icon-fast-test=1", {
    waitUntil: "commit",
  });
  await expect(favicon(blocked)).toHaveAttribute(
    "href",
    base + savedSpaceIconPath("blue", "dark"),
  );
  assert.equal(await blocked.locator(".app").count(), 0);
  console.log(
    `Manager favicon ready with all UI scripts blocked (${Date.now() - started} ms in isolated Chromium).`,
  );
  await rpc(first, {
    type: "settings",
    value: { ...initial.settings, colorTheme: "blue" },
  });
  // Viewing a different Space must not change the window's real active identity.
  await first
    .getByRole("button", { name: `Settings for ${beta.name}`, exact: true })
    .click();
  await first.getByRole("button", { name: "View Space", exact: true }).click();
  await expect(
    first.getByRole("heading", { name: beta.name, exact: true }),
  ).toBeVisible();
  await expect(favicon(first)).toHaveAttribute(
    "href",
    base + savedSpaceIconPath("blue", "dark"),
  );
  for (const color of colors) {
    [alpha] = await rpc(first, {
      type: "command",
      command: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "update",
        id: alpha.id,
        expectedRevision: alpha.revision,
        patch: { color },
      },
    });
    await expect(favicon(first)).toHaveAttribute(
      "href",
      base + savedSpaceIconPath(color, "dark"),
    );
    await expect(favicon(second)).toHaveAttribute(
      "href",
      base + savedSpaceIconPath("red", "dark"),
    );
    await expect(favicon(blocked)).toHaveAttribute(
      "href",
      base + savedSpaceIconPath(color, "dark"),
    );
  }
  releaseAssets();
  await blocked.locator(".app").waitFor();
  await expect(favicon(blocked)).toHaveAttribute(
    "href",
    base + savedSpaceIconPath(alpha.color, "dark"),
  );
  await blocked.close();
  await first.emulateMedia({ colorScheme: "light" });
  await expect(favicon(first)).toHaveAttribute(
    "href",
    base + savedSpaceIconPath(alpha.color, "light"),
  );
  await expect(favicon(second)).toHaveAttribute(
    "href",
    base + savedSpaceIconPath("red", "dark"),
  );
  await second.reload();
  await expect(favicon(second)).toHaveAttribute(
    "href",
    base + savedSpaceIconPath("red", "dark"),
  );
  await activate(unsaved.id, firstWindow);
  await expect(favicon(first)).toHaveAttribute(
    "href",
    base + "icons/blue/icon32.png",
  );
  const currentUnsaved = (await load(first)).entities.find(
    (item) => item.id === unsaved.id,
  );
  await rpc(first, {
    type: "command",
    command: {
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "update",
      id: unsaved.id,
      expectedRevision: currentUnsaved.revision,
      patch: { temporary: false, color: "pink" },
    },
  });
  await expect(favicon(first)).toHaveAttribute(
    "href",
    base + savedSpaceIconPath("pink", "light"),
  );
  // The target color must be visible while the browser is still creating tabs.
  const early = entity("space", "Early icon", { color: "cyan" });
  await create(early);
  await create(
    entity("savedTab", "Delayed website", {
      spaceId: early.id,
      url: "https://manager-icon.test/delayed",
      order: 0,
    }),
  );
  await worker.evaluate(() => {
    const original = chrome.tabs.create.bind(chrome.tabs);
    globalThis.originalCreate = original;
    globalThis.creationBlocked = false;
    globalThis.creationGate = new Promise((resolve) => {
      globalThis.releaseCreation = resolve;
    });
    chrome.tabs.create = async (details) => {
      if (details.url?.endsWith("/delayed")) {
        globalThis.creationBlocked = true;
        await globalThis.creationGate;
      }
      return original(details);
    };
  });
  await first.evaluate(
    ({ spaceId, windowId }) => {
      window.earlyActivation = chrome.runtime.sendMessage({
        type: "browser",
        commandId: crypto.randomUUID(),
        action: "activateSession",
        payload: { spaceId, windowId },
      });
    },
    { spaceId: early.id, windowId: firstWindow },
  );
  await expect
    .poll(() => worker.evaluate(() => globalThis.creationBlocked))
    .toBe(true);
  await expect(favicon(first)).toHaveAttribute(
    "href",
    base + savedSpaceIconPath("cyan", "light"),
  );
  await worker.evaluate(() => {
    globalThis.releaseCreation();
    chrome.tabs.create = globalThis.originalCreate;
  });
  assert.equal((await first.evaluate(() => window.earlyActivation)).ok, true);
  await expect(favicon(first)).toHaveAttribute(
    "href",
    base + savedSpaceIconPath("cyan", "light"),
  );
  console.log(
    "Target favicon appears before the blocked tab-creation operation finishes.",
  );
  // Both packages contain each real PNG asset at both favicon resolutions.
  const images = [];
  for (const appearance of ["light", "dark"])
    for (const color of colors)
      for (const size of [16, 32]) {
        const path = savedSpaceIconPath(color, appearance, size);
        for (const variant of ["core", "newtab"]) {
          const dir = resolve(root, "dist", variant),
            inventory = JSON.parse(
              await readFile(resolve(dir, "build-files.json"), "utf8"),
            );
          assert(inventory.includes(path));
          const bytes = await readFile(resolve(dir, path));
          assert.equal(bytes.subarray(1, 4).toString(), "PNG");
          assert.equal(bytes.readUInt32BE(16), size);
          assert.equal(bytes.readUInt32BE(20), size);
          if (variant === "core" && size === 16)
            images.push({
              color,
              appearance,
              src: "data:image/png;base64," + bytes.toString("base64"),
            });
        }
      }
  assert.equal(new Set(images.map((image) => image.src)).size, 18);
  await first.evaluate(async (images) => {
    const gallery = document.createElement("div");
    gallery.id = "icon-gallery";
    gallery.style.cssText =
      "display:grid;grid-template-columns:repeat(3,160px);gap:16px;padding:24px;background:#132438;color:#eef5ff;font:14px Segoe UI";
    for (const image of images) {
      const cell = document.createElement("div");
      cell.textContent = `${image.color} · ${image.appearance} `;
      for (const size of [16, 48]) {
        const img = new Image();
        img.src = image.src;
        img.width = img.height = size;
        img.style.cssText = "image-rendering:pixelated;margin:8px";
        await img.decode();
        cell.append(img);
      }
      gallery.append(cell);
    }
    document.body.append(gallery);
  }, images);
  await first
    .locator("#icon-gallery")
    .screenshot({ path: resolve(root, "artifacts/manager-icons-0.17.10.png") });
  assert.deepEqual(errors, []);
  console.log(
    "Passed: all nine colors, independent window identities, view-only navigation, live color edits, Unsaved fallback/save conversion, appearance change, reload and all 36 assets in both packages. Chrome toolbar rendering remains manual acceptance.",
  );
} finally {
  await context.close();
}
