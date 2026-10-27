import { z } from "zod";
import { beginIconIntent, endIconIntent } from "./manager-icon-intent";
import { savedSessionData } from "../../../../packages/domain/saved-session";
import {
  entity,
  safeUrl,
  snapshotSchema,
  type LiveTab,
  type Entity,
  type BrowserState,
  type Snapshot,
} from "../../../../packages/domain/model";
import { repository as repo } from "../../../../packages/persistence/repository";
import {
  blueprint,
  browserAction,
  generation,
  live,
  reconcile,
  retryDrag,
  saveBindings,
} from "./browser";

const bindingSchema = z.object({
  windowId: z.number().int(),
  spaceId: z.string().uuid(),
  parked: z.boolean(),
});
const registrySchema = z.object({
  generation: z.string(),
  bindings: z.array(bindingSchema),
});
export type SessionBinding = z.infer<typeof bindingSchema>;
const registryKey = "session:registry";
const closingWindows = new Set<number>();
export function noteClosingWindow(windowId: number) {
  closingWindows.add(windowId);
}
const checkpointKey = (spaceId: string) => `session:checkpoint:${spaceId}`;

export async function setSpaceTabLock(
  spaceId: string,
  locked: boolean,
  ids: number[] = [],
  keys: string[] = [],
  all = false,
) {
  const space = await available(spaceId);
  if (space.temporary)
    throw new Error("Lock in Space is available only for Saved Spaces.");
  await reconcile("Prepare tab locks");
  const state = await live(),
    data = await savedData(spaceId);
  const selected = data.entries.filter((entry) => keys.includes(entry.key));
  if (selected.length !== new Set(keys).size)
    throw new Error("This tab selection changed. Refresh and retry.");
  const liveTabs = state.tabs.filter(
    (tab) =>
      tab.spaceId === spaceId &&
      sessionTab(tab) &&
      (all || ids.includes(tab.id)),
  );
  if (!all && liveTabs.length !== new Set(ids).size)
    throw new Error("Choose tabs in this Saved Space.");
  const targets = new Set<string>(),
    liveIds = new Set<string>();
  const byUrl = new Map<string, string[]>();
  for (const tab of liveTabs) {
    const row = await repo.db.meta.get(`tab:${state.generation}:${tab.id}`);
    if (typeof row?.value === "string") {
      targets.add(row.value);
      liveIds.add(row.value);
      byUrl.set(tab.url, [...(byUrl.get(tab.url) ?? []), row.value]);
    }
  }
  const snapshot = {
    ...data.snapshot,
    tabs: data.snapshot.tabs.map((tab) => ({ ...tab })),
  };
  const removed = new Set<number>();
  for (const entry of all ? data.entries : selected) {
    const liveId = byUrl.get(entry.tab.url)?.shift();
    if (entry.tab.lockId) {
      targets.add(entry.tab.lockId);
      if (!locked && !liveIds.has(entry.tab.lockId)) removed.add(entry.index);
    } else if (locked) {
      if (liveId) {
        snapshot.tabs[entry.index].lockId = liveId;
        snapshot.tabs[entry.index].recordId = liveId;
        continue;
      }
      const prior = entry.tab.recordId
        ? await repo.db.entities.get(entry.tab.recordId)
        : undefined;
      if (
        prior?.kind === "savedTab" &&
        prior.spaceId === spaceId &&
        !prior.deletedAt
      ) {
        targets.add(prior.id);
        snapshot.tabs[entry.index].lockId = prior.id;
        continue;
      }
      const item = entity(
        "savedTab",
        entry.tab.title.slice(0, 500) || entry.tab.url,
        {
          spaceId,
          url: entry.tab.url,
          order: entry.index,
          muted: entry.tab.muted,
          locked: true,
        },
      );
      await repo.execute({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: item,
      });
      snapshot.tabs[entry.index].lockId = item.id;
      snapshot.tabs[entry.index].recordId = item.id;
      targets.add(item.id);
    }
  }
  for (const id of targets) {
    const item = await repo.db.entities.get(id);
    if (
      item?.kind === "savedTab" &&
      item.spaceId === spaceId &&
      !item.deletedAt
    )
      await repo.execute({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "update",
        id,
        expectedRevision: item.revision,
        patch: { locked },
      });
  }
  await reconcile("Tab locks changed");
  if (state.tabs.some((tab) => tab.spaceId === spaceId && sessionTab(tab)))
    await capture(spaceId);
  else
    await repo.db.meta.put({
      id: checkpointKey(spaceId),
      value: {
        snapshot: editedSnapshot(
          snapshot,
          snapshot.tabs
            .filter((_, index) => !removed.has(index))
            .map((tab) => ({
              ...tab,
              lockId:
                !locked && tab.lockId && targets.has(tab.lockId)
                  ? undefined
                  : tab.lockId,
            })),
        ),
        activeIndex: 0,
      },
    });
}

