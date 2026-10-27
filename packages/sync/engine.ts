import { assertGraph, type Attachment } from "../domain/model";
import { conflictCopy } from "./conflict-copy";
import type { Repository } from "../persistence/repository";
import {
  documentSchema,
  mergeEntries,
  validateUnits,
  equal,
  INBOX,
  emptyEntries,
  type SyncDocument,
  type Conflict,
  type Bundle,
} from "./model";
import { capture, apply, fingerprint, type SyncBase } from "./repository";
import {
  decodeDocument,
  encodeDocument,
  digest,
  seal,
  open,
  vaultKey,
} from "./crypto";
import { RemoteChanged, type SyncTransport } from "./webdav";

export type Choices = Record<string, "local" | "remote" | "both">;
export type ConflictReview = { token: string; conflicts: Conflict[] };
const MANIFEST_LIMIT = 24 * 1024 * 1024;
const blobPath = (id: string, hash: string) => `blobs/${id}-${hash}.bin`;
export async function synchronize(
  repo: Repository,
  transport: SyncTransport,
  target: string,
  passphrase: string,
  queue: <T>(job: () => Promise<T>) => Promise<T> = (job) => job(),
  resolution?: { token: string; choices: Choices },
) {
  const local = await queue(() => capture(repo));
  const base = (await repo.db.meta.get(`sync:base:${target}`))?.value as
    SyncBase | undefined;
  if (base && base.target !== target)
    throw new Error(
      "Disconnect the previous sync folder before changing accounts.",
    );
  await transport.prepare();
  let file = await transport.read("manifest.json", MANIFEST_LIMIT);
  if (!file && base)
    throw new Error(
      "The cloud library is missing. Sync stopped to protect your existing data.",
    );
  const decoded = file
    ? await decodeDocument(file.bytes, passphrase)
    : undefined;
  const salt = decoded?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const key = decoded?.key ?? (await vaultKey(passphrase, salt));
  const remote: SyncDocument = decoded
    ? documentSchema.parse(decoded.value)
    : {
        schemaVersion: 1,
        vaultId: crypto.randomUUID(),
        revision: 1,
        entries: emptyEntries(),
        files: {},
      };
  if (!file) {
    // Publish an empty vault header first. Retries after a partial first upload
    // must reuse the same encryption salt/key and attachment authentication context.
    const initial = await encodeDocument(remote, key, salt);
    await transport.write("manifest.json", initial, null);
    file = await transport.read("manifest.json", MANIFEST_LIMIT);
    if (!file || (await digest(file.bytes)) !== (await digest(initial)))
      throw new RemoteChanged("verifying the newly created manifest.json");
  }
  validateUnits(remote.entries);
  if (base && base.document.vaultId !== remote.vaultId)
    throw new Error(
      "The cloud library identity changed. Disconnect and review it before reconnecting.",
    );
  if (
    base &&
    (remote.revision < base.document.revision ||
      (remote.revision === base.document.revision &&
        !equal(remote, base.document)) ||
      Object.keys(base.document.entries).some(
        (id) => !Object.hasOwn(remote.entries, id),
      ))
  )
    throw new Error(
      "Cloud history moved backwards or lost identities. Sync stopped; restore a verified cloud version first.",
    );
  if (!remote.entries.inbox || !remote.entries.library)
    throw new Error("The cloud library is incomplete.");
  const merged = mergeEntries(
    base?.generation === local.generation
      ? base.document.entries
      : emptyEntries(),
    local.entries,
    remote.entries,
  );
  const token = await digest(
    new TextEncoder().encode(fingerprint({ local, remote })),
  );
  const review: ConflictReview = { token, conflicts: merged.conflicts };
  if (resolution && resolution.token !== token)
    throw new Error(
      "The conflict preview changed. Sync again to review the current versions.",
    );
  for (const conflict of merged.conflicts) {
    const choice = resolution?.choices[conflict.key];
    if (!choice) {
      await repo.db.meta.put({ id: "sync:conflicts", value: review });
      return { synced: false as const, review };
    }
    if (choice === "both") {
      if (
        ["library", "inbox"].includes(conflict.key) ||
        !conflict.local ||
        !conflict.remote
      )
        throw new Error(
          "Keep both is available for two existing Saved Space versions.",
        );
      const bundle = await conflictCopy(
        remote.vaultId,
        conflict.key,
        conflict.local,
      );
      const space = bundle.entities.find((e) => e.kind === "space")!;
      if (remote.entries[space.id] && !equal(remote.entries[space.id], bundle))
        throw new Error(
          "A previous conflict copy has changed on another device. Keep its changes and choose which version to keep for the original Space.",
        );
      merged.entries[space.id] = bundle;
      merged.entries[conflict.key] = conflict.remote;
    } else
      merged.entries[conflict.key] =
        choice === "local" ? conflict.local : conflict.remote;
  }
  validateUnits(merged.entries);
  const all = Object.values(merged.entries).flatMap((b) => b?.entities ?? []);
  const files = { ...remote.files, ...local.files };
  for (const [id, info] of Object.entries(local.files))
    if (remote.files[id] && !equal(info, remote.files[id]))
      throw new Error(
        "Attachment identity collision. Sync stopped without replacing local content.",
      );
  assertGraph(all, new Set(Object.keys(files)));
  if (!all.some((e) => e.id === INBOX && e.kind === "space"))
    throw new Error("Cloud Inbox is missing.");
  const modified =
    !equal(merged.entries, remote.entries) || !equal(files, remote.files);
  const next: SyncDocument = {
    ...remote,
    revision: remote.revision + (modified ? 1 : 0),
    entries: merged.entries,
    files,
  };
  // Resolve/download only live references. Remote blobs and tombstones are never automatically deleted.
  const downloads: Attachment[] = [];
  for (const id of new Set(all.flatMap((e) => e.attachmentIds))) {
    const info = files[id];
    const existing = await repo.db.attachments.get(id);
    if (existing && existing.hash !== info.hash)
      throw new Error("Attachment identity collision.");
    const path = blobPath(id, info.hash),
      aad = `TabSpace/sync/v1/${remote.vaultId}/${path}`;
    if (!remote.files[id]) {
      if (!existing) throw new Error("A local sync attachment is missing.");
      const bytes = new Uint8Array(await existing.blob.arrayBuffer());
      if (bytes.length !== info.size || (await digest(bytes)) !== info.hash)
        throw new Error("A local attachment failed its integrity check.");
      try {
        await transport.write(path, await seal(bytes, key, aad), null);
      } catch (error) {
        if (!(error instanceof RemoteChanged)) throw error;
        const uploaded = await transport.read(path, info.size + 28);
        if (
          !uploaded ||
          (await digest(await open(uploaded.bytes, key, aad))) !== info.hash
        )
          throw new Error(
            "An existing cloud attachment failed its integrity check.",
          );
      }
    }
    if (!existing) {
      const blob = await transport.read(path, info.size + 28);
      if (!blob)
        throw new Error(
          "A cloud attachment is incomplete. Local data was not replaced.",
        );
      const bytes = await open(blob.bytes, key, aad);
      if (bytes.length !== info.size || (await digest(bytes)) !== info.hash)
        throw new Error("A cloud attachment failed its integrity check.");
      downloads.push({
        ...info,
        blob: new Blob([new Uint8Array(bytes)], { type: info.mediaType }),
      });
    }
  }
  // Check all apply preconditions before publication, then check again in the final transaction.
  await queue(async () => {
    await apply(repo, local, next, downloads, target, true);
  });
  if (merged.conflicts.length)
    await repo.db.meta.put({
      id: `sync:recovery:${crypto.randomUUID()}`,
      value: {
        createdAt: new Date().toISOString(),
        entries: local.entries,
        incoming: remote.entries,
        files: { ...remote.files, ...local.files },
        reason: "Before explicit sync conflict resolution",
      },
    });
  const encoded = await encodeDocument(next, key, salt);
  if (encoded.length > MANIFEST_LIMIT)
    throw new Error(
      "Sync metadata exceeds this version's safe processing size.",
    );
  if (!file || !equal(next, remote))
    await transport.write("manifest.json", encoded, file?.etag ?? null);
  await queue(() => apply(repo, local, next, downloads, target));
  return {
    synced: true as const,
    spaces: Object.entries(next.entries).filter(
      ([k, v]) => v && k !== "library" && k !== "inbox",
    ).length,
  };
}
