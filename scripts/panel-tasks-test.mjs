import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const extension = resolve(root, "dist/core");
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/panel-tasks-${Date.now()}`),
  {
    channel: "chromium",
    headless: true,
    viewport: { width: 380, height: 900 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  },
);
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const base = `chrome-extension://${worker.url().split("/")[2]}/`;
  const popup = await context.newPage();
  const errors = [];
  popup.on("pageerror", (e) => errors.push(e.message));
  await popup.goto(`${base}popup.html`);
  await expect(
    popup.getByRole("button", { name: "Add task", exact: true }),
  ).toBeEnabled();
  const rpc = (m) =>
    popup.evaluate(async (message) => {
      const result = await chrome.runtime.sendMessage(message);
      if (!result.ok) throw Error(result.error);
      return result.value;
    }, m);
  const load = () => rpc({ type: "view", recovery: false, force: false });
  const before = await load();
  const windowId = before.currentWindowId;
  const key = `panel:navigation:${windowId}`;
  const taskCount = before.entities.filter((e) => e.kind === "task").length;
  // The native panel frame and popup dismissal are mocked; real session routing and UI are exercised.
  await popup.evaluate(() => {
    globalThis.testPanelOpen = [];
    globalThis.testPopupClose = 0;
    chrome.sidePanel.open = async (args) => {
      globalThis.testPanelOpen.push(args);
    };
    window.close = () => {
      globalThis.testPopupClose++;
    };
  });
  await popup.getByRole("button", { name: "Add task", exact: true }).click();
  await expect
    .poll(() => popup.evaluate(() => globalThis.testPopupClose))
    .toBe(1);
  const pending = await popup.evaluate(
    async (key) => (await chrome.storage.session.get(key))[key],
    key,
  );
  assert.equal(pending.destination, "tasks");
  assert.equal(
    (await load()).entities.filter((e) => e.kind === "task").length,
    taskCount,
  );
  const panel = await context.newPage();
  panel.on("pageerror", (e) => errors.push(e.message));
  await panel.goto(`${base}sidepanel.html`);
  await expect(
    panel.getByRole("heading", { name: "My Tasks", exact: true }),
  ).toBeVisible();
  const input = panel.getByRole("textbox", {
    name: "Add task from My Tasks",
    exact: true,
  });
  await expect(input).toBeFocused();
  await expect
    .poll(() =>
      popup.evaluate(
        async (key) => (await chrome.storage.session.get(key))[key],
        key,
      ),
    )
    .toBeUndefined();
  await input.fill("Write my own task");
  await input.press("Enter");
  await expect
    .poll(
      async () =>
        (await load()).entities.filter((e) => e.kind === "task").length,
    )
    .toBe(taskCount + 1);
  const added = (await load()).entities.find(
    (e) => e.kind === "task" && e.name === "Write my own task",
  );
  assert(added);
  assert(!added.description);
  assert.equal(added.spaceId, before.inboxId);
  await panel.getByRole("button", { name: "Completed", exact: true }).click();
  await expect(input).toHaveCount(0);
  await popup.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "To do", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(input).toBeFocused();
  await popup
    .getByRole("button", { name: "Open side panel", exact: true })
    .click();
  await expect(panel.locator(".app")).toHaveClass(/panel-tree/);
  const library = panel.getByRole("navigation", {
    name: "Library",
    exact: true,
  });
  const labels = await library.locator("button").allTextContents();
  assert(
    labels.findIndex((t) => t.includes("My Tasks")) >
      labels.findIndex((t) => t.includes("Inbox")),
  );
  await library.getByRole("button", { name: /My Tasks/ }).click();
  await expect(input).toBeFocused();
  await panel
    .locator(".panel-toolbar")
    .getByRole("button", { name: "Spaces", exact: true })
    .click();
  await popup.evaluate(async () =>
    chrome.storage.session.set({
      "panel:navigation:999999": {
        destination: "tasks",
        requestId: crypto.randomUUID(),
      },
    }),
  );
  await panel.getByRole("button", { name: "Inbox", exact: true }).waitFor();
  assert(
    await popup.evaluate(
      async () =>
        !!(await chrome.storage.session.get("panel:navigation:999999"))[
          "panel:navigation:999999"
        ],
    ),
  );
  await panel.reload();
  await expect(panel.locator(".app")).toHaveClass(/panel-tree/);
  await library.getByRole("button", { name: /My Tasks/ }).click();
  for (const width of [320, 380, 500]) {
    await panel.setViewportSize({ width, height: 900 });
    assert(
      await panel
        .locator("#main")
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      `My Tasks overflow at ${width}`,
    );
  }
  await panel.setViewportSize({ width: 380, height: 900 });
  await panel.screenshot({
    path: resolve(root, "artifacts/panel-my-tasks.png"),
    animations: "disabled",
  });
  const priorClose = await popup.evaluate(() => globalThis.testPopupClose);
  await popup.evaluate(() => {
    chrome.sidePanel.open = async () => {
      throw Error("Panel open fixture failure");
    };
  });
  await popup.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(popup.getByRole("alert")).toHaveText(
    "Panel open fixture failure",
  );
  assert.equal(
    await popup.evaluate(() => globalThis.testPopupClose),
    priorClose,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Passed: queued first-open routing, already-open routing, input focus, explicit task creation without tab data, Completed reset, regular panel tree destination, My Tasks position, back navigation, command consumption/window scoping, reload default, 320/380/500 widths, popup dismissal and open-failure handling.",
  );
} finally {
  await context.close();
}
