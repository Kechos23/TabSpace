import "./development-maintenance.mjs";
import { resolve } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const bundle = resolve(root, "artifacts/drag-group"),
  ext = resolve(bundle, "extension");
const { extensionId } = JSON.parse(
  await readFile(resolve(bundle, "identity.json"), "utf8"),
);
const stamp = Date.now(),
  profile = resolve(root, `artifacts/drag-group-test-profile-${stamp}`);
const reportPath = resolve(profile, "validation.json");
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: false,
  viewport: null,
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    "--window-size=1100,780",
    "--no-first-run",
  ],
});
let page;
for (let attempt = 0; attempt < 60; attempt++) {
  page = context
    .pages()
    .find(
      (p) => p.url() === `chrome-extension://${extensionId}/controller.html`,
    );
  if (page) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!page) throw new Error("Automatic controller did not open.");
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.evaluate(() =>
  chrome.runtime.sendMessage({ type: "setEnabled", enabled: false }),
);
for (let attempt = 0; attempt < 40; attempt++) {
  if ((await page.locator("#status").textContent()).startsWith("Paused")) break;
  await page.waitForTimeout(100);
}
await page.evaluate(async () => {
  const self = await chrome.tabs.getCurrent();
  await chrome.tabs.update(self.id, { pinned: true });
});
await page
  .getByRole("button", { name: "Open two local test tabs", exact: true })
  .click();
await page.waitForFunction(
  async () =>
    !document.getElementById("fixtures").disabled &&
    (await chrome.runtime.getContexts({ contextTypes: ["TAB"] })).filter((c) =>
      c.documentUrl?.includes("/fixture.html?name="),
    ).length === 2,
);
const fixturePages = context
  .pages()
  .filter((p) => p.url().includes("/fixture.html?name="));
if (fixturePages.length !== 2)
  throw new Error("Exactly two fixture pages are required.");
for (const fixture of fixturePages)
  await fixture.evaluate(() => {
    document.title = "Identical fixture title";
  });
if (process.env.DRAG_GROUP_DISTANT_FIXTURE === "1")
  await page.evaluate(async () => {
    const self = await chrome.tabs.getCurrent();
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["TAB"],
      windowIds: [self.windowId],
    });
    const target = contexts.find((c) =>
      c.documentUrl?.endsWith("fixture.html?name=B"),
    );
    const tab = await chrome.tabs.get(target.tabId);
    for (const [offset, name] of ["C", "D"].entries())
      await chrome.tabs.create({
        windowId: self.windowId,
        index: tab.index + offset,
        url: chrome.runtime.getURL(`fixture.html?name=${name}`),
        active: false,
      });
  });
// Test-only observation of real native mapping messages, before Enable connects.
await page.evaluate(() => {
  const connect = chrome.runtime.connectNative.bind(chrome.runtime);
  globalThis.nativeMaps = [];
  globalThis.nativeMapSequence = 0;
  chrome.runtime.connectNative = (...args) => {
    const port = connect(...args);
    port.onMessage.addListener((message) => {
      if (message.type === "mapped") {
        globalThis.nativeMaps.push({
          sequence: ++globalThis.nativeMapSequence,
          windowId: message.windowId,
        });
        if (globalThis.nativeMaps.length > 20) globalThis.nativeMaps.shift();
      }
    });
    return port;
  };
});
await page
  .getByRole("button", { name: "Enable everywhere", exact: true })
  .click();
await page.bringToFront();
await page.evaluate(async () => {
  const self = await chrome.tabs.getCurrent();
  await chrome.windows.update(self.windowId, { focused: true });
});
if (process.env.DRAG_GROUP_MAXIMIZED === "1")
  await page.evaluate(async () => {
    const self = await chrome.tabs.getCurrent();
    await chrome.windows.update(self.windowId, { state: "maximized" });
  });
console.log(
  "Isolated visible Chromium test window opened; extension/helper enabled. No ordinary Chrome profile is used.",
);
let prior,
  ready = false;