async function savedData(spaceId: string) {
  await available(spaceId);
  return savedSessionData(
    spaceId,
    await repo.list(),
    (await repo.db.meta.get(checkpointKey(spaceId)))?.value,
  );
}
async function relocateLocks(
  tabs: Snapshot["tabs"],
  spaceId: string,
  copy: boolean,
) {
  const space = await available(spaceId);
  const result: Snapshot["tabs"] = [];
  for (const tab of tabs) {
    const item = tab.lockId
      ? await repo.db.entities.get(tab.lockId)
      : undefined;
    if (!item?.locked || item.deletedAt) {
      result.push({ ...tab, lockId: undefined, recordId: undefined });
      continue;
    }
    let id = item.id;
    if (copy) {
      const clone = entity("savedTab", item.name, {
        spaceId,
        url: item.url,
        muted: item.muted,
        order: item.order,
        locked: !space.temporary,
        groupId: item.spaceId === spaceId ? item.groupId : undefined,
      });
      await repo.execute({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: clone,
      });
      id = clone.id;
    } else
      await repo.execute({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "move",
        id,
        expectedRevision: item.revision,
        targetSpaceId: spaceId,
        patch: { locked: !space.temporary },
      });
    result.push({
      ...tab,
      lockId: space.temporary ? undefined : id,
      recordId: id,
    });
  }
  return result;
}
function editedSnapshot(snapshot: Snapshot, tabs: Snapshot["tabs"]): Snapshot {
  return snapshotSchema.parse({
    ...snapshot,
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    tabs,
    groups: snapshot.groups.filter((g) =>
      tabs.some((t) => t.groupKey === g.key),
    ),
  });
}
function appendSnapshot(
  destination: Snapshot,
  incoming: Snapshot,
  tabs: Snapshot["tabs"],
  spaceId: string,
) {
  const prefix = crypto.randomUUID();
  const appended = tabs.map((t) => ({
    ...t,
    spaceId,
    windowKey: "window-1",
    groupKey: t.groupKey ? `${prefix}:${t.groupKey}` : undefined,
  }));
  return snapshotSchema.parse({
    ...destination,
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    tabs: [...destination.tabs, ...appended],
    groups: [
      ...destination.groups,
      ...incoming.groups
        .filter((g) => tabs.some((t) => t.groupKey === g.key))
        .map((g) => ({
          ...g,
          key: `${prefix}:${g.key}`,
          windowKey: "window-1",
        })),
    ],
  });
}
export async function editSavedTabs(
  action:
    | "openSavedTabs"
    | "moveSavedTabs"
    | "copySavedTabs"
    | "removeSavedTabs"
    | "duplicateSavedTabs"
    | "groupSavedTabs"
    | "ungroupSavedTabs",
  sourceSpaceId: string,
  keys: string[],
  destinationId?: string,
  windowId?: number,
  background = false,
) {
  if (await repo.db.meta.get("session:operation"))
    throw new Error("Inspect the interrupted operation first.");
  const state = await live();
  const source = await savedData(sourceSpaceId);
  const keySet = new Set(keys);
  const chosen = source.entries.filter((e) => keySet.has(e.key));
  const liveSource = state.tabs.filter(
    (tab) => tab.spaceId === sourceSpaceId && sessionTab(tab),
  );
  if (
    liveSource.length &&
    chosen.some(
      (entry) =>
        !entry.tab.lockId ||
        liveSource.some((tab) => tab.lockId === entry.tab.lockId),
    )
  )
    throw new Error("This session changed. Refresh before retrying.");
  if (!keys.length || chosen.length !== new Set(keys).size)
    throw new Error("This saved selection changed. Refresh before retrying.");
  if (action === "openSavedTabs") {
    if (windowId === undefined) throw new Error("Choose a normal window.");
    const window = await chrome.windows.get(windowId);
    if (window.incognito || window.type !== "normal")
      throw new Error("Use a normal window.");
    const binding = (await sessionStatus()).find(
      (binding) => binding.spaceId === sourceSpaceId,
    );
    for (const { tab } of chosen) {
      if (tab.lockId && binding) {
        await restoreMissingLockedTabs(
          binding.windowId,
          sourceSpaceId,
          new Set([tab.lockId]),
        );
        const restored = (await live()).tabs.find(
          (item) =>
            item.spaceId === sourceSpaceId && item.lockId === tab.lockId,
        );
        if (restored && !background)
          await chrome.tabs.update(restored.id, { active: true });
        continue;
      }
      const created = await chrome.tabs.create({
        windowId: tab.lockId && binding ? binding.windowId : windowId,
        url: safeUrl(tab.url),
        active: !background && chosen.length === 1,
      });
      if (tab.lockId && binding) {
        await repo.db.meta.put({
          id: `tab:${state.generation}:${created.id}`,
          value: tab.lockId,
        });
        await claim([created.id!], sourceSpaceId);
      }
    }
    await syncSessions();
    return;
  }
  if (action === "moveSavedTabs" && destinationId === sourceSpaceId) return;
  if (
    (action === "moveSavedTabs" || action === "copySavedTabs") &&
    !destinationId
  )
    throw new Error("Choose a destination Space.");
  if (action !== "moveSavedTabs" && action !== "copySavedTabs" && destinationId)
    throw new Error("Unexpected destination for this action.");
  const destination = destinationId
    ? await savedData(destinationId)
    : undefined;
  await repo.snapshot({
    ...source.snapshot,
    id: crypto.randomUUID(),
    protected: true,
    reason: "Before editing saved session tabs",
  });
  if (destination)
    await repo.snapshot({
      ...destination.snapshot,
      id: crypto.randomUUID(),
      protected: true,
      reason: "Before receiving saved session tabs",
    });
  if (
    action === "duplicateSavedTabs" ||
    action === "groupSavedTabs" ||
    action === "ungroupSavedTabs"
  ) {
    const indices = new Set(chosen.map((entry) => entry.index));
    const groupKey = crypto.randomUUID();
    const space = await available(sourceSpaceId);
    const duplicates =
      action === "duplicateSavedTabs"
        ? await relocateLocks(
            chosen.map((entry) => entry.tab),
            sourceSpaceId,
            true,
          )
        : [];
    if (action === "groupSavedTabs")
      await repo.execute({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: entity("group", space.name, {
          id: groupKey,
          spaceId: sourceSpaceId,
          color: space.color,
        }),
      });
    if (action !== "duplicateSavedTabs")
      for (const { tab } of chosen) {
        const item = tab.lockId
          ? await repo.db.entities.get(tab.lockId)
          : undefined;
        if (item)
          await repo.execute({
            schemaVersion: 1,
            commandId: crypto.randomUUID(),
            type: "update",
            id: item.id,
            expectedRevision: item.revision,
            patch: {
              groupId: action === "groupSavedTabs" ? groupKey : undefined,
            },
          });
      }
    const base =
      action === "groupSavedTabs"
        ? {
            ...source.snapshot,
            groups: [
              ...source.snapshot.groups,
              {
                key: groupKey,
                title: space.name,
                color: space.color,
                collapsed: false,
              },
            ],
          }
        : source.snapshot;
    const tabs = source.snapshot.tabs.flatMap((tab, index) => {
      if (!indices.has(index)) return [tab];
      if (action === "duplicateSavedTabs")
        return [
          tab,
          duplicates[chosen.findIndex((entry) => entry.index === index)],
        ];
      return [
        {
          ...tab,
          groupKey: action === "groupSavedTabs" ? groupKey : undefined,
        },
      ];
    });
    await repo.db.meta.put({
      id: checkpointKey(sourceSpaceId),
      value: { snapshot: editedSnapshot(base, tabs), activeIndex: 0 },
    });
    return;
  }
  const removed = new Set(chosen.map((e) => e.index));
  const incomingTabs = destinationId
    ? await relocateLocks(
        chosen.map((entry) => entry.tab),
        destinationId,
        action === "copySavedTabs",
      )
    : chosen.map((entry) => entry.tab);
  if (action === "removeSavedTabs")
    for (const { tab } of chosen) {
      const item = tab.lockId
        ? await repo.db.entities.get(tab.lockId)
        : undefined;
      if (item)
        await repo.execute({
          schemaVersion: 1,
          commandId: crypto.randomUUID(),
          type: "update",
          id: item.id,
          expectedRevision: item.revision,
          patch: { locked: false },
        });
    }
  const remaining = editedSnapshot(
    source.snapshot,
    source.snapshot.tabs.filter((_, i) => !removed.has(i)),
  );
  const binding = destinationId
    ? (await sessionStatus()).find((b) => b.spaceId === destinationId)
    : undefined;
  if (binding && destinationId) {
    await repo.db.meta.put({
      id: "session:operation",
      value: {
        spaceId: destinationId,
        intent: "move saved tabs",
        startedAt: new Date().toISOString(),
      },
    });
    const ids: number[] = [];
    for (const tab of incomingTabs) {
      const created = await chrome.tabs.create({
        windowId: binding.windowId,
        url: safeUrl(tab.url),
        active: false,
      });
      ids.push(created.id!);
      if (tab.lockId)
        await repo.db.meta.put({
          id: `tab:${state.generation}:${created.id}`,
          value: tab.lockId,
        });
      if (tab.muted) await chrome.tabs.update(created.id!, { muted: true });
    }
    for (const group of source.snapshot.groups) {
      const members = chosen.flatMap((entry, index) =>
        entry.tab.groupKey === group.key ? [ids[index]] : [],
      );
      if (!members.length) continue;
      const groupId = await chrome.tabs.group({
        tabIds: members as [number, ...number[]],
      });
      await chrome.tabGroups.update(groupId, {
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
      });
    }
    await claim(ids, destinationId);
    await capture(destinationId);
    if (action !== "copySavedTabs")
      await repo.db.meta.put({
        id: checkpointKey(sourceSpaceId),
        value: { snapshot: remaining, activeIndex: 0 },
      });
    await repo.db.meta.delete("session:operation");
  } else {
    await repo.db.transaction("rw", repo.db.meta, async () => {
      if (action !== "copySavedTabs")
        await repo.db.meta.put({
          id: checkpointKey(sourceSpaceId),
          value: { snapshot: remaining, activeIndex: 0 },
        });
      if (destination && destinationId)
        await repo.db.meta.put({
          id: checkpointKey(destinationId),
          value: {
            snapshot: appendSnapshot(
              destination.snapshot,
              source.snapshot,
              incomingTabs,
              destinationId,
            ),
            activeIndex: 0,
          },
        });
    });
  }
}
export async function copyTabsToSpace(ids: number[], spaceId: string) {
  await available(spaceId);
  if (await repo.db.meta.get("session:operation"))
    throw new Error("Inspect the interrupted operation first.");
  const state = await live(),
    selected = new Set(ids);
  const tabs = state.tabs.filter((tab) => selected.has(tab.id));
  if (
    !tabs.length ||
    tabs.length !== selected.size ||
    tabs.some((tab) => !sessionTab(tab))
  )
    throw new Error("Select ordinary unpinned website tabs.");
  const incoming = blueprint(
    {
      ...state,
      tabs,
      groups: state.groups.filter((group) =>
        tabs.some((tab) => tab.groupId === group.id),
      ),
    },
    "Copied tabs",
  );
  const destination = await savedData(spaceId);
  incoming.tabs = await relocateLocks(incoming.tabs, spaceId, true);
  await repo.snapshot({
    ...destination.snapshot,
    id: crypto.randomUUID(),
    protected: true,
    reason: "Before receiving copied tabs",
  });
  const binding = (await sessionStatus()).find(
    (session) => session.spaceId === spaceId,
  );
  if (!binding) {
    await repo.db.meta.put({
      id: checkpointKey(spaceId),
      value: {
        snapshot: appendSnapshot(
          destination.snapshot,
          incoming,
          incoming.tabs,
          spaceId,
        ),
        activeIndex: 0,
      },
    });
    return;
  }
  await repo.db.meta.put({
    id: "session:operation",
    value: {
      spaceId,
      intent: "copy tabs",
      startedAt: new Date().toISOString(),
    },
  });
  const created: number[] = [];
  for (const tab of incoming.tabs) {
    const copy = await chrome.tabs.create({
      windowId: binding.windowId,
      url: safeUrl(tab.url),
      active: false,
    });
    created.push(copy.id!);
    if (tab.lockId)
      await repo.db.meta.put({
        id: `tab:${state.generation}:${copy.id}`,
        value: tab.lockId,
      });
    if (tab.muted) await chrome.tabs.update(copy.id!, { muted: true });
  }
  for (const group of incoming.groups) {
    const members = incoming.tabs.flatMap((tab, index) =>
      tab.groupKey === group.key ? [created[index]] : [],
    );
    if (!members.length) continue;
    const groupId = await chrome.tabs.group({
      tabIds: members as [number, ...number[]],
    });
    await chrome.tabGroups.update(groupId, {
      title: group.title,
      color: group.color,
      collapsed: group.collapsed,
    });
  }
  await claim(created, spaceId);
  await capture(spaceId);
  await repo.db.meta.delete("session:operation");
}
// Save a closed copy, without adopting, moving or replacing any live tabs.
export async function saveWindowAsSpace(
  windowId: number,
  spaceId: string,
  name: string,
  locked: boolean,
  color: Entity["color"] = "blue",
  collectionId?: string,
) {
  const window = await chrome.windows.get(windowId);
  if (window.type !== "normal" || window.incognito)
    throw new Error("Use a normal Chrome window.");
  const state = await live();
  const tabs = state.tabs
    .filter((tab) => {
      if (tab.windowId !== windowId || tab.url.length > 20000) return false;
      try {
        safeUrl(tab.url);
        return true;
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.index - b.index);
  if (!tabs.length) throw new Error("This window has no website tabs to save.");
  const space = entity("space", name.trim(), {
    id: spaceId,
    temporary: false,
    view: "tabs",
    color,
    sidebarId: collectionId,
  });
  const groups = state.groups.filter(
    (group) =>
      group.windowId === windowId &&
      tabs.some((tab) => tab.groupId === group.id),
  );
  const copies = groups.map((group) =>
    entity("group", group.title, {
      spaceId,
      color: group.color,
      collapsed: group.collapsed,
    }),
  );
  const groupIds = new Map(
    groups.map((group, index) => [group.id, copies[index].id]),
  );
  const records = tabs.map((tab, index) =>
    entity("savedTab", tab.title, {
      spaceId,
      url: tab.url,
      order: index,
      muted: tab.muted,
      locked,
      // Pinned sites are copied as ordinary Space tabs; the live pins stay global.
      pinned: false,
      groupId: groupIds.get(tab.groupId),
    }),
  );
  const snapshot = snapshotSchema.parse({
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    reason: "Saved window as Space",
    protected: false,
    tabs: records.map((record) => ({
      url: record.url!,
      title: record.name,
      spaceId,
      windowKey: "window-1",
      pinned: false,
      muted: !!record.muted,
      recordId: record.id,
      lockId: locked ? record.id : undefined,
      groupKey: record.groupId,
    })),
    groups: copies.map((group) => ({
      key: group.id,
      windowKey: "window-1",
      title: group.name,
      color: group.color,
      collapsed: group.collapsed,
    })),
  });
  await repo.db.transaction("rw", repo.db.tables, async () => {
    if (collectionId) {
      const collection = await repo.db.entities.get(collectionId);
      if (
        collection?.kind !== "sidebar" ||
        collection.deletedAt ||
        collection.archivedAt
      )
        throw new Error("Choose an available collection.");
    }
    await repo.execute({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "create",
      entity: space,
    });
    await repo.db.entities.bulkAdd([...copies, ...records]);
    await repo.db.meta.put({
      id: checkpointKey(spaceId),
      value: {
        snapshot,
        activeIndex: Math.max(
          0,
          tabs.findIndex((tab) => tab.active),
        ),
      },
    });
  });
}
const parkingUrl = (spaceId: string) =>
  chrome.runtime.getURL(`parking.html?space=${spaceId}`);

// Internal/extension pages and pinned tabs remain global to their window.
export const sessionTab = (t: Pick<LiveTab, "pinned" | "url">) =>
  !t.pinned &&
  (/^https?:\/\//.test(t.url) || /^chrome:\/\/newtab\/?$/.test(t.url));

async function available(spaceId: string) {
  if (spaceId === (await repo.inbox()))
    throw new Error("Inbox stores content, not browsing sessions.");
  const space = await repo.db.entities.get(spaceId);
  if (!space || space.kind !== "space" || space.deletedAt || space.archivedAt)
    throw new Error("Choose an available Space.");
  return space;
}
async function registry() {
  const gen = await generation();
  const parsed = registrySchema.safeParse(
    (await repo.db.meta.get(registryKey))?.value,
  );
  return parsed.success && parsed.data.generation === gen
    ? parsed.data
    : { generation: gen, bindings: [] as SessionBinding[] };
}
async function persist(bindings: SessionBinding[]) {
  await repo.db.meta.put({
    id: registryKey,
    value: { generation: await generation(), bindings },
  });
  // Publish the committed window identity before full capture/maintenance ends.
  void chrome.runtime
    .sendMessage({ type: "tabspace:iconChanged" })
    .catch(() => undefined);
}
export async function sessionStatus() {
  const current = await registry();
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const valid = new Set(windows.filter((w) => !w.incognito).map((w) => w.id));
  return current.bindings.filter(
    (b) => valid.has(b.windowId) && !closingWindows.has(b.windowId),
  );
}
export async function labelTemporarySpaces() {
  const all = await repo.list();
  if (await repo.db.meta.where("id").startsWith("quarantine:").count()) return;
  const legacy = all
    .filter(
      (e) =>
        e.kind === "space" &&
        e.temporary &&
        !e.deletedAt &&
        e.name === "Temporary browsing",
    )
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  if (legacy.length < 2) return;
  const names = new Set(
    all.filter((e) => e.kind === "space").map((e) => e.name),
  );
  let number = 1;
  for (const space of legacy) {
    while (names.has(`Temporary browsing (${number})`)) number++;
    const name = `Temporary browsing (${number++})`;
    names.add(name);
    await repo.execute({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "update",
      id: space.id,
      expectedRevision: space.revision,
      patch: { name },
    });
  }
}
export async function ensureTemporarySession(
  windowId: number,
  tabIds: number[],
) {
  const key = `session:auto-temp:${await generation()}:${windowId}:${[...tabIds].sort((a, b) => a - b).join(",")}`;
  const existing = (await repo.db.meta.get(key))?.value;
  if (typeof existing === "string") {
    const space = await repo.db.entities.get(existing);
    if (
      space?.kind === "space" &&
      space.temporary &&
      !space.deletedAt &&
      !space.archivedAt
    )
      return space.id;
  }
  const names = new Set(
    (await repo.list()).filter((e) => e.kind === "space").map((e) => e.name),
  );
  let name = "Unsaved 1",
    number = 2;
  while (names.has(name)) name = `Unsaved ${number++}`;
  const space = entity("space", name, {
    temporary: true,
    view: "tabs",
    icon: "◌",
  });
  await repo.execute({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    type: "create",
    entity: space,
  });
  await repo.db.meta.put({ id: key, value: space.id });
  return space.id;
}
async function claim(ids: number[], spaceId: string) {
  const state = await live();
  const selected = new Set(ids);
  for (const group of state.groups) {
    if (!state.tabs.some((t) => selected.has(t.id) && t.groupId === group.id))
      continue;
    if (group.spaceId !== spaceId || !group.logicalId) {
      const logical = entity("group", group.title, {
        spaceId,
        color: group.color,
        collapsed: group.collapsed,
      });
      await repo.execute({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: logical,
      });
      group.spaceId = spaceId;
      group.logicalId = logical.id;
    }
  }
  for (const tab of state.tabs) if (selected.has(tab.id)) tab.spaceId = spaceId;
  await saveBindings(state);
}
export async function discardBrowsingBinding(windowId: number) {
  await persist(
    (await sessionStatus()).filter((binding) => binding.windowId !== windowId),
  );
}
export async function bindBrowsingWindow(windowId: number, spaceId: string) {
  const state = await live();
  const saved = await savedData(spaceId);
  const queues = new Map<string, typeof saved.entries>();
  for (const entry of saved.entries)
    queues.set(entry.tab.url, [...(queues.get(entry.tab.url) ?? []), entry]);
  for (const tab of state.tabs
    .filter((tab) => tab.windowId === windowId && sessionTab(tab))
    .sort((a, b) => a.index - b.index)) {
    const entry = queues.get(tab.url)?.shift();
    if (entry?.tab.recordId || entry?.tab.lockId) {
      const item = await repo.db.entities.get(
        (entry.tab.lockId || entry.tab.recordId)!,
      );
      if (
        item?.kind !== "savedTab" ||
        item.spaceId !== spaceId ||
        item.deletedAt
      )
        continue;
      await repo.db.meta.put({
        id: `tab:${state.generation}:${tab.id}`,
        value: entry.tab.lockId || entry.tab.recordId,
      });
      if (tab.groupId >= 0 && item?.groupId)
        await repo.db.meta.put({
          id: `owner:${state.generation}:group:${tab.groupId}`,
          value: { spaceId, logicalId: item.groupId },
        });
    }
  }
  await claim(
    state.tabs
      .filter((tab) => tab.windowId === windowId && sessionTab(tab))
      .map((tab) => tab.id),
    spaceId,
  );
  await persist([
    ...(await sessionStatus()).filter(
      (binding) => binding.windowId !== windowId && binding.spaceId !== spaceId,
    ),
    { windowId, spaceId, parked: false },
  ]);
  await capture(spaceId);
}
export async function restoreMissingLockedTabs(
  windowId: number,
  spaceId: string,
  lockIds?: Set<string>,
) {
  const space = await available(spaceId);
  if (space.temporary) return;
  const state = await live();
  const all = await repo.list();
  const groupIds = new Map(
    state.groups
      .filter(
        (group) =>
          group.spaceId === spaceId &&
          group.logicalId &&
          group.windowId === windowId,
      )
      .map((group) => [group.logicalId!, group.id]),
  );
  const locks = all.filter(
    (item) =>
      item.kind === "savedTab" &&
      item.spaceId === spaceId &&
      item.locked &&
      (!lockIds || lockIds.has(item.id)) &&
      !item.deletedAt &&
      !item.pinned &&
      item.url,
  );
  for (const item of locks) {
    if (
      state.tabs.some(
        (tab) => tab.spaceId === spaceId && tab.lockId === item.id,
      )
    )
      continue;
    const tab = await chrome.tabs.create({
      windowId,
      url: safeUrl(item.url!),
      active: false,
    });
    await repo.db.meta.put({
      id: `tab:${state.generation}:${tab.id}`,
      value: item.id,
    });
    if (item.muted) await chrome.tabs.update(tab.id!, { muted: true });
    const logical = all.find(
      (group) =>
        group.id === item.groupId &&
        group.kind === "group" &&
        group.spaceId === spaceId &&
        !group.deletedAt,
    );
    if (logical) {
      let groupId = groupIds.get(logical.id);
      if (groupId === undefined) {
        groupId = await chrome.tabs.group({
          tabIds: [tab.id!],
          createProperties: { windowId },
        });
        groupIds.set(logical.id, groupId);
        await chrome.tabGroups.update(groupId, {
          title: logical.name,
          color: logical.color,
          collapsed: logical.collapsed,
        });
        await repo.db.meta.put({
          id: `owner:${state.generation}:group:${groupId}`,
          value: { spaceId, logicalId: logical.id },
        });
      } else await chrome.tabs.group({ tabIds: [tab.id!], groupId });
    }
    await claim([tab.id!], spaceId);
  }
  await capture(spaceId);
}
export async function restoreBrowsingWindow(
  spaceId: string,
  requestedWindowId?: number,
) {
  const windowId =
    requestedWindowId ??
    (await chrome.windows.create({ url: "chrome://newtab", focused: false }))
      ?.id;
  if (windowId === undefined)
    throw new Error("Could not restore the browsing window.");
  const before = await chrome.tabs.query({ windowId });
  const activeIndex = await restore(spaceId, windowId);
  const after = await chrome.tabs.query({ windowId });
  const created = after.filter(
    (tab) => !before.some((old) => old.id === tab.id),
  );
  if (created.length) {
    for (const tab of before.filter((tab) =>
      /^chrome:\/\/newtab\/?$/.test(tab.url ?? ""),
    )) {
      const current = await chrome.tabs.get(tab.id!).catch(() => undefined);
      if (current && /^chrome:\/\/newtab\/?$/.test(current.url ?? ""))
        await chrome.tabs.remove(tab.id!);
    }
    await chrome.tabs.update(
      created[Math.min(activeIndex, created.length - 1)].id!,
      { active: true },
    );
  }
  await bindBrowsingWindow(windowId, spaceId);
  return windowId;
}
async function capture(
  spaceId: string,
  preserveActive = false,
  currentState?: BrowserState,
) {
  const state = currentState ?? (await live());
  const tabs = state.tabs.filter((t) => t.spaceId === spaceId && sessionTab(t));
  const groups = state.groups.filter((g) =>
    tabs.some((t) => t.groupId === g.id),
  );
  const snapshot = blueprint(
    { ...state, tabs, groups },
    `Space session: ${spaceId}`,
  );
  const previous = (await repo.db.meta.get(checkpointKey(spaceId)))?.value as
    { snapshot?: Snapshot; activeIndex?: number } | undefined;
  const activeIndex = preserveActive
    ? (previous?.activeIndex ?? 0)
    : Math.max(
        0,
        tabs.findIndex((t) => t.active),
      );
  if (
    (await registry()).bindings.some(
      (b) => b.spaceId === spaceId && closingWindows.has(b.windowId),
    )
  )
    return previous?.snapshot ?? snapshot;
  // Chrome can acknowledge tabs.create before publishing its URL. Do not turn
  // that transient state into an authoritative empty session.
  if (
    state.tabs.some(
      (t) =>
        t.spaceId === spaceId &&
        !t.pinned &&
        (!t.url || t.url === "about:blank"),
    )
  )
    return previous?.snapshot ?? snapshot;
  if (
    JSON.stringify(previous?.snapshot?.tabs) ===
      JSON.stringify(snapshot.tabs) &&
    JSON.stringify(previous?.snapshot?.groups) ===
      JSON.stringify(snapshot.groups) &&
    previous?.activeIndex === activeIndex
  )
    return previous.snapshot!;
  // Keep the latest empty session too: closing the last tab must not resurrect it.
  await repo.db.meta.put({
    id: checkpointKey(spaceId),
    value: {
      snapshot,
      activeIndex,
    },
  });
  return snapshot;
}
async function anchor(windowId: number) {
  const tabs = await chrome.tabs.query({ windowId });
  if (
    !tabs.some(
      (t) =>
        t.pinned ||
        !sessionTab({ pinned: !!t.pinned, url: t.url || t.pendingUrl || "" }),
    )
  )
    await chrome.tabs.create({
      windowId,
      url: chrome.runtime.getURL("index.html"),
      active: false,
    });
}
async function transfer(tabs: LiveTab[], windowId: number) {
  const movedGroups = new Set<number>();
  for (const tab of [...tabs].sort((a, b) => a.index - b.index)) {
    if (tab.groupId >= 0) {
      if (movedGroups.has(tab.groupId)) continue;
      // A native group moves as a unit and keeps its identity and loaded pages.
      await retryDrag(() =>
        chrome.tabGroups.move(tab.groupId, { windowId, index: -1 }),
      );
      movedGroups.add(tab.groupId);
    } else
      await retryDrag(() => chrome.tabs.move(tab.id, { windowId, index: -1 }));
  }
}
async function park(spaceId: string, from: number, bindings: SessionBinding[]) {
  const state = await live();
  const tabs = state.tabs.filter(
    (t) => t.windowId === from && t.spaceId === spaceId && sessionTab(t),
  );
  await capture(spaceId);
  if (!tabs.length) return;
  await anchor(from);
  let parking = bindings.find(
    (b) => b.spaceId === spaceId && b.parked && b.windowId !== from,
  );
  if (!parking) {
    const window = await chrome.windows.create({
      url: parkingUrl(spaceId),
      focused: false,
      state: "minimized",
    });
    if (window?.id === undefined)
      throw new Error("Could not preserve the previous session.");
    parking = { windowId: window.id, spaceId, parked: true };
    // Persist before moving so a suspended worker never mistakes it for a user window.
    bindings.push(parking);
    await persist(bindings);
  }
  await transfer(tabs, parking.windowId);
  await chrome.windows.update(parking.windowId, { state: "minimized" });
}
async function restore(spaceId: string, windowId: number) {
  const raw = (await repo.db.meta.get(checkpointKey(spaceId)))?.value as
    { activeIndex?: number } | undefined;
  const data = await savedData(spaceId);
  if (data.snapshot.tabs.length)
    await browserAction("restoreSession", {
      snapshotId: await storeSnapshot(data.snapshot),
      windowId,
      preserveLocks: true,
    });
  return raw?.activeIndex ?? 0;
}
async function storeSnapshot(snapshot: Snapshot) {
  await repo.db.snapshots.put(snapshot);
  return snapshot.id;
}

export async function activateSession(
  spaceId: string,
  requestedWindowId?: number,
  newWindow = false,
) {
  const token = Symbol("Space activation");
  try {
    return await activateSessionWithIcon(
      spaceId,
      requestedWindowId,
      newWindow,
      token,
    );
  } finally {
    endIconIntent(token);
  }
}
async function activateSessionWithIcon(
  spaceId: string,
  requestedWindowId: number | undefined,
  newWindow: boolean,
  token: symbol,
) {
  await repo.initialize();
  if (spaceId === (await repo.inbox()))
    throw new Error("Inbox stores content, not browsing sessions.");
  const unresolved = (await repo.db.meta.get("browsing:unresolved"))?.value as
    string[] | undefined;
  if (unresolved?.includes(spaceId))
    await repo.db.meta.put({
      id: "browsing:unresolved",
      value: unresolved.filter((id) => id !== spaceId),
    });
  if (await repo.db.meta.get("session:operation"))
    throw new Error(
      "Inspect the interrupted Space switch in Recovery before continuing.",
    );
  const target = await available(spaceId);
  const bindings = await sessionStatus();
  const existing = bindings.find((b) => b.spaceId === spaceId && !b.parked);
  // A Space has one active window. Repeated selection focuses it rather than copying tabs.
  if (existing && !newWindow) {
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  if (existing && newWindow) {
    const before = await live();
    const tabs = before.tabs.filter(
      (t) =>
        t.spaceId === spaceId &&
        t.windowId === existing.windowId &&
        sessionTab(t),
    );
    if (
      tabs.some(
        (t) =>
          t.groupId >= 0 &&
          before.tabs.some(
            (other) => other.groupId === t.groupId && !sessionTab(other),
          ),
      )
    )
      throw new Error(
        "Ungroup internal browser pages before moving this Space.",
      );
    await repo.snapshot(
      blueprint(before, "Before opening Space in new window", true),
    );
    await repo.db.meta.put({
      id: "session:operation",
      value: {
        spaceId,
        intent: "new-window",
        startedAt: new Date().toISOString(),
      },
    });
    const destination = await chrome.windows.create({
      url: chrome.runtime.getURL(`index.html?space=${spaceId}`),
      focused: true,
    });
    if (destination?.id === undefined)
      throw new Error("Could not create a working window.");
    beginIconIntent(destination.id, spaceId, token);
    await anchor(existing.windowId);
    await transfer(tabs, destination.id);
    await persist([
      ...bindings.filter((b) => b !== existing),
      { windowId: destination.id, spaceId, parked: false },
    ]);
    await reconcile("Space moved to new window");
    await capture(spaceId);
    await repo.db.meta.delete("session:operation");
    return;
  }
  let windowId = requestedWindowId;
  if (newWindow)
    windowId = (
      await chrome.windows.create({
        url: chrome.runtime.getURL("index.html"),
        focused: true,
      })
    )?.id;
  if (windowId === undefined)
    windowId = (
      await chrome.windows.getLastFocused({ windowTypes: ["normal"] })
    ).id;
  if (windowId === undefined)
    throw new Error("Choose a normal browser window.");
  const window = await chrome.windows.get(windowId);
  if (
    window.incognito ||
    window.type !== "normal" ||
    bindings.some((b) => b.windowId === windowId && b.parked)
  )
    throw new Error("Choose a normal working window.");
  beginIconIntent(windowId, spaceId, token);
  await reconcile("Before Space activation");
  let before = await live();
  // Explicitly selecting a temporary session after reload can reattach its
  // complete ordered website set, rather than preserving another copy of it.
  if (target.temporary) {
    const unmatched = before.tabs
      .filter((t) => t.windowId === windowId && !t.spaceId && sessionTab(t))
      .sort((a, b) => a.index - b.index);
    const checkpoint = (await repo.db.meta.get(checkpointKey(spaceId)))
      ?.value as { snapshot?: Snapshot } | undefined;
    if (
      unmatched.length &&
      checkpoint?.snapshot?.tabs.length === unmatched.length &&
      unmatched.every((t, i) => t.url === checkpoint.snapshot!.tabs[i].url)
    ) {
      await claim(
        unmatched.map((t) => t.id),
        spaceId,
      );
      before = await live();
    }
  }
  await repo.snapshot(blueprint(before, "Before Space activation", true));
  for (const current of bindings.filter(
    (b) => b.windowId === windowId && !b.parked,
  ))
    await capture(current.spaceId);
  const outgoing = before.tabs.filter(
    (t) => t.windowId === windowId && sessionTab(t) && t.spaceId !== spaceId,
  );
  const preserve = (await repo.settings()).preserveLiveTabs;
  if (!preserve) {
    const closing = before.tabs.filter(
      (t) =>
        sessionTab(t) &&
        (outgoing.some((other) => other.id === t.id) ||
          bindings.some(
            (b) =>
              b.parked &&
              b.spaceId !== spaceId &&
              b.windowId === t.windowId &&
              b.spaceId === t.spaceId,
          )),
    );
    for (const tab of closing) {
      if (/^chrome:\/\/newtab\/?$/.test(tab.url)) continue;
      safeUrl(tab.url);
      if (tab.url.length > 20000)
        throw new Error(
          "Keep live tabs enabled for website URLs longer than the recovery limit.",
        );
    }
  }
  for (const tab of outgoing) {
    if (
      tab.groupId >= 0 &&
      before.tabs.some((t) => t.groupId === tab.groupId && !sessionTab(t))
    )
      throw new Error(
        "Ungroup internal browser pages before switching this Space.",
      );
  }
  await repo.db.meta.put({
    id: "session:operation",
    value: { spaceId, windowId, startedAt: new Date().toISOString() },
  });
  const unassigned = outgoing.filter((t) => !t.spaceId);
  if (unassigned.length) {
    const id = await ensureTemporarySession(
      windowId,
      unassigned.map((t) => t.id),
    );
    await claim(
      unassigned.map((t) => t.id),
      id,
    );
    for (const tab of unassigned) tab.spaceId = id;
  }
  for (const owner of new Set(outgoing.map((t) => t.spaceId!))) {
    if (preserve) await park(owner, windowId, bindings);
    else {
      await capture(owner);
      await anchor(windowId);
      const ids = outgoing.filter((t) => t.spaceId === owner).map((t) => t.id);
      if (ids.length) await retryDrag(() => chrome.tabs.remove(ids));
    }
  }
  if (!preserve) {
    for (const parkedBinding of [...bindings].filter(
      (b) => b.parked && b.spaceId !== spaceId,
    )) {
      await capture(parkedBinding.spaceId, true);
      const ids = (await live()).tabs
        .filter(
          (t) =>
            t.windowId === parkedBinding.windowId &&
            t.spaceId === parkedBinding.spaceId &&
            sessionTab(t),
        )
        .map((t) => t.id);
      if (ids.length) await retryDrag(() => chrome.tabs.remove(ids));
      const marker = (
        await chrome.tabs.query({ windowId: parkedBinding.windowId })
      ).find((t) => t.url === parkingUrl(parkedBinding.spaceId));
      if (marker?.id !== undefined) await chrome.tabs.remove(marker.id);
      bindings.splice(bindings.indexOf(parkedBinding), 1);
    }
  }
  // Supersede the old active binding only after its tabs have been checkpointed and parked.
  const next = bindings.filter((b) => b.windowId !== windowId || b.parked);
  await persist(next);
  const parked = next.filter((b) => b.spaceId === spaceId && b.parked);
  const state = await live();
  const incoming = state.tabs.filter(
    (t) => t.spaceId === spaceId && sessionTab(t),
  );
  let activeIndex = Math.max(
    0,
    incoming.findIndex((t) => t.active),
  );
  if (parked.length)
    activeIndex =
      (
        (await repo.db.meta.get(checkpointKey(spaceId)))?.value as
          { activeIndex?: number } | undefined
      )?.activeIndex ?? activeIndex;
  if (incoming.length) {
    for (const source of new Set(incoming.map((t) => t.windowId))) {
      if (source === windowId) continue;
      await anchor(source);
      await transfer(
        incoming.filter((t) => t.windowId === source),
        windowId,
      );
    }
  } else {
    const prior = new Set(state.tabs.map((t) => t.id));
    activeIndex = await restore(spaceId, windowId);
    const created = (await live()).tabs.filter(
      (t) => t.windowId === windowId && !prior.has(t.id) && !t.pinned,
    );
    await claim(
      created.map((t) => t.id),
      spaceId,
    );
  }
  const closedParking = new Set<number>();
  for (const parkedWindow of parked) {
    const remaining = await chrome.tabs.query({
      windowId: parkedWindow.windowId,
    });
    // Remove only our empty parking anchor; never close a window with unexpected user tabs.
    if (remaining.length === 1 && remaining[0].url === parkingUrl(spaceId)) {
      await chrome.tabs.remove(remaining[0].id!);
      closedParking.add(parkedWindow.windowId);
    }
  }
  await persist([
    ...next.filter((b) => !closedParking.has(b.windowId)),
    { windowId, spaceId, parked: false },
  ]);
  const now = (await live()).tabs.filter(
    (t) => t.windowId === windowId && t.spaceId === spaceId && sessionTab(t),
  );
  if (now.length)
    await chrome.tabs.update(now[Math.min(activeIndex, now.length - 1)].id, {
      active: true,
    });
  await chrome.windows.update(windowId, { focused: true });
  await reconcile("Space activated");
  await capture(spaceId);
  await repo.db.meta.delete("session:operation");
}

export async function closeSession(spaceId: string) {
  await available(spaceId);
  if (await repo.db.meta.get("session:operation"))
    throw new Error("Inspect the interrupted operation first.");
  const bindings = await sessionStatus();
  const tabs = (await live()).tabs.filter(
    (t) => t.spaceId === spaceId && sessionTab(t),
  );
  if (!tabs.length && !bindings.some((b) => b.spaceId === spaceId)) return;
  await reconcile("Before closing Space session");
  const snapshot = await capture(spaceId);
  await repo.snapshot({
    ...snapshot,
    id: crypto.randomUUID(),
    reason: "Before closing Space session",
    protected: true,
  });
  for (const windowId of new Set(tabs.map((t) => t.windowId)))
    await anchor(windowId);
  if (tabs.length)
    await retryDrag(() => chrome.tabs.remove(tabs.map((t) => t.id)));
  for (const binding of bindings.filter(
    (b) => b.spaceId === spaceId && b.parked,
  )) {
    const remaining = await chrome.tabs.query({ windowId: binding.windowId });
    if (remaining.length === 1 && remaining[0].url === parkingUrl(spaceId))
      await chrome.tabs.remove(remaining[0].id!);
  }
  await persist(bindings.filter((b) => b.spaceId !== spaceId));
  await reconcile("Space session closed (content kept)");
}

// Runs on the same worker queue as browser actions, never between steps of a switch.
export async function syncSessions(attachedWindowId?: number) {
  const bindings = await sessionStatus();
  const all = await repo.list();
  const valid = new Set(
    all
      .filter((e) => e.kind === "space" && !e.deletedAt && !e.archivedAt)
      .map((e) => e.id),
  );
  const safe = bindings.filter((b) => valid.has(b.spaceId));
  // A failed/interrupted transition is inspectable and must not auto-claim or replay effects.
  if (await repo.db.meta.get("session:operation")) return;
  let state = await live();
  const globalPins = state.tabs.filter(
    (t) => t.pinned && safe.some((b) => b.spaceId === t.spaceId),
  );
  if (globalPins.length) {
    await repo.db.meta.bulkDelete(
      globalPins.map((t) => `owner:${state.generation}:tab:${t.id}`),
    );
    for (const tab of globalPins) tab.spaceId = undefined;
    await saveBindings(state);
  }
  for (const binding of safe) {
    const tabs = state.tabs.filter(
      (t) => t.windowId === binding.windowId && sessionTab(t),
    );
    const missing = tabs.filter(
      (t) =>
        t.spaceId !== binding.spaceId ||
        (t.groupId >= 0 &&
          !state.groups.some(
            (g) =>
              g.id === t.groupId &&
              g.spaceId === binding.spaceId &&
              g.logicalId,
          )),
    );
    if (missing.length)
      await claim(
        missing.map((t) => t.id),
        binding.spaceId,
      );
  }
  // A detached owned tab creates an independent temporary session in its new window.
  state = await live();
  for (const windowId of new Set(
    state.tabs.filter((t) => t.spaceId && sessionTab(t)).map((t) => t.windowId),
  )) {
    if (windowId !== attachedWindowId) continue;
    if (safe.some((b) => b.windowId === windowId)) continue;
    const tabs = state.tabs.filter(
      (t) => t.windowId === windowId && sessionTab(t),
    );
    if (!tabs.some((t) => t.spaceId && valid.has(t.spaceId))) continue;
    const spaceId = await ensureTemporarySession(
      windowId,
      tabs.map((t) => t.id),
    );
    await claim(
      tabs.map((t) => t.id),
      spaceId,
    );
    safe.push({ windowId, spaceId, parked: false });
  }
  for (const spaceId of new Set(
    safe.filter((b) => !closingWindows.has(b.windowId)).map((b) => b.spaceId),
  ))
    await capture(
      spaceId,
      !safe.some((b) => b.spaceId === spaceId && !b.parked),
      state,
    );
  await persist(safe);
}

export async function acknowledgeSessionFailure() {
  // Explicitly called from Recovery after inspection; never replays an operation.
  await repo.db.meta.delete("session:operation");
}

export async function registerRecoveredSession(result: unknown) {
  const recovered = result as
    { spaceId?: string; tabIds?: number[] } | undefined;
  if (!recovered?.spaceId || !recovered.tabIds?.length) return;
  const tabs = (await live()).tabs.filter((t) =>
    recovered.tabIds!.includes(t.id),
  );
  const bindings = await sessionStatus();
  for (const windowId of new Set(tabs.map((t) => t.windowId)))
    if (!bindings.some((b) => b.windowId === windowId))
      bindings.push({ windowId, spaceId: recovered.spaceId, parked: false });
  await persist(bindings);
  await capture(recovered.spaceId);
}

export async function moveTabsToSpace(ids: number[], spaceId: string) {
  await available(spaceId);
  if (await repo.db.meta.get("session:operation"))
    throw new Error("Inspect the interrupted operation first.");
  const state = await live();
  const selected = new Set(ids);
  const tabs = state.tabs.filter((t) => selected.has(t.id));
  if (
    !tabs.length ||
    tabs.length !== selected.size ||
    tabs.some((t) => !sessionTab(t))
  )
    throw new Error("Select ordinary unpinned website tabs.");
  await repo.snapshot(
    blueprint(state, "Before moving tabs to another Space", true),
  );
  await repo.db.meta.put({
    id: "session:operation",
    value: { spaceId, startedAt: new Date().toISOString(), intent: "move" },
  });
  const bindings = await sessionStatus();
  let destination =
    bindings.find((b) => b.spaceId === spaceId && !b.parked) ??
    bindings.find((b) => b.spaceId === spaceId);
  if (!destination) {
    const saved = await savedData(spaceId);
    const incoming = blueprint(
      {
        ...state,
        tabs,
        groups: state.groups.filter((g) =>
          tabs.some((t) => t.groupId === g.id),
        ),
      },
      "Moved live tabs",
    );
    incoming.tabs = await relocateLocks(incoming.tabs, spaceId, false);
    const next = appendSnapshot(
      saved.snapshot,
      incoming,
      incoming.tabs,
      spaceId,
    );
    for (const windowId of new Set(tabs.map((t) => t.windowId)))
      await anchor(windowId);
    await repo.snapshot({
      ...saved.snapshot,
      id: crypto.randomUUID(),
      protected: true,
      reason: "Before receiving moved tabs",
    });
    await repo.db.meta.put({
      id: checkpointKey(spaceId),
      value: { snapshot: next, activeIndex: 0 },
    });
    await retryDrag(() => chrome.tabs.remove(ids));
    for (const owner of new Set(
      tabs.flatMap((t) => (t.spaceId ? [t.spaceId] : [])),
    ))
      await capture(owner);
    await reconcile("Moved tabs to closed Space");
    await repo.db.meta.delete("session:operation");
    return;
  }
  for (const windowId of new Set(tabs.map((t) => t.windowId)))
    if (windowId !== destination.windowId) await anchor(windowId);
  const partial = tabs.filter(
    (t) =>
      t.groupId >= 0 &&
      state.tabs.some(
        (other) => other.groupId === t.groupId && !selected.has(other.id),
      ),
  );
  if (partial.length)
    await retryDrag(() =>
      chrome.tabs.ungroup(partial.map((t) => t.id) as [number, ...number[]]),
    );
  const current = (await live()).tabs.filter((t) => selected.has(t.id));
  for (const windowId of new Set(current.map((t) => t.windowId)))
    if (windowId !== destination.windowId)
      await transfer(
        current.filter((t) => t.windowId === windowId),
        destination.windowId,
      );
  await claim(ids, spaceId);
  if (destination.parked)
    await chrome.windows.update(destination.windowId, { state: "minimized" });
  for (const owner of new Set([
    ...tabs.flatMap((t) => (t.spaceId ? [t.spaceId] : [])),
    spaceId,
  ]))
    await capture(owner);
  await reconcile("Moved tabs to Space");
  await repo.db.meta.delete("session:operation");
}

// Recover only our positively identified parking windows after a full browser restart.
// Ordinary windows never acquire ownership by numeric ID or matching URL/title.
export async function recoverParkingWindows() {
  const bindings = await sessionStatus();
  const windows = await chrome.windows.getAll({
    windowTypes: ["normal"],
    populate: true,
  });
  for (const window of windows) {
    if (
      window.incognito ||
      window.id === undefined ||
      bindings.some((b) => b.windowId === window.id)
    )
      continue;
    const marker = window.tabs?.find((t) =>
      t.url?.startsWith(chrome.runtime.getURL("parking.html?space=")),
    );
    if (!marker?.url) continue;
    const spaceId = new URL(marker.url).searchParams.get("space");
    if (!spaceId) continue;
    try {
      await available(spaceId);
    } catch {
      continue;
    }
    const tabs = (await live()).tabs.filter(
      (t) => t.windowId === window.id && sessionTab(t),
    );
    await claim(
      tabs.map((t) => t.id),
      spaceId,
    );
    bindings.push({ windowId: window.id, spaceId, parked: true });
  }
  await persist(bindings);
}
