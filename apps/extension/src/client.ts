import {
  entity,
  type BrowserState,
  type Command,
  type Draft,
  type Entity,
  type Settings,
  type Snapshot,
} from "../../../packages/domain/model";
import { repository } from "../../../packages/persistence/repository";
import type { SpaceTreeTab } from "../../../packages/domain/space-tabs";
import {
  recoveryPage,
  type RecoveryPage,
} from "../../../packages/persistence/recovery";
export type State = {
  viewVersion?: string;
  collectionGeneration?: string;
  recoveryLoaded?: boolean;
  snapshotCount?: number;
  draftCount?: number;
  entities: Entity[];
  settings: Settings;
  browser: BrowserState;
  snapshots: Snapshot[];
  drafts: Draft[];
  helperStatus: string;
  inboxId: string;
  quarantineCount: number;
  sessions: { windowId: number; spaceId: string; parked: boolean }[];
  sessionInterrupted: boolean;
  currentWindowId?: number;
  windows: { id: number; title: string; tabs: number }[];
  spaceTabs: Record<string, SpaceTreeTab[]>;
  browsingUnresolved?: string[];
};
export const isExtension =
  typeof chrome !== "undefined" && !!chrome.runtime?.id;
export async function request<T>(message: unknown): Promise<T> {
  if (isExtension) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok)
      throw new Error(
        response?.error ??
          "Worker did not acknowledge this operation. Retry the same command.",
      );
    return response.value as T;
  }
  throw new Error(
    "This action needs Chrome. Use the built unpacked extension.",
  );
}
export async function load(): Promise<State> {
  if (isExtension)
    return normalizeState(await request<State>({ type: "load" }));
  await repository.initialize();
  return {
    entities: await repository.list(),
    settings: await repository.settings(),
    browser: {
      id: "browser",
      generation: "preview",
      tabs: [],
      groups: [],
      updatedAt: new Date().toISOString(),
    },
    snapshots: await repository.db.snapshots
      .orderBy("capturedAt")
      .reverse()
      .toArray(),
    drafts: await repository.db.drafts.toArray(),
    helperStatus: "Preview — native host requires extension installation",
    inboxId: await repository.inbox(),
    quarantineCount: await repository.db.meta
      .where("id")
      .startsWith("quarantine:")
      .count(),
    sessions: [],
    sessionInterrupted: false,
    windows: [],
    spaceTabs: {},
  };
}
export async function loadView(
  previous?: State,
  recovery = false,
  force = false,
): Promise<State> {
  if (!isExtension) return load();
  const result = await request<State | { unchanged: true }>({
    type: "view",
    recovery,
    force,
    knownVersion:
      previous?.recoveryLoaded === recovery ? previous.viewVersion : undefined,
  });
  if ("unchanged" in result && previous) return previous;
  return normalizeState(result as State);
}
export async function loadRecovery(
  offset = 0,
  draftOffset = 0,
): Promise<RecoveryPage> {
  return isExtension
    ? request({ type: "recoveryList", offset, draftOffset })
    : recoveryPage(repository.db, offset, draftOffset);
}
export async function recoverySnapshot(id: string): Promise<Snapshot> {
  const value = isExtension
    ? await request<Snapshot | undefined>({ type: "recoverySnapshot", id })
    : await repository.db.snapshots.get(id);
  if (!value)
    throw new Error(
      "This checkpoint is no longer available. Refresh Recovery.",
    );
  return value;
}
export async function recoveryDraft(id: string): Promise<Draft> {
  const value = isExtension
    ? await request<Draft | undefined>({ type: "recoveryDraft", id })
    : await repository.db.drafts.get(id);
  if (!value)
    throw new Error("This draft is no longer available. Refresh Recovery.");
  return value;
}
export async function protectCheckpoint(id: string, protectedValue: boolean) {
  if (isExtension)
    return request({ type: "recoveryProtect", id, protected: protectedValue });
  if (
    !(await repository.db.snapshots.update(id, { protected: protectedValue }))
  )
    throw new Error("Checkpoint no longer exists.");
}
// Extension views can briefly receive an older worker response during reload.
// Keep existing collection data intact while defaulting additive view metadata.
export function normalizeState(value: State): State {
  return {
    ...value,
    snapshots: value.snapshots ?? [],
    drafts: value.drafts ?? [],
    snapshotCount: value.snapshotCount ?? value.snapshots?.length ?? 0,
    draftCount: value.draftCount ?? value.drafts?.length ?? 0,
    settings: {
      ...value.settings,
      colorTheme: value.settings?.colorTheme ?? "green",
      preserveLiveTabs: value.settings?.preserveLiveTabs ?? true,
    },
    sessions: Array.isArray(value.sessions) ? value.sessions : [],
    windows: Array.isArray(value.windows) ? value.windows : [],
    sessionInterrupted: value.sessionInterrupted ?? false,
    spaceTabs: value.spaceTabs ?? {},
  };
}
export type PopupState = {
  collections?: Pick<Entity, "id" | "name">[];
  activeTabId?: number;
  canLock?: boolean;
  tabLocked?: boolean;
  spaces: Entity[];
  settings: Settings;
  inboxId: string;
  windowId?: number;
  activeSpaceId?: string;
};
export async function loadPopup(): Promise<PopupState> {
  return request({ type: "popup" });
}
export async function command(
  c: Omit<Command, "schemaVersion" | "commandId">,
  commandId: string = crypto.randomUUID(),
): Promise<Entity[]> {
  const full = { ...c, commandId, schemaVersion: 1 as const };
  const wire = {
    ...full,
    patch: c.patch
      ? Object.fromEntries(
          Object.entries(c.patch).map(([k, v]) => [
            k,
            v === undefined ? null : v,
          ]),
        )
      : undefined,
  };
  return isExtension
    ? request({ type: "command", command: wire })
    : repository.execute(full);
}
export async function create(
  kind: Entity["kind"],
  name: string,
  props: Partial<Entity> = {},
) {
  return (
    await command({ type: "create", entity: entity(kind, name, props) })
  )[0];
}
export async function update(e: Entity, patch: Partial<Entity>) {
  return (
    await command({
      type: "update",
      id: e.id,
      expectedRevision: e.revision,
      patch,
    })
  )[0];
}
export async function settings(patch: Partial<Settings>) {
  if (isExtension) await request({ type: "settingsPatch", patch });
  else await repository.patchSettings(patch);
}
export async function importCollection(file: Blob, mode: "merge" | "replace") {
  if (!isExtension) {
    const { parseBackup, importBackup } =
      await import("../../../packages/persistence/backup");
    return importBackup(repository, await parseBackup(file), mode);
  }
  // Blobs cannot travel through Chrome's JSON message boundary. Stage the source
  // file in IndexedDB; only the worker validates and commits it on its queue.
  const token = crypto.randomUUID();
  const id = `pending-import:${token}`;
  await repository.db.meta.put({
    id,
    value: { file, createdAt: new Date().toISOString() },
  });
  try {
    return await request({ type: "importCollection", token, mode });
  } finally {
    await repository.db.meta.delete(id);
  }
}
export async function draft(value: Draft) {
  if (isExtension) await request({ type: "draft", draft: value });
  else await repository.saveDraft(value);
}
export async function browser(
  action: string,
  payload: Record<string, unknown> = {},
) {
  return request({
    type: "browser",
    action,
    payload,
    commandId: crypto.randomUUID(),
  });
}
