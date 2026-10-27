import { resolve, dirname } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { unzipSync } from "fflate";
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(".cache/browsers");
const { chromium } = await import("playwright");
const rows = [];
for (const version of ["0.4.8", "0.5.0"]) {
  const out = resolve(`artifacts/variant-comparison-${version}-${Date.now()}`),
    profile = out + "-profile";
  for (const variant of ["core", "newtab"]) {
    const files = unzipSync(
      new Uint8Array(
        await readFile(`artifacts/TabSpace-${version}-${variant}.zip`),
      ),
    );
    for (const [name, bytes] of Object.entries(files)) {
      if (name.includes("..") || name.startsWith("/") || name.includes("\\"))
        throw Error("Unsafe archive path");
      const p = resolve(out, variant, name);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, bytes);
    }
  }
  const launch = (variant) => {
    const ext = resolve(out, variant);
    return chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    });
  };
  let ctx;
  try {
    ctx = await launch("core");
    let w =
      ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
    const id = w.url().split("/")[2];
    let p = await ctx.newPage();
    await p.goto(`chrome-extension://${id}/index.html`);
    await p.getByRole("heading", { name: "Home", exact: true }).waitFor();
    await ctx.close();
    ctx = await launch("newtab");
    p = await ctx.newPage();
    await p.goto("chrome://newtab/");
    await p.getByRole("heading", { name: "Your next useful step" }).waitFor();
    await ctx.close();
    ctx = await launch("core");
    p = await ctx.newPage();
    await p.goto(`chrome-extension://${id}/index.html`);
    await p.getByRole("heading", { name: "Home", exact: true }).waitFor();
    const manifest = await p.evaluate(() => chrome.runtime.getManifest());
    const n = await ctx.newPage();
    await n.goto("chrome://newtab/");
    await n.waitForLoadState("domcontentloaded");
    if (n.url().startsWith("chrome-extension://"))
      await n.getByRole("heading", { name: "Your next useful step" }).waitFor();
    const count = await n
      .getByRole("heading", { name: "Your next useful step" })
      .count();
    rows.push({
      version,
      loadedCoreHasOverride: !!manifest.chrome_url_overrides,
      nativeNewTabUrl: n.url(),
      retainedPreviousVariantPage: count === 1,
    });
    console.log(rows.at(-1));
  } finally {
    await ctx?.close();
  }
}
await writeFile(
  "docs/VALIDATION_VARIANT_ROLLBACK_COMPARISON.json",
  JSON.stringify(
    {
      note: "Isolated Chromium command-line same-ID unpacked path switching; compares unchanged 0.4.8 archives with final 0.5.0 archives.",
      rows,
    },
    null,
    2,
  ),
);
