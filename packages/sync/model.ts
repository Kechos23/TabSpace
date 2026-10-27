import { z } from "zod";
import {
  entity,
  entitySchema,
  snapshotSchema,
  type Entity,
} from "../domain/model";

export const INBOX = "00000000-0000-4000-8000-000000000001";
export const inboxEntity = () =>
  entity("space", "Inbox", {
    id: INBOX,
    order: 0,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    color: "grey",
    view: "tabs",
    splitRatio: 50,
  });
export const emptyEntries = (): Entries => ({
  inbox: { entities: [inboxEntity()] },
  library: { entities: [] },
});
export const fileSchema = z
  .object({
    id: z.string().uuid(),
    filename: z.string().min(1).max(500),
    mediaType: z.string().max(500),
    size: z
      .number()
      .int()
      .min(0)
      .max(64 * 1024 * 1024),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
  })
  .strict();
export type SyncFile = z.infer<typeof fileSchema>;
export const bundleSchema = z
  .object({
    entities: z.array(entitySchema).max(100000),
    session: snapshotSchema.pick({ tabs: true, groups: true }).optional(),
  })
  .strict();
export type Bundle = z.infer<typeof bundleSchema>;
export const documentSchema = z
  .object({
    schemaVersion: z.literal(1),
    vaultId: z.string().uuid(),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    entries: z.record(z.string().max(80), bundleSchema.nullable()),
    files: z.record(z.string().uuid(), fileSchema),
  })
  .strict();
export type SyncDocument = z.infer<typeof documentSchema>;
export type Entries = SyncDocument["entries"];
export type Conflict = {
  key: string;
  name: string;
  local: Bundle | null;
  remote: Bundle | null;
};

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export function portableSession(
  snapshot: NonNullable<Bundle["session"]>,
): NonNullable<Bundle["session"]> {
  const keys = [
    ...new Set(
      snapshot.tabs
        .filter((t) => !t.pinned && t.groupKey)
        .map((t) => t.groupKey!),
    ),
  ];
  const groups = new Map(snapshot.groups.map((g) => [g.key, g]));
  const mapped = new Map(
    keys.map((key, index) => [key, `sync-group-${index + 1}`]),
  );
  return {
    tabs: snapshot.tabs
      .filter((t) => !t.pinned)
      .map((t) => ({
        ...t,
        windowKey: undefined,
        groupKey: t.groupKey ? mapped.get(t.groupKey) : undefined,
      })),
    groups: keys.map((key) => {
      const info = groups.get(key);
      if (!info)
        throw new Error(
          "A saved tab group is missing its definition. Refresh its Space before syncing.",
        );
      return { ...info, key: mapped.get(key)!, windowKey: undefined };
    }),
  };
}
function combineBundle(
  base: Bundle | null,
  local: Bundle | null,
  remote: Bundle | null,
): Bundle | undefined {
  if (!base || !local || !remote) return;
  const localSpace = local.entities.find((e) => e.kind === "space");
  const remoteSpace = remote.entities.find((e) => e.kind === "space");
  if (localSpace?.deletedAt !== remoteSpace?.deletedAt) return;
  const maps = [base, local, remote].map(
    (b) => new Map(b.entities.map((e) => [e.id, e])),
  );
  const entities: Entity[] = [];
  for (const id of new Set(maps.flatMap((m) => [...m.keys()]))) {
    const [b, l, r] = maps.map((m) => m.get(id) ?? null);
    const next = equal(l, r) || equal(b, r) ? l : equal(b, l) ? r : undefined;
    if (next === undefined) return;
    if (next) entities.push(next);
  }
  const [b, l, r] = [base.session, local.session, remote.session];
  const session = equal(l, r) || equal(b, r) ? l : equal(b, l) ? r : undefined;
  if (session === undefined && (l || r)) return;
  return {
    entities: entities.sort((a, b) => a.id.localeCompare(b.id)),
    ...(session ? { session } : {}),
  };
}

// UI preferences and local revision counters must not become cross-device edits.
export function portable(e: Entity): Entity {
  return {
    ...e,
    revision: 1,
    updatedAt: e.createdAt,
    browsingClosedAt: undefined,
    view: "tabs",
    rightView: "tasks",
    split: false,
    splitRatio: 50,
    collapsed: e.kind === "group" ? e.collapsed : false,
  };
}

export function mergeEntries(base: Entries, local: Entries, remote: Entries) {
  const entries: Entries = {},
    conflicts: Conflict[] = [];
  for (const key of new Set([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote),
  ])) {
    const b = base[key] ?? null;
    // A locally absent previously-known Space is a durable deletion tombstone.
    const l = local[key] ?? null,
      r = remote[key] ?? null;
    if (equal(l, r) || equal(b, r)) entries[key] = l;
    else if (equal(b, l)) entries[key] = r;
    else {
      const combined = combineBundle(b, l, r);
      if (combined) {
        entries[key] = combined;
        continue;
      }
      entries[key] = l;
      conflicts.push({
        key,
        name:
          l?.entities.find((e) => e.kind === "space")?.name ??
          r?.entities.find((e) => e.kind === "space")?.name ??
          "Collections and properties",
        local: l,
        remote: r,
      });
    }
  }
  return { entries, conflicts };
}

export function validateUnits(entries: Entries) {
  for (const [key, bundle] of Object.entries(entries)) {
    if (
      key !== "library" &&
      key !== "inbox" &&
      !z.string().uuid().safeParse(key).success
    )
      throw new Error("Unsupported sync identity.");
    if (!bundle) {
      if (key === "library" || key === "inbox")
        throw new Error("Shared content cannot be removed.");
      continue;
    }
    if (key === "library") {
      if (
        bundle.session ||
        bundle.entities.some((e) => !["sidebar", "property"].includes(e.kind))
      )
        throw new Error("Invalid shared library.");
    } else {
      const id = key === "inbox" ? INBOX : key;
      if (
        bundle.entities.filter(
          (e) => e.kind === "space" && e.id === id && !e.temporary,
        ).length !== 1 ||
        bundle.entities.some((e) =>
          e.kind === "space" ? e.id !== id : e.spaceId !== id,
        )
      )
        throw new Error("Invalid synchronized Space.");
      if (key === "inbox" && bundle.session)
        throw new Error("Inbox cannot own browser tabs.");
      for (const tab of bundle.session?.tabs ?? []) {
        if (
          tab.pinned ||
          tab.spaceId !== id ||
          tab.windowKey ||
          [tab.lockId, tab.recordId].some(
            (ref) =>
              ref &&
              !bundle.entities.some(
                (e) => e.id === ref && e.kind === "savedTab",
              ),
          )
        )
          throw new Error("Invalid synchronized tab reference.");
      }
      if (bundle.session?.groups.some((g) => g.windowKey))
        throw new Error(
          "Synchronized groups cannot contain local window bindings.",
        );
    }
  }
}
