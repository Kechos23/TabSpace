import { snapshotSchema, type Entity, type Snapshot } from "./model";

// A reference identifies one occurrence, never merely its URL. Snapshot IDs
// invalidate old selections after a session changes.
export function savedSessionData(
  spaceId: string,
  entities: Entity[],
  raw: unknown,
) {
  const parsed = snapshotSchema.safeParse(
    (raw as { snapshot?: unknown } | undefined)?.snapshot,
  );
  const saved = entities
    .filter(
      (e) =>
        e.kind === "savedTab" &&
        e.spaceId === spaceId &&
        !e.deletedAt &&
        !e.pinned &&
        e.url,
    )
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  let snapshot: Snapshot = parsed.success
    ? parsed.data
    : {
        id: crypto.randomUUID(),
        capturedAt: new Date().toISOString(),
        reason: "Saved session",
        protected: false,
        tabs: saved.map((e) => ({
          url: e.url!,
          title: e.name,
          spaceId,
          pinned: false,
          muted: !!e.muted,
          lockId: e.locked ? e.id : undefined,
          recordId: e.id,
          groupKey: e.groupId,
        })),
        groups: entities
          .filter(
            (e) => e.kind === "group" && e.spaceId === spaceId && !e.deletedAt,
          )
          .map((e) => ({
            key: e.id,
            title: e.name,
            color: e.color,
            collapsed: e.collapsed,
          })),
      };
  const locks = saved.filter((item) => item.locked);
  const valid = new Set(locks.map((item) => item.id));
  // Lock IDs identify occurrences, so two identical URLs remain distinct tabs.
  const tabs = snapshot.tabs.map((tab) => ({
    ...tab,
    lockId: tab.lockId && valid.has(tab.lockId) ? tab.lockId : undefined,
  }));
  for (const item of locks) {
    if (tabs.some((tab) => tab.lockId === item.id)) continue;
    tabs.push({
      url: item.url!,
      title: item.name,
      pinned: false,
      muted: item.muted,
      spaceId,
      groupKey: item.groupId,
      lockId: item.id,
      recordId: item.id,
    });
  }
  const groups = [...snapshot.groups];
  for (const group of entities.filter(
    (item) =>
      item.kind === "group" && item.spaceId === spaceId && !item.deletedAt,
  ))
    if (
      !groups.some((item) => item.key === group.id) &&
      tabs.some((tab) => tab.groupKey === group.id)
    )
      groups.push({
        key: group.id,
        title: group.name,
        color: group.color,
        collapsed: group.collapsed,
      });
  snapshot = { ...snapshot, tabs, groups };
  return {
    snapshot,
    entries: snapshot.tabs.flatMap((tab, index) =>
      tab.pinned
        ? []
        : [
            {
              tab,
              index,
              key: tab.lockId
                ? `lock:${tab.lockId}`
                : parsed.success
                  ? `${snapshot.id}:${index}`
                  : `entity:${saved[index].id}:${saved[index].revision}`,
            },
          ],
    ),
  };
}
