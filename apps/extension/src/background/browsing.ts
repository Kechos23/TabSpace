import { repository as repo } from "../../../../packages/persistence/repository";
import {
  expiredUnsaved,
  hasPersonalContent,
} from "../../../../packages/domain/browsing";
import { generation, live, reconcile } from "./browser";
import {
  ensureTemporarySession,
  sessionStatus,
  sessionTab,
  bindBrowsingWindow,
  restoreMissingLockedTabs,
  restoreBrowsingWindow,
  discardBrowsingBinding,
} from "./sessions";
import type { Snapshot } from "../../../../packages/domain/model";

type SavedWindow = {
  spaceId: string;
  windowId: number;
  urls: string[];
  pinned: { url: string; muted: boolean }[];
  activeTab?: { url: string; occurrence: number };
};
type Startup = {
  generation: string;
  windows: SavedWindow[];
  focusedSpaceId?: string;
};
const startupKey = "browsing:last-session";
const lifecycleKey = "browsing:lifecycle";
type Lifecycle = { generation: string; open: boolean; epoch: string };
let knownBrowsingWindows = new Set<number>();
const closingBrowsingWindows = new Set<number>();
let browsingStopped = false;
let closingUntil = 0;
export function browsingWindowClosing(windowId: number) {
  if (!knownBrowsingWindows.has(windowId)) return;
  closingBrowsingWindows.add(windowId);
  knownBrowsingWindows.delete(windowId);
  if (!knownBrowsingWindows.size) browsingStopped = true;
  closingUntil = Date.now() + 2500;
}

async function browsingWindows() {
  const parked = new Set(
    (await sessionStatus())
      .filter((binding) => binding.parked)
      .map((binding) => binding.windowId),
  );
  const allWindows = await chrome.windows.getAll({
    windowTypes: ["normal"],
    populate: true,
  });
  for (const id of closingBrowsingWindows)
    if (!allWindows.some((window) => window.id === id))
      closingBrowsingWindows.delete(id);
  const windows = allWindows.filter(
    (window) =>
      !window.incognito &&
      window.id !== undefined &&
      !closingBrowsingWindows.has(window.id) &&
      !parked.has(window.id) &&
      !window.tabs?.some((tab) =>
        tab.url?.startsWith(chrome.runtime.getURL("parking.html?space=")),
      ),
  );
  knownBrowsingWindows = new Set(windows.map((window) => window.id!));
  return windows;
}

let lifecycleWork: Promise<void> | undefined;
export function restoreStartupBrowsing() {
  return (lifecycleWork ??= restoreBrowsingLifecycle().finally(() => {
    lifecycleWork = undefined;
  }));
}

