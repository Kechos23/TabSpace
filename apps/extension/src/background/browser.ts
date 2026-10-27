import {
  entity,
  entitySchema,
  assertGraph,
  browserLabel,
  safeUrl,
  type BrowserState,
  type Entity,
  type LiveGroup,
  type LiveTab,
  type Snapshot,
} from "../../../../packages/domain/model";
import { repository as repo } from "../../../../packages/persistence/repository";

export async function generation() {
  let { browserGeneration } =
    await chrome.storage.session.get("browserGeneration");
  if (typeof browserGeneration !== "string") {
    browserGeneration = crypto.randomUUID();
    await chrome.storage.session.set({ browserGeneration });
  }
  return browserGeneration as string;
}
export async function live(): Promise<BrowserState> {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const allowed = new Set(windows.filter((w) => !w.incognito).map((w) => w.id));
  const tabs = (await chrome.tabs.query({}))
    .filter(
      (t) =>
        allowed.has(t.windowId) &&
        !t.incognito &&
        !t.url?.startsWith(chrome.runtime.getURL("")),
    )
    .map(
      (t) =>
        ({
          id: t.id!,
          windowId: t.windowId,
          index: t.index,
          groupId: t.groupId,
          title: browserLabel(t.title, "Untitled tab"),
          url: t.url || t.pendingUrl || "",
          faviconKey: t.favIconUrl
            ? Array.from(t.favIconUrl)
                .reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 0)
                .toString(36)
            : undefined,
          active: t.active,
          pinned: t.pinned,
          audible: t.audible ?? false,
          discarded: t.discarded,
          autoDiscardable: t.autoDiscardable,
          muted: t.mutedInfo?.muted ?? false,
          openerTabId: t.openerTabId,
        }) satisfies LiveTab,
    );
  const groups = (await chrome.tabGroups.query({}))
    .filter((g) => allowed.has(g.windowId))
    .map(
      (g) =>
        ({
          id: g.id,
          windowId: g.windowId,
          title: browserLabel(g.title, "Unnamed group"),
          color: g.color,
          collapsed: g.collapsed,
        }) satisfies LiveGroup,
    );
  const gen = await generation(),
    previous = await repo.db.browser.get("browser");
  if (previous?.generation === gen) {
    for (const t of tabs) {
      const old = previous.tabs.find((p) => p.id === t.id);
      if (old?.spaceId) (t as LiveTab).spaceId = old.spaceId;
    }
    for (const g of groups) {
      const old = previous.groups.find((p) => p.id === g.id);
      if (old?.spaceId) {
        (g as LiveGroup).spaceId = old.spaceId;
        (g as LiveGroup).logicalId = old.logicalId;
      }
    }
    // Manual membership changes to an already explicitly owned group inherit its owner.
    for (const t of tabs) {
      const group = groups.find((g) => g.id === t.groupId) as
        LiveGroup | undefined;
      if (group?.spaceId) (t as LiveTab).spaceId = group.spaceId;
    }
  }
  const ownership = await repo.db.meta.bulkGet([
    ...tabs.map((t) => `owner:${gen}:tab:${t.id}`),
    ...groups.map((g) => `owner:${gen}:group:${g.id}`),
  ]);
  for (let i = 0; i < tabs.length; i++) {
    const owner = ownership[i]?.value as { spaceId: string } | undefined;
    if (owner?.spaceId) (tabs[i] as LiveTab).spaceId = owner.spaceId;
  }
  for (let i = 0; i < groups.length; i++) {
    const owner = ownership[tabs.length + i]?.value as
      { spaceId: string; logicalId: string } | undefined;
    if (owner?.spaceId) Object.assign(groups[i], owner);
  }
  for (const tab of tabs) {
    const group = groups.find((g) => g.id === tab.groupId) as
      LiveGroup | undefined;
    if (group?.spaceId) (tab as LiveTab).spaceId = group.spaceId;
  }
  const tabRecords = await repo.db.meta.bulkGet(
    tabs.map((tab) => `tab:${gen}:${tab.id}`),
  );
  const locked = new Map(
    (await repo.db.entities.where("kind").equals("savedTab").toArray())
      .filter((item) => !item.deletedAt)
      .map((item) => [item.id, item]),
  );
  for (let index = 0; index < tabs.length; index++) {
    const item = locked.get(tabRecords[index]?.value as string);
    if (item && item.spaceId === (tabs[index] as LiveTab).spaceId) {
      (tabs[index] as LiveTab).recordId = item.id;
      if (item.locked) (tabs[index] as LiveTab).lockId = item.id;
    }
  }
  return {
    id: "browser",
    generation: gen,
    tabs,
    groups,
    updatedAt: new Date().toISOString(),
  };
}
export async function saveBindings(state: BrowserState) {
  await repo.db.transaction("rw", repo.db.meta, repo.db.browser, async () => {
    const rows = [
      ...state.tabs
        .filter((t) => t.spaceId)
        .map((t) => ({
          id: `owner:${state.generation}:tab:${t.id}`,
          value: { spaceId: t.spaceId },
        })),
      ...state.groups
        .filter((g) => g.spaceId && g.logicalId)
        .map((g) => ({
          id: `owner:${state.generation}:group:${g.id}`,
          value: { spaceId: g.spaceId, logicalId: g.logicalId },
        })),
    ];
    if (rows.length) await repo.db.meta.bulkPut(rows);
    await repo.db.browser.put(state);
  });
}
export function blueprint(
  state: BrowserState,
  reason: string,
  protectedSnapshot = false,
): Snapshot {
  const windows = new Map(
    [
      ...new Set([
        ...state.tabs.map((t) => t.windowId),
        ...state.groups.map((g) => g.windowId),
      ]),
    ].map((id, i) => [id, `window-${i + 1}`]),
  );
  const key = (windowId: number, groupId: number) =>
    `${windows.get(windowId)}:group-${groupId}`;
  return {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    reason,
    protected: protectedSnapshot,
    tabs: state.tabs
      .filter((t) => {
        try {
          safeUrl(t.url);
          return t.url.length <= 20000;
        } catch {
          return false;
        }
      })
      .map((t) => ({
        url: t.url,
        title: t.title,
        spaceId: t.spaceId,
        groupKey: t.groupId >= 0 ? key(t.windowId, t.groupId) : undefined,
        windowKey: windows.get(t.windowId),
        pinned: t.pinned,
        muted: t.muted,
        lockId: t.lockId,
        recordId: t.recordId,
      })),
    groups: state.groups.map((g) => ({
      key: key(g.windowId, g.id),
      windowKey: windows.get(g.windowId),
      title: g.title,
      color: g.color,
      collapsed: g.collapsed,
    })),
  };
}
let pendingReconcile: Promise<BrowserState> | undefined;
let lastSnapshotPrune = 0;
let lastRetentionDays: number | undefined;
const pendingReasons = new Set<string>();
export function reconcile(reason = "browser event") {
  pendingReasons.add(reason);
  if (pendingReconcile) return pendingReconcile;
  const job = async () => {
    const reasons = [...pendingReasons];
    pendingReasons.clear();
    reason = reasons.includes("periodic checkpoint")
      ? "periodic checkpoint"
      : (reasons[0] ?? reason);
    await repo.initialize();
    const collectionGeneration = (
      await repo.db.meta.get("collectionGeneration")
    )?.value;
    const prior = await repo.db.browser.get("browser");
    const actual = await live();
    const all = await repo.list();
    if (await repo.db.meta.where("id").startsWith("quarantine:").count())
      return actual;
    const validOwners = new Set(
      all.filter((e) => e.kind === "space" && !e.deletedAt).map((e) => e.id),
    );
    for (const tab of actual.tabs)
      if (tab.spaceId && !validOwners.has(tab.spaceId)) tab.spaceId = undefined;
    for (const group of actual.groups)
      if (group.spaceId && !validOwners.has(group.spaceId)) {
        group.spaceId = undefined;
        group.logicalId = undefined;
      }
    const changed =
      prior &&
      JSON.stringify(
        prior.tabs.map((t) => [
          t.id,
          t.url,
          t.title,
          t.groupId,
          t.windowId,
          t.index,
          t.spaceId,
        ]),
      ) !==
        JSON.stringify(
          actual.tabs.map((t) => [
            t.id,
            t.url,
            t.title,
            t.groupId,
            t.windowId,
            t.index,
            t.spaceId,
          ]),
        );
    // Preserve a nonempty previous state before removals, including window shutdown.
    if (
      prior?.tabs.length &&
      (changed || prior.generation !== actual.generation)
    )
      await repo.snapshot(
        blueprint(
          prior,
          prior.generation !== actual.generation
            ? "Previous browser session"
            : reason,
        ),
      );
    if (actual.tabs.length && (!prior || reason === "periodic checkpoint"))
      await repo.snapshot(blueprint(actual, reason));
    const saved: Entity[] = [];
    const newMappings = new Map<string, string>();
    for (const group of actual.groups) {
      if (!group.spaceId) continue;
      const logical = all.find((e) => e.id === group.logicalId);
      const previous =
        prior?.generation === actual.generation
          ? prior.groups.find((g) => g.id === group.id)
          : undefined;
      const bindingChanged =
        !previous ||
        previous.logicalId !== group.logicalId ||
        previous.title !== group.title ||
        previous.color !== group.color ||
        previous.collapsed !== group.collapsed;
      if (
        logical &&
        bindingChanged &&
        (logical.name !== group.title ||
          logical.color !== group.color ||
          logical.collapsed !== group.collapsed)
      )
        saved.push({
          ...logical,
          name: group.title,
          color: group.color,
          collapsed: group.collapsed,
          updatedAt: actual.updatedAt,
          revision: logical.revision + 1,
        });
    }
    const lockDefault = (await repo.settings()).lockTabsByDefault;
    const inbox = await repo.inbox();
    for (const tab of actual.tabs) {
      if (!tab.spaceId) continue;
      try {
        safeUrl(tab.url);
        if (tab.url.length > 20000) continue;
      } catch {
        continue;
      }
      const key = `tab:${actual.generation}:${tab.id}`;
      const mapping = await repo.db.meta.get(key);
      let old = all.find((e) => e.id === mapping?.value);
      if (old?.kind !== "savedTab" || old.deletedAt) old = undefined;
      const isNew = !old;
      const parent = all.find((item) => item.id === tab.spaceId);
      const canLock =
        parent?.kind === "space" && !parent.temporary && parent.id !== inbox;
      const previous =
        prior?.generation === actual.generation
          ? prior.tabs.find((t) => t.id === tab.id)
          : undefined;
      // A second window can display the same saved session. An unchanged physical
      // binding must not overwrite a deliberate change from the other window.
      if (
        old &&
        old.spaceId === tab.spaceId &&
        old.groupId ===
          actual.groups.find((g) => g.id === tab.groupId)?.logicalId &&
        previous &&
        [
          "title",
          "url",
          "spaceId",
          "index",
          "pinned",
          "muted",
          "groupId",
        ].every(
          (key) => previous[key as keyof LiveTab] === tab[key as keyof LiveTab],
        )
      )
        continue;
      if (!old) {
        old = entity("savedTab", tab.title, {
          spaceId: tab.spaceId,
          url: tab.url,
          order: tab.index,
          locked: !!canLock && lockDefault,
        });
        newMappings.set(key, old.id);
      }
      const next = {
        ...old,
        name: tab.title,
        url: tab.url,
        spaceId: tab.spaceId,
        order: tab.index,
        pinned: tab.pinned,
        muted: tab.muted,
        groupId: actual.groups.find((g) => g.id === tab.groupId)?.logicalId,
        locked:
          !!canLock &&
          (old.locked ||
            ((isNew || old.spaceId !== tab.spaceId) && lockDefault)),
        revision: isNew ? old.revision : old.revision + 1,
        updatedAt: actual.updatedAt,
      };
      tab.lockId = next.locked ? next.id : undefined;
      tab.recordId = next.id;
      if (
        isNew ||
        [
          "name",
          "url",
          "spaceId",
          "order",
          "pinned",
          "muted",
          "groupId",
          "locked",
        ].some((key) => old[key as keyof Entity] !== next[key as keyof Entity])
      )
        saved.push(next);
    }
    await repo.db.transaction(
      "rw",
      repo.db.browser,
      repo.db.entities,
      repo.db.meta,
      repo.db.attachments,
      async () => {
        // Imports and ownership changes must not be overwritten by a refresh
        // which observed the previous collection/binding generation.
        const currentGeneration = (
          await repo.db.meta.get("collectionGeneration")
        )?.value;
        const currentBrowser = await repo.db.browser.get("browser");
        if (
          currentGeneration !== collectionGeneration ||
          JSON.stringify(currentBrowser) !== JSON.stringify(prior)
        ) {
          pendingReasons.add("collection or bindings changed during refresh");
          return;
        }
        // A view-only refresh has no entity writes to merge or validate. For
        // writes, reload current rows under the lock; only the changed entities
        // need schema parsing again (command/import writers already validate).
        if (!saved.length) {
          await repo.db.browser.put(actual);
          return;
        }
        const current = await repo.db.entities.toArray();
        if (await repo.db.meta.where("id").startsWith("quarantine:").count())
          return;
        const latest = new Map(current.map((e) => [e.id, e]));
        const baseline = new Map(all.map((e) => [e.id, e]));
        const changes: Entity[] = [];
        for (const candidate of saved) {
          const parent = latest.get(candidate.spaceId!);
          if (parent?.kind !== "space" || parent.deletedAt) continue;
          const before = baseline.get(candidate.id);
          const now = latest.get(candidate.id);
          if (before && (!now || now.deletedAt || now.kind !== before.kind))
            continue;
          const fields =
            candidate.kind === "group"
              ? (["name", "color", "collapsed"] as const)
              : ([
                  "name",
                  "url",
                  "spaceId",
                  "order",
                  "pinned",
                  "muted",
                  "groupId",
                  "locked",
                ] as const);
          const patch = Object.fromEntries(
            fields
              .filter((field) => !before || now?.[field] === before[field])
              .map((field) => [field, candidate[field]]),
          );
          const next = entitySchema.parse(
            now
              ? {
                  ...now,
                  ...patch,
                  revision: now.revision + 1,
                  updatedAt: actual.updatedAt,
                }
              : candidate,
          );
          if (!now || fields.some((field) => now[field] !== next[field])) {
            changes.push(next);
            latest.set(next.id, next);
          }
        }
        assertGraph(
          [...latest.values()],
          new Set(await repo.db.attachments.toCollection().primaryKeys()),
        );
        await repo.db.browser.put(actual);
        if (changes.length) await repo.db.entities.bulkPut(changes);
        for (const [key, value] of newMappings)
          if (latest.has(value)) await repo.db.meta.put({ id: key, value });
      },
    );
    // Follow default titles only. Manual titles never change from tab events.
    for (const resource of all.filter(
      (e) => e.kind === "resource" && e.titleMode === "auto" && !e.deletedAt,
    )) {
      const tab = actual.tabs.find((t) => t.url === resource.url);
      if (tab && tab.title !== resource.name)
        await repo
          .execute({
            schemaVersion: 1,
            commandId: crypto.randomUUID(),
            type: "update",
            id: resource.id,
            expectedRevision: resource.revision,
            patch: { name: tab.title },
          })
          .catch(() => undefined);
    }
    const settings = await repo.settings();
    if (
      lastRetentionDays !== settings.retentionDays ||
      Date.now() - lastSnapshotPrune >= 300000
    ) {
      await repo.pruneSnapshots(settings.retentionDays);
      lastSnapshotPrune = Date.now();
      lastRetentionDays = settings.retentionDays;
    }
    return actual;
  };
  pendingReconcile = (async () => {
    try {
      let state: BrowserState;
      do {
        state = await job();
      } while (pendingReasons.size);
      return state;
    } finally {
      pendingReconcile = undefined;
    }
  })();
  return pendingReconcile;
}
export async function retryDrag<T>(work: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (e) {
      if (
        attempt >= 4 ||
        !String(e).includes("Tabs cannot be edited right now")
      )
        throw e;
      await new Promise((r) => setTimeout(r, 75 * (attempt + 1)));
    }
  }
}
async function checkTabs(ids: number[]) {
  if (!ids.length || ids.length > 1000 || new Set(ids).size !== ids.length)
    throw new Error("Select distinct tabs.");
  const state = await live();
  return ids.map((id) => {
    const t = state.tabs.find((t) => t.id === id);
    if (!t)
      throw new Error("A tab is missing or outside normal profile scope.");
    return t;
  });
}
async function requireSpace(id: string) {
  const space = await repo.db.entities.get(id);
  if (!space || space.kind !== "space" || space.deletedAt || space.archivedAt)
    throw new Error("Choose an available Space.");
  return space;
}
export async function openUrl(url: string, copy = false, windowId?: number) {
  safeUrl(url);
  const state = await live();
  const match = state.tabs.find(
    (t) => t.url === url && (windowId === undefined || t.windowId === windowId),
  );
  if (match && !copy) {
    await chrome.windows.update(match.windowId, { focused: true });
    await chrome.tabs.update(match.id, { active: true });
    return match;
  }
  return chrome.tabs.create({ url, windowId, active: false });
}
let ensureAutomaticManager: ((windowId: number) => Promise<void>) | undefined;
export function registerManagerLifecycle(
  ensure: (windowId: number) => Promise<void>,
) {
  ensureAutomaticManager = ensure;
}
export async function manager() {
  const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  if (w.incognito || !w.id) throw new Error("Use a normal Chrome window.");
  const settings = await repo.settings();
  if (settings.autoOpenManager || settings.dragGroupEnabled)
    await ensureAutomaticManager?.(w.id);
  const url = chrome.runtime.getURL("index.html"),
    tabs = await chrome.tabs.query({ windowId: w.id });
  let tab = tabs.find((t) =>
    [t.url, t.pendingUrl].some((value) => value?.split(/[?#]/)[0] === url),
  );
  const pinned =
    settings.pinManager ||
    settings.autoOpenManager ||
    settings.dragGroupEnabled;
  if (!tab)
    tab = await chrome.tabs.create({
      url,
      windowId: w.id,
      pinned,
      index: pinned ? 0 : undefined,
    });
  else await chrome.tabs.update(tab.id!, { active: true });
  if (pinned && !tab.pinned) {
    await chrome.tabs.update(tab.id!, { pinned: true });
    await chrome.tabs.move(tab.id!, { index: 0 });
  }
  return tab;
}
export async function bindDragGroup(groupId: number, spaceId?: string) {
  if (!spaceId) return reconcile("drag grouping");
  await requireSpace(spaceId);
  let state = await live();
  let native = state.groups.find((g) => g.id === groupId);
  if (!native) throw new Error("Created group is no longer available.");
  if (!native.title.trim()) {
    await chrome.tabGroups.update(groupId, { title: "Group" });
    state = await live();
    native = state.groups.find((g) => g.id === groupId)!;
  }
  const logical = entity("group", native.title, {
    spaceId,
    color: native.color,
    collapsed: native.collapsed,
  });
  await repo.execute({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    type: "create",
    entity: logical,
  });
  state.groups = state.groups.map((g) =>
    g.id === groupId ? { ...g, spaceId, logicalId: logical.id } : g,
  );
  state.tabs = state.tabs.map((t) =>
    t.groupId === groupId ? { ...t, spaceId } : t,
  );
  await saveBindings(state);
  return reconcile("drag grouping");
}

export async function browserAction(
  type: string,
  payload: {
    ids?: number[];
    spaceId?: string;
    resourceId?: string;
    resourceIds?: string[];
    groupId?: number;
    name?: string;
    color?: LiveGroup["color"];
    collapsed?: boolean;
    windowId?: number;
    index?: number;
    url?: string;
    copy?: boolean;
    snapshotId?: string;
    preserveLocks?: boolean;
    indices?: number[];
    newWindow?: boolean;
    recoveredSpaceName?: string;
    replace?: boolean;
    restoreWindows?: boolean;
  },
) {
  const ids = payload.ids ?? [];
  if (type === "open") {
    if (payload.spaceId) await requireSpace(payload.spaceId);
    const before = await live();
    const tab = await openUrl(payload.url!, payload.copy, payload.windowId);
    if (
      payload.spaceId &&
      tab.id !== undefined &&
      !before.tabs.some((t) => t.id === tab.id)
    ) {
      const current = await live();
      current.tabs = current.tabs.map((t) =>
        t.id === tab.id ? { ...t, spaceId: payload.spaceId } : t,
      );
      await saveBindings(current);
      await reconcile("Opened a tab in a Space");
    }
    if (
      payload.resourceId &&
      tab.id !== undefined &&
      !before.tabs.some((t) => t.id === tab.id)
    ) {
      const resource = await repo.db.entities.get(payload.resourceId);
      if (
        resource?.kind === "resource" &&
        resource.url === payload.url &&
        !resource.deletedAt
      )
        await repo.db.meta.put({
          id: `resource-tab:${before.generation}:${tab.id}`,
          value: { resourceId: resource.id, url: resource.url },
        });
    }
    return tab;
  }
  if (["openResources", "replaceResources", "closeResources"].includes(type)) {
    const requested = new Set(payload.resourceIds ?? []),
      all = await repo.list(),
      resources = all.filter(
        (e) => e.kind === "resource" && !e.deletedAt && requested.has(e.id),
      );
    if (resources.length !== requested.size)
      throw new Error("Some selected resources are no longer available.");
    const before = await live();
    if (type === "closeResources") {
      const closable: number[] = [];
      for (const tab of before.tabs) {
        const owned = await repo.db.meta.get(
            `resource-tab:${before.generation}:${tab.id}`,
          ),
          record = owned?.value as
            { resourceId: string; url: string } | undefined;
        if (
          record &&
          requested.has(record.resourceId) &&
          record.url === tab.url &&
          !tab.pinned
        )
          closable.push(tab.id);
      }
      if (closable.length) {
        await repo.snapshot(
          blueprint(before, "Before closing resource-owned tabs", true),
        );
        await retryDrag(() => chrome.tabs.remove(closable));
      }
      return reconcile("Closed resource-owned tabs");
    }
    const window = await chrome.windows.getLastFocused({
      windowTypes: ["normal"],
    });
    if (!window.id || window.incognito)
      throw new Error("Use a normal Chrome window.");
    const links = resources.filter((e) => e.url);
    if (!links.length)
      throw new Error("The selection contains no website links.");
    if (type === "replaceResources")
      await repo.snapshot(
        blueprint(before, "Before explicit resource replacement", true),
      );
    for (const resource of links)
      await browserAction("open", {
        url: resource.url,
        resourceId: resource.id,
        windowId: window.id,
        copy: type === "replaceResources",
      });
    if (type === "replaceResources") {
      const current = await live();
      const closing = before.tabs
        .filter(
          (t) =>
            t.windowId === window.id &&
            !t.pinned &&
            current.tabs.some(
              (now) => now.id === t.id && now.url === t.url && !now.pinned,
            ),
        )
        .filter((t) => {
          try {
            safeUrl(t.url);
            return true;
          } catch {
            return false;
          }
        })
        .map((t) => t.id);
      if (closing.length) await retryDrag(() => chrome.tabs.remove(closing));
    }
    return reconcile("Opened resource selection");
  }
  if (type === "manager") return manager();
  if (type === "checkpoint") {
    const state = await live();
    const snap = blueprint(state, "Manual checkpoint", true);
    await repo.snapshot(snap);
    return snap;
  }
  if (type === "restoreSession") {
    if (payload.replace && (payload.newWindow || payload.restoreWindows))
      throw new Error("Replacement is supported only in the current window.");
    if (payload.newWindow && payload.restoreWindows)
      throw new Error("Choose one new window or the original window layout.");
    const snap = await repo.db.snapshots.get(payload.snapshotId!);
    if (!snap) throw new Error("Snapshot no longer exists.");
    const selected = payload.indices
      ? snap.tabs.filter((_, i) => payload.indices!.includes(i))
      : snap.tabs;
    if (!selected.length)
      throw new Error("Select at least one recoverable tab.");
    for (const tab of selected) safeUrl(tab.url);
    let windowId = payload.windowId;
    if (!payload.newWindow && !payload.restoreWindows && !windowId) {
      const window = await chrome.windows.getLastFocused({
        windowTypes: ["normal"],
      });
      if (window.incognito || !window.id)
        throw new Error("Use a normal window.");
      windowId = window.id;
    }
    if (windowId) {
      const window = await chrome.windows.get(windowId);
      if (window.incognito || window.type !== "normal")
        throw new Error("Use a normal window.");
    }
    const before = await live();
    await repo.snapshot(blueprint(before, "Before session restoration", true));
    let recoveredSpace: Entity | undefined;
    if (payload.recoveredSpaceName) {
      recoveredSpace = entity("space", payload.recoveredSpaceName, {
        view: "tabs",
        description: `Recovered from ${new Date(snap.capturedAt).toLocaleString()}. ${snap.reason}`,
      });
      await repo.execute({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: recoveredSpace,
      });
    }
    const tabIds: number[] = [];
    const groups = new Map<string, number[]>();
    const openedWindows = new Map<string, number>();
    const managerUrl = chrome.runtime.getURL(
      `index.html${recoveredSpace ? `?space=${recoveredSpace.id}` : ""}`,
    );
    if (payload.newWindow) {
      const w = await chrome.windows.create({
        url: managerUrl,
      });
      if (!w?.id) throw new Error("Could not create a normal window.");
      windowId = w.id;
    }
    for (const tab of selected) {
      let destinationWindow = windowId;
      if (payload.restoreWindows) {
        const key = tab.windowKey ?? "legacy-window";
        if (!openedWindows.has(key)) {
          const window = await chrome.windows.create({ url: managerUrl });
          if (!window?.id)
            throw new Error("Could not restore a normal window.");
          openedWindows.set(key, window.id);
        }
        destinationWindow = openedWindows.get(key);
      }
      const created = await chrome.tabs.create({
        url: safeUrl(tab.url),
        windowId: destinationWindow,
        active: false,
        pinned: tab.pinned,
      });
      tabIds.push(created.id!);
      if (payload.preserveLocks && (tab.lockId || tab.recordId)) {
        const item = await repo.db.entities.get((tab.lockId || tab.recordId)!);
        if (
          item?.kind === "savedTab" &&
          item.spaceId === tab.spaceId &&
          !item.deletedAt
        )
          await repo.db.meta.put({
            id: `tab:${await generation()}:${created.id}`,
            value: item.id,
          });
      }
      if (tab.groupKey && !tab.pinned) {
        const arr = groups.get(tab.groupKey) ?? [];
        arr.push(created.id!);
        groups.set(tab.groupKey, arr);
      }
      if (tab.muted) await chrome.tabs.update(created.id!, { muted: true });
    }
    for (const [key, members] of groups) {
      const destinationForGroup = (await chrome.tabs.get(members[0])).windowId;
      const old = snap.groups.find((g) => g.key === key),
        groupId = await retryDrag(() =>
          chrome.tabs.group({
            tabIds: members as [number, ...number[]],
            createProperties: { windowId: destinationForGroup },
          }),
        );
      if (old)
        await chrome.tabGroups.update(groupId, {
          title: old.title,
          color: old.color,
          collapsed: old.collapsed,
        });
      if (recoveredSpace) {
        const logical = entity("group", old?.title ?? "Recovered group", {
          spaceId: recoveredSpace.id,
          color: old?.color ?? "grey",
          collapsed: old?.collapsed ?? false,
        });
        await repo.execute({
          schemaVersion: 1,
          commandId: crypto.randomUUID(),
          type: "create",
          entity: logical,
        });
        const current = await live();
        current.groups = current.groups.map((g) =>
          g.id === groupId
            ? { ...g, spaceId: recoveredSpace!.id, logicalId: logical.id }
            : g,
        );
        await saveBindings(current);
      }
    }
    if (recoveredSpace) {
      const current = await live();
      current.tabs = current.tabs.map((t) =>
        tabIds.includes(t.id) ? { ...t, spaceId: recoveredSpace!.id } : t,
      );
      await saveBindings(current);
    }
    if (payload.replace) {
      const current = await live(),
        closing = before.tabs
          .filter(
            (t) =>
              t.windowId === windowId &&
              !t.pinned &&
              current.tabs.some(
                (now) => now.id === t.id && now.url === t.url && !now.pinned,
              ),
          )
          .filter((t) => {
            try {
              return Boolean(safeUrl(t.url));
            } catch {
              return false;
            }
          })
          .map((t) => t.id);
      if (closing.length) await retryDrag(() => chrome.tabs.remove(closing));
    }
    await reconcile("restored session");
    return { tabIds, spaceId: recoveredSpace?.id };
  }
  if (type === "openSaved") {
    await requireSpace(payload.spaceId!);
    const state = await live();
    const owned = state.tabs.filter((t) => t.spaceId === payload.spaceId);
    if (owned.length && !payload.newWindow) {
      await browserAction("focusSpace", payload);
      return;
    }
    const entities = await repo.list(),
      saved = entities
        .filter(
          (e) =>
            e.kind === "savedTab" &&
            e.spaceId === payload.spaceId &&
            !e.deletedAt,
        )
        .sort((a, b) => a.order - b.order);
    let windowId = payload.windowId;
    if (payload.newWindow) {
      windowId = (
        await chrome.windows.create({
          url: chrome.runtime.getURL(`index.html?space=${payload.spaceId}`),
        })
      )?.id;
      if (!windowId) throw new Error("Could not create a normal window.");
    }
    const opened: number[] = [];
    const gen = await generation();
    for (const s of saved) {
      const t = await chrome.tabs.create({
        url: safeUrl(s.url!),
        windowId,
        pinned: s.pinned,
        active: false,
      });
      opened.push(t.id!);
      await repo.db.meta.put({ id: `tab:${gen}:${t.id}`, value: s.id });
      if (s.muted) await chrome.tabs.update(t.id!, { muted: true });
    }
    const stateAfter = await live();
    stateAfter.tabs = stateAfter.tabs.map((t) =>
      opened.includes(t.id) ? { ...t, spaceId: payload.spaceId } : t,
    );
    await saveBindings(stateAfter);
    const byGroup = new Map<string, number[]>();
    for (let i = 0; i < saved.length; i++) {
      const s = saved[i];
      if (!s.pinned && s.groupId) {
        const members = byGroup.get(s.groupId) ?? [];
        members.push(opened[i]);
        byGroup.set(s.groupId, members);
      }
    }
    for (const [logicalId, members] of byGroup) {
      const logical = entities.find((e) => e.id === logicalId);
      const destinationForGroup = (await chrome.tabs.get(members[0])).windowId;
      const groupId = await retryDrag(() =>
        chrome.tabs.group({
          tabIds: members as [number, ...number[]],
          createProperties: { windowId: destinationForGroup },
        }),
      );
      if (logical)
        await chrome.tabGroups.update(groupId, {
          title: logical.name,
          color: logical.color,
          collapsed: logical.collapsed,
        });
      const fresh = await live();
      fresh.groups = fresh.groups.map((g) =>
        g.id === groupId ? { ...g, spaceId: payload.spaceId, logicalId } : g,
      );
      await saveBindings(fresh);
    }
    await reconcile("opened saved session");
    return opened;
  }
  if (type === "focusSpace") {
    const state = await live(),
      groups = state.groups.filter((g) => g.spaceId === payload.spaceId),
      tab = state.tabs.find((t) => t.spaceId === payload.spaceId);
    for (const g of state.groups.filter(
      (g) => g.spaceId && tab?.windowId === g.windowId,
    ))
      await chrome.tabGroups.update(g.id, {
        collapsed: !groups.some((x) => x.id === g.id),
      });
    if (tab) {
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
    }
    return;
  }
  if (type === "groupUpdate") {
    const state = await live();
    if (!state.groups.some((g) => g.id === payload.groupId))
      throw new Error("Missing group.");
    await retryDrag(() =>
      chrome.tabGroups.update(payload.groupId!, {
        title: payload.name,
        color: payload.color,
        collapsed: payload.collapsed,
      }),
    );
    return reconcile("group edit");
  }
  const tabs = await checkTabs(ids);
  if (type === "sortTitle" || type === "sortDomain") {
    if (
      tabs.some((t) => t.pinned) ||
      new Set(tabs.map((t) => `${t.windowId}:${t.groupId}`)).size !== 1
    )
      throw new Error(
        "Sort unpinned tabs within one window and native group at a time.",
      );
    const sorted = [...tabs].sort((a, b) =>
      (type === "sortTitle" ? a.title : new URL(a.url).hostname).localeCompare(
        type === "sortTitle" ? b.title : new URL(b.url).hostname,
      ),
    );
    const positions = tabs.map((t) => t.index).sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++)
      await retryDrag(() =>
        chrome.tabs.move(sorted[i].id, { index: positions[i] }),
      );
    return reconcile("sorted tabs");
  }
  if (type === "focus") {
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    return chrome.tabs.update(tabs[0].id, { active: true });
  }
  if (type === "close") {
    await repo.snapshot(
      blueprint(await live(), "Before explicit tab close", true),
    );
    await retryDrag(() => chrome.tabs.remove(ids));
    return reconcile("explicit close");
  }
  if (type === "discard") {
    for (const t of tabs) {
      if (t.active || t.audible || t.pinned || !t.autoDiscardable || t.muted)
        throw new Error(
          "Active, audible, pinned, muted/capture-uncertain or exempt tabs are protected.",
        );
      await chrome.tabs.discard(t.id);
    }
    return reconcile("manual discard");
  }
  if (type === "duplicate") {
    for (const id of ids) await chrome.tabs.duplicate(id);
    return reconcile();
  }
  if (type === "pin") {
    for (const t of tabs) await chrome.tabs.update(t.id, { pinned: !t.pinned });
    return reconcile();
  }
  if (type === "mute") {
    for (const t of tabs) await chrome.tabs.update(t.id, { muted: !t.muted });
    return reconcile();
  }
  if (type === "move") {
    const target = payload.windowId
      ? await chrome.windows.get(payload.windowId)
      : undefined;
    if (target?.incognito || (target && target.type !== "normal"))
      throw new Error("Use a normal window.");
    await retryDrag(() =>
      chrome.tabs.move(ids, {
        windowId: payload.windowId,
        index: payload.index ?? -1,
      }),
    );
    return reconcile("tab move");
  }
  if (type === "ungroup") {
    await retryDrag(() => chrome.tabs.ungroup(ids as [number, ...number[]]));
    return reconcile("dissolve group");
  }
  if (type === "adopt" || type === "group") {
    if (tabs.some((t) => t.pinned))
      throw new Error(
        "Pinned tabs remain global. Explicitly unpin them before grouping.",
      );
    if (new Set(tabs.map((t) => t.windowId)).size !== 1)
      throw new Error("Select tabs in the same window.");
    const spaces = await repo.list(),
      space = spaces.find(
        (e) =>
          e.kind === "space" &&
          e.id === payload.spaceId &&
          !e.deletedAt &&
          !e.archivedAt,
      );
    if (!space) throw new Error("Choose an available Space.");
    await repo.snapshot(
      blueprint(await live(), "Before native grouping", true),
    );
    const groupId = await retryDrag(() =>
      chrome.tabs.group({
        tabIds: ids as [number, ...number[]],
        ...(payload.groupId === undefined
          ? { createProperties: { windowId: tabs[0].windowId } }
          : { groupId: payload.groupId }),
      }),
    );
    if (payload.groupId === undefined)
      await chrome.tabGroups.update(groupId, {
        title: payload.name ?? space.name,
        color: payload.color ?? space.color,
      });
    const state = await live(),
      native = state.groups.find((g) => g.id === groupId)!;
    let logicalId = native.logicalId;
    const existingLogical = logicalId
      ? await repo.db.entities.get(logicalId)
      : undefined;
    if (
      !existingLogical ||
      existingLogical.kind !== "group" ||
      existingLogical.deletedAt ||
      existingLogical.spaceId !== space.id
    ) {
      const logical = entity("group", native.title, {
        spaceId: space.id,
        color: native.color,
      });
      await repo.execute({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: logical,
      });
      logicalId = logical.id;
    }
    state.groups = state.groups.map((g) =>
      g.id === groupId ? { ...g, spaceId: space.id, logicalId } : g,
    );
    state.tabs = state.tabs.map((t) =>
      ids.includes(t.id) || t.groupId === groupId
        ? { ...t, spaceId: space.id }
        : t,
    );
    await saveBindings(state);
    return reconcile("native grouping");
  }
  throw new Error("Unknown browser action.");
}