const report = {
  date: "2026-10-19",
  version: JSON.parse(await readFile(resolve(ext, "manifest.json"), "utf8"))
    .version,
  browser: context.browser()?.version(),
  installedChrome: "155.0.8059.80",
  extensionId,
  profile,
  ready: false,
  windowState: await page.evaluate(async () => {
    const self = await chrome.tabs.getCurrent();
    return (await chrome.windows.get(self.windowId)).state;
  }),
  duplicateFixtureTitles: true,
  distantFixture: process.env.DRAG_GROUP_DISTANT_FIXTURE === "1",
  errors,
  notes:
    "Separate visible Chromium; no real dwell/drop assertion is inferred from mapped status.",
};
try {
  for (
    let i = 0;
    i < Number(process.env.DRAG_GROUP_TEST_SECONDS ?? 90) * 4;
    i++
  ) {
    const status = await page.locator("#status").textContent();
    if (status !== prior) {
      console.log("Controller status: " + status);
      prior = status;
    }
    const result = await page.locator("#result").textContent();
    report.gestureEvents = await page.locator("#trace li").allTextContents();
    if (result && !report.lastResult) {
      report.lastResult = result;
      console.log("Grouping result: " + result);
    }
    if (status.startsWith("Ready")) {
      ready = true;
      report.ready = true;
      if (!report.controllerScreenshot) {
        await mkdir(resolve(root, "docs/screenshots"), { recursive: true });
        await page.screenshot({
          path: resolve(root, "docs/screenshots/drag-group-controller.png"),
          fullPage: true,
        });
        report.controllerScreenshot =
          "docs/screenshots/drag-group-controller.png";
      }
    }
    if (
      ready &&
      process.env.DRAG_GROUP_API_FIXTURE === "1" &&
      !report.backgroundMapping
    ) {
      const other = await page.evaluate(async () => {
        const self = await chrome.tabs.getCurrent();
        const window = await chrome.windows.create({
          url: chrome.runtime.getURL("fixture.html?name=B"),
          focused: true,
        });
        return {
          other: window.id,
          original: self.windowId,
          since: globalThis.nativeMapSequence,
        };
      });
      try {
        let observed = false;
        for (let attempt = 0; attempt < 32; attempt++) {
          const state = await page.evaluate(
            async (ids) => ({
              focused: (await chrome.windows.get(ids.original)).focused,
              fresh: globalThis.nativeMaps.filter(
                (m) => m.sequence > ids.since && m.windowId === ids.original,
              ).length,
            }),
            other,
          );
          if (!state.focused && state.fresh >= 2) {
            observed = true;
            break;
          }
          await page.waitForTimeout(250);
        }
        if (!observed)
          throw new Error(
            "The opted-in background window did not receive two fresh maps.",
          );
        report.backgroundMapping = await page.evaluate((ids) => {
          const maps = globalThis.nativeMaps.filter(
            (m) => m.sequence > ids.since,
          );
          if (maps.some((m) => m.windowId !== ids.original))
            throw new Error("Native mapping escaped the opted-in window.");
          if (maps.length < 2)
            throw new Error("Expected two fresh background maps.");
          return { freshMaps: maps.length, onlyOptedInWindow: true };
        }, other);
      } finally {
        await page.evaluate(async (ids) => {
          await chrome.windows.remove(ids.other);
          await chrome.windows.update(ids.original, { focused: true });
        }, other);
      }
      await page.waitForFunction(
        () => document.getElementById("status").textContent.startsWith("Ready"),
        null,
        { timeout: 8000 },
      );
      console.log(
        "Native mapping: duplicate titles accepted; opted-in window keeps fresh maps while another Chrome window has focus.",
      );
    }
    if (
      ready &&
      process.env.DRAG_GROUP_API_FIXTURE === "1" &&
      !report.browserExecutor
    ) {
      report.browserExecutor = await page.evaluate(async (distant) => {
        const { applyGesture } = await import("./grouping.js");
        const self = await chrome.tabs.getCurrent();
        const contexts = await chrome.runtime.getContexts({
          contextTypes: ["TAB"],
          windowIds: [self.windowId],
        });
        const a = contexts.find((c) =>
            c.documentUrl?.endsWith("fixture.html?name=A"),
          ),
          b = contexts.find((c) =>
            c.documentUrl?.endsWith("fixture.html?name=B"),
          );
        if (!a || !b)
          throw new Error("Both local fixture pages must have loaded.");
        await chrome.tabs.update(a.tabId, { active: true });
        const get = async () => ({
          windowId: self.windowId,
          beaconId: self.id,
          tabs: (await chrome.tabs.query({ windowId: self.windowId }))
            .sort((a, b) => a.index - b.index)
            .map((t) => ({
              id: t.id,
              index: t.index,
              pinned: t.pinned,
              groupId: t.groupId,
              highlighted: t.highlighted,
            })),
        });
        const capture = {
          ...(await get()),
          mapId: "explicit-browser-executor-fixture",
          capturedAt: Date.now(),
        };
        const sourceIndex = capture.tabs.find((t) => t.id === a.tabId).index,
          targetIndex = capture.tabs.find((t) => t.id === b.tabId).index;
        const intervening = capture.tabs
          .filter(
            (t) =>
              t.index > Math.min(sourceIndex, targetIndex) &&
              t.index < Math.max(sourceIndex, targetIndex),
          )
          .map((t) => t.id);
        if (distant && intervening.length < 2)
          throw new Error("Expected at least two intervening tabs.");
        const message = {
          mapId: capture.mapId,
          windowId: self.windowId,
          sourceId: a.tabId,
          targetId: b.tabId,
        };
        let calls = 0;
        const adapter = {
          snapshot: get,
          focused: async () =>
            (await chrome.windows.get(self.windowId)).focused,
          enabled: () => true,
          createGroup: async (options) => {
            calls++;
            return chrome.tabs.group(options);
          },
        };
        let rejected = false;
        try {
          await applyGesture({ ...message, mapId: "stale" }, capture, adapter);
        } catch {
          rejected = true;
        }
        if (!rejected || calls !== 0)
          throw new Error("Invalid map reached the browser mutation.");
        const groupId = await applyGesture(message, capture, adapter);
        const members = (await chrome.tabs.query({ groupId }))
          .map((t) => t.id)
          .sort((a, b) => a - b);
        if (
          JSON.stringify(members) !==
          JSON.stringify([a.tabId, b.tabId].sort((a, b) => a - b))
        )
          throw new Error("The real group has unexpected members.");
        const remaining = await get();
        if (
          intervening.some(
            (id) => remaining.tabs.find((t) => t.id === id)?.groupId !== -1,
          )
        )
          throw new Error("An intervening tab was unexpectedly grouped.");
        return {
          passed: true,
          realGroupId: groupId,
          expectedTwoMembers: true,
          staleIntentRejected: true,
          nativeMouseGesture: false,
          interveningTabsUntouched: intervening.length,
        };
      }, process.env.DRAG_GROUP_DISTANT_FIXTURE === "1");
      console.log(
        "Shared browser executor fixture: actual A+B group created; stale map rejected. This does not simulate an OS mouse gesture.",
      );
    }
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    await page.waitForTimeout(250);
    if (process.env.DRAG_GROUP_EXIT_WHEN_READY === "1" && ready) break;
  }
} finally {
  try {
    await page
      .getByRole("button", { name: "Pause everywhere", exact: true })
      .click();
  } catch {}
  await context.close();
  await writeFile(
    reportPath,
    JSON.stringify({ ...report, helperDisconnected: true }, null, 2),
  );
  await writeFile(
    resolve(root, "docs/DRAG_GROUP_DESKTOP.json"),
    JSON.stringify({ ...report, helperDisconnected: true }, null, 2),
  );
  console.log(`Visible desktop run ended. Mapping ready: ${ready}.`);
}
