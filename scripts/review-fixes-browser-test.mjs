import { resolve } from "node:path";
import assert from "node:assert/strict";
import { entity } from "../packages/domain/model.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const ext = resolve(root, "dist/core");
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/review-fixes-${Date.now()}`),
  {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  },
);
try {
  await context.route("https://review.test/**", (r) =>
    r.fulfill({
      body: "<title>Review fixture</title>",
      contentType: "text/html",
    }),
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const base = worker.url().replace("worker.js", "");
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "index.html");
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const rpc = (m, surface = page) =>
    surface.evaluate(async (m) => {
      const r = await chrome.runtime.sendMessage(m);
      if (!r.ok) throw Error(r.error);
      return r.value;
    }, m);
  const view = () => rpc({ type: "view", force: true, recovery: false });
  const source = entity("space", "Copy source", { view: "tabs" });
  for (const row of [
    source,
    entity("savedTab", "Kept", {
      spaceId: source.id,
      url: "https://review.test/kept",
    }),
    entity("savedTab", "Close me", {
      spaceId: source.id,
      url: "https://review.test/closed",
    }),
  ])
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
  await rpc({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "activateSession",
    payload: { spaceId: source.id, windowId },
  });
  await expect
    .poll(
      async () =>
        (await view()).browser.tabs.filter(
          (t) =>
            t.spaceId === source.id && /^https:\/\/review\.test\//.test(t.url),
        ).length,
    )
    .toBe(2);
  const closing = (await view()).browser.tabs.find(
    (t) => t.url === "https://review.test/closed",
  );
  await page.evaluate((id) => chrome.tabs.remove(id), closing.id);
  const copyRows = await rpc({
    type: "command",
    command: {
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "duplicate",
      id: source.id,
      expectedRevision: source.revision,
    },
  });
  const copy = copyRows.find((e) => e.kind === "space");
  assert.deepEqual(
    (await view()).spaceTabs[copy.id].map((t) => t.url),
    ["https://review.test/kept"],
  );
  console.log(
    "PASS duplicating an active Space immediately after manual closure copies only the current session",
  );
  await page.goto(base + `index.html?space=${copy.id}`);
  await expect(
    page.getByRole("heading", { name: copy.name, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: copy.name, exact: true }),
  ).toBeVisible();
  assert(
    (await view()).sessions.some(
      (s) => s.windowId === windowId && s.spaceId === source.id,
    ),
  );
  console.log(
    "PASS explicit Space links and reload preserve view-only selection without switching Chrome tabs",
  );
  const second = await context.newPage();
  await second.goto(base + "index.html");
  await second.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await Promise.all([
    rpc({ type: "settingsPatch", patch: { colorTheme: "blue" } }),
    rpc({ type: "settingsPatch", patch: { restoreBrowsing: false } }, second),
  ]);
  assert.equal((await view()).settings.colorTheme, "blue");
  assert.equal((await view()).settings.restoreBrowsing, false);
  console.log(
    "PASS independent manager preference patches preserve both edits",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Reset TabSpace data", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Home", exact: true }),
  ).toBeVisible();
  assert.equal(
    (await view()).entities.some((e) => e.id === source.id),
    false,
  );
  assert.deepEqual(errors, []);
  console.log("PASS Reset clears data and history routing, returning to Home");
} finally {
  await context.close();
}