async function restoreBrowsingLifecycle() {
  const gen = await generation();
  const lifecycle = (await repo.db.meta.get(lifecycleKey))?.value as
    Lifecycle | undefined;
  const windows = await browsingWindows();
  if (!windows.length) {
    // The profile may be alive exclusively because a PWA is running.
    // Keep the last browsing checkpoint and defer all browser creation.
    if (!lifecycle || lifecycle.open || lifecycle.generation !== gen)
      await repo.db.meta.put({
        id: lifecycleKey,
        value: {
          generation: gen,
          open: false,
          epoch: lifecycle?.epoch ?? crypto.randomUUID(),
        } satisfies Lifecycle,
      });
    return;
  }
  if (lifecycle?.open && lifecycle.generation === gen && !browsingStopped)
    return;
  const previous = (await repo.db.meta.get(startupKey))?.value as
    Startup | undefined;
  const epoch = crypto.randomUUID();
  browsingStopped = false;
  // Persist before effects: worker suspension/restart must not replay a restore.
  await repo.db.meta.put({
    id: lifecycleKey,
    value: { generation: gen, open: true, epoch } satisfies Lifecycle,
  });
  await repo.db.meta.put({ id: "browsing:startup-handled", value: gen });
  if (
    !(await repo.settings()).restoreBrowsing ||
    !previous?.windows?.length ||
    (!lifecycle && previous.generation === gen)
  )
    return;
  if (await repo.db.meta.get("session:operation")) return;
  if (await repo.db.meta.where("id").startsWith("quarantine:").count()) return;
  const activeBefore = new Map(
    windows.map((window) => [
      window.id!,
      window.tabs?.find((tab) => tab.active)?.id,
    ]),
  );
  const interacted = new Set<number>();
  const completed = new Set<string>();
  const used = new Set<number>(),
    unresolved: string[] = [],
    reconnected: string[] = [],
    restored: string[] = [];
  const onActivated = (info: { tabId: number; windowId: number }) => {
    // A different unpinned tab selected while startup settles takes precedence.
    void chrome.tabs
      .get(info.tabId)
      .then((tab) => {
        if (
          !tab.pinned &&
          activeBefore.has(info.windowId) &&
          activeBefore.get(info.windowId) !== tab.id
        )
          interacted.add(info.windowId);
      })
      .catch(() => undefined);
  };
  chrome.tabs.onActivated.addListener(onActivated);
  try {
    // Give Chrome's own session restore a chance to publish its windows and URLs.
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (!(await browsingWindows()).length) {
      await repo.db.meta.put({
        id: lifecycleKey,
        value: { generation: gen, open: false, epoch } satisfies Lifecycle,
      });
      return;
    }
    for (const saved of previous.windows) {
      const space = await repo.db.entities.get(saved.spaceId);
      if (
        !space ||
        space.deletedAt ||
        space.archivedAt ||
        space.id === (await repo.inbox())
      ) {
        completed.add(saved.spaceId);
        continue;
      }
      const state = await live(),
        windows = await browsingWindows();
      if (!windows.length) break;
      const fingerprint = (windowId: number) =>
        state.tabs
          .filter((tab) => tab.windowId === windowId && sessionTab(tab))
          .sort((a, b) => a.index - b.index)
          .map((tab) => tab.url);
      const candidates = windows.filter(
        (window) =>
          !window.incognito &&
          window.id !== undefined &&
          !used.has(window.id) &&
          JSON.stringify(fingerprint(window.id)) === JSON.stringify(saved.urls),
      );
      const identical = previous.windows.filter(
        (other) => JSON.stringify(other.urls) === JSON.stringify(saved.urls),
      );
      if (
        candidates.length &&
        (candidates.length !== 1 || identical.length > 1)
      ) {
        unresolved.push(saved.spaceId);
        continue;
      }
      let windowId = candidates[0]?.id;
      if (
        windowId === undefined &&
        saved.urls.some((url) =>
          state.tabs.some(
            (tab) =>
              !used.has(tab.windowId) &&
              windows.some((window) => window.id === tab.windowId) &&
              sessionTab(tab) &&
              tab.url === url,
          ),
        )
      ) {
        unresolved.push(saved.spaceId);
        continue;
      }
      if (windowId !== undefined) {
        await bindBrowsingWindow(windowId, saved.spaceId);
        await restoreMissingLockedTabs(windowId, saved.spaceId);
        reconnected.push(saved.spaceId);
      } else {
        const blank = windows.find(
          (window) =>
            !window.incognito &&
            window.id !== undefined &&
            !used.has(window.id) &&
            state.tabs
              .filter((tab) => tab.windowId === window.id)
              .every(
                (tab) => tab.pinned || /^chrome:\/\/newtab\/?$/.test(tab.url),
              ),
        );
        if (blank?.id !== undefined && interacted.has(blank.id)) {
          unresolved.push(saved.spaceId);
          continue;
        }
        // Ignore activations caused by our own restore in this destination.
        if (blank?.id !== undefined) activeBefore.delete(blank.id);
        windowId = await restoreBrowsingWindow(saved.spaceId, blank?.id);
        restored.push(saved.spaceId);
      }
      used.add(windowId!);
      // Pinned tabs are global to a window, not owned by a Space. Match occurrences.
      const existingPins = (
        await chrome.tabs.query({ windowId, pinned: true })
      ).map((tab) => tab.url);
      for (const pin of saved.pinned ?? []) {
        const found = existingPins.indexOf(pin.url);
        if (found >= 0) existingPins.splice(found, 1);
        else if (/^https?:\/\//.test(pin.url)) {
          const tab = await chrome.tabs.create({
            windowId,
            url: pin.url,
            pinned: true,
            active: false,
          });
          if (pin.muted) await chrome.tabs.update(tab.id!, { muted: true });
        }
      }
      // Select once, after matching/restoring and creating pins. No background
      // timer fights later user actions or another extension's later activation.
      if (!interacted.has(windowId!)) {
        const tabs = (await chrome.tabs.query({ windowId }))
          .filter((tab) =>
            sessionTab({
              pinned: tab.pinned,
              url: tab.url ?? tab.pendingUrl ?? "",
            }),
          )
          .sort((a, b) => a.index - b.index);
        const matches = tabs.filter(
          (tab) => (tab.url || tab.pendingUrl) === saved.activeTab?.url,
        );
        const target = matches[saved.activeTab?.occurrence ?? 0] ?? tabs[0];
        if (target?.id !== undefined) {
          activeBefore.delete(windowId!);
          await chrome.tabs.update(target.id, { active: true });
        }
      }
      const focused = (await browsingWindows()).find(
        (window) => window.focused,
      );
      if (
        saved.spaceId === previous.focusedSpaceId &&
        !interacted.size &&
        focused &&
        (activeBefore.has(focused.id!) || used.has(focused.id!))
      )
        await chrome.windows.update(windowId!, { focused: true });
      completed.add(saved.spaceId);
    }
    await repo.db.meta.put({ id: "browsing:unresolved", value: unresolved });
    await repo.db.meta.put({
      id: "browsing:last-startup",
      value: { generation: gen, epoch, reconnected, restored, unresolved },
    });
    await reconcile("Startup browsing restored");
  } catch (error) {
    // A window/tab can disappear between awaited API calls. Do not replay
    // uncertain effects; preserve the remaining session for explicit recovery.
    const pending = [
      ...new Set([
        ...unresolved,
        ...previous.windows
          .filter((entry) => !completed.has(entry.spaceId))
          .map((entry) => entry.spaceId),
      ]),
    ];
    await repo.db.meta.put({ id: "browsing:unresolved", value: pending });
    await repo.db.meta.put({
      id: "browsing:last-startup",
      value: {
        generation: gen,
        epoch,
        reconnected,
        restored,
        unresolved: pending,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  } finally {
    chrome.tabs.onActivated.removeListener(onActivated);
  }
}

export async function maintainBrowsing() {
  if (await repo.db.meta.get("session:operation")) return;
  if (await repo.db.meta.where("id").startsWith("quarantine:").count()) return;
  await restoreStartupBrowsing();
  let bindings = await sessionStatus();
  const windows = (
    await chrome.windows.getAll({ windowTypes: ["normal"] })
  ).filter(
    (window) => !window.incognito && !closingBrowsingWindows.has(window.id!),
  );
  let state = await live();
  const inbox = await repo.inbox();
  for (const binding of bindings.filter((item) => item.spaceId === inbox))
    await discardBrowsingBinding(binding.windowId);
  bindings = await sessionStatus();
  for (const window of windows) {
    if (
      window.id === undefined ||
      bindings.some((binding) => binding.windowId === window.id)
    )
      continue;
    const tabs = state.tabs.filter((tab) => tab.windowId === window.id);
    if (
      !tabs.some(
        (tab) =>
          sessionTab(tab) || (tab.pinned && /^https?:\/\//.test(tab.url)),
      )
    )
      continue;
    const id = await ensureTemporarySession(
      window.id,
      tabs.filter(sessionTab).map((tab) => tab.id),
    );
    await bindBrowsingWindow(window.id, id);
    bindings.push({ windowId: window.id, spaceId: id, parked: false });
  }
  bindings = await sessionStatus();
  state = await live();
  // A window left with just our manager after closing/moving its tabs is not an active Unsaved.
  for (const binding of bindings) {
    const space = await repo.db.entities.get(binding.spaceId);
    if (
      space?.temporary &&
      !state.tabs.some(
        (tab) =>
          tab.windowId === binding.windowId &&
          (sessionTab(tab) || (tab.pinned && /^https?:\/\//.test(tab.url))),
      )
    )
      await discardBrowsingBinding(binding.windowId);
  }
  bindings = await sessionStatus();
  const active = new Set(bindings.map((binding) => binding.spaceId));
  for (const space of (await repo.list()).filter(
    (item) =>
      item.kind === "space" &&
      item.temporary &&
      !item.deletedAt &&
      !item.archivedAt,
  )) {
    const closedAt = active.has(space.id)
      ? undefined
      : (space.browsingClosedAt ?? new Date().toISOString());
    if (closedAt !== space.browsingClosedAt)
      await repo.execute({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "update",
        id: space.id,
        expectedRevision: space.revision,
        patch: { browsingClosedAt: closedAt },
      });
  }
  const browsing = await browsingWindows();
  if (Date.now() >= closingUntil && browsing.length) {
    const focused = await chrome.windows
      .getLastFocused({ windowTypes: ["normal"] })
      .catch(() => undefined);
    const previous = (await repo.db.meta.get(startupKey))?.value as
      Startup | undefined;
    const saved: SavedWindow[] = [];
    for (const binding of bindings.filter(
      (item) =>
        !item.parked && browsing.some((window) => window.id === item.windowId),
    )) {
      const tabs = state.tabs
        .filter((tab) => tab.windowId === binding.windowId && sessionTab(tab))
        .sort((a, b) => a.index - b.index);
      const current = tabs.find((tab) => tab.active);
      const prior = previous?.windows.find(
        (entry) => entry.spaceId === binding.spaceId,
      )?.activeTab;
      const activeTab = current
        ? {
            url: current.url,
            occurrence: tabs.filter(
              (tab) => tab.index < current.index && tab.url === current.url,
            ).length,
          }
        : prior;
      saved.push({
        spaceId: binding.spaceId,
        windowId: binding.windowId,
        urls: state.tabs
          .filter((tab) => tab.windowId === binding.windowId && sessionTab(tab))
          .sort((a, b) => a.index - b.index)
          .map((tab) => tab.url),
        pinned: state.tabs
          .filter(
            (tab) =>
              tab.windowId === binding.windowId &&
              tab.pinned &&
              /^https?:\/\//.test(tab.url),
          )
          .map((tab) => ({ url: tab.url, muted: tab.muted })),
        activeTab,
      });
    }
    const unresolved =
      ((await repo.db.meta.get("browsing:unresolved"))?.value as string[]) ??
      [];
    for (const old of previous?.windows ?? [])
      if (unresolved.includes(old.spaceId)) {
        const partial = saved.findIndex(
          (entry) => entry.spaceId === old.spaceId,
        );
        if (partial >= 0) saved.splice(partial, 1);
        saved.push(old);
      }
    await repo.db.meta.put({
      id: startupKey,
      value: {
        generation: await generation(),
        windows: saved,
        focusedSpaceId: bindings.find(
          (binding) => binding.windowId === focused?.id,
        )?.spaceId,
      } satisfies Startup,
    });
  }
  const settings = await repo.settings(),
    startup = (await repo.db.meta.get(startupKey))?.value as
      Startup | undefined;
  const protectedIds = new Set(
    settings.restoreBrowsing
      ? (startup?.windows.map((entry) => entry.spaceId) ?? [])
      : [],
  );
  const all = await repo.list();
  const empty = all.filter(
    (space) =>
      space.kind === "space" &&
      space.temporary &&
      !space.deletedAt &&
      !space.archivedAt &&
      space.browsingClosedAt &&
      !active.has(space.id) &&
      !protectedIds.has(space.id) &&
      !hasPersonalContent(space, all),
  );
  const ids = expiredUnsaved(
    all,
    active,
    protectedIds,
    settings.unsavedLimit,
    settings.unsavedDays,
  );
  for (const space of empty) {
    const checkpoint = (
      await repo.db.meta.get(`session:checkpoint:${space.id}`)
    )?.value as { snapshot?: Snapshot } | undefined;
    if (
      !checkpoint?.snapshot?.tabs.length &&
      !all.some(
        (item) =>
          item.spaceId === space.id &&
          item.kind === "savedTab" &&
          !item.deletedAt,
      )
    )
      ids.push(space.id);
  }
  if (ids.length)
    await repo.removeEmptyUnsaved([...new Set(ids)], active, protectedIds);
}
