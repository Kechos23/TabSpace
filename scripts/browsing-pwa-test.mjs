import "./development-maintenance.mjs";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { APP_VERSION } from "../packages/domain/version.ts";
import { entity } from "../packages/domain/model.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const extension = resolve(
  process.env.TABSPACE_EXTENSION_DIR || resolve(root, "dist/core"),
);
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/pwa-lifecycle-${Date.now()}`),
  {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  },
);
const results = [],
  errors = [];
try {
  await context.route("https://pwa.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<title>Fixture</title><p>Offline</p>`,
    }),
  );
  let worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const origin = `chrome-extension://${worker.url().split("/")[2]}`;
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/parking.html`);
  // A script-free extension page keeps the API transport alive in a popup.
  // Manager routing/history and UI effects are not part of this lifecycle fixture.
  await page.evaluate(async () => {
    const tab = await chrome.tabs.getCurrent();
    await chrome.windows.create({ tabId: tab.id, type: "popup" });
  });
  await page.waitForLoadState("load");
  const rpc = async (message) => {
    const response = await page.evaluate(
      (message) => chrome.runtime.sendMessage(message),
      message,
    );
    assert(response.ok, response.error);
    return response.value;
  };
  const load = () => rpc({ type: "load" });
  const meta = (key) =>
    page.evaluate(
      (key) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("TabSpace-v1");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const read = db.transaction("meta").objectStore("meta").get(key);
            read.onsuccess = () => {
              resolve(read.result?.value);
              db.close();
            };
          };
        }),
      key,
    );
  const normal = () =>
    page.evaluate(() =>
      chrome.windows.getAll({ windowTypes: ["normal"], populate: true }),
    );
  const closeNormal = async () => {
    await page.evaluate(async () => {
      for (const window of await chrome.windows.getAll({
        windowTypes: ["normal"],
      }))
        await chrome.windows.remove(window.id);
    });
    await expect
      .poll(async () => (await meta("browsing:lifecycle"))?.open)
      .toBe(false);
  };
  const initial = await page.evaluate(() =>
    chrome.windows.create({
      url: ["https://pwa.test/alpha", "https://pwa.test/beta"],
      focused: false,
    }),
  );
  await expect
    .poll(async () =>
      (await load()).sessions.some(
        (binding) => binding.windowId === initial.id,
      ),
    )
    .toBe(true);
  const spaceId = (await load()).sessions.find(
    (binding) => binding.windowId === initial.id,
  ).spaceId;
  await page.evaluate(async (windowId) => {
    const tabs = await chrome.tabs.query({ windowId });
    await chrome.tabs.update(tabs.find((tab) => tab.url.endsWith("/beta")).id, {
      active: true,
    });
  }, initial.id);
  await expect
    .poll(
      async () =>
        (await meta("browsing:last-session"))?.windows.find(
          (entry) => entry.spaceId === spaceId,
        )?.activeTab?.url,
    )
    .toBe("https://pwa.test/beta");
  await page.evaluate(
    (windowId) =>
      chrome.tabs.create({
        windowId,
        url: "https://pwa.test/pinned",
        pinned: true,
        active: true,
      }),
    initial.id,
  );
  await expect
    .poll(
      async () =>
        (await meta("browsing:last-session"))?.windows.find(
          (entry) => entry.spaceId === spaceId,
        )?.pinned.length,
    )
    .toBe(1);
  assert.equal(
    (await meta("browsing:last-session")).windows.find(
      (entry) => entry.spaceId === spaceId,
    ).activeTab.url,
    "https://pwa.test/beta",
  );
  const popup = await page.evaluate(() =>
    chrome.windows.create({
      url: "https://pwa.test/app",
      type: "popup",
      focused: false,
    }),
  );
  await closeNormal();
  const preserved = await meta("browsing:last-session");
  await page.waitForTimeout(2900);
  assert.equal((await normal()).length, 0);
  assert.deepEqual(await meta("browsing:last-session"), preserved);
  assert(
    !(await load()).browser.tabs.some(
      (tab) => tab.url === "https://pwa.test/app",
    ),
  );
  await page.evaluate((windowId) => chrome.windows.remove(windowId), popup.id);
  await page.waitForTimeout(350);
  assert.deepEqual(await meta("browsing:last-session"), preserved);
  results.push(
    "Non-normal app-like windows are excluded; closing the final normal window preserves the last browsing checkpoint while popups remain and popup close events do not replace it",
  );
  // Simulate a fresh browser-session identity in this disposable profile.
  // The separate lifecycle test also exercises actual full browser restarts.
  await page.evaluate(() => chrome.storage.session.clear());
  await rpc({ type: "settings", value: (await load()).settings });
  assert.equal((await normal()).length, 0);
  assert.equal((await meta("browsing:lifecycle")).open, false);
  assert.deepEqual(await meta("browsing:last-session"), preserved);
  results.push(
    "A simulated fresh browser-session identity with only non-normal windows defers startup restoration and keeps the prior browsing record",
  );
  const reopened = await page.evaluate(async () => {
    const window = await chrome.windows.create({
      url: "https://pwa.test/pinned",
      focused: true,
    });
    const tabs = await chrome.tabs.query({ windowId: window.id });
    await chrome.tabs.update(tabs[0].id, { pinned: true, active: true });
    return window;
  });
  await expect
    .poll(
      async () =>
        (await meta("browsing:last-startup"))?.restored.includes(spaceId),
      { timeout: 15000 },
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await normal())
          .flatMap((window) => window.tabs)
          .find((tab) => tab.active && !tab.pinned)?.url,
    )
    .toBe("https://pwa.test/beta");
  assert.equal((await normal()).length, 1);
  assert.equal((await normal())[0].id, reopened.id);
  assert.equal(
    (await normal())[0].tabs.filter(
      (tab) => tab.url === "https://pwa.test/pinned",
    ).length,
    1,
  );
  results.push(
    "Opening a real normal window resumes the previous Space, reuses a pinned-only launch window without duplicating its pin, and activates the last unpinned tab",
  );
  const epoch = (await meta("browsing:lifecycle")).epoch;
  await rpc({ type: "settings", value: (await load()).settings });
  assert.equal((await meta("browsing:lifecycle")).epoch, epoch);
  const nativeWindow = async () =>
    page.evaluate(async () => {
      const window = await chrome.windows.create({
        url: [
          "https://pwa.test/alpha",
          "https://pwa.test/beta",
          "https://pwa.test/other-pin",
        ],
        focused: true,
      });
      const tabs = await chrome.tabs.query({ windowId: window.id });
      await chrome.tabs.update(tabs[2].id, { pinned: true, active: true });
      return window;
    });
  await page.waitForTimeout(2700);
  // Require the active preference to be durable before closing this session.
  await expect
    .poll(
      async () =>
        (await meta("browsing:last-session")).windows.find(
          (entry) => entry.spaceId === spaceId,
        )?.activeTab?.url,
    )
    .toBe("https://pwa.test/beta");
  await closeNormal();
  await nativeWindow();
  await expect
    .poll(async () => (await meta("browsing:lifecycle")).epoch !== epoch)
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await meta("browsing:last-startup"))?.reconnected.includes(spaceId),
      { timeout: 15000 },
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await normal())
          .flatMap((window) => window.tabs)
          .find((tab) => tab.active)?.url,
    )
    .toBe("https://pwa.test/beta");
  assert.equal(
    (await normal())
      .flatMap((window) => window.tabs)
      .filter((tab) => tab.url === "https://pwa.test/alpha").length,
    1,
  );
  results.push(
    "Closing and reopening normal Chrome within the same profile generation triggers a new browsing epoch; native-style restored tabs reconnect despite an extra extension pin and focus the remembered unpinned tab",
  );
  await page.waitForTimeout(2700);
  await closeNormal();
  const next = await nativeWindow();
  await page.waitForTimeout(350);
  await page.evaluate(async (id) => {
    const tabs = await chrome.tabs.query({ windowId: id });
    await chrome.tabs.update(
      tabs.find((tab) => tab.url.endsWith("/alpha")).id,
      { active: true },
    );
  }, next.id);
  await page.waitForTimeout(1200);
  assert.equal(
    (await normal())
      .find((window) => window.id === next.id)
      .tabs.find((tab) => tab.active).url,
    "https://pwa.test/alpha",
  );
  results.push(
    "Selecting a different unpinned tab while startup settles is respected; no delayed focus loop steals it back",
  );
  const project = entity("space", "Working project");
  for (const item of [
    project,
    entity("savedTab", "Shared alpha", {
      spaceId: project.id,
      url: "https://pwa.test/alpha",
    }),
  ])
    await rpc({
      type: "command",
      command: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: item,
      },
    });
  await rpc({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "activateSession",
    payload: { spaceId: project.id, windowId: next.id },
  });
  await expect
    .poll(async () =>
      (await load()).sessions.some(
        (binding) => binding.spaceId === spaceId && binding.parked,
      ),
    )
    .toBe(true);
  await page.waitForTimeout(2700);
  await expect
    .poll(async () =>
      (await meta("browsing:last-session")).windows.some(
        (entry) => entry.spaceId === project.id,
      ),
    )
    .toBe(true);
  await page.evaluate((id) => chrome.windows.remove(id), next.id);
  await expect
    .poll(async () => (await meta("browsing:lifecycle")).open)
    .toBe(false);
  assert((await normal()).length > 0, "A parked normal window remains");
  await page.evaluate(() =>
    chrome.windows.create({ url: "chrome://newtab", focused: true }),
  );
  await expect
    .poll(
      async () =>
        (await meta("browsing:last-startup"))?.restored.includes(project.id),
      { timeout: 15000 },
    )
    .toBe(true);
  assert.equal(
    (await normal())
      .flatMap((window) => window.tabs)
      .filter((tab) => tab.url === "https://pwa.test/alpha").length,
    2,
  );
  results.push(
    "Parked windows do not keep browsing open or falsely block restoration when they share a URL with the working Space; one alpha tab belongs to each Space",
  );
  await page.waitForTimeout(2700);
  const priorEpoch = (await meta("browsing:lifecycle")).epoch;
  const workingId = (await load()).sessions.find(
    (binding) => binding.spaceId === project.id && !binding.parked,
  ).windowId;
  await page.evaluate(async (id) => {
    await chrome.windows.remove(id);
    await chrome.windows.create({ url: "chrome://newtab", focused: true });
  }, workingId);
  await expect
    .poll(
      async () => {
        const last = await meta("browsing:last-startup");
        return (
          last?.epoch !== priorEpoch && last?.restored.includes(project.id)
        );
      },
      { timeout: 15000 },
    )
    .toBe(true);
  results.push(
    "An immediate normal-window close/reopen is detected even within one checkpoint-coalescing interval",
  );
  await page.waitForTimeout(2900);
  const beforeFailure = await meta("browsing:last-session");
  await closeNormal();
  await worker.evaluate(() => {
    const update = chrome.tabs.update.bind(chrome.tabs);
    chrome.tabs.update = (id, properties) => {
      if (properties.active) {
        chrome.tabs.update = update;
        return Promise.reject(
          new Error("Injected vanished tab during restore"),
        );
      }
      return update(id, properties);
    };
  });
  await page.evaluate(() =>
    chrome.windows.create({ url: "chrome://newtab", focused: true }),
  );
  await expect
    .poll(async () => (await meta("browsing:last-startup"))?.error, {
      timeout: 15000,
    })
    .toBe("Injected vanished tab during restore");
  assert((await load()).browsingUnresolved.includes(project.id));
  assert.deepEqual(
    (await meta("browsing:last-session")).windows.find(
      (entry) => entry.spaceId === project.id,
    ).urls,
    beforeFailure.windows.find((entry) => entry.spaceId === project.id).urls,
  );
  const failedEpoch = (await meta("browsing:last-startup")).epoch;
  const count = (await normal()).flatMap((window) => window.tabs).length;
  await rpc({ type: "settings", value: (await load()).settings });
  assert.equal((await meta("browsing:last-startup")).epoch, failedEpoch);
  assert.equal((await normal()).flatMap((window) => window.tabs).length, count);
  results.push(
    "A tab API failure midway through restore preserves the original pending session, keeps manager requests working and does not replay partial effects on subsequent maintenance",
  );
  const after = await load();
  await rpc({
    type: "settings",
    value: { ...after.settings, restoreBrowsing: false },
  });
  await closeNormal();
  await page.evaluate(() =>
    chrome.windows.create({ url: "chrome://newtab", focused: false }),
  );
  await page.waitForTimeout(1300);
  assert.equal(
    (await normal())
      .flatMap((window) => window.tabs)
      .filter((tab) => /^https?:/.test(tab.url)).length,
    0,
  );
  results.push(
    "Restore disabled still prevents restoration on a same-profile normal-window reopening",
  );
  await rpc({
    type: "settings",
    value: { ...(await load()).settings, restoreBrowsing: true },
  });
  const readWorkerMeta = (key) =>
    worker.evaluate(
      (key) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("TabSpace-v1");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const read = db.transaction("meta").objectStore("meta").get(key);
            read.onsuccess = () => {
              resolve(read.result?.value);
              db.close();
            };
          };
        }),
      key,
    );
  // Remove the final manager surface; only website and worker APIs remain.
  await page.goto("https://pwa.test/control");
  assert.equal(
    await worker.evaluate(
      async () =>
        (await chrome.tabs.query({})).filter((tab) =>
          tab.url.startsWith(chrome.runtime.getURL("")),
        ).length,
    ),
    0,
  );
  await worker.evaluate(async () => {
    const window = (
      await chrome.windows.getAll({ windowTypes: ["normal"] })
    )[0];
    const tab = (await chrome.tabs.query({ windowId: window.id }))[0];
    await chrome.tabs.update(tab.id, { url: "https://pwa.test/no-manager" });
  });
  await page.waitForTimeout(2900);
  await expect
    .poll(async () =>
      (await readWorkerMeta("browsing:last-session"))?.windows.some((entry) =>
        entry.urls.includes("https://pwa.test/no-manager"),
      ),
    )
    .toBe(true);
  const backgroundId = (
    await readWorkerMeta("browsing:last-session")
  ).windows.find((entry) =>
    entry.urls.includes("https://pwa.test/no-manager"),
  ).spaceId;
  await worker.evaluate(async () => {
    for (const window of await chrome.windows.getAll({
      windowTypes: ["normal"],
    }))
      await chrome.windows.remove(window.id);
  });
  await expect
    .poll(async () => (await readWorkerMeta("browsing:lifecycle"))?.open)
    .toBe(false);
  await worker.evaluate(() =>
    chrome.windows.create({ url: "chrome://newtab" }),
  );
  await expect
    .poll(
      async () =>
        (await readWorkerMeta("browsing:last-startup"))?.restored.includes(
          backgroundId,
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  assert.equal(
    await worker.evaluate(
      async () =>
        (await chrome.tabs.query({})).filter(
          (tab) => tab.url === "https://pwa.test/no-manager",
        ).length,
    ),
    1,
  );
  results.push(
    "Automatic checkpointing and restoration work with no manager, popup or other TabSpace page open",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(root, "docs/VALIDATION_PWA_BROWSING.json"),
    JSON.stringify(
      {
        version: APP_VERSION,
        extension,
        results,
        pageErrors: errors,
        boundary:
          "App/PWA exclusion exercised using actual non-normal Chrome popup windows; an installed branded-Chrome PWA remains manual acceptance.",
      },
      null,
      2,
    ),
  );
  console.log(results.join("\n"));
} finally {
  await context.close();
}
