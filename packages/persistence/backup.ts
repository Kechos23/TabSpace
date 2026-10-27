import { z } from "zod";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import {
  assertGraph,
  entitySchema,
  remapEntities,
  settingsSchema,
  snapshotSchema,
  documentSchema,
  type Attachment,
  type Draft,
  type NoteRevision,
} from "../domain/model";
import { type Repository } from "./repository";
import { APP_VERSION } from "../domain/version";
import { trimImportCopies } from "./maintenance";
import { cleanLegacyBackup } from "./legacy-cleanup";

const attachmentInfo = z
  .object({
    id: z.string().uuid(),
    filename: z.string().max(240),
    mediaType: z.string().max(240),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 * 1024),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
    data: z.string().optional(),
  })
  .strict();
const draftSchema = z
  .object({
    id: z.string().max(200),
    noteId: z.string().uuid(),
    baseRevision: z.number().int().positive(),
    doc: documentSchema,
    text: z.string().max(2_000_000),
    updatedAt: z.string().datetime(),
  })
  .strict();
const revisionSchema = z
  .object({
    id: z.string().uuid(),
    noteId: z.string().uuid(),
    revision: z.number().int().positive(),
    doc: documentSchema,
    text: z.string().max(2_000_000),
    createdAt: z.string().datetime(),
  })
  .strict();
