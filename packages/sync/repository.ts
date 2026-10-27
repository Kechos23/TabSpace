import {
  assertGraph,
  entity,
  entitySchema,
  type Attachment,
  type Entity,
} from "../domain/model";
import { savedSessionData } from "../domain/saved-session";
import type { Repository } from "../persistence/repository";
import {
  INBOX,
  inboxEntity,
  portable,
  portableSession,
  canonical,
  equal,
  validateUnits,
  type Entries,
  type SyncDocument,
  type SyncFile,
} from "./model";

export type Projection = {
  entries: Entries;
  files: Record<string, SyncFile>;
  generation: string;
};
const sorted = (items: Entity[]) =>
  items.sort((a, b) => a.id.localeCompare(b.id));
export async function capture(repo: Repository): Promise<Projection> {
  return repo.db.transaction(
    "r",
    [repo.db.entities, repo.db.meta, repo.db.attachments],
    async () => {
      if (await repo.db.meta.where("id").startsWith("quarantine:").count())
        throw new Error("Resolve quarantined records before syncing.");
      const all = (await repo.db.entities.toArray()).map((e) =>
        entitySchema.parse(e),
      );
      const inbox = await repo.inbox();
      const entries: Entries = {
        library: {
          entities: sorted(
            all
              .filter((e) => ["sidebar", "property"].includes(e.kind))
              .map(portable),
          ),
        },
      };
      for (const space of all.filter(
        (e) => e.kind === "space" && !e.temporary,
      )) {
        const isInbox = space.id === inbox,
          id = isInbox ? INBOX : space.id;
        const items = all
          .filter((e) => e.id === space.id || e.spaceId === space.id)
          .map((e) => {
            if (isInbox && e.id === space.id) return inboxEntity();
            return portable({
              ...e,
              spaceId: e.spaceId === space.id ? id : e.spaceId,
            });
          });
        const snapshot = isInbox
          ? undefined
          : savedSessionData(
              space.id,
              all,
              (await repo.db.meta.get(`session:checkpoint:${space.id}`))?.value,
            ).snapshot;
        entries[isInbox ? "inbox" : id] = {
          entities: sorted(items),
          ...(snapshot
            ? {
                session: portableSession({
                  tabs: snapshot.tabs
                    .filter((t) => !t.pinned)
                    .map((t) => ({
                      ...t,
                      spaceId: id,
                      windowKey: undefined,
                      recordId: items.some((e) => e.id === t.recordId)
                        ? t.recordId
                        : undefined,
                      lockId: items.some((e) => e.id === t.lockId)
                        ? t.lockId
                        : undefined,
                    })),
                  groups: snapshot.groups,
                }),
              }
            : {}),
        };
      }
      const files: Record<string, SyncFile> = {};
      for (const id of new Set(
        Object.values(entries).flatMap(
          (b) => b?.entities.flatMap((e) => e.attachmentIds) ?? [],
        ),
      )) {
        const file = await repo.db.attachments.get(id);
        if (!file)
          throw new Error("A synchronized item is missing its attachment.");
        const { blob: _, ...info } = file;
        files[id] = info;
      }
      validateUnits(entries);
      return {
        entries,
        files,
        generation: String(
          (await repo.db.meta.get("collectionGeneration"))?.value ?? inbox,
        ),
      };
    },
  );
}

