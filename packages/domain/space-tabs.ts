import { type BrowserState, type Entity } from "./model";
import { savedSessionData } from "./saved-session";
export type SpaceTreeTab = {
  faviconKey?: string;
  savedKey?: string;
  id?: number;
  title: string;
  url: string;
  live: boolean;
  group?: string;
  groupKey?: string;
  groupColor?: string;
  lockId?: string;
};
export function spaceTabTree(
  entities: Entity[],
  browser: BrowserState,
  checkpoints: { id: string; value: unknown }[],
): Record<string, SpaceTreeTab[]> {
  const result: Record<string, SpaceTreeTab[]> = {};
  const groupById = new Map(browser.groups.map((g) => [g.id, g]));
  const checkpointById = new Map(checkpoints.map((c) => [c.id, c.value]));
  const liveBySpace = new Map<string, BrowserState["tabs"]>();
  for (const tab of browser.tabs) {
    if (
      !tab.spaceId ||
      tab.pinned ||
      !(/^https?:\/\//.test(tab.url) || /^chrome:\/\/newtab\/?$/.test(tab.url))
    )
      continue;
    const tabs = liveBySpace.get(tab.spaceId) ?? [];
    tabs.push(tab);
    liveBySpace.set(tab.spaceId, tabs);
  }
  const entitiesBySpace = new Map<string, Entity[]>();
  for (const row of entities) {
    if (!row.spaceId) continue;
    const bucket = entitiesBySpace.get(row.spaceId) ?? [];
    bucket.push(row);
    entitiesBySpace.set(row.spaceId, bucket);
  }
  for (const space of entities.filter(
    (e) => e.kind === "space" && !e.deletedAt && !e.archivedAt,
  )) {
    const live = (liveBySpace.get(space.id) ?? []).sort(
      (a, b) => a.windowId - b.windowId || a.index - b.index,
    );
    if (live.length) {
      result[space.id] = live.map((t) => ({
        faviconKey: t.faviconKey,
        id: t.id,
        title: t.title,
        url: t.url,
        live: true,
        lockId: t.lockId,
        group: groupById.get(t.groupId)?.title,
        groupKey:
          t.groupId >= 0
            ? (groupById.get(t.groupId)?.logicalId ?? String(t.groupId))
            : undefined,
        groupColor: groupById.get(t.groupId)?.color,
      }));
      const closed = savedSessionData(
        space.id,
        entitiesBySpace.get(space.id) ?? [],
        checkpointById.get(`session:checkpoint:${space.id}`),
      );
      const savedById = new Map(
        (entitiesBySpace.get(space.id) ?? []).map((e) => [e.id, e]),
      );
      const closedGroups = new Map(
        closed.snapshot.groups.map((g) => [g.key, g]),
      );
      for (const entry of closed.entries.filter(
        (entry) =>
          entry.tab.lockId &&
          !live.some((tab) => tab.lockId === entry.tab.lockId),
      )) {
        const logicalKey = savedById.get(entry.tab.lockId!)?.groupId;
        const liveGroup = logicalKey
          ? browser.groups.find(
              (g) => g.spaceId === space.id && g.logicalId === logicalKey,
            )
          : undefined;
        const savedGroup = closedGroups.get(entry.tab.groupKey ?? "");
        result[space.id].push({
          savedKey: entry.key,
          title: entry.tab.title,
          url: entry.tab.url,
          live: false,
          lockId: entry.tab.lockId,
          groupKey: liveGroup ? logicalKey : entry.tab.groupKey,
          group: liveGroup?.title ?? savedGroup?.title,
          groupColor: liveGroup?.color ?? savedGroup?.color,
        });
      }
      continue;
    }
    const { snapshot, entries } = savedSessionData(
      space.id,
      entitiesBySpace.get(space.id) ?? [],
      checkpointById.get(`session:checkpoint:${space.id}`),
    );
    const groups = new Map(snapshot.groups.map((g) => [g.key, g]));
    result[space.id] = entries.map(({ tab, key }) => ({
      savedKey: key,
      title: tab.title,
      url: tab.url,
      live: false,
      group: tab.groupKey ? groups.get(tab.groupKey)?.title : undefined,
      groupColor: tab.groupKey ? groups.get(tab.groupKey)?.color : undefined,
      groupKey: tab.groupKey,
      lockId: tab.lockId,
    }));
  }
  return result;
}
