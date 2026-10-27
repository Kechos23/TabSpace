import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
for (const variant of ["core", "newtab"]) {
  const extension = resolve(root, "dist", variant);
  const context = await chromium.launchPersistentContext(
    resolve(root, `artifacts/settings-${variant}-${Date.now()}`),
    {
      channel: "chromium",
      headless: true,
      acceptDownloads: true,
      downloadsPath: resolve(root, "artifacts"),
      viewport: { width: 1440, height: 1000 },
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
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(
      `chrome-extension://${worker.url().split("/")[2]}/index.html`,
    );
    await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
    const rpc = (message) =>
      page.evaluate(async (m) => {
        const result = await chrome.runtime.sendMessage(m);
        if (!result.ok) throw Error(result.error);
        return result.value;
      }, message);
    const load = () => rpc({ type: "view", recovery: false, force: false });
    const initial = (await load()).settings;
    const expected = {
      ...initial,
      preserveLiveTabs: false,
      pinManager: true,
      unsavedLimit: 8,
      unsavedDays: 4,
    };
    await rpc({ type: "settings", value: expected });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.locator(".settings");
    const headings = await settings.locator("section > h2").allTextContents();
    assert.deepEqual(headings, [
      "Appearance",
      "Browsing & Spaces",
      "Unsaved Spaces",
      "Manager",
      ...(variant === "newtab" ? ["New Tab"] : []),
      "Backup & Recovery",
      "Drag Group",
      "Advanced",
      "About & Privacy",
      "Reset data",
    ]);
    assert.deepEqual((await load()).settings, expected);
    await expect(
      page.getByText("Native Windows helper", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Open / pin manager" }),
    ).toHaveCount(0);
    await expect(
      page.getByLabel("When switching Spaces", { exact: true }),
    ).toHaveValue("close");
    await page
      .getByLabel("When switching Spaces", { exact: true })
      .selectOption("preserve");
    await expect
      .poll(async () => (await load()).settings.preserveLiveTabs)
      .toBe(true);
    await page
      .getByRole("checkbox", {
        name: "Restore browsing on startup",
        exact: true,
      })
      .uncheck();
    await expect
      .poll(async () => (await load()).settings.restoreBrowsing)
      .toBe(false);
    await page
      .getByRole("checkbox", {
        name: "Lock tabs in Saved Spaces by default",
        exact: true,
      })
      .check();
    await expect
      .poll(async () => (await load()).settings.lockTabsByDefault)
      .toBe(true);
    const limit = page.getByLabel("Closed Unsaved Spaces to keep", {
      exact: true,
    });
    await limit.fill("12");
    await limit.press("Enter");
    await expect
      .poll(async () => (await load()).settings.unsavedLimit)
      .toBe(12);
    await limit.fill("");
    await limit.blur();
    await expect(limit).toHaveValue("12");
    const retention = page.getByLabel("Keep automatic checkpoints for", {
      exact: true,
    });
    await retention.fill("0");
    await retention.blur();
    await expect
      .poll(async () => (await load()).settings.retentionDays)
      .toBe(1);
    await expect(retention).toHaveValue("1");
    const advanced = page.locator("#settings-advanced details");
    assert.equal(await advanced.getAttribute("open"), null);
    await advanced.locator("summary").click();
    await expect(
      advanced.getByText(
        "No custom properties yet. Add one with + Property in a Space.",
      ),
    ).toBeVisible();
    const diagnostic = page.locator("#settings-about details");
    assert.equal(await diagnostic.getAttribute("open"), null);
    const historyLength = await page.evaluate(() => history.length);
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Backup & Recovery", exact: true })
      .click();
    assert.equal(await page.evaluate(() => history.length), historyLength);
    // Inspect generated backup bytes before handing them to the OS download manager.
    await page.evaluate(() => {
      globalThis.testExports = [];
      const blobs = new Map();
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = create(blob);
        blobs.set(url, blob);
        return url;
      };
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download && blobs.has(this.href)) {
          const name = this.download;
          blobs
            .get(this.href)
            .arrayBuffer()
            .then((bytes) =>
              globalThis.testExports.push({
                name,
                bytes: Array.from(new Uint8Array(bytes)),
              }),
            );
        } else click.call(this);
      };
    });
    for (const format of ["JSON", "ZIP"]) {
      await page
        .getByRole("button", { name: `Export ${format}`, exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => globalThis.testExports.length))
        .toBe(format === "JSON" ? 1 : 2);
      const exported = await page.evaluate(() => globalThis.testExports.at(-1));
      assert(exported.name.endsWith(`.${format.toLowerCase()}`));
      if (format === "JSON") {
        assert.equal(
          JSON.parse(Buffer.from(exported.bytes).toString("utf8")).settings
            .unsavedLimit,
          12,
        );
        await page
          .getByLabel("Import backup file", { exact: true })
          .setInputFiles({
            name: exported.name,
            mimeType: "application/json",
            buffer: Buffer.from(exported.bytes),
          });
        await expect(
          page.getByRole("button", {
            name: "Merge as new records",
            exact: true,
          }),
        ).toBeVisible();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Close dialog" })
          .click();
      } else assert.deepEqual(exported.bytes.slice(0, 2), [80, 75]);
    }
    await page
      .getByRole("button", { name: "Open Recovery", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Recovery", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "← Back to Settings", exact: true })
      .click();
    const beforeReset = (await load()).settings;
    await page
      .getByRole("button", { name: "Reset TabSpace data", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    assert.deepEqual((await load()).settings, beforeReset);
    if (variant === "newtab") {
      await page
        .getByRole("checkbox", { name: "Show clock", exact: true })
        .uncheck();
      await expect.poll(async () => (await load()).settings.clock).toBe(false);
      await page
        .getByLabel("Choose background image", { exact: true })
        .setInputFiles(resolve(extension, "icons/icon32.png"));
      await expect(
        page.getByRole("button", { name: "Remove image", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Remove image", exact: true })
        .click();
      await expect
        .poll(async () => (await load()).settings.backgroundAttachmentId)
        .toBeUndefined();
    } else
      await expect(
        page.getByRole("checkbox", { name: "Show clock", exact: true }),
      ).toHaveCount(0);
    await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "dark",
    );
    await page.locator(".settings-heading").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: resolve(root, `artifacts/settings-${variant}-dark.png`),
      animations: "disabled",
    });
    const toggle = page.getByRole("checkbox", {
      name: "Restore browsing on startup",
      exact: true,
    });
    assert.equal(
      await toggle.evaluate((e) => getComputedStyle(e).width),
      "38px",
    );
    await page.setViewportSize({ width: 760, height: 1000 });
    assert(await settings.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
    const final = (await load()).settings;
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    assert.deepEqual((await load()).settings, final);
    assert.deepEqual(errors, []);
    console.log(
      `${variant}: Settings order, retained preferences, switching/toggles/numeric validation, collapsed details, no-history section navigation, export/import preview, Recovery, reset cancel, conditional New Tab, narrow layout, and persistence passed.`,
    );
  } finally {
    await context.close();
  }
}