export type SyncBase = {
  target: string;
  generation: string;
  document: SyncDocument;
};
export async function apply(
  repo: Repository,
  expected: Projection,
  document: SyncDocument,
  downloads: Attachment[],
  target: string,
  dryRun = false,
) {
  await repo.db.transaction(
    "rw",
    [
      repo.db.entities,
      repo.db.meta,
      repo.db.attachments,
      repo.db.drafts,
      repo.db.revisions,
    ],
    async () => {
      const current = await capture(repo);
      if (!equal(current, expected))
        throw new Error(
          "Local content changed during sync. Retry; your edits are preserved.",
        );
      const changed = Object.keys(document.entries).filter(
        (key) =>
          !equal(document.entries[key] ?? null, current.entries[key] ?? null),
      );
      const binding = (await repo.db.meta.get("session:registry"))?.value as
        { bindings?: { spaceId: string }[] } | undefined;
      for (const key of changed) {
        const localSpace = current.entries[key]?.entities.find(
          (e) => e.kind === "space",
        );
        const remoteSpace = document.entries[key]?.entities.find(
          (e) => e.kind === "space",
        );
        if (
          binding?.bindings?.some((b) => b.spaceId === key) &&
          (!document.entries[key] ||
            remoteSpace?.deletedAt !== localSpace?.deletedAt ||
            remoteSpace?.archivedAt !== localSpace?.archivedAt ||
            !equal(
              document.entries[key]?.session,
              current.entries[key]?.session,
            ))
        )
          throw new Error(
            `Close Space “${localSpace?.name ?? key}” here before receiving its cloud changes. Your current tabs are unchanged.`,
          );
      }
      const inbox = await repo.inbox();
      const old = await repo.db.entities.toArray();
      const oldById = new Map(old.map((e) => [e.id, e]));
      const removedIds = new Set(
        changed.flatMap(
          (key) =>
            current.entries[key]?.entities
              .filter((e) => e.id !== INBOX)
              .map((e) => e.id) ?? [],
        ),
      );
      const now = new Date().toISOString();
      const incoming: Entity[] = [];
      for (const key of changed)
        for (const item of document.entries[key]?.entities ?? []) {
          if (item.id === INBOX) continue;
          const prior = oldById.get(item.id);
          const mapped = {
            ...item,
            spaceId: item.spaceId === INBOX ? inbox : item.spaceId,
          };
          if (prior && equal(portable(prior), portable(mapped))) {
            incoming.push(prior);
            continue;
          }
          incoming.push(
            entitySchema.parse({
              ...mapped,
              revision: (prior?.revision ?? 0) + 1,
              updatedAt: now,
              view: prior?.view ?? item.view,
              rightView: prior?.rightView ?? item.rightView,
              split: prior?.split ?? item.split,
              splitRatio: prior?.splitRatio ?? item.splitRatio,
              collapsed:
                item.kind === "group"
                  ? item.collapsed
                  : (prior?.collapsed ?? item.collapsed),
            }),
          );
        }
      const nextById = new Map(incoming.map((e) => [e.id, e]));
      for (const draft of await repo.db.drafts.toArray())
        if (removedIds.has(draft.noteId)) {
          const prior = oldById.get(draft.noteId),
            next = nextById.get(draft.noteId);
          if (!prior || !next || !equal(portable(prior), portable(next)))
            throw new Error(
              "An incoming change overlaps an editor draft. Save or recover that draft before syncing.",
            );
        }
      const final = [...old.filter((e) => !removedIds.has(e.id)), ...incoming];
      const ids = new Set(
        await repo.db.attachments.toCollection().primaryKeys(),
      );
      for (const file of downloads) {
        const previous = await repo.db.attachments.get(file.id);
        if (previous && previous.hash !== file.hash)
          throw new Error(
            "Attachment identity collision; no local data was replaced.",
          );
        ids.add(file.id);
      }
      assertGraph(final, ids);
      if (dryRun) return;
      const writes = incoming.filter((item) => item !== oldById.get(item.id));
      if (changed.length) {
        // Independent recovery, never automatically pruned. Keeps overwritten content and file references.
        await repo.db.meta.put({
          id: `sync:recovery:${crypto.randomUUID()}`,
          value: {
            createdAt: now,
            entries: Object.fromEntries(
              changed.map((key) => [key, current.entries[key] ?? null]),
            ),
            files: Object.fromEntries(
              Object.entries(current.files).filter(([id]) =>
                changed.some((key) =>
                  current.entries[key]?.entities.some((e) =>
                    e.attachmentIds.includes(id),
                  ),
                ),
              ),
            ),
          },
        });
        for (const item of writes) {
          const previous = oldById.get(item.id);
          if (previous?.doc && !equal(previous.doc, item.doc))
            await repo.db.revisions.put({
              id: crypto.randomUUID(),
              noteId: item.id,
              revision: previous.revision,
              doc: previous.doc,
              text: previous.text,
              createdAt: now,
            });
        }
        await repo.db.entities.bulkDelete(
          [...removedIds].filter((id) => !nextById.has(id)),
        );
        await repo.db.entities.bulkPut(writes);
        for (const key of changed)
          if (key !== "library" && key !== "inbox") {
            const bundle = document.entries[key];
            if (
              bundle?.session &&
              !equal(bundle.session, current.entries[key]?.session)
            )
              await repo.db.meta.put({
                id: `session:checkpoint:${key}`,
                value: {
                  snapshot: {
                    ...bundle.session,
                    id: crypto.randomUUID(),
                    capturedAt: now,
                    reason: "Cloud sync",
                    protected: false,
                  },
                  activeIndex: 0,
                },
              });
            else if (!bundle?.session)
              await repo.db.meta.delete(`session:checkpoint:${key}`);
          }
        await repo.db.meta.put({ id: "indexRevision", value: now });
      }
      await repo.db.attachments.bulkPut(downloads);
      await repo.db.meta.put({
        id: `sync:base:${target}`,
        value: {
          target,
          generation: expected.generation,
          document,
        } satisfies SyncBase,
      });
      await repo.db.meta.delete("sync:conflicts");
    },
  );
}

export const fingerprint = (projection: unknown) => canonical(projection);
