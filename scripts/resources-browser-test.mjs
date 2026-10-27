import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { entity } from "../packages/domain/model.ts";
import { APP_VERSION } from "../packages/domain/version.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright"),
  { expect } = await import("@playwright/test");
const extension = resolve(
  process.env.TABSPACE_EXTENSION_DIR || resolve(root, "dist/core"),
);
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/resources-profile-${Date.now()}`),
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
  errors = [];
try {
  await context.route("https://resources.test/**", (route) =>
    route.fulfill({
      body: `<title>${route.request().url().endsWith("second") ? "Second reference" : "Existing reference"}</title><p>Local fixture</p>`,
      contentType: "text/html",
    }),
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const origin = `chrome-extension://${worker.url().split("/")[2]}`;
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/index.html`);
  const rpc = async (message) => {
    const response = await page.evaluate(
      (m) => chrome.runtime.sendMessage(m),
      message,
    );
    assert(response?.ok, response?.error);
    return response.value;
  };
  const space = entity("space", "Resources project", { view: "resources" }),
    destination = entity("space", "Destination");
  const existing = entity("resource", "Existing reference", {
    spaceId: space.id,
    url: "https://resources.test/reference",
    description: "Keep this documentation.",
  });
  for (const row of [space, destination, existing])
    await rpc({
      type: "command",
      command: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: row,
      },
    });
  const website = await context.newPage();
  await website.goto(existing.url);
  const second = await context.newPage();
  await second.goto("https://resources.test/second");
  await page.goto(`${origin}/index.html?space=${space.id}`);
  const pane = page.getByRole("region", { name: "Main resources pane" });
  await expect(pane.locator(".resource-row")).toHaveCount(1);
  assert.equal(await pane.locator(".pane-tools").count(), 0);
  assert.equal(
    await pane.getByRole("button", { name: "Open links", exact: true }).count(),
    0,
  );
  await expect(pane.locator(".resource-row .tab-favicon")).toBeVisible();
  await pane.getByRole("button", { name: "Add resource", exact: true }).click();
  await page.getByRole("menuitem", { name: "Add link", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Saved article");
  await dialog
    .getByLabel("URL", { exact: true })
    .fill("https://resources.test/article");
  await dialog.getByRole("button", { name: "Save link", exact: true }).click();
  await expect(
    pane.getByRole("button", { name: "Saved article", exact: true }),
  ).toBeVisible();
  results.push(
    "Resources name retained; existing records render with favicons and descriptions; one Add menu replaces the permanent action strip",
  );
  const row = (name) =>
    pane
      .locator(".resource-row")
      .filter({ has: page.locator(".resource-title", { hasText: name }) });
  await pane
    .getByRole("button", { name: "Existing reference", exact: true })
    .click();
  assert.equal(
    (await rpc({ type: "load" })).browser.tabs.filter(
      (tab) => tab.url === existing.url,
    ).length,
    1,
  );
  await page.bringToFront();
  await row("Existing reference")
    .getByRole("button", {
      name: "Actions for Existing reference",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Open copy", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await rpc({ type: "load" })).browser.tabs.filter(
          (tab) => tab.url === existing.url,
        ).length,
    )
    .toBe(2);
  await page.bringToFront();
  await row("Saved article")
    .getByRole("button", { name: "Actions for Saved article", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await expect(
    pane.getByRole("button", { name: "Saved article copy", exact: true }),
  ).toBeVisible();
  results.push(
    "Title focuses an existing tab; Open copy explicitly creates a tab; Duplicate creates an independent saved resource in the compact menu",
  );
  await pane.getByRole("button", { name: "Add resource", exact: true }).click();
  const fileChooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Add file", exact: true }).click();
  await (
    await fileChooser
  ).setFiles({
    name: "project.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Local project evidence"),
  });
  await expect(
    pane.getByRole("button", { name: "project.txt", exact: true }),
  ).toBeVisible();
  await expect(
    row("project.txt").getByText(/TXT.*Stored locally/),
  ).toBeVisible();
  const fileDownload = page.waitForEvent("download");
  await pane.getByRole("button", { name: "project.txt", exact: true }).click();
  const downloaded = await fileDownload;
  assert.equal(downloaded.suggestedFilename(), "project.txt");
  assert.equal(
    await readFile(await downloaded.path(), "utf8"),
    "Local project evidence",
  );
  await row("Existing reference")
    .getByLabel("Attach file to Existing reference", { exact: true })
    .setInputFiles({
      name: "extra.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Extra file"),
    });
  await expect(
    pane.getByRole("button", { name: /↓ extra\.txt/ }),
  ).toBeVisible();
  results.push(
    "File rows show type/size/local storage; title downloads exact bytes; attached files keep their names and individual download actions",
  );
  await pane.getByRole("button", { name: "Add resource", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Save from open tabs", exact: true })
    .click();
  await dialog.getByRole("checkbox", { name: /Second reference/ }).check();
  await dialog
    .getByRole("button", { name: "Save 1 link", exact: true })
    .click();
  await expect(
    pane.getByRole("button", { name: "Second reference", exact: true }),
  ).toBeVisible();
  assert(!second.isClosed());
  await pane
    .getByRole("checkbox", { name: "Select Saved article", exact: true })
    .check();
  await expect(
    pane.getByRole("button", { name: "Open links", exact: true }),
  ).toBeVisible();
  const linksDownload = page.waitForEvent("download");
  await pane.getByRole("button", { name: "Export links", exact: true }).click();
  assert.equal(
    await readFile(await (await linksDownload).path(), "utf8"),
    "- [Saved article](https://resources.test/article)",
  );
  await pane
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await expect(
    pane.getByRole("button", { name: "Export links", exact: true }),
  ).toHaveCount(0);
  results.push(
    "Open-tab picker saves only checked links without closing original tabs; bulk actions appear on selection and Markdown export uses only the selection",
  );
  await pane
    .getByRole("button", { name: "Resources options", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", {
      name: "Replace tabs with links…",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", { name: "Add section", exact: true })
    .click();
  await dialog.getByLabel("Name", { exact: true }).fill("Reference docs");
  await dialog
    .getByRole("button", { name: "Create section", exact: true })
    .click();
  const section = pane.locator(".content-section").filter({
    has: page.getByRole("heading", { name: "Reference docs", exact: true }),
  });
  await row("Saved article copy").dragTo(
    section.getByRole("heading", { name: "Reference docs", exact: true }),
  );
  await expect(
    section.getByRole("button", { name: "Saved article copy", exact: true }),
  ).toBeVisible();
  await section
    .getByRole("button", { name: "Add resource", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Add link", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Section link");
  await dialog
    .getByLabel("URL", { exact: true })
    .fill("https://resources.test/section");
  await dialog.getByRole("button", { name: "Save link", exact: true }).click();
  await expect(
    section.getByRole("button", { name: "Section link", exact: true }),
  ).toBeVisible();
  await row("Saved article")
    .filter({
      has: page.getByRole("button", { name: "Saved article", exact: true }),
    })
    .getByRole("button", { name: "Actions for Saved article", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Move to Space", exact: true })
    .click();
  await dialog
    .getByLabel("Destination Space", { exact: true })
    .selectOption(destination.id);
  await dialog.getByRole("button", { name: "Move", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await rpc({ type: "load" })).entities.find(
          (item) => item.name === "Saved article",
        )?.spaceId,
    )
    .toBe(destination.id);
  results.push(
    "Sections are optional through the options menu; drag into a section, section-scoped Add and cross-Space Move retain their behavior; advanced tab replacement stays behind an explicit menu",
  );
  const beforeDark = await rpc({ type: "load" });
  await rpc({
    type: "settings",
    value: { ...beforeDark.settings, theme: "dark" },
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(pane.locator(".resource-row").first()).toBeVisible();
  await page.screenshot({
    path: resolve(root, "artifacts/resources-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  const state = await rpc({ type: "load" });
  await rpc({
    type: "settings",
    value: { ...state.settings, theme: "light", colorTheme: "blue" },
  });
  await page.reload();
  await expect(pane.locator(".resource-row").first()).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({
    path: resolve(root, "artifacts/resources-light.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 420, height: 900 });
  assert(
    await pane.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  );
  await page.screenshot({
    path: resolve(root, "artifacts/resources-narrow.png"),
    fullPage: true,
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(root, "docs/VALIDATION_RESOURCES.json"),
    JSON.stringify(
      { version: APP_VERSION, extension, results, pageErrors: errors },
      null,
      2,
    ),
  );
  console.log(results.join("\n"));
} catch (error) {
  console.error("Page errors:", errors);
  throw error;
} finally {
  await context.close();
}
