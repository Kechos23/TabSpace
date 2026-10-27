import "fake-indexeddb/auto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { repository as repo } from "../packages/persistence/repository";
import { entity } from "../packages/domain/model";
import {
  browserAction,
  live,
  reconcile,
  retryDrag,
} from "../apps/extension/src/background/browser";
let groups: {
  id: number;
  windowId: number;
  title: string;
  color: string;
  collapsed: boolean;
}[];
let tabs: {
  id: number;
  windowId: number;
  index: number;
  groupId: number;
  title: string;
  url: string;
  active: boolean;
  pinned: boolean;
  incognito: boolean;
  autoDiscardable: boolean;
  discarded: boolean;
}[];
beforeEach(async () => {
  await repo.db.delete();
  await repo.db.open();
  await repo.initialize();
  groups = [
    {
      id: 9,
      windowId: 1,
      title: "Untouched",
      color: "green",
      collapsed: false,
    },
  ];
  tabs = [
    {
      id: 1,
      windowId: 1,
      index: 0,
      groupId: 9,
      title: "A",
      url: "https://example.org/a",
      active: true,
      pinned: false,
      incognito: false,
      autoDiscardable: true,
      discarded: false,
    },
    {
      id: 2,
      windowId: 1,
      index: 1,
      groupId: -1,
      title: "B",
      url: "https://example.org/b",
      active: false,
      pinned: true,
      incognito: false,
      autoDiscardable: true,
      discarded: false,
    },
  ];
  vi.stubGlobal("chrome", {
    runtime: { getURL: (s: string) => `chrome-extension://test/${s}` },
    storage: {
      session: {
        get: async () => ({ browserGeneration: "gen1" }),
        set: async () => {},
      },
    },
    windows: {
      getAll: async () => [{ id: 1, type: "normal", incognito: false }],
    },
    tabs: {
      query: async () => tabs,
      get: async (id: number) => tabs.find((t) => t.id === id),
      group: vi.fn(async ({ tabIds }: { tabIds: number[] }) => {
        for (const t of tabs) if (tabIds.includes(t.id)) t.groupId = 10;
        groups.push({
          id: 10,
          windowId: 1,
          title: "",
          color: "blue",
          collapsed: false,
        });
        return 10;
      }),
      ungroup: vi.fn(async (ids: number[]) => {
        for (const t of tabs) if (ids.includes(t.id)) t.groupId = -1;
      }),
      discard: vi.fn(),
      remove: vi.fn(async (ids: number[]) => {
        tabs = tabs.filter((t) => !ids.includes(t.id));
      }),
    },
    tabGroups: {
      query: async () => groups,
      update: vi.fn(async (id: number, patch: object) => {
        Object.assign(
          groups.find((g) => g.id === id)!,
          patch,
        );
      }),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
it("reads unmanaged groups without adopting or renaming them", async () => {
  await reconcile();
  const state = await live();
  expect(state.groups[0].spaceId).toBeUndefined();
  expect(chrome.tabGroups.update).not.toHaveBeenCalled();
  expect((await repo.list()).filter((e) => e.kind === "group")).toHaveLength(0);
});
it("creates a native group in its selected window, independent of browser focus", async () => {
  await browserAction("group", { ids: [1], spaceId: await repo.inbox() });
  expect(chrome.tabs.group).toHaveBeenCalledWith(
    expect.objectContaining({ createProperties: { windowId: 1 } }),
  );
});
it("coalesces a burst of event refreshes while still reading the final browser state", async () => {
  const query = vi.spyOn(chrome.windows, "getAll");
  const states = await Promise.all(
    Array.from({ length: 30 }, () => reconcile("browser event")),
  );
  expect(query.mock.calls.length).toBeLessThanOrEqual(2);
  expect(states.every((state) => state.tabs.length === 2)).toBe(true);
});
it("does not bump durable group/tab revisions during an unchanged view refresh", async () => {
  await browserAction("adopt", { ids: [1], spaceId: await repo.inbox() });
  const before = (await repo.list())
    .filter((e) => e.kind === "group" || e.kind === "savedTab")
    .map((e) => [e.id, e.revision]);
  await reconcile("view refresh");
  await reconcile("view refresh");
  expect(
    (await repo.list())
      .filter((e) => e.kind === "group" || e.kind === "savedTab")
      .map((e) => [e.id, e.revision]),
  ).toEqual(before);
});
it("rejects incompatible restoration options before changing windows or content", async () => {
  const before = await repo.db.entities.count();
  await expect(
    browserAction("restoreSession", {
      replace: true,
      newWindow: true,
      recoveredSpaceName: "Should not exist",
    }),
  ).rejects.toThrow("current window");
  await expect(
    browserAction("restoreSession", { restoreWindows: true, newWindow: true }),
  ).rejects.toThrow("Choose one");
  expect(await repo.db.entities.count()).toBe(before);
  expect(await repo.db.snapshots.count()).toBe(0);
});
it("does not oscillate shared saved-tab metadata between unchanged window bindings", async () => {
  const inbox = await repo.inbox();
  await browserAction("adopt", { ids: [1], spaceId: inbox });
  const saved = (await repo.list()).find((e) => e.kind === "savedTab")!;
  const prior = (await repo.db.browser.get("browser"))!;
  // Simulate a second explicit binding after a copy-window session open.
  tabs.push({
    ...tabs[0],
    id: 3,
    windowId: 2,
    title: "Other window title",
    index: 1,
  });
  Object.defineProperty(chrome.windows, "getAll", {
    value: vi.fn(async () => [
      { id: 1, type: "normal", incognito: false },
      { id: 2, type: "normal", incognito: false },
    ]),
    configurable: true,
  });
  await repo.db.meta.put({ id: "tab:gen1:3", value: saved.id });
  await repo.db.browser.put({
    ...prior,
    tabs: [
      ...prior.tabs,
      {
        ...prior.tabs[0],
        id: 3,
        windowId: 2,
        title: "Other window title",
        index: 1,
      },
    ],
  });
  const unchangedRevision = (await repo.db.entities.get(saved.id))!.revision;
  await reconcile();
  await reconcile();
  expect((await repo.db.entities.get(saved.id))!.revision).toBe(
    unchangedRevision,
  );
  expect((await repo.db.entities.get(saved.id))!.name).toBe(saved.name);
  tabs.find((t) => t.id === 3)!.title = "Actual change in other window";
  await reconcile();
  expect((await repo.db.entities.get(saved.id))!.name).toBe(
    "Actual change in other window",
  );
  await reconcile();
  expect((await repo.db.entities.get(saved.id))!.name).toBe(
    "Actual change in other window",
  );
});
it("rejects pinned grouping and active discard", async () => {
  await expect(
    browserAction("adopt", { ids: [2], spaceId: await repo.inbox() }),
  ).rejects.toThrow("Pinned");
  await expect(browserAction("discard", { ids: [1] })).rejects.toThrow(
    "protected",
  );
  expect(chrome.tabs.group).not.toHaveBeenCalled();
  expect(chrome.tabs.discard).not.toHaveBeenCalled();
});
it("keeps explicit ownership when an event refresh overwrites the transient browser view", async () => {
  const inbox = await repo.inbox();
  await browserAction("adopt", { ids: [1], spaceId: inbox });
  const current = (await repo.db.browser.get("browser"))!;
  await repo.db.browser.put({
    ...current,
    tabs: current.tabs.map((t) => ({ ...t, spaceId: undefined })),
    groups: current.groups.map((g) => ({
      ...g,
      spaceId: undefined,
      logicalId: undefined,
    })),
  });
  const restored = await live();
  expect(restored.tabs.find((t) => t.id === 1)?.spaceId).toBe(inbox);
  expect(restored.groups.some((g) => g.spaceId === inbox && g.logicalId)).toBe(
    true,
  );
});
it("preserves a nonempty snapshot after a window shutdown empties live state", async () => {
  await reconcile();
  tabs = [];
  groups = [];
  await reconcile("window close");
  expect(
    (await repo.db.snapshots.toArray()).some((s) => s.tabs.length === 2),
  ).toBe(true);
});
it("bounded drag retry only retries the documented transient error", async () => {
  let n = 0;
  const value = await retryDrag(async () => {
    if (n++ < 2)
      throw Error(
        "Tabs cannot be edited right now (user may be dragging a tab).",
      );
    return 7;
  });
  expect(value).toBe(7);
  await expect(
    retryDrag(async () => {
      throw Error("access denied");
    }),
  ).rejects.toThrow("access denied");
});
it("closes only unchanged owned resource tabs and preserves pinned, navigated and unowned tabs", async () => {
  const resource = entity("resource", "Owned link", {
    spaceId: await repo.inbox(),
    url: "https://example.org/a",
  });
  await repo.execute({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    type: "create",
    entity: resource,
  });
  await repo.db.meta.put({
    id: "resource-tab:gen1:1",
    value: { resourceId: resource.id, url: "https://example.org/previous" },
  });
  await repo.db.meta.put({
    id: "resource-tab:gen1:2",
    value: { resourceId: resource.id, url: tabs[1].url },
  });
  await browserAction("closeResources", { resourceIds: [resource.id] });
  expect(chrome.tabs.remove).not.toHaveBeenCalled();
  await repo.db.meta.put({
    id: "resource-tab:gen1:1",
    value: { resourceId: resource.id, url: tabs[0].url },
  });
  await browserAction("closeResources", { resourceIds: [resource.id] });
  expect(tabs.map((t) => t.id)).toEqual([2]);
  expect(
    (await repo.db.snapshots.toArray()).some(
      (s) => s.protected && s.reason.includes("resource-owned"),
    ),
  ).toBe(true);
});
