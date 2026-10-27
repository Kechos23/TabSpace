import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import {
  themeIconColors,
  themeIconPath,
  themeToolbarIcons,
} from "../packages/domain/theme-icons.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const extension = resolve(root, "dist/core");
const profile = resolve(root, `artifacts/theme-icons-profile-${Date.now()}`);
const options = {
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
};
let context = await chromium.launchPersistentContext(profile, options);
const errors = [];
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const url = `chrome-extension://${worker.url().split("/")[2]}/index.html`;
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  // Observe real Chrome setIcon calls while preserving the real API implementation.
  await worker.evaluate(() => {
    globalThis.iconCalls = [];
    const original = chrome.action.setIcon.bind(chrome.action);
    chrome.action.setIcon = async (details) => {
      await original(details);
      globalThis.iconCalls.push(details.path);
    };
  });
  const other = await context.newPage();
  other.on("pageerror", (e) => errors.push(e.message));
  await other.goto(url);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["blue", "purple", "graphite", "sand", "green"]) {
    await page
      .locator(`.color-theme-option[data-color-theme="${theme}"]`)
      .click();
    for (const view of [page, other]) {
      await expect(view.locator('link[rel="icon"]')).toHaveAttribute(
        "href",
        `${url.replace("index.html", "")}${themeIconPath(theme, 32)}`,
      );
      const pixel = await view.evaluate(async () => {
        const img = new Image();
        img.src = document.querySelector('link[rel="icon"]').href;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 32;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return Array.from(ctx.getImageData(5, 5, 1, 1).data);
      });
      assert.deepEqual(
        pixel.slice(0, 3),
        themeIconColors[theme]
          .match(/[a-f0-9]{2}/gi)
          .map((h) => parseInt(h, 16)),
      );
    }
    assert.deepEqual(
      await worker.evaluate(() => globalThis.iconCalls.at(-1)),
      themeToolbarIcons(theme),
    );
  }
  // Icon updates also work without a manager page: the extension worker handles settings.
  await page.close();
  await other.close();
  const popup = await context.newPage();
  await popup.goto(url.replace("index.html", "popup.html"));
  await popup.evaluate(async () => {
    const initial = await chrome.runtime.sendMessage({ type: "popup" });
    if (!initial.ok) throw Error(initial.error);
    const result = await chrome.runtime.sendMessage({
      type: "settings",
      value: { ...initial.value.settings, colorTheme: "purple" },
    });
    if (!result.ok) throw Error(result.error);
  });
  await popup.close();
  assert.deepEqual(
    await worker.evaluate(() => globalThis.iconCalls.at(-1)),
    themeToolbarIcons("purple"),
  );
  // Packaged builds must include every asset, not just the default manifest icons.
  for (const variant of ["core", "newtab"]) {
    const dir = resolve(root, "dist", variant);
    const inventory = JSON.parse(
      await readFile(resolve(dir, "build-files.json"), "utf8"),
    );
    for (const theme of Object.keys(themeIconColors))
      for (const path of Object.values(themeToolbarIcons(theme))) {
        assert(inventory.includes(path));
        assert.equal(
          (await readFile(resolve(dir, path))).subarray(1, 4).toString(),
          "PNG",
        );
      }
  }
  await context.close();
  context = await chromium.launchPersistentContext(profile, options);
  const reopened = await context.newPage();
  reopened.on("pageerror", (e) => errors.push(e.message));
  await reopened.goto(url);
  await expect(reopened.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    /icons\/purple\/icon32.png$/,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Passed: five theme favicons and actual toolbar API updates, multiple managers, no-manager change, packaged assets, persisted theme after browser restart.",
  );
} finally {
  await context.close();
}
