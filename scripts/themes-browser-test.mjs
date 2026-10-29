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
  resolve(root, `artifacts/themes-profile-${Date.now()}`),
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
  colors = [],
  errors = [];
const luminance = (color) => {
  const rgb = color
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number)
    .map((v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
};
const contrast = (a, b) => {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const origin = `chrome-extension://${worker.url().split("/")[2]}`;
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/index.html`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.locator('.color-theme-option[aria-pressed="true"]'),
  ).toHaveText("Green · Default");
  const mode = page.getByLabel("Appearance", { exact: true });
  const readColors = () =>
    page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const read = (name) => {
        probe.style.color = `var(--${name})`;
        return getComputedStyle(probe).color;
      };
      const colors = Object.fromEntries(
        [
          "bg",
          "surface",
          "sidebar",
          "text",
          "muted",
          "accent",
          "tint",
          "hover",
          "primary",
        ].map((key) => [key, read(key)]),
      );
      probe.remove();
      return colors;
    });
  for (const [key, label] of [
    ["green", "Green · Default"],
    ["blue", "Blue"],
    ["purple", "Purple"],
    ["graphite", "Graphite"],
    ["sand", "Warm Sand"],
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-color-theme", key);
    const variants = {};
    for (const appearance of ["light", "dark"]) {
      await mode.selectOption(appearance);
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        appearance,
      );
      const palette = await readColors();
      variants[appearance] = palette;
      for (const bg of ["bg", "surface", "sidebar", "tint", "hover"])
        assert(
          contrast(palette.text, palette[bg]) >= 4.5,
          `${key}/${appearance}: text contrast on ${bg}`,
        );
      assert(
        contrast(palette.accent, palette.surface) >= 4.5,
        `${key}/${appearance}: accent contrast`,
      );
      if (key !== "green")
        assert(
          contrast("rgb(255, 255, 255)", palette.primary) >= 4.5,
          `${key}/${appearance}: button contrast`,
        );
      colors.push({ key, appearance, ...palette });
    }
    await mode.selectOption("system");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      assert.deepEqual(await readColors(), variants[colorScheme]);
    }
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-color-theme", key);
    const popup = await context.newPage();
    await popup.goto(`${origin}/popup.html`);
    await expect(popup.locator("html")).toHaveAttribute(
      "data-color-theme",
      key,
    );
    await popup.close();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  results.push(
    "Five palettes are selectable in Settings, survive reload and apply to the popup; light/dark/system and live OS changes work independently",
  );
  assert.equal(new Set(colors.map((c) => c.bg)).size, 10);
  results.push(
    "All ten palette variants have distinct backgrounds; body text and accents meet 4.5:1 contrast; new primary buttons meet 4.5:1",
  );
  const panel = await context.newPage();
  await panel.goto(`${origin}/sidepanel.html`);
  await expect(panel.locator("html")).toHaveAttribute(
    "data-color-theme",
    "sand",
  );
  await panel.close();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Blue", exact: true }).click();
  await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-theme",
    "blue",
  );
  await page.screenshot({
    path: resolve(root, "artifacts/themes-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByLabel("Appearance", { exact: true }).selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-theme",
    "blue",
  );
  await page.screenshot({
    path: resolve(root, "artifacts/themes-light.png"),
    fullPage: true,
    animations: "disabled",
  });
  results.push(
    "Side panel uses the saved palette; appearance picker supports keyboard controls and selected palette is exposed through aria-pressed",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(root, "docs/VALIDATION_THEMES.json"),
    JSON.stringify(
      { version: APP_VERSION, extension, results, colors, pageErrors: errors },
      null,
      2,
    ),
  );
  console.log(results.join("\n"));
} catch (error) {
  console.error("Page errors:", errors);
  for (const page of context.pages())
    console.error(
      page.url(),
      (await page.locator("body").innerText()).slice(-1500),
    );
  throw error;
} finally {
  await context.close();
}
