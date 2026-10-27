import { build } from "esbuild";
import { resolve } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { cpus, totalmem, release } from "node:os";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, ".."),
  stamp = Date.now();
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
await build({
  stdin: {
    contents:
      "export {entity,defaults,blankDoc} from './packages/domain/model.ts';",
    resolveDir: root,
  },
  outfile: resolve(root, "artifacts/benchmark-model.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
});
const { entity, defaults, blankDoc } = await import(
  `file:///${resolve(root, "artifacts/benchmark-model.mjs").replaceAll("\\", "/")}`
);
const spaces = Array.from({ length: 100 }, (_, i) =>
    entity("space", `Load project ${i}`),
  ),
  entities = [...spaces];
for (const [kind, count] of [
  ["resource", 10000],
  ["note", 1000],
  ["task", 5000],
])
  for (let i = 0; i < count; i++)
    entities.push(
      entity(kind, `${kind} ${i} Σημειώσεις`, {
        spaceId: spaces[0].id,
        url:
          kind === "resource"
            ? `https://benchmark.tabspace.invalid/item/${i}`
            : undefined,
        description: `Evidence about item ${i}`,
        doc: kind === "note" ? blankDoc() : undefined,
      }),
    );
const fixture = resolve(root, `artifacts/browser-load-${stamp}.json`);
await writeFile(
  fixture,
  JSON.stringify({
    app: "TabSpace",
    appVersion: "0.1.0",
    schemaVersion: 1,
    exportId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    inboxId: spaces[0].id,
    entities,
    attachments: [],
    settings: defaults,
    snapshots: [],
    drafts: [],
    revisions: [],
  }),
);
const ext = resolve(root, "dist/core");
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/load-profile-${stamp}`),
  {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  },
);
try {
  await context.route("https://benchmark.tabspace.invalid/**", (r) =>
    r.fulfill({
      body: "<!doctype html><title>Local load fixture</title><p>Isolated offline tab</p>",
      contentType: "text/html",
    }),
  );
  const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker")),
    id = worker.url().split("/")[2],
    page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${id}/index.html`);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator('input[type=file][accept=".json,.zip"]')
    .setInputFiles(fixture);
  await page.getByRole("heading", { name: "Review backup import" }).waitFor();
  await page.getByRole("button", { name: "Replace after backup" }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page
    .getByRole("heading", { name: "Load project 0", exact: true })
    .waitFor({ timeout: 60000 });
  console.log("Large backup imported; measuring real UI.");
  const importState = (
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "load" }))
  ).value;
  assert.equal(importState.entities.length, 16100);
  let began = performance.now();
  await page.reload();
  await page
    .getByRole("heading", { name: "Load project 0", exact: true })
    .waitFor({ timeout: 60000 });
  await page.locator(".virtual-list").waitFor();
  const managerLoadMs = performance.now() - began;
  console.log(`Manager reload: ${managerLoadMs.toFixed(1)} ms`);
  const visibleResourceRows = await page
    .locator(".content-section .item")
    .count();
  assert(visibleResourceRows < 100);
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog").waitFor();
  const times = [];
  for (let i = 0; i < 20; i++) {
    const name = `resource ${9990 + (i % 10)} Σημειώσεις`;
    began = performance.now();
    await page
      .getByRole("textbox", { name: "Search local collection" })
      .fill(`resource ${9990 + (i % 10)}`);
    await page
      .locator("dialog .search-result strong")
      .filter({ hasText: name })
      .waitFor();
    times.push(performance.now() - began);
  }
  await page.keyboard.press("Escape");
  const task = importState.entities.find((e) => e.kind === "task");
  began = performance.now();
  const saved = await page.evaluate(
    async (task) =>
      chrome.runtime.sendMessage({
        type: "command",
        command: {
          schemaVersion: 1,
          commandId: crypto.randomUUID(),
          type: "update",
          id: task.id,
          expectedRevision: task.revision,
          patch: { description: "Measured durable commit" },
        },
      }),
    task,
  );
  assert(saved.ok, saved.error);
  const contentAckMs = performance.now() - began;
  began = performance.now();
  for (let i = 0; i < 300; i++) {
    await worker.evaluate(
      async (i) =>
        chrome.tabs.create({
          url: `https://benchmark.tabspace.invalid/page/${i}`,
          active: false,
        }),
      i,
    );
    if (i % 100 === 99) console.log(`${i + 1} actual fixture tabs opened`);
  }
  const realTabCreationMs = performance.now() - began;
  began = performance.now();
  const after = (
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "load" }))
  ).value;
  assert.equal(
    after.browser.tabs.filter((t) =>
      t.url.startsWith("https://benchmark.tabspace.invalid/page/"),
    ).length,
    300,
  );
  const reconcileAndLoadMs = performance.now() - began;
  assert.deepEqual(errors, []);
  times.sort((a, b) => a - b);
  const result = {
    date: new Date().toISOString(),
    browser: "Chromium 153.0.8010.12",
    hardware: {
      cpu: cpus()[0].model,
      logicalCores: cpus().length,
      memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
      windows: release(),
    },
    dataset: {
      spaces: 100,
      resources: 10000,
      notes: 1000,
      tasks: 5000,
      actualLiveTabs: 300,
      layout:
        "All content in one Space to exercise virtualized worst-case bucket",
    },
    managerReloadUsableMs: Number(managerLoadMs.toFixed(2)),
    visibleResourceRows,
    searchUiMedianMs: Number(times[10].toFixed(2)),
    searchUiP95Ms: Number(times[19].toFixed(2)),
    contentDurableAckMs: Number(contentAckMs.toFixed(2)),
    realTabCreationMs: Number(realTabCreationMs.toFixed(2)),
    reconcileAndLoadMs: Number(reconcileAndLoadMs.toFixed(2)),
    limitations:
      "Local isolated headless Chromium, one UI/save sample and 20 query samples. Hardware screen readers, native gestures, OS crashes, sustained load and background helper CPU remain unmeasured.",
  };
  await writeFile(
    resolve(root, "docs/VALIDATION_BROWSER_PERFORMANCE.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  for (const page of context.pages())
    if (page.url().includes("index.html")) {
      console.error((await page.locator("body").innerText()).slice(0, 3000));
      await page
        .screenshot({
          path: resolve(root, "artifacts/load-failure.png"),
          fullPage: true,
        })
        .catch(() => {});
    }
  throw error;
} finally {
  await context.close();
}
