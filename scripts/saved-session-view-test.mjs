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
  resolve(root, `artifacts/saved-view-profile-${Date.now()}`),
  {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  },
);
const results = [];
try {
  await context.route("https://saved-view.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<title>Saved fixture</title>`,
    }),
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
  const api = async (message) => {
    const response = await page.evaluate(
      (m) => chrome.runtime.sendMessage(m),
      message,
    );
    assert(response?.ok, response?.error);
    return response.value;
  };
  const load = () => api({ type: "load" });
  const waitOwned = async (spaceId, count) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const value = await load();
      if (
        value.browser.tabs.filter((t) => t.spaceId === spaceId && !t.pinned)
          .length === count
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Fixture tabs did not join their session");
  };
  const action = (action, payload) =>
    api({ type: "browser", commandId: crypto.randomUUID(), action, payload });
  const create = async (name, temporary) =>
    (
      await api({
        type: "command",
        command: {
          schemaVersion: 1,
          commandId: crypto.randomUUID(),
          type: "create",
          entity: {
            id: crypto.randomUUID(),
            kind: "space",
            name,
            temporary,
            view: "tabs",
            order: Date.now(),
            revision: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      })
    )[0].id;
  const temp = await create("Temporary preview", true);
  const other = await create("Other Space", false);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("When switching Spaces", { exact: true })
    .selectOption("close");
  const windowId = await page.evaluate(
    async () => (await chrome.windows.getCurrent()).id,
  );
  await action("activateSession", { spaceId: temp, windowId });
  const urls = [
    "https://saved-view.test/a",
    "https://saved-view.test/a",
    "https://saved-view.test/b",
  ];
  for (const [index, url] of urls.entries()) {
    const tab = await context.newPage();
    await tab.goto(url);
    await tab.evaluate((i) => (document.title = `Saved tab ${i}`), index);
  }
  await waitOwned(temp, 3);
  await action("activateSession", { spaceId: other, windowId });
  const snapshot = await load();
  assert.equal(
    snapshot.browser.tabs.filter((t) => t.spaceId === temp).length,
    0,
  );
  assert.deepEqual(
    snapshot.spaceTabs[temp].map((t) => t.url),
    urls,
  );
  await page
    .getByRole("button", { name: "Refresh browser state", exact: true })
    .click();
  const browserBefore = await page.evaluate(async () =>
    (await chrome.tabs.query({}))
      .map((t) => [t.id, t.windowId, t.url, t.active])
      .sort(),
  );
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page
    .getByRole("button", { name: "View Space Temporary preview", exact: true })
    .click();
  await page.locator(".saved-session-tab").nth(2).waitFor();
  assert.equal(await page.locator(".saved-session-tab").count(), 3);
  assert.equal(
    await page.getByRole("heading", { name: "A calm tab strip" }).count(),
    0,
  );
  assert.deepEqual(
    await page.locator(".saved-session-tab .item-name").allTextContents(),
    snapshot.spaceTabs[temp].map((t) => t.title),
  );
  await page.getByText("3 saved session tabs", { exact: true }).waitFor();
  assert.equal(await page.locator(".pane .count").first().textContent(), "3");
  assert.deepEqual((await load()).sessions, snapshot.sessions);
  assert.deepEqual(
    await page.evaluate(async () =>
      (await chrome.tabs.query({}))
        .map((t) => [t.id, t.windowId, t.url, t.active])
        .sort(),
    ),
    browserBefore,
  );
  results.push(
    "Closed temporary Space shows checkpoint titles/order/duplicate URLs without reopening tabs or changing sessions",
  );
  await page.getByRole("button", { name: "Open Space", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".saved-session-tab").length === 0,
  );
  const live = await load();
  assert.deepEqual(
    live.browser.tabs
      .filter((t) => t.spaceId === temp && !t.pinned)
      .sort((a, b) => a.index - b.index)
      .map((t) => t.url),
    urls,
  );
  await page.getByText("3 live", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("Session actions", { exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "Close Space", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Close Space", exact: true })
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await page.locator(".saved-session-tab").nth(2).waitFor();
  assert(
    await page
      .getByRole("button", { name: "Close Space", exact: true })
      .isDisabled(),
  );
  assert.deepEqual(
    (await load()).spaceTabs[temp].map((t) => t.url),
    urls,
  );
  await page.getByRole("button", { name: "Open Space", exact: true }).click();
  await page.getByText("3 live", { exact: true }).waitFor();
  results.push(
    "Header Open Space and Close Space preserve the saved tabs; Session actions is removed and Close is disabled for a closed Space",
  );

  results.push(
    "Explicit Open session restores the saved tabs and replaces the preview with live rows",
  );
  // The same preview must work for an ordinary, closed Space.
  await action("activateSession", { spaceId: other, windowId });
  const regular = await context.newPage();
  await regular.goto("https://saved-view.test/regular");
  await waitOwned(other, 1);
  await action("activateSession", { spaceId: temp, windowId });
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page
    .getByRole("button", { name: "View Space Other Space", exact: true })
    .click();
  await page.locator(".saved-session-tab").waitFor();
  assert.equal(await page.locator(".saved-session-tab").count(), 1);
  results.push("Closed ordinary Spaces use the same saved-session preview");
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: resolve(root, "artifacts/saved-session-view.png"),
  });
  await writeFile(
    resolve(root, "docs/VALIDATION_SAVED_SESSION_VIEW.json"),
    JSON.stringify({ extension, results }, null, 2),
  );
  console.log(results.map((name) => `PASS ${name}`).join("\n"));
} finally {
  await context.close();
}
