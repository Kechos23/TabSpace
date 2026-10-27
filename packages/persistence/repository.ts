import Dexie, { type Table } from "dexie";
import { cleanRetiredData } from "./legacy-cleanup";
import { hasPersonalContent } from "../domain/browsing";
import { savedSessionData } from "../domain/saved-session";
import {
  assertGraph,
  blankDoc,
  browserLabel,
  commandSchema,
  defaults,
  documentSchema,
  documentText,
  entity,
  entitySchema,
  remapEntities,
  settingsSchema,
  type Attachment,
  type BrowserState,
  type Command,
  type Draft,
  type Entity,
  type Journal,
  type NoteRevision,
  type Settings,
  type Snapshot,
} from "../domain/model";

export class TabSpaceDB extends Dexie {
  entities!: Table<Entity, string>;
  attachments!: Table<Attachment, string>;
  drafts!: Table<Draft, string>;
  revisions!: Table<NoteRevision, string>;
  journal!: Table<Journal, string>;
  snapshots!: Table<Snapshot, string>;
  meta!: Table<{ id: string; value: unknown }, string>;
  browser!: Table<BrowserState, string>;
  constructor(name = "TabSpace-v1") {
    super(name);
    this.version(1).stores({
      entities: "id,kind,spaceId,sectionId,order,updatedAt",
      attachments: "id,hash",
      drafts: "id,noteId",
      revisions: "id,noteId,createdAt",
      journal: "id,state,createdAt",
      snapshots: "id,capturedAt",
      meta: "id",
      browser: "id",
    });
    this.version(2).stores({
      revisions: "id,noteId,createdAt,[noteId+createdAt]",
      journal: "id,state,createdAt,[state+createdAt]",
    });
  }
}
export const db = new TabSpaceDB();
export class ConflictError extends Error {
  constructor(public current: Entity) {
    super(
      "This item changed in another TabSpace view. Your draft is preserved. Reload or save a separate copy.",
    );
  }
}
export class Repository {
  constructor(public db: TabSpaceDB) {}
  async initialize() {
    const cleanupKey = "migration:retired-content:v1";
    if (!(await this.db.meta.get(cleanupKey)))
      await this.db.transaction("rw", this.db.tables, async () => {
        if (await this.db.meta.get(cleanupKey)) return;
        const captured: Record<string, any[]> = {};
        for (const table of this.db.tables)
          captured[table.name] = await table.toArray();
        const cleaned = cleanRetiredData(captured).value;
        for (const table of this.db.tables) {
          const retained = cleaned[table.name];
          const ids = new Set(retained.map((row) => row.id));
          await table.bulkDelete(
            captured[table.name]
              .filter((row) => !ids.has(row.id))
              .map((row) => row.id),
          );
          if (retained.length) await table.bulkPut(retained);
        }
        await this.db.meta.put({ id: cleanupKey, value: true });
      });
    await this.db.transaction(
      "rw",
      this.db.entities,
      this.db.meta,
      async () => {
        // Repair only the known 0.1.0 browser-title defect, keeping exact raw
        // records/quarantine evidence. Other invalid records stay protected.
        const repairKey = "repair:browser-labels:v1";
        if (!(await this.db.meta.get(repairKey))) {
          for (const record of await this.db.entities
            .where("kind")
            .anyOf("savedTab", "group")
            .toArray()) {
            if (typeof record.name !== "string" || record.name.length <= 500)
              continue;
            const fixed = entitySchema.safeParse({
              ...record,
              name: browserLabel(record.name, "Untitled"),
              revision: record.revision + 1,
              updatedAt: new Date().toISOString(),
            });
            if (!fixed.success) continue;
            await this.db.meta.put({
              id: `repair:browser-label:${record.id}`,
              value: {
                record,
                quarantine: await this.db.meta.get(`quarantine:${record.id}`),
                repairedAt: new Date().toISOString(),
              },
            });
            await this.db.entities.put(fixed.data);
            await this.db.meta.delete(`quarantine:${record.id}`);
          }
          await this.db.meta.put({ id: repairKey, value: true });
        }
        if (await this.db.meta.get("initialized")) return;
        const inbox = entity("space", "Inbox", {
          view: "resources",
          icon: "◇",
          color: "grey",
          description:
            "Links, notes and tasks to organize. Inbox does not manage browser tabs.",
        });
        await this.db.entities.add(inbox);
        await this.db.meta.put({ id: "settings", value: defaults });
        await this.db.meta.put({ id: "inbox", value: inbox.id });
        await this.db.meta.put({ id: "initialized", value: true });
      },
    );
  }
  async list() {
    const valid: Entity[] = [];
    for (const record of await this.db.entities.toArray()) {
      const checked = entitySchema.safeParse(record);
      if (checked.success) valid.push(checked.data);
      else
        await this.db.meta.put({
          id: `quarantine:${record.id}`,
          value: {
            record,
            reason: "Invalid schema record; preserved without modification",
          },
        });
    }
    return valid;
  }
  async settings() {
    const raw = await this.db.meta.get("settings");
    return settingsSchema.parse(raw?.value ?? defaults);
  }
  async setSettings(value: Settings) {
    await this.db.meta.put({
      id: "settings",
      value: settingsSchema.parse(value),
    });
  }
  async patchSettings(patch: Partial<Settings>): Promise<Settings> {
    if (Object.hasOwn(patch, "schemaVersion"))
      throw new Error("Settings schema version cannot be changed.");
    return this.db.transaction("rw", this.db.meta, async () => {
      const next = settingsSchema.parse({
        ...(await this.settings()),
        ...patch,
      });
      await this.setSettings(next);
      return next;
    });
  }
  async inbox() {
    return (await this.db.meta.get("inbox"))?.value as string;
  }
  async resetCollection() {
    await this.db.transaction("rw", this.db.tables, async () => {
      for (const table of this.db.tables) await table.clear();
    });
    await this.initialize();
  }
  async removeEmptyUnsaved(
    ids: string[],
    active: Set<string>,
    protectedIds: Set<string>,
  ) {
    await this.db.transaction("rw", this.db.tables, async () => {
      const all = await this.list();
      for (const id of ids) {
        const space = all.find((item) => item.id === id);
        if (
          !space?.temporary ||
          space.deletedAt ||
          space.archivedAt ||
          !space.browsingClosedAt ||
          active.has(id) ||
          protectedIds.has(id) ||
          hasPersonalContent(space, all)
        )
          continue;
        const children = all.filter(
          (item) => item.id === id || item.spaceId === id,
        );
        const childIds = new Set(children.map((item) => item.id));
        if (
          await this.db.drafts
            .filter((draft) => childIds.has(draft.noteId))
            .count()
        )
          continue;
        await this.db.entities.bulkDelete([...childIds]);
        const metadata = await this.db.meta.toArray();
        await this.db.meta.bulkDelete(
          metadata
            .filter(
              (row) =>
                row.id === `session:checkpoint:${id}` ||
                (row.id.startsWith("session:auto-temp:") && row.value === id),
            )
            .map((row) => row.id),
        );
      }
      await this.db.meta.put({ id: "indexRevision", value: Date.now() });
    });
  }
  async execute(raw: Command): Promise<Entity[]> {
    const c = commandSchema.parse(raw);
    if (c.type === "presentation") {
      const allowed = new Set([
        "view",
        "rightView",
        "split",
        "splitRatio",
        "collapsed",
      ]);
      if (!c.patch || Object.keys(c.patch).some((key) => !allowed.has(key)))
        throw new Error("Only presentation preferences can use this command.");
      return this.db.transaction(
        "rw",
        this.db.entities,
        this.db.meta,
        this.db.journal,
        async () => {
          const prior = await this.db.journal.get(c.commandId);
          if (prior) {
            if (prior.state === "committed" && prior.intent === "presentation")
              return prior.result ?? [];
            throw new Error("Command ID belongs to another operation.");
          }
          if (await this.db.meta.where("id").startsWith("quarantine:").count())
            throw new Error(
              "Editing is paused while invalid local records are preserved.",
            );
          const rawCurrent = c.id
            ? await this.db.entities.get(c.id)
            : undefined;
          if (!rawCurrent) throw new Error("Item no longer exists.");
          const current = entitySchema.parse(rawCurrent);
          if (
            current.deletedAt ||
            !["space", "sidebar", "section"].includes(current.kind)
          )
            throw new Error(
              "Choose an available Space, collection or section.",
            );
          if (current.revision !== c.expectedRevision)
            throw new ConflictError(current);
          const now = new Date().toISOString();
          const next = entitySchema.parse({
            ...current,
            ...c.patch,
            revision: current.revision + 1,
            updatedAt: now,
          });
          await this.db.entities.put(next);
          await this.db.journal.add({
            id: c.commandId,
            state: "committed",
            createdAt: now,
            intent: "presentation",
            result: [next],
          });
          await this.db.meta.put({ id: "indexRevision", value: now });
          return [next];
        },
      );
    }
    return this.db.transaction(
      "rw",
      [
        this.db.entities,
        this.db.journal,
        this.db.attachments,
        this.db.revisions,
        this.db.drafts,
        this.db.meta,
      ],
      async () => {
        const prior = await this.db.journal.get(c.commandId);
        if (prior) {
          if (prior.state === "committed") return prior.result ?? [];
          throw new Error("Command ID belongs to another operation.");
        }
        const all = await this.list();
        if (await this.db.meta.where("id").startsWith("quarantine:").count())
          throw new Error(
            "Local storage contains invalid records. Editing is paused to preserve them. Export quarantine details from Recovery and import a verified backup.",
          );
        let changed: Entity[] = [];
        const now = new Date().toISOString();
        if (c.type === "create") {
          if (!c.entity || all.some((e) => e.id === c.entity!.id))
            throw new Error("Invalid new item.");
          changed = [c.entity];
        } else if (c.type === "emptyTrash") {
          const removed = all.filter((e) => e.deletedAt).map((e) => e.id);
          if (removed.includes(await this.inbox()))
            throw new Error("Inbox is permanent.");
          await this.db.entities.bulkDelete(removed);
          if (removed.length) {
            await this.db.drafts.where("noteId").anyOf(removed).delete();
            await this.db.revisions.where("noteId").anyOf(removed).delete();
          }
          // Keep the same recovery/attachment policy as individual permanent removal.
        } else {
          const current = all.find((e) => e.id === c.id);
          if (!current) throw new Error("Item no longer exists.");
          if (current.deletedAt && !["restore", "purge"].includes(c.type))
            throw new Error(
              "Restore trashed content before editing or copying it.",
            );
          if (c.expectedRevision !== current.revision)
            throw new ConflictError(current);
          const next = {
            ...current,
            revision: current.revision + 1,
            updatedAt: now,
          };
          if (c.type === "update") {
            const patch = Object.fromEntries(
              Object.entries(c.patch ?? {}).map(([k, v]) => [
                k,
                v === null ? undefined : v,
              ]),
            ) as Partial<Entity>;
            changed = [
              entitySchema.parse({
                ...next,
                ...patch,
                id: current.id,
                kind: current.kind,
                revision: next.revision,
                createdAt: current.createdAt,
                updatedAt: now,
              }),
            ];
            if (
              (current.kind === "note" || current.kind === "task") &&
              current.doc &&
              patch.doc
            ) {
              await this.db.revisions.add({
                id: crypto.randomUUID(),
                noteId: current.id,
                revision: current.revision,
                doc: current.doc,
                text: current.text,
                createdAt: now,
              });
            }
          } else if (c.type === "trash") {
            if (current.id === (await this.inbox()))
              throw new Error("Inbox is permanent.");
            if (
              current.kind === "property" &&
              all.some((e) =>
                e.fields.some((f) => f.definitionId === current.id),
              )
            )
              throw new Error("Remove fields before deleting this property.");
            const children = all.filter(
              (e) => e.spaceId === current.id || e.sectionId === current.id,
            );
            if (current.kind === "sidebar") {
              changed = [
                ...all
                  .filter((e) => e.sidebarId === current.id)
                  .map((e) => ({
                    ...e,
                    sidebarId: undefined,
                    revision: e.revision + 1,
                    updatedAt: now,
                  })),
                { ...next, deletedAt: now },
              ];
            } else
              changed = [
                { ...next, deletedAt: now },
                ...children
                  .filter((e) => !e.deletedAt)
                  .map((e) => ({
                    ...e,
                    revision: e.revision + 1,
                    updatedAt: now,
                    deletedAt: now,
                  })),
              ];
          } else if (c.type === "purge") {
            if (!current.deletedAt || current.id === (await this.inbox()))
              throw new Error("Only trashed items can be permanently removed.");
            const removed = new Set([
              current.id,
              ...all
                .filter(
                  (e) => e.spaceId === current.id || e.sectionId === current.id,
                )
                .map((e) => e.id),
            ]);
            if (
              all.some(
                (e) =>
                  !removed.has(e.id) &&
                  e.fields.some((f) => removed.has(f.definitionId)),
              )
            )
              throw new Error("Property is still referenced.");
            await this.db.entities.bulkDelete([...removed]);
            await this.db.drafts
              .where("noteId")
              .anyOf([...removed])
              .delete();
            await this.db.revisions
              .where("noteId")
              .anyOf([...removed])
              .delete();
            // Attachments and protected snapshots are retained; do not guess orphanhood.
          } else if (c.type === "restore") {
            changed = [
              { ...next, deletedAt: undefined },
              ...all
                .filter(
                  (e) =>
                    (e.spaceId === current.id || e.sectionId === current.id) &&
                    e.deletedAt === current.deletedAt,
                )
                .map((e) => ({
                  ...e,
                  deletedAt: undefined,
                  revision: e.revision + 1,
                  updatedAt: now,
                })),
            ];
            if (current.spaceId) {
              const parent = all.find((e) => e.id === current.spaceId);
              if (parent?.deletedAt)
                throw new Error("Restore the parent Space first.");
            }
            if (
              current.sectionId &&
              all.find((e) => e.id === current.sectionId)?.deletedAt
            )
              throw new Error("Restore the parent content section first.");
          } else if (c.type === "move") {
            if (current.kind === "space") {
              changed = [
                {
                  ...next,
                  sidebarId: c.targetSectionId,
                  order: c.patch?.order ?? Date.now(),
                },
              ];
            } else if (current.kind === "section") {
              changed = [
                {
                  ...next,
                  spaceId: c.targetSpaceId,
                  order: c.patch?.order ?? Date.now(),
                },
                ...all
                  .filter((e) => e.sectionId === current.id)
                  .map((e) => ({
                    ...e,
                    spaceId: c.targetSpaceId,
                    revision: e.revision + 1,
                    updatedAt: now,
                  })),
              ];
            } else
              changed = [
                {
                  ...next,
                  spaceId: c.targetSpaceId,
                  sectionId: c.targetSectionId,
                  groupId: undefined,
                  order: c.patch?.order ?? Date.now(),
                },
              ];
          } else if (c.type === "duplicate") {
            let source = [
              current,
              ...all.filter(
                (e) =>
                  !e.deletedAt &&
                  (current.kind === "section"
                    ? e.sectionId === current.id
                    : e.spaceId === current.id),
              ),
            ];
            source[0] = {
              ...current,
              name: c.patch?.name ?? `${current.name} copy`,
            };
            const checkpoint =
              current.kind === "space"
                ? ((await this.db.meta.get(`session:checkpoint:${current.id}`))
                    ?.value as
                    { snapshot?: Snapshot; activeIndex?: number } | undefined)
                : undefined;
            const session =
              current.kind === "space"
                ? savedSessionData(current.id, all, checkpoint).snapshot
                : undefined;
            if (session) {
              // Stale savedTab records are historical bookkeeping, not membership.
              const visible = new Set(
                session.tabs.flatMap((tab) =>
                  [tab.recordId, tab.lockId].filter(Boolean),
                ),
              );
              source = source.filter(
                (item) => item.kind !== "savedTab" || visible.has(item.id),
              );
            }
            changed = remapEntities(source);
            if (session) {
              const ids = new Map(
                source.map((item, index) => [item.id, changed[index].id]),
              );
              const groupKeys = new Map(
                session.groups.map((group) => [
                  group.key,
                  ids.get(group.key) ?? crypto.randomUUID(),
                ]),
              );
              const copyId = ids.get(current.id)!;
              await this.db.meta.put({
                id: `session:checkpoint:${copyId}`,
                value: {
                  activeIndex: checkpoint?.activeIndex ?? 0,
                  snapshot: {
                    ...session,
                    id: crypto.randomUUID(),
                    capturedAt: now,
                    reason: "Duplicated Space",
                    protected: false,
                    tabs: session.tabs.map((tab) => ({
                      ...tab,
                      spaceId: copyId,
                      recordId: tab.recordId
                        ? ids.get(tab.recordId)
                        : undefined,
                      lockId: tab.lockId ? ids.get(tab.lockId) : undefined,
                      groupKey: tab.groupKey
                        ? groupKeys.get(tab.groupKey)
                        : undefined,
                    })),
                    groups: session.groups.map((group) => ({
                      ...group,
                      key: groupKeys.get(group.key)!,
                    })),
                  },
                },
              });
            }
            if (current.spaceId && c.targetSpaceId)
              changed = changed.map((e) => ({
                ...e,
                spaceId: c.targetSpaceId,
                sectionId: current.kind === "section" ? e.sectionId : undefined,
              }));
          }
        }
        changed = changed.map((e) =>
          entitySchema.parse({
            ...e,
            text: e.doc ? documentText(e.doc) : e.text,
          }),
        );
        const graph = [
          ...(["purge", "emptyTrash"].includes(c.type)
            ? await this.list()
            : all
          ).filter((e) => !changed.some((x) => x.id === e.id)),
          ...changed,
        ];
        assertGraph(
          graph,
          new Set(await this.db.attachments.toCollection().primaryKeys()),
        );
        await this.db.entities.bulkPut(changed);
        await this.db.journal.add({
          id: c.commandId,
          state: "committed",
          createdAt: now,
          intent: c.type,
          result: changed,
        });
        await this.db.meta.put({ id: "indexRevision", value: now });
        return changed;
      },
    );
  }
  async saveDraft(draft: Draft) {
    documentSchema.parse(draft.doc);
    const parent = await this.db.entities.get(draft.noteId);
    if (!parent || !["note", "task"].includes(parent.kind))
      throw new Error("Missing draft parent.");
    await this.db.drafts.put(draft);
  }
  async attachment(file: Blob, filename: string) {
    if (file.size > 64 * 1024 * 1024)
      throw new Error(
        "This build accepts attachments up to 64 MiB per file to bound memory.",
      );
    const bytes = await file.arrayBuffer();
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    )
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    const item: Attachment = {
      id: crypto.randomUUID(),
      filename: filename.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 240),
      mediaType: file.type || "application/octet-stream",
      size: file.size,
      hash,
      blob: file,
      createdAt: new Date().toISOString(),
    };
    await this.db.attachments.add(item);
    return item;
  }
  async snapshot(snapshot: Snapshot) {
    await this.db.snapshots.add(snapshot);
  }
  async pruneSnapshots(days: number) {
    const cutoff = Date.now() - days * 86400000;
    const all = (await this.db.snapshots.toArray()).sort((a, b) =>
      b.capturedAt.localeCompare(a.capturedAt),
    );
    const keep = new Set<string>();
    const seen = new Set<string>();
    for (const s of all) {
      for (const t of s.tabs) {
        const scope = t.spaceId ?? "unassigned";
        if (!seen.has(scope)) {
          seen.add(scope);
          keep.add(s.id);
        }
      }
    }
    await this.db.snapshots.bulkDelete(
      all
        .filter(
          (s) =>
            !s.protected &&
            !keep.has(s.id) &&
            Date.parse(s.capturedAt) < cutoff,
        )
        .map((s) => s.id),
    );
  }
}
export const repository = new Repository(db);
