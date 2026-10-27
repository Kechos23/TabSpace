import Dexie from "dexie";
import { entitySchema } from "../domain/model";
import type { Repository } from "./repository";
import { z } from "zod";
import {
  bundleSchema,
  documentSchema as syncDocumentSchema,
  fileSchema,
} from "../sync/model";

const syncRecoverySchema = z.object({
  createdAt: z.string().datetime(),
  entries: z.record(z.string(), bundleSchema.nullable()),
  incoming: z.record(z.string(), bundleSchema.nullable()).optional(),
  files: z.record(z.string(), fileSchema),
  reason: z.string().optional(),
});
const syncConflictSchema = z.object({
  token: z.string(),
  conflicts: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      local: bundleSchema.nullable(),
      remote: bundleSchema.nullable(),
    }),
  ),
});

const DAY = 86_400_000;

/** Background only: key queries avoid loading note documents and journal results. */
export async function maintainHistory(
  repo: Repository,
  days: number,
  now = Date.now(),
) {
  const cutoff = new Date(now - 7 * DAY).toISOString();
  for (const state of ["committed", "applied"]) {
    await repo.db.transaction("rw", repo.db.journal, async () => {
      const keys = await repo.db.journal
        .where("[state+createdAt]")
        .between([state, Dexie.minKey], [state, cutoff], true, false)
        .limit(250)
        .primaryKeys();
      await repo.db.journal.bulkDelete(keys);
    });
  }
  const noteIds = await repo.db.revisions.orderBy("noteId").uniqueKeys();
  const revisionCutoff = new Date(now - days * DAY).toISOString();
  for (const noteId of noteIds) {
    await repo.db.transaction("rw", repo.db.revisions, async () => {
      const ordered = () =>
        repo.db.revisions
          .where("[noteId+createdAt]")
          .between([noteId, Dexie.minKey], [noteId, Dexie.maxKey]);
      const newest = new Set(await ordered().reverse().limit(10).primaryKeys());
      const excess = await ordered().reverse().offset(100).primaryKeys();
      const expired = await repo.db.revisions
        .where("[noteId+createdAt]")
        .between([noteId, Dexie.minKey], [noteId, revisionCutoff], true, false)
        .primaryKeys();
      await repo.db.revisions.bulkDelete(
        [...new Set([...excess, ...expired])].filter((key) => !newest.has(key)),
      );
    });
  }
}

/** Must run inside the successful import transaction. New copy wins timestamp ties. */
export async function trimImportCopies(repo: Repository, newestId: string) {
  const copies: { id: string; createdAt: string }[] = [];
  await repo.db.meta
    .where("id")
    .startsWith("before-import:")
    .each((row) => {
      copies.push({
        id: row.id,
        createdAt: String((row.value as any)?.createdAt ?? ""),
      });
    });
  copies.sort((a, b) =>
    a.id === newestId
      ? -1
      : b.id === newestId
        ? 1
        : b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
  await repo.db.meta.bulkDelete(copies.slice(3).map((copy) => copy.id));
}

export type StorageInfo = {
  fileCount: number;
  fileBytes: number;
  unusedCount: number;
  unusedBytes: number;
  cleanupBlocked: boolean;
  unusedIds: string[];
};

async function inspectFiles(repo: Repository) {
  const referenced = new Set<string>();
  let cleanupBlocked =
    (await repo.db.meta.where("id").startsWith("quarantine:").count()) > 0;
  for (const row of await repo.db.entities.toArray()) {
    const parsed = entitySchema.safeParse(row);
    if (!parsed.success) cleanupBlocked = true;
    else for (const id of parsed.data.attachmentIds) referenced.add(id);
  }
  const background = (await repo.settings()).backgroundAttachmentId;
  if (background) referenced.add(background);
  // Sync bases, conflict previews and recovery copies outlive ordinary journals.
  // Preserve their file references even after an item has been removed locally.
  await repo.db.meta
    .where("id")
    .startsWith("sync:")
    .each((row) => {
      const valid = row.id.startsWith("sync:base:")
        ? syncDocumentSchema.safeParse((row.value as any)?.document).success
        : row.id.startsWith("sync:recovery:")
          ? syncRecoverySchema.safeParse(row.value).success
          : row.id === "sync:conflicts"
            ? syncConflictSchema.safeParse(row.value).success
            : false;
      if (!valid) cleanupBlocked = true;
      const pending: unknown[] = [row.value],
        seen = new Set<object>();
      while (pending.length) {
        const value = pending.pop();
        if (!value || typeof value !== "object" || seen.has(value)) continue;
        seen.add(value);
        if (Array.isArray(value)) {
          pending.push(...value);
          continue;
        }
        const record = value as Record<string, unknown>;
        if (record.attachmentIds !== undefined) {
          if (
            !Array.isArray(record.attachmentIds) ||
            record.attachmentIds.some((id) => typeof id !== "string")
          )
            cleanupBlocked = true;
          else for (const id of record.attachmentIds) referenced.add(id);
        }
        if (record.files && typeof record.files === "object")
          for (const id of Object.keys(record.files)) referenced.add(id);
        pending.push(...Object.values(record));
      }
    });
  await repo.db.journal.each((journal) => {
    for (const row of journal.result ?? []) {
      const parsed = entitySchema.safeParse(row);
      if (!parsed.success) cleanupBlocked = true;
      else for (const id of parsed.data.attachmentIds) referenced.add(id);
    }
  });
  // Safety copies own their Blob rows, independently of the current attachment store.
  // Drafts/revisions contain rich text only; attachment IDs belong to entities.
  const unused: string[] = [];
  const info: StorageInfo = {
    fileCount: 0,
    fileBytes: 0,
    unusedCount: 0,
    unusedBytes: 0,
    cleanupBlocked,
    unusedIds: unused,
  };
  await repo.db.attachments.each((file) => {
    info.fileCount++;
    info.fileBytes += file.size;
    if (!referenced.has(file.id)) {
      unused.push(file.id);
      info.unusedCount++;
      info.unusedBytes += file.size;
    }
  });
  return { info, unused };
}

export async function storageInfo(repo: Repository): Promise<StorageInfo> {
  return repo.db.transaction(
    "r",
    [repo.db.entities, repo.db.attachments, repo.db.journal, repo.db.meta],
    async () => (await inspectFiles(repo)).info,
  );
}

export async function cleanUnusedFiles(
  repo: Repository,
  previewIds: string[],
): Promise<StorageInfo> {
  return repo.db.transaction(
    "rw",
    [repo.db.entities, repo.db.attachments, repo.db.journal, repo.db.meta],
    async () => {
      const { info, unused } = await inspectFiles(repo);
      if (info.cleanupBlocked)
        throw new Error(
          "File cleanup is unavailable while preserved invalid records need review.",
        );
      const approved = new Set(previewIds);
      await repo.db.attachments.bulkDelete(
        unused.filter((id) => approved.has(id)),
      );
      return (await inspectFiles(repo)).info;
    },
  );
}
