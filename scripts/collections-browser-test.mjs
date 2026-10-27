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
  resolve(root, `artifacts/collections-profile-${Date.now()}`),
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
  await context.route("https://collections.test/**", (route) =>
    route.fulfill(
      route.request().url().endsWith("favicon.svg")
        ? {
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#e65100"/></svg>',
          }
        : {
            contentType: "text/html",
            body: '<!doctype html><title>Prototype</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><p>Offline fixture</p>',
          },
    ),
  );
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
  assert.equal(
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "New Space", exact: true })
      .count(),
    1,
  );
  assert.equal(
    await page
      .locator(".sidebar")
      .getByText("+ New Space", { exact: true })
      .count(),
    0,
  );
  const load = async () =>
    (await page.evaluate(() => chrome.runtime.sendMessage({ type: "load" })))
      .value;
  await page
    .getByRole("button", { name: "New collection", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "New collection", exact: true })
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Projects");
  await page
    .getByRole("button", { name: "Create collection", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Collapse collection Projects", exact: true })
    .waitFor();
  const stored = (await load()).entities.find(
    (e) => e.kind === "sidebar" && e.name === "Projects",
  );
  const collection = page.locator(`[data-collection-id="${stored.id}"]`);
  await collection.getByText("Drop a Space here", { exact: true }).waitFor();
  passed(
    "New collection uses collection labels and folder row while preserving the existing storage kind",
  );
  await page
    .locator(".home")
    .getByRole("button", { name: "+ New Space", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Design");
  await page.getByRole("button", { name: "Create Space", exact: true }).click();
  await page
    .getByRole("heading", { name: "Design", exact: true, level: 1 })
    .waitFor();
  const design = (await load()).entities.find(
    (e) => e.kind === "space" && e.name === "Design",
  );
  const move = async (value) => {
    await page
      .getByRole("button", { name: "Settings for Design", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Move to collection", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Move Space to collection" })
      .getByRole("combobox", { name: "Collection", exact: true })
      .selectOption(value);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Move", exact: true })
      .click();
  };
  await move(stored.id);
  await collection
    .locator(".space-link")
    .filter({ hasText: "Design" })
    .waitFor();
  assert.equal(
    (await load()).entities.find((e) => e.id === design.id).sidebarId,
    stored.id,
  );
  const rootInbox = page
    .locator(".sidebar-section:not(.collection) .space-link")
    .filter({ hasText: "Inbox" });
  assert(
    (await collection.boundingBox()).y > (await rootInbox.boundingBox()).y,
  );
  passed(
    "Move dialog assigns an existing Space to a collection below independent Spaces",
  );
  await page
    .getByRole("button", { name: "Collapse collection Projects", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Expand collection Projects", exact: true })
    .waitFor();
  assert.equal(await collection.locator(".space-link").isVisible(), false);
  await page.reload();
  await page
    .getByRole("button", { name: "Expand collection Projects", exact: true })
    .waitFor();
  assert.equal(
    (await load()).entities.find((e) => e.id === stored.id).collapsed,
    true,
  );
  await page
    .getByRole("button", { name: "Expand collection Projects", exact: true })
    .click();
  await collection
    .locator(".space-link")
    .filter({ hasText: "Design" })
    .waitFor();
  passed(
    "Collection collapse/expand hides children accessibly and persists across reload",
  );
  await page
    .getByRole("button", {
      name: "Collection settings for Projects",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Edit details", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Edit collection" })
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Client projects");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Collapse collection Client projects",
      exact: true,
    })
    .waitFor();
  assert.equal(
    (await load()).entities.find((e) => e.id === design.id).sidebarId,
    stored.id,
  );
  passed("Renaming a collection keeps its identity and child Space ownership");
  await collection.locator(".space-link").filter({ hasText: "Design" }).click();
  const fixture = await context.newPage();
  await fixture.goto("https://collections.test/prototype");
  await collection
    .getByRole("button", { name: "Prototype", exact: true })
    .waitFor();
  const expectFixtureFavicon = () =>
    page.waitForFunction(() => {
      const img = document.querySelector(".collection .tab-favicon img");
      if (!img?.complete || !img.naturalWidth) return false;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 32;
      const drawing = canvas.getContext("2d");
      drawing.drawImage(img, 0, 0, 32, 32);
      const pixel = drawing.getImageData(16, 16, 1, 1).data;
      return pixel[0] === 230 && pixel[1] === 81 && pixel[2] === 0;
    });
  await expectFixtureFavicon();
  passed(
    "Tree uses Chrome's cached fixture favicon rather than a generic image, with one sidebar Space creation action",
  );
  await page.screenshot({
    animations: "disabled",
    path: resolve(root, "docs/screenshots/collections-light.png"),
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
    path: resolve(root, "docs/screenshots/collections-dark.png"),
  });
  await page.setViewportSize({ width: 400, height: 900 });
  assert(
    await page
      .locator(".sidebar")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await page.screenshot({
    animations: "disabled",
    path: resolve(root, "docs/screenshots/collections-narrow.png"),
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  passed(
    "Collection → Space → live tab tree renders in both themes and at 400px without sidebar overflow",
  );
  await move("");
  const rootRow = page.locator(
    `.sidebar-section:not(.collection) [data-space-id="${design.id}"] .space-row`,
  );
  await rootRow.waitFor();
  await rootRow.dragTo(collection.locator(".collection-row"));
  await collection
    .locator(".space-link")
    .filter({ hasText: "Design" })
    .waitFor();
  assert.equal(
    (await load()).entities.find((e) => e.id === design.id).sidebarId,
    stored.id,
  );
  assert.deepEqual(errors, []);
  passed(
    "No collection moves the Space back to root; native drag/drop puts it into the collection again",
  );
  const closed = await page.evaluate(
    (spaceId) =>
      chrome.runtime.sendMessage({
        type: "browser",
        action: "closeSession",
        commandId: crypto.randomUUID(),
        payload: { spaceId },
      }),
    design.id,
  );
  assert(closed.ok, closed.error);
  await collection.locator(".saved-tab .tab-favicon img").waitFor();
  await expectFixtureFavicon();
  passed(
    "Closed-session tree tabs reuse the cached website favicon without needing a live tab",
  );
  await writeFile(
    resolve(root, "docs/VALIDATION_COLLECTIONS.json"),
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
