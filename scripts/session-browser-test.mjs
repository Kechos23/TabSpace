import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const extension = resolve(
  process.env.TABSPACE_EXTENSION_DIR || resolve(root, "dist/core"),
);
const profile = resolve(root, `artifacts/session-profile-${Date.now()}`);
await mkdir(profile, { recursive: true });
const launch = () =>
  chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
let context = await launch();
const results = [];
const passed = (name) => {
  results.push(name);
  console.log("PASS", name);
};
try {
  await context.route("https://session.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><title>Session fixture</title><input id="draft"><div style="height:5000px">Local offline fixture</div>',
    }),
  );
  let worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = worker.url().split("/")[2];
  let manager = await context.newPage();
  await manager.goto(`chrome-extension://${id}/index.html`);
  const api = async (message) => {
    const r = await manager.evaluate(
      (m) => chrome.runtime.sendMessage(m),
      message,
    );
    assert(r?.ok, r?.error || JSON.stringify(r));
    return r.value;
  };
  const action = (action, payload = {}) =>
    api({ type: "browser", commandId: crypto.randomUUID(), action, payload });
  const load = () => api({ type: "load" });
  const eventually = async (read, check, label) => {
    for (let i = 0; i < 60; i++) {
      const value = await read();
      if (check(value)) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error(`Timed out: ${label}`);
  };
  const create = async (name) => {
    const now = new Date().toISOString();
    const value = await api({
      type: "command",
      command: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: {
          id: crypto.randomUUID(),
          kind: "space",
          name,
          createdAt: now,
          updatedAt: now,
          revision: 1,
          order: Date.now(),
        },
      },
    });
    return value[0].id;
  };
  const A = await create("Session A"),
    B = await create("Session B"),
    C = await create("Session C");
  const windowId = await manager.evaluate(
    async () => (await chrome.windows.getCurrent()).id,
  );
  const original = await context.newPage();
  await original.goto("https://session.test/original");
  const pinned = await manager.evaluate(
    async () =>
      (
        await chrome.tabs.create({
          url: "https://session.test/pinned",
          pinned: true,
          active: false,
        })
      ).id,
  );
  await action("activateSession", { spaceId: A, windowId });
  let state = await load();
  assert(
    state.sessions.some(
      (s) => s.spaceId === A && !s.parked && s.windowId === windowId,
    ),
  );
  assert(
    state.entities.some((e) => e.temporary && /^Unsaved \d+$/.test(e.name)),
  );
  assert.equal(
    state.browser.tabs.find((t) => t.id === pinned).windowId,
    windowId,
  );
  passed(
    "First activation preserves unmanaged browsing as a temporary session; pinned stays global",
  );
  const a = await context.newPage();
  await a.goto("https://session.test/a");
  const a2 = await context.newPage();
  await a2.goto("https://session.test/a2");
  await a.locator("#draft").fill("unsaved local draft");
  await a.evaluate(() => {
    window.fixtureIdentity = crypto.randomUUID();
    window.scrollTo(0, 700);
  });
  const identity = await a.evaluate(() => window.fixtureIdentity);
  state = await eventually(
    load,
    (s) => s.browser.tabs.filter((t) => t.spaceId === A).length === 2,
    "new tabs join active Space",
  );
  const aid = state.browser.tabs.find(
    (t) => t.url === "https://session.test/a",
  ).id;
  const a2id = state.browser.tabs.find(
    (t) => t.url === "https://session.test/a2",
  ).id;
  const groupId = await manager.evaluate(
    async (ids) => {
      const group = await chrome.tabs.group({ tabIds: ids });
      await chrome.tabGroups.update(group, {
        title: "Research",
        color: "purple",
      });
      return group;
    },
    [aid, a2id],
  );
  await eventually(
    load,
    (s) => s.browser.groups.some((g) => g.id === groupId && g.spaceId === A),
    "manual group belongs to active Space",
  );
  passed(
    "New tabs and manually created groups automatically belong to the active session",
  );
  await action("activateSession", { spaceId: B, windowId });
  state = await load();
  const parking = state.sessions.find((s) => s.spaceId === A && s.parked);
  assert(parking);
  assert.equal(
    state.browser.tabs.find((t) => t.id === aid).windowId,
    parking.windowId,
  );
  assert.equal(
    await manager.evaluate(
      async (id) => (await chrome.windows.get(id)).state,
      parking.windowId,
    ),
    "minimized",
  );
  const b = await context.newPage();
  await b.goto("https://session.test/b");
  await eventually(
    load,
    (s) =>
      s.browser.tabs.some(
        (t) => t.url === "https://session.test/b" && t.spaceId === B,
      ),
    "B owns new tab",
  );
  const foreignPin = await manager.evaluate(
    async (windowId) =>
      (
        await chrome.tabs.create({
          windowId,
          url: "https://session.test/foreign-pinned",
          pinned: true,
          active: false,
        })
      ).id,
    parking.windowId,
  );
  await action("activateSession", { spaceId: A, windowId });
  state = await load();
  assert.equal(state.browser.tabs.find((t) => t.id === aid).windowId, windowId);
  assert.equal(state.browser.tabs.find((t) => t.id === aid).groupId, groupId);
  assert.deepEqual(
    state.browser.tabs
      .filter((t) => t.groupId === groupId)
      .sort((a, b) => a.index - b.index)
      .map((t) => t.id),
    [aid, a2id],
  );
  assert.equal(await a.locator("#draft").inputValue(), "unsaved local draft");
  assert.equal(await a.evaluate(() => window.fixtureIdentity), identity);
  assert.equal(await a.evaluate(() => window.scrollY), 700);
  assert.equal(
    state.browser.groups.find((g) => g.id === groupId).title,
    "Research",
  );
  passed(
    "A→B→A preserves native group ID, order, color, page identity, unsaved form and scroll",
  );
  await action("activateSession", { spaceId: B, windowId });
  assert.equal(
    (await load()).sessions.filter((s) => s.spaceId === A && s.parked).length,
    1,
  );
  assert.equal(
    (await load()).sessions.find((s) => s.spaceId === A && s.parked).windowId,
    parking.windowId,
  );
  await action("activateSession", { spaceId: A, windowId });
  assert.equal(
    (await manager.evaluate((id) => chrome.tabs.get(id), foreignPin)).windowId,
    parking.windowId,
  );
  passed(
    "Parking windows containing unrelated pinned tabs are preserved and reused without accumulating windows",
  );
  const mirror = await context.newPage();
  await mirror.goto(`chrome-extension://${id}/sidepanel.html`);
  const windowsBefore = await manager.evaluate(
    async () => (await chrome.windows.getAll()).length,
  );
  await action("activateSession", { spaceId: A });
  assert.equal(
    await manager.evaluate(async () => (await chrome.windows.getAll()).length),
    windowsBefore,
  );
  passed(
    "Opening an already active Space focuses its window without duplicating it",
  );
  await action("moveToSpace", { spaceId: B, ids: [a2id] });
  state = await load();
  assert.equal(state.browser.tabs.find((t) => t.id === a2id).spaceId, B);
  assert.equal(state.browser.tabs.find((t) => t.id === aid).spaceId, A);
  assert.equal(state.browser.tabs.find((t) => t.id === aid).windowId, windowId);
  assert.equal(await a.locator("#draft").inputValue(), "unsaved local draft");
  await action("moveToSpace", { spaceId: A, ids: [a2id] });
  assert.equal(
    (await load()).browser.tabs.find((t) => t.id === a2id).spaceId,
    A,
  );
  passed(
    "Moving a partial group to an inactive Space preserves unselected siblings and page state",
  );
  const detached = await manager.evaluate(
    async () =>
      (
        await chrome.windows.create({
          url: chrome.runtime.getURL("index.html"),
          focused: false,
        })
      ).id,
  );
  await manager.evaluate(
    async ({ aid, detached }) => {
      await chrome.tabs.ungroup(aid);
      await chrome.tabs.move(aid, { windowId: detached, index: -1 });
    },
    { aid, detached },
  );
  state = await eventually(
    load,
    (s) => s.sessions.some((b) => b.windowId === detached && !b.parked),
    "detached window auto-managed",
  );
  const detachedBinding = state.sessions.find(
    (b) => b.windowId === detached && !b.parked,
  );
  assert.notEqual(detachedBinding.spaceId, A);
  assert.equal(
    state.browser.tabs.find((t) => t.id === aid).spaceId,
    detachedBinding.spaceId,
  );
  await manager.evaluate(
    async ({ aid, windowId }) => chrome.tabs.move(aid, { windowId, index: -1 }),
    { aid, windowId },
  );
  await eventually(
    load,
    (s) => s.browser.tabs.find((t) => t.id === aid)?.spaceId === A,
    "reattached tab follows destination",
  );
  passed(
    "Detach creates an independent temporary session; attach follows destination ownership",
  );
  await action("closeSession", { spaceId: A });
  await action("closeSession", { spaceId: A });
  assert(
    !(await load()).browser.tabs.some((t) => t.id === aid || t.id === a2id),
  );
  await action("activateSession", { spaceId: A, windowId });
  state = await load();
  assert.equal(
    state.browser.tabs.filter(
      (t) => t.spaceId === A && t.url.startsWith("https://session.test/a"),
    ).length,
    2,
  );
  passed(
    "Close session and reopen restores website URLs without deleting the Space",
  );
  const owned = state.browser.tabs
    .filter((t) => t.spaceId === A && !t.pinned)
    .map((t) => t.id);
  await manager.evaluate((ids) => chrome.tabs.remove(ids), owned);
  await eventually(
    load,
    (s) => !s.browser.tabs.some((t) => t.spaceId === A && !t.pinned),
    "last tab closed",
  );
  // Ensure the event-driven checkpoint has observed the empty session.
  await eventually(
    () =>
      manager.evaluate(async () => {
        const req = indexedDB.open("TabSpace-v1");
        const db = await new Promise((r, j) => {
          req.onsuccess = () => r(req.result);
          req.onerror = () => j(req.error);
        });
        return await new Promise((r) => {
          const q = db.transaction("meta").objectStore("meta").getAll();
          q.onsuccess = () => {
            db.close();
            r(
              q.result
                .filter((x) => x.id.startsWith("session:checkpoint:"))
                .map((x) => x.value.snapshot),
            );
          };
        });
      }),
    (snaps) =>
      snaps.some(
        (s) => s.reason === `Space session: ${A}` && s.tabs.length === 0,
      ),
    "empty session persisted",
  );
  await action("activateSession", { spaceId: B, windowId });
  await action("activateSession", { spaceId: A, windowId });
  assert(
    !(await load()).browser.tabs.some((t) => t.spaceId === A && !t.pinned),
  );
  passed(
    "Closing the last tab records an empty session and does not resurrect removed tabs",
  );
  await Promise.all([
    action("activateSession", { spaceId: B, windowId }),
    action("activateSession", { spaceId: C, windowId }),
    action("activateSession", { spaceId: A, windowId }),
  ]);
  state = await load();
  assert.equal(
    state.sessions.find((s) => s.windowId === windowId && !s.parked).spaceId,
    A,
  );
  passed(
    "Rapid A/B/C switching is serialized and finishes with the requested Space",
  );
  await action("activateSession", { spaceId: B, windowId });
  const cdp = await context.newCDPSession(manager);
  await cdp.send("ServiceWorker.enable");
  const beforeWorker = await load();
  const bLive = beforeWorker.browser.tabs.find(
    (t) => t.spaceId === B && t.url === "https://session.test/b",
  );
  assert(bLive);
  await cdp.send("ServiceWorker.stopAllWorkers");
  state = await load();
  assert.equal(state.browser.tabs.find((t) => t.id === bLive.id).spaceId, B);
  assert(state.sessions.some((s) => s.spaceId === B && !s.parked));
  passed(
    "Worker termination preserves session ownership and live tab identity",
  );
  await manager.evaluate(async (spaceId) => {
    const req = indexedDB.open("TabSpace-v1");
    const db = await new Promise((r, j) => {
      req.onsuccess = () => r(req.result);
      req.onerror = () => j(req.error);
    });
    await new Promise((r, j) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put({
        id: "session:operation",
        value: { spaceId, intent: "fixture interrupted switch" },
      });
      tx.oncomplete = () => {
        db.close();
        r();
      };
      tx.onerror = () => j(tx.error);
    });
  }, B);
  await cdp.send("ServiceWorker.stopAllWorkers");
  state = await load();
  assert(state.sessionInterrupted);
  const blocked = await manager.evaluate(
    (spaceId) =>
      chrome.runtime.sendMessage({
        type: "browser",
        commandId: crypto.randomUUID(),
        action: "activateSession",
        payload: { spaceId },
      }),
    A,
  );
  assert.equal(blocked.ok, false);
  assert((await load()).browser.tabs.some((t) => t.id === bLive.id));
  await action("acknowledgeSessionFailure");
  assert.equal((await load()).sessionInterrupted, false);
  passed(
    "Interrupted transitions are surfaced, not replayed; explicit inspection acknowledgment resumes management",
  );
  await action("activateSession", { spaceId: A, windowId });
  state = await load();
  const parkedB = state.sessions.find((s) => s.spaceId === B && s.parked);
  assert(parkedB);
  const readCheckpoint = () =>
    manager.evaluate(async (spaceId) => {
      const req = indexedDB.open("TabSpace-v1");
      const db = await new Promise((r) => {
        req.onsuccess = () => r(req.result);
      });
      return await new Promise((r) => {
        const q = db
          .transaction("meta")
          .objectStore("meta")
          .get(`session:checkpoint:${spaceId}`);
        q.onsuccess = () => {
          db.close();
          r(q.result?.value);
        };
      });
    }, B);
  assert(
    (await readCheckpoint()).snapshot.tabs.some(
      (t) => t.url === "https://session.test/b",
    ),
  );
  await manager.evaluate((id) => chrome.windows.remove(id), parkedB.windowId);
  assert(
    (await readCheckpoint()).snapshot.tabs.some(
      (t) => t.url === "https://session.test/b",
    ),
  );
  await action("activateSession", { spaceId: B, windowId });
  state = await eventually(
    load,
    (s) =>
      s.browser.tabs.some(
        (t) => t.spaceId === B && t.url === "https://session.test/b",
      ),
    "parking URL restore settles",
  );
  const restoredB = state.browser.tabs.find(
    (t) => t.spaceId === B && t.url === "https://session.test/b",
  );
  assert(restoredB);
  assert.notEqual(restoredB.id, bLive.id);
  passed(
    "Closing a parking window recovers website URLs with new tab identities",
  );
  await action("closeSession", { spaceId: B });
  await action("activateSession", { spaceId: A, windowId });
  const appendPage = await context.newPage();
  await appendPage.goto("https://session.test/append");
  state = await eventually(
    load,
    (s) =>
      s.browser.tabs.some(
        (t) => t.url === "https://session.test/append" && t.spaceId === A,
      ),
    "append source joins A",
  );
  const appendId = state.browser.tabs.find(
    (t) => t.url === "https://session.test/append",
  ).id;
  await action("moveToSpace", { spaceId: B, ids: [appendId] });
  state = await eventually(
    load,
    (s) =>
      s.spaceTabs[B].filter((t) =>
        ["https://session.test/b", "https://session.test/append"].includes(
          t.url,
        ),
      ).length === 2,
    "closed destination checkpoint contains old and moved tabs",
  );
  assert.equal(
    state.sessions.some((binding) => binding.spaceId === B && !binding.parked),
    false,
  );
  passed(
    "Moving into a closed Space appends to its saved session without losing its previous tabs",
  );
  await action("closeSession", { spaceId: B });
  await context.close();
  context = await launch();
  await context.route("https://session.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><title>Session fixture</title><input id="draft">',
    }),
  );
  manager = await context.newPage();
  await manager.goto(`chrome-extension://${id}/index.html`);
  await action("activateSession", { spaceId: B });
  state = await eventually(
    load,
    (s) =>
      s.browser.tabs.some(
        (t) => t.spaceId === B && t.url === "https://session.test/b",
      ),
    "restart URL restore settles",
  );
  assert(
    state.browser.tabs.some(
      (t) => t.spaceId === B && t.url === "https://session.test/b",
    ),
  );
  await eventually(
    load,
    (s) =>
      s.browser.tabs.some(
        (t) => t.spaceId === B && t.url === "https://session.test/append",
      ),
    "appended URL survives restart",
  );
  passed(
    "Full browser restart restores the closed session from durable website blueprints",
  );
  await manager.getByRole("button", { name: "Refresh browser state" }).click();
  const cWindowButton = manager
    .locator(".sidebar-section")
    .getByRole("button", { name: "Open Session C in new window", exact: true })
    .first();
  await cWindowButton.click();
  state = await eventually(
    load,
    (s) => s.sessions.some((b) => b.spaceId === C && !b.parked),
    "sidebar opens C window",
  );
  const firstCWindow = state.sessions.find(
    (b) => b.spaceId === C && !b.parked,
  ).windowId;
  const mainWindow = state.sessions.find(
    (b) => b.spaceId === B && !b.parked,
  ).windowId;
  assert.notEqual(firstCWindow, mainWindow);
  const cTab = await manager.evaluate(
    async (windowId) =>
      (
        await chrome.tabs.create({
          windowId,
          url: "https://session.test/c",
          active: false,
        })
      ).id,
    firstCWindow,
  );
  await eventually(
    load,
    (s) => s.browser.tabs.some((t) => t.id === cTab && t.spaceId === C),
    "C tab auto-owned",
  );
  passed(
    "Sidebar new-window button opens a closed Space in an independent window",
  );
  const temporaryCount = (await load()).entities.filter(
    (e) => e.kind === "space" && e.temporary && !e.deletedAt,
  ).length;
  await cWindowButton.click();
  state = await eventually(
    load,
    (s) =>
      s.sessions.some(
        (b) => b.spaceId === C && !b.parked && b.windowId !== firstCWindow,
      ),
    "active C moved to fresh window",
  );
  const secondCWindow = state.sessions.find(
    (b) => b.spaceId === C && !b.parked,
  ).windowId;
  assert.equal(
    state.browser.tabs.find((t) => t.id === cTab).windowId,
    secondCWindow,
  );
  await manager.waitForTimeout(250);
  assert.equal(
    (await load()).entities.filter(
      (e) => e.kind === "space" && e.temporary && !e.deletedAt,
    ).length,
    temporaryCount,
  );
  passed(
    "New-window button moves an active Space with its existing tab IDs and creates no extra temporary Space",
  );
  const bTree = manager
    .locator(`.sidebar-section [data-space-id="${B}"]`)
    .first();
  const toggle = bTree.getByRole("button", {
    name: "Tabs in Session B",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await bTree.locator(".space-tabs li button").first().waitFor();
  const bPage = context
    .pages()
    .find((p) => p.url() === "https://session.test/b");
  assert(bPage);
  await bPage.evaluate(() => (document.title = "B first website"));
  await bTree.getByText("B first website", { exact: true }).waitFor();
  passed(
    "Sidebar tree shows owned tabs and updates their titles through worker notifications",
  );
  await manager.getByRole("button", { name: "Settings", exact: true }).click();
  await manager
    .getByLabel("When switching Spaces", { exact: true })
    .selectOption("close");
  await eventually(
    load,
    (s) => s.settings.preserveLiveTabs === false,
    "close-on-switch preference persisted",
  );
  const windowCount = await manager.evaluate(
    async () =>
      (await chrome.windows.getAll({ windowTypes: ["normal"] })).length,
  );
  const oldB = (await load()).browser.tabs
    .filter((t) => t.spaceId === B && !t.pinned)
    .map((t) => t.id);
  await action("activateSession", { spaceId: A, windowId: mainWindow });
  state = await load();
  assert(!state.browser.tabs.some((t) => oldB.includes(t.id)));
  assert(!state.sessions.some((b) => b.parked));
  assert(
    (await manager.evaluate(
      async () =>
        (await chrome.windows.getAll({ windowTypes: ["normal"] })).length,
    )) <= windowCount,
  );
  assert(state.browser.tabs.some((t) => t.id === cTab));
  assert(
    state.spaceTabs[B].some(
      (t) => t.url === "https://session.test/b" && !t.live,
    ),
  );
  passed(
    "Disabling live preservation saves/closes outgoing tabs, removes parking windows and keeps other active windows intact",
  );
  const savedToggle = bTree.getByRole("button", {
    name: "Tabs in Session B",
    exact: true,
  });
  if ((await savedToggle.getAttribute("aria-expanded")) !== "true")
    await savedToggle.click();
  const appendIndex = state.spaceTabs[B].findIndex(
    (tab) => tab.url === "https://session.test/append",
  );
  assert(appendIndex >= 0);
  const sessionBindingsBeforeOpen = JSON.stringify(state.sessions);
  await bTree
    .locator(".space-tabs li")
    .nth(appendIndex)
    .locator("button")
    .first()
    .click();
  await eventually(
    load,
    (s) =>
      s.browser.tabs.some(
        (t) =>
          t.spaceId === A &&
          t.url === "https://session.test/append" &&
          t.active,
      ),
    "saved tree item opens and focuses a copy in the current Space",
  );
  assert.equal(
    JSON.stringify((await load()).sessions),
    sessionBindingsBeforeOpen,
  );
  passed(
    "Clicking a saved tree item opens that website in the current Space without activating its source Space",
  );
  await action("activateSession", { spaceId: B, windowId: mainWindow });
  state = await eventually(
    load,
    (s) =>
      s.browser.tabs.some(
        (t) => t.spaceId === B && t.url === "https://session.test/b",
      ),
    "closed-on-switch B restored",
  );
  assert(
    !oldB.includes(
      state.browser.tabs.find(
        (t) => t.spaceId === B && t.url === "https://session.test/b",
      ).id,
    ),
  );
  assert(!state.sessions.some((b) => b.parked));
  passed(
    "Close-on-switch restores saved URLs with new IDs and no new parking window",
  );
  const originalSpace = state.entities.find(
    (e) =>
      e.kind === "space" &&
      e.temporary &&
      state.spaceTabs[e.id]?.some(
        (t) => t.url === "https://session.test/original",
      ),
  );
  assert(originalSpace);
  const restoredWindow = await manager.evaluate(
    async () =>
      (
        await chrome.windows.create({
          url: chrome.runtime.getURL("index.html"),
          focused: false,
        })
      ).id,
  );
  const restoredId = await manager.evaluate(
    async (windowId) =>
      (
        await chrome.tabs.create({
          windowId,
          url: "https://session.test/original",
          active: false,
        })
      ).id,
    restoredWindow,
  );
  state = await eventually(
    load,
    (s) =>
      s.browser.tabs.some(
        (t) =>
          t.id === restoredId &&
          t.url === "https://session.test/original" &&
          !!t.spaceId,
      ),
    "new window's automatic Unsaved ownership settled",
  );
  const freshOwner = state.browser.tabs.find(
    (t) => t.id === restoredId,
  ).spaceId;
  assert(freshOwner && freshOwner !== originalSpace.id);
  const countBeforeReopen = state.entities.filter(
    (e) => e.kind === "space" && e.temporary && !e.deletedAt,
  ).length;
  await action("activateSession", {
    spaceId: originalSpace.id,
    windowId: restoredWindow,
  });
  state = await load();
  assert(
    state.browser.tabs.some(
      (t) =>
        t.spaceId === originalSpace.id &&
        t.url === "https://session.test/original",
    ),
  );
  assert(
    state.spaceTabs[freshOwner].some(
      (t) => t.url === "https://session.test/original",
    ),
  );
  assert.equal(
    state.entities.filter(
      (e) => e.kind === "space" && e.temporary && !e.deletedAt,
    ).length,
    countBeforeReopen,
  );
  passed(
    "A new window owns fresh Unsaved browsing; explicitly opening an older Unsaved restores its URLs while preserving the fresh session without adding another Space",
  );
  await manager.getByRole("button", { name: "Refresh browser state" }).click();
  await manager
    .locator(".space-list")
    .getByRole("button", { name: /Session B/ })
    .filter({ hasText: "Session B" })
    .first()
    .click();
  await manager.screenshot({
    path: resolve(root, "artifacts/session-manager.png"),
    fullPage: true,
  });
  const finalPanel = await context.newPage();
  await finalPanel.goto(`chrome-extension://${id}/sidepanel.html`);
  await finalPanel.setViewportSize({ width: 400, height: 900 });
  await finalPanel.screenshot({
    path: resolve(root, "artifacts/session-sidepanel.png"),
    fullPage: true,
  });
  await writeFile(
    resolve(root, "artifacts/SESSION_VALIDATION.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        extension,
        browser: context.browser()?.version(),
        results,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const page = context.pages().find((p) => p.url().includes("/index.html"));
  if (page) {
    const debug = await page.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({ type: "load" });
      const req = indexedDB.open("TabSpace-v1");
      const db = await new Promise((r) => {
        req.onsuccess = () => r(req.result);
      });
      const rows = await new Promise((r) => {
        const q = db.transaction("meta").objectStore("meta").getAll();
        q.onsuccess = () =>
          r(q.result.filter((x) => x.id.startsWith("session:")));
      });
      db.close();
      return { state: response.value, rows };
    });
    await writeFile(
      resolve(root, "artifacts/session-failure.json"),
      JSON.stringify(debug, null, 2),
    );
  }
  throw error;
} finally {
  await context.close();
}
