import type { Entity } from "./model";

export function hasPersonalContent(space: Entity, entities: Entity[]) {
  return !!(
    space.attachmentIds.length ||
    space.fields.length ||
    space.description.trim() ||
    entities.some(
      (item) =>
        item.spaceId === space.id &&
        (["note", "task", "resource"].includes(item.kind) ||
          item.attachmentIds.length ||
          item.fields.length),
    )
  );
}

export function expiredUnsaved(
  entities: Entity[],
  activeIds: Set<string>,
  protectedIds: Set<string>,
  limit: number,
  days: number,
  now = Date.now(),
) {
  const closed = entities
    .filter(
      (item) =>
        item.kind === "space" &&
        item.temporary &&
        !item.deletedAt &&
        !item.archivedAt &&
        item.browsingClosedAt &&
        !activeIds.has(item.id) &&
        !protectedIds.has(item.id) &&
        !hasPersonalContent(item, entities),
    )
    .sort((a, b) => b.browsingClosedAt!.localeCompare(a.browsingClosedAt!));
  return closed
    .filter(
      (item, index) =>
        index >= limit ||
        Date.parse(item.browsingClosedAt!) < now - days * 86400000,
    )
    .map((item) => item.id);
}