const backupSchema = z
  .object({
    app: z.literal("TabSpace"),
    // Storage schema, rather than the producing patch version, controls import
    // compatibility. Keep accepting existing 0.1.0/schema-1 backups.
    appVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
    schemaVersion: z.literal(1),
    exportId: z.string().uuid(),
    createdAt: z.string().datetime(),
    inboxId: z.string().uuid().optional(),
    entities: z.array(entitySchema).max(1_000_000),
    attachments: z.array(attachmentInfo).max(100_000),
    settings: settingsSchema,
    snapshots: z.array(snapshotSchema).max(100_000),
    drafts: z.array(draftSchema).max(100_000),
    revisions: z.array(revisionSchema).max(1_000_000),
    sessions: z
      .array(
        z
          .object({
            spaceId: z.string().uuid(),
            snapshot: snapshotSchema,
            activeIndex: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(100000)
      .default([]),
  })
  .strict();
export type Backup = z.infer<typeof backupSchema>;
const maxArchive = 256 * 1024 * 1024;
const hash = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
function base64(bytes: Uint8Array) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(out);
}
export async function exportBackup(repo: Repository, format: "json" | "zip") {
  // Capture one IndexedDB snapshot. Blob reads, hashing and compression happen
  // afterwards so async non-IDB work cannot expire the read transaction.
  const captured = await repo.db.transaction(
    "r",
    [
      repo.db.entities,
      repo.db.attachments,
      repo.db.meta,
      repo.db.snapshots,
      repo.db.drafts,
      repo.db.revisions,
    ],
    async () => ({
      entities: (await repo.db.entities.toArray()).map((item) =>
        entitySchema.parse(item),
      ),
      attachments: await repo.db.attachments.toArray(),
      inboxId: await repo.inbox(),
      settings: await repo.settings(),
      snapshots: await repo.db.snapshots.toArray(),
      drafts: await repo.db.drafts.toArray(),
      revisions: await repo.db.revisions.toArray(),
      sessions: (
        await repo.db.meta
          .where("id")
          .startsWith("session:checkpoint:")
          .toArray()
      ).map((row) => ({
        spaceId: row.id.slice("session:checkpoint:".length),
        ...(row.value as {
          snapshot: z.infer<typeof snapshotSchema>;
          activeIndex: number;
        }),
      })),
    }),
  );
  const entities = captured.entities;
  const attachments = captured.attachments;
  const size = attachments.reduce((n, a) => n + a.size, 0);
  if (size > maxArchive)
    throw new Error(
      "This in-memory exporter supports up to 256 MiB. A streaming exporter is required for larger backups.",
    );
  const data: Backup = {
    app: "TabSpace",
    appVersion: APP_VERSION,
    schemaVersion: 1,
    exportId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    inboxId: captured.inboxId,
    entities,
    attachments: attachments.map(({ blob, ...a }) => a),
    settings: captured.settings,
    snapshots: captured.snapshots,
    drafts: captured.drafts,
    revisions: captured.revisions,
    sessions: captured.sessions.filter((s) =>
      entities.some((e) => e.id === s.spaceId && e.kind === "space"),
    ),
  };
  const files: Record<string, Uint8Array> = {};
  for (const a of attachments) {
    const bytes = new Uint8Array(await a.blob.arrayBuffer());
    if (bytes.length !== a.size || (await hash(bytes)) !== a.hash)
      throw new Error("Attachment size/checksum mismatch.");
    if (format === "json")
      data.attachments.find((x) => x.id === a.id)!.data = base64(bytes);
    else files[`attachments/${a.id}.bin`] = bytes;
  }
  backupSchema.parse(data);
  assertGraph(data.entities, new Set(data.attachments.map((a) => a.id)));
  validateBackupGraph(data);
  if (format === "json") {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    if (blob.size > maxArchive)
      throw new Error(
        "Encoded backup exceeds the 256 MiB import safety bound.",
      );
    return blob;
  }
  files["manifest.json"] = strToU8(JSON.stringify(data));
  if (
    Object.values(files).reduce((total, file) => total + file.length, 0) >
    maxArchive
  )
    throw new Error("Expanded archive exceeds 256 MiB.");
  const bytes = zipSync(files, { level: 1 });
  if (bytes.length > maxArchive)
    throw new Error("Encoded backup exceeds the 256 MiB import safety bound.");
  return new Blob([new Uint8Array(bytes).buffer], { type: "application/zip" });
}
function inspectZip(bytes: Uint8Array) {
  // Validate central-directory sizes and paths before any decompression/allocation.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("Invalid ZIP directory.");
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true))
    throw new Error("Split archives are unsupported.");
  const count = view.getUint16(end + 10, true);
  let pos = view.getUint32(end + 16, true),
    total = 0;
  const names = new Set<string>();
  if (count === 65535)
    throw new Error("ZIP64 archives require a streaming importer.");
  for (let n = 0; n < count; n++) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50)
      throw new Error("Invalid ZIP entry.");
    const flags = view.getUint16(pos + 8, true),
      method = view.getUint16(pos + 10, true),
      size = view.getUint32(pos + 24, true),
      len = view.getUint16(pos + 28, true),
      extra = view.getUint16(pos + 30, true),
      comment = view.getUint16(pos + 32, true);
    if (flags & 1 || ![0, 8].includes(method) || size === 0xffffffff)
      throw new Error("Unsupported ZIP encoding.");
    const name = strFromU8(bytes.subarray(pos + 46, pos + 46 + len));
    if (
      !/^(manifest\.json|attachments\/[a-f0-9-]{36}\.bin)$/.test(name) ||
      names.has(name)
    )
      throw new Error("Unsafe or duplicate archive path.");
    names.add(name);
    total += size;
    if (total > maxArchive)
      throw new Error("Expanded archive exceeds 256 MiB.");
    pos += 46 + len + extra + comment;
  }
  if (!names.has("manifest.json")) throw new Error("Missing backup manifest.");
}
export async function parseBackup(
  blob: Blob,
): Promise<{ data: Backup; attachments: Attachment[] }> {
  if (blob.size > maxArchive)
    throw new Error("Backup exceeds the 256 MiB import safety bound.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let files: Record<string, Uint8Array> | undefined;
  let raw: unknown;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    inspectZip(bytes);
    files = unzipSync(bytes);
    raw = JSON.parse(strFromU8(files["manifest.json"]));
  } else
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const cleaned = cleanLegacyBackup(raw);
  const data = backupSchema.parse(cleaned.value);
  if (files)
    for (const id of cleaned.removedIds) delete files[`attachments/${id}.bin`];
  validateBackupGraph(data);
  const attachments: Attachment[] = [];
  let total = 0;
  for (const a of data.attachments) {
    const content =
      files?.[`attachments/${a.id}.bin`] ??
      (a.data !== undefined
        ? Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0))
        : undefined);
    if (
      !content ||
      content.length !== a.size ||
      (await hash(content)) !== a.hash
    )
      throw new Error("Attachment size/checksum mismatch.");
    total += content.length;
    if (total > maxArchive)
      throw new Error("Expanded backup exceeds safety bound.");
    attachments.push({
      id: a.id,
      filename: a.filename,
      mediaType: a.mediaType,
      size: a.size,
      hash: a.hash,
      createdAt: a.createdAt,
      blob: new Blob([new Uint8Array(content).buffer], { type: a.mediaType }),
    });
  }
  if (files && Object.keys(files).length !== attachments.length + 1)
    throw new Error("Unreferenced archive entries.");
  return { data, attachments };
}
function validateBackupGraph(data: Backup) {
  const sessionOwners = new Set<string>();
  for (const session of data.sessions) {
    if (
      sessionOwners.has(session.spaceId) ||
      !data.entities.some(
        (e) => e.id === session.spaceId && e.kind === "space",
      ) ||
      session.snapshot.tabs.some(
        (t) => t.spaceId && t.spaceId !== session.spaceId,
      )
    )
      throw new Error("Invalid Space session ownership.");
    sessionOwners.add(session.spaceId);
  }
  if (
    data.settings.backgroundAttachmentId &&
    !data.attachments.some((a) => a.id === data.settings.backgroundAttachmentId)
  )
    throw new Error("Missing local background attachment.");
  assertGraph(data.entities, new Set(data.attachments.map((a) => a.id)));
  if (data.entities.find((e) => e.id === data.inboxId)?.kind !== "space")
    throw new Error("Missing Inbox.");
  const ids = new Set(data.entities.map((e) => e.id));
  for (const d of [...data.drafts, ...data.revisions])
    if (
      !ids.has(d.noteId) ||
      !["note", "task"].includes(
        data.entities.find((e) => e.id === d.noteId)?.kind ?? "",
      )
    )
      throw new Error("Missing note history parent.");
  if (
    new Set(data.attachments.map((a) => a.id)).size !== data.attachments.length
  )
    throw new Error("Duplicate attachment IDs.");
}
export async function importBackup(
  repo: Repository,
  parsed: Awaited<ReturnType<typeof parseBackup>>,
  mode: "merge" | "replace",
) {
  const { data } = parsed;
  let entities = data.entities,
    attachments = parsed.attachments,
    drafts: Draft[] = data.drafts,
    revisions: NoteRevision[] = data.revisions,
    snapshots = data.snapshots,
    sessions = data.sessions;
  if (mode === "merge") {
    const remapped = remapEntities(entities),
      ids = new Map(entities.map((e, i) => [e.id, remapped[i].id]));
    const attachmentIds = new Map(
      attachments.map((a) => [a.id, crypto.randomUUID()]),
    );
    attachments = attachments.map((a) => ({
      ...a,
      id: attachmentIds.get(a.id)!,
    }));
    entities = remapped.map((e, index) => ({
      ...e,
      // Backup merge preserves lifecycle and history while remapping identities.
      deletedAt: data.entities[index].deletedAt,
      archivedAt: data.entities[index].archivedAt,
      revision: data.entities[index].revision,
      createdAt: data.entities[index].createdAt,
      updatedAt: data.entities[index].updatedAt,
      attachmentIds: e.attachmentIds.map((id) => attachmentIds.get(id)!),
    }));
    drafts = drafts.map((d) => ({
      ...d,
      id: crypto.randomUUID(),
      noteId: ids.get(d.noteId)!,
    }));
    revisions = revisions.map((r) => ({
      ...r,
      id: crypto.randomUUID(),
      noteId: ids.get(r.noteId)!,
    }));
    snapshots = snapshots.map((s) => ({
      ...s,
      id: crypto.randomUUID(),
      tabs: s.tabs.map((t) => ({
        ...t,
        spaceId: t.spaceId ? ids.get(t.spaceId) : undefined,
        lockId: t.lockId ? ids.get(t.lockId) : undefined,
        recordId: t.recordId ? ids.get(t.recordId) : undefined,
      })),
    }));
    sessions = sessions.map((s) => ({
      ...s,
      spaceId: ids.get(s.spaceId)!,
      snapshot: {
        ...s.snapshot,
        id: crypto.randomUUID(),
        tabs: s.snapshot.tabs.map((t) => ({
          ...t,
          spaceId: t.spaceId ? ids.get(t.spaceId) : undefined,
          lockId: t.lockId ? ids.get(t.lockId) : undefined,
          recordId: t.recordId ? ids.get(t.recordId) : undefined,
        })),
      },
    }));
  }
  await repo.db.transaction(
    "rw",
    [
      repo.db.entities,
      repo.db.attachments,
      repo.db.snapshots,
      repo.db.meta,
      repo.db.drafts,
      repo.db.revisions,
      repo.db.browser,
      repo.db.journal,
    ],
    async () => {
      assertGraph(
        [...(mode === "merge" ? await repo.list() : []), ...entities],
        new Set([
          ...(mode === "merge"
            ? await repo.db.attachments.toCollection().primaryKeys()
            : []),
          ...attachments.map((a) => a.id),
        ]),
      );
      const safetyCopyId = `before-import:${crypto.randomUUID()}`;
      await repo.db.meta.put({
        id: safetyCopyId,
        value: {
          createdAt: new Date().toISOString(),
          entities: await repo.list(),
          rawEntities: await repo.db.entities.toArray(),
          quarantine: await repo.db.meta
            .where("id")
            .startsWith("quarantine:")
            .toArray(),
          attachments: await repo.db.attachments.toArray(),
          snapshots: await repo.db.snapshots.toArray(),
          settings: await repo.settings(),
          inboxId: await repo.inbox(),
          drafts: await repo.db.drafts.toArray(),
          revisions: await repo.db.revisions.toArray(),
        },
      });
      if (mode === "replace") {
        for (const prefix of [
          "tab:",
          "owner:",
          "resource-tab:",
          "session:",
          "browsing:",
        ])
          await repo.db.meta.where("id").startsWith(prefix).delete();
        await repo.db.meta.where("id").startsWith("quarantine:").delete();
        await repo.db.entities.clear();
        await repo.db.attachments.clear();
        await repo.db.snapshots.clear();
        await repo.db.drafts.clear();
        await repo.db.revisions.clear();
        await repo.db.journal.clear();
        await repo.db.meta.put({ id: "inbox", value: data.inboxId! });
        await repo.setSettings({ ...data.settings, helperEnabled: false });
      }
      await repo.db.entities.bulkPut(entities);
      await repo.db.attachments.bulkPut(attachments);
      await repo.db.snapshots.bulkPut(snapshots);
      for (const session of sessions)
        await repo.db.meta.put({
          id: `session:checkpoint:${session.spaceId}`,
          value: {
            snapshot: session.snapshot,
            activeIndex: session.activeIndex,
          },
        });
      await repo.db.drafts.bulkPut(drafts);
      await repo.db.revisions.bulkPut(revisions);
      // Merge only adds independent identities; existing live ownership remains valid.
      if (mode === "replace") await repo.db.browser.clear();
      await repo.db.meta.put({
        id: "collectionGeneration",
        value: crypto.randomUUID(),
      });
      await repo.db.meta.put({
        id: "indexRevision",
        value: new Date().toISOString(),
      });
      await trimImportCopies(repo, safetyCopyId);
    },
  );
}
