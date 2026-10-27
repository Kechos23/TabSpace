import { digest } from "./crypto";
import { canonical, type Bundle } from "./model";

// A completed cloud write can outlive a terminated local transaction. Derive
// copy identities from the logical local branch, not the attempt/remote revision.
export async function conflictCopy(
  vaultId: string,
  originalId: string,
  source: Bundle,
): Promise<Bundle> {
  const branch = await digest(
    new TextEncoder().encode(canonical({ vaultId, originalId, source })),
  );
  const ids = new Map<string, string>();
  for (const item of source.entities) {
    const hash = await digest(new TextEncoder().encode(`${branch}/${item.id}`));
    const chars = hash.slice(0, 32).split("");
    chars[12] = "4";
    chars[16] = ((parseInt(chars[16], 16) & 3) | 8).toString(16);
    const hex = chars.join("");
    ids.set(
      item.id,
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    );
  }
  const ref = (id: string | undefined) =>
    id ? (ids.get(id) ?? id) : undefined;
  const entities = source.entities.map((item) => ({
    ...item,
    id: ids.get(item.id)!,
    // Preserve source creation metadata so retrying produces the same copy.
    revision: 1,
    updatedAt: item.createdAt,
    spaceId: ref(item.spaceId),
    sectionId: ref(item.sectionId),
    groupId: ref(item.groupId),
    sidebarId: ref(item.sidebarId),
    fields: item.fields.map((field) => ({
      ...field,
      definitionId: ref(field.definitionId)!,
    })),
  }));
  const space = entities.find((e) => e.kind === "space")!;
  space.name = `${space.name.slice(0, 470)} (Conflict copy)`;
  entities.sort((a, b) => a.id.localeCompare(b.id));
  return {
    entities,
    ...(source.session
      ? {
          session: {
            tabs: source.session.tabs.map((tab) => ({
              ...tab,
              spaceId: space.id,
              lockId: ref(tab.lockId),
              recordId: ref(tab.recordId),
              groupKey: ref(tab.groupKey),
            })),
            groups: source.session.groups.map((group) => ({
              ...group,
              key: ref(group.key)!,
            })),
          },
        }
      : {}),
  };
}
