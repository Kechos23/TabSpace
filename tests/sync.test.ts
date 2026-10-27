import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Repository, TabSpaceDB } from "../packages/persistence/repository";
import { entity, blankDoc } from "../packages/domain/model";
import { synchronize } from "../packages/sync/engine";
import { capture } from "../packages/sync/repository";
import { portableSession } from "../packages/sync/model";
import {
  RemoteChanged,
  WebDAV,
  folderUrl,
  syncFolder,
  type SyncTransport,
} from "../packages/sync/webdav";
import { digest, decodeDocument } from "../packages/sync/crypto";
import {
  storageInfo,
  cleanUnusedFiles,
} from "../packages/persistence/maintenance";

class MemoryDAV implements SyncTransport {
  data = new Map<string, { bytes: Uint8Array; etag: string }>();
  writes = 0;
  async prepare() {}
  async read(path: string) {
    return this.data.get(path);
  }
  async write(path: string, bytes: Uint8Array, etag: string | null) {
    const prior = this.data.get(path);
    if (etag ? prior?.etag !== etag : prior) throw new RemoteChanged();
    this.data.set(path, { bytes, etag: `"${++this.writes}"` });
  }
}
let a: Repository, b: Repository, dav: MemoryDAV;
const pass = "long sync passphrase for tests",
  target = "https://cloud.test/TabSpace/|test";
const run = (
  repo: Repository,
  resolution?: Parameters<typeof synchronize>[5],
) => synchronize(repo, dav, target, pass, undefined, resolution);
beforeEach(async () => {
  a = new Repository(new TabSpaceDB(`sync-a-${crypto.randomUUID()}`));
  b = new Repository(new TabSpaceDB(`sync-b-${crypto.randomUUID()}`));
  await a.initialize();
  await b.initialize();
  dav = new MemoryDAV();
});
afterEach(async () => {
  await a.db.delete();
  await b.db.delete();
});
const create = async (repo: Repository, e: ReturnType<typeof entity>) => {
  await repo.execute({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    type: "create",
    entity: e,
  });
  return e;
};
const rename = async (repo: Repository, id: string, name: string) => {
  const e = (await repo.db.entities.get(id))!;
  await repo.execute({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    type: "update",
    id,
    expectedRevision: e.revision,
    patch: { name },
  });
};

it("syncs Saved Spaces, Inbox and files across independent databases without exporting local sessions or preferences", async () => {
  const space = await create(a, entity("space", "Cloud project"));
  const file = await a.attachment(
    new Blob(["file content"], { type: "text/plain" }),
    "file.txt",
  );
  await create(
    a,
    entity("resource", "Resource", {
      spaceId: space.id,
      attachmentIds: [file.id],
      url: "https://example.org",
    }),
  );
  await create(
    a,
    entity("note", "Inbox note", {
      spaceId: await a.inbox(),
      doc: blankDoc(),
      text: "hello",
    }),
  );
  const temporary = await create(
    a,
    entity("space", "Private unsaved", { temporary: true }),
  );
  await a.patchSettings({ colorTheme: "blue" });
  expect((await run(a)).synced).toBe(true);
  const wire = new TextDecoder().decode(dav.data.get("manifest.json")!.bytes);
  expect(wire).not.toContain("Cloud project");
  expect(wire).not.toContain("file content");
  await run(b);
  expect((await b.db.entities.get(space.id))?.name).toBe("Cloud project");
  expect(await b.db.entities.get(temporary.id)).toBeUndefined();
  const note = (await b.list()).find((e) => e.name === "Inbox note")!;
  expect(note.spaceId).toBe(await b.inbox());
  expect(await (await b.db.attachments.get(file.id))!.blob.text()).toBe(
    "file content",
  );
  expect((await b.settings()).colorTheme).toBe("green");
  const writes = dav.writes;
  await run(a);
  await run(b);
  expect(dav.writes).toBe(writes);
});

it("merges independent Space changes and retains stable identities", async () => {
  const first = await create(a, entity("space", "First")),
    second = await create(a, entity("space", "Second"));
  await run(a);
  await run(b);
  await rename(a, first.id, "First changed");
  await rename(b, second.id, "Second changed");
  await run(a);
  await run(b);
  await run(a);
  expect((await a.db.entities.get(second.id))?.name).toBe("Second changed");
  expect((await b.db.entities.get(first.id))?.name).toBe("First changed");
  expect((await a.list()).filter((e) => e.kind === "space")).toHaveLength(3);
});

it("merges independent notes and Inbox additions without forcing a whole-Space conflict", async () => {
  const space = await create(a, entity("space", "Shared"));
  await run(a);
  await run(b);
  for (const repo of [a, b]) {
    await create(
      repo,
      entity("note", repo === a ? "Note A" : "Note B", { spaceId: space.id }),
    );
    await create(
      repo,
      entity("task", repo === a ? "Task A" : "Task B", {
        spaceId: await repo.inbox(),
      }),
    );
  }
  await run(a);
  expect((await run(b)).synced).toBe(true);
  await run(a);
  for (const repo of [a, b])
    for (const name of ["Note A", "Note B", "Task A", "Task B"])
      expect((await repo.list()).some((e) => e.name === name)).toBe(true);
});

it("reattaches an imported collection without silently deleting unrelated cloud Spaces", async () => {
  const remote = await create(a, entity("space", "Already in cloud"));
  await run(a);
  await a.db.entities.delete(remote.id);
  await a.db.meta.put({
    id: "collectionGeneration",
    value: crypto.randomUUID(),
  });
  await create(a, entity("space", "Imported project"));
  await run(a);
  expect((await a.list()).some((e) => e.id === remote.id)).toBe(true);
});

it("joins a user-selected folder without accepting path traversal", () => {
  expect(syncFolder("https://cloud.test/dav/user", "Tab Space")).toBe(
    "https://cloud.test/dav/user/Tab%20Space/",
  );
  for (const folder of ["", "../other", "a//b", "a/./b", "a\\b"])
    expect(() => syncFolder("https://cloud.test/dav/user/", folder)).toThrow();
});

it("normalizes native group and window identities without losing duplicate tabs or group appearance", () => {
  const session = (key: string, window: string) => ({
    tabs: [1, 2].map(() => ({
      url: "https://example.org",
      title: "Duplicate",
      groupKey: key,
      windowKey: window,
      pinned: false,
      muted: false,
    })),
    groups: [
      {
        key,
        windowKey: window,
        title: "Research",
        color: "red" as const,
        collapsed: true,
      },
    ],
  });
  const first = portableSession(session("window-1:group-123", "window-1"));
  expect(first).toEqual(
    portableSession(session("window-2:group-999", "window-2")),
  );
  expect(first.tabs).toHaveLength(2);
  expect(first.groups[0].collapsed).toBe(true);
  expect(JSON.stringify(first)).not.toContain("window-");
});

it("preserves concurrent versions until explicit review, then keeps both Spaces", async () => {
  const space = await create(a, entity("space", "Original"));
  await create(
    a,
    entity("savedTab", "Tab", {
      spaceId: space.id,
      url: "https://example.org",
      locked: true,
    }),
  );
  await run(a);
  await run(b);
  await rename(a, space.id, "From A");
  await rename(b, space.id, "From B");
  await run(a);
  const writes = dav.writes,
    pending = await run(b);
  expect(pending.synced).toBe(false);
  if (pending.synced) throw Error("Expected conflict");
  expect(dav.writes).toBe(writes);
  expect((await b.db.entities.get(space.id))?.name).toBe("From B");
  await run(b, {
    token: pending.review.token,
    choices: { [space.id]: "both" },
  });
  await run(a);
  expect(
    (await a.list()).some((e) => e.name === "From B (Conflict copy)"),
  ).toBe(true);
  expect((await a.db.entities.get(space.id))?.name).toBe("From A");
  expect(
    await b.db.meta.where("id").startsWith("sync:recovery:").count(),
  ).toBeGreaterThan(0);
});

it("rejects stale conflict choices and incorrect keys without cloud or local replacement", async () => {
  const space = await create(a, entity("space", "Original"));
  await run(a);
  await run(b);
  await rename(a, space.id, "A");
  await rename(b, space.id, "B");
  await run(a);
  const pending = await run(b);
  if (pending.synced) throw Error("Expected conflict");
  await rename(b, space.id, "New B");
  await expect(
    run(b, { token: pending.review.token, choices: { [space.id]: "remote" } }),
  ).rejects.toThrow("preview changed");
  const writes = dav.writes;
  await expect(
    synchronize(b, dav, target, "wrong passphrase 12345"),
  ).rejects.toThrow("decrypt");
  expect(dav.writes).toBe(writes);
  expect((await b.db.entities.get(space.id))?.name).toBe("New B");
});

it("does not rewrite an untouched note or session when another note in its Space changes", async () => {
  const space = await create(a, entity("space", "Shared editor"));
  const untouched = await create(
    a,
    entity("note", "Typing here", { spaceId: space.id, doc: blankDoc() }),
  );
  const edited = await create(
    a,
    entity("note", "Other note", { spaceId: space.id, doc: blankDoc() }),
  );
  await run(a);
  await run(b);
  const before = (await b.db.entities.get(untouched.id))!;
  const checkpoint = (await b.db.meta.get(`session:checkpoint:${space.id}`))!
    .value as any;
  await b.db.meta.put({
    id: `session:checkpoint:${space.id}`,
    value: { ...checkpoint, activeIndex: 2 },
  });
  await b.db.drafts.put({
    id: crypto.randomUUID(),
    noteId: untouched.id,
    baseRevision: before.revision,
    doc: blankDoc(),
    text: "Uncommitted typing",
    updatedAt: new Date().toISOString(),
  });
  await rename(a, edited.id, "Changed remotely");
  await run(a);
  await run(b);
  expect(await b.db.entities.get(untouched.id)).toEqual(before);
  const after = (await b.db.meta.get(`session:checkpoint:${space.id}`))!
    .value as any;
  expect(after.snapshot.id).toBe(checkpoint.snapshot.id);
  expect(after.activeIndex).toBe(2);
  await b.execute({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    type: "update",
    id: untouched.id,
    expectedRevision: before.revision,
    patch: { name: "Saved my typing" },
  });
});

it("blocks trashing an open Space even when its tab list did not change", async () => {
  const space = await create(a, entity("space", "Still open here"));
  await run(a);
  await run(b);
  await b.db.meta.put({
    id: "session:registry",
    value: { bindings: [{ spaceId: space.id, windowId: 8, parked: true }] },
  });
  const current = (await a.db.entities.get(space.id))!;
  await a.execute({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    type: "trash",
    id: space.id,
    expectedRevision: current.revision,
  });
  await run(a);
  await expect(run(b)).rejects.toThrow("Close Space");
  expect((await b.db.entities.get(space.id))?.deletedAt).toBeUndefined();
});

it("protects an editor draft when a remote change moves or renames its note", async () => {
  const source = await create(a, entity("space", "Source"));
  const destination = await create(a, entity("space", "Destination"));
  const note = await create(
    a,
    entity("note", "Typing", { spaceId: source.id, doc: blankDoc() }),
  );
  await run(a);
  await run(b);
  const before = (await b.db.entities.get(note.id))!;
  await b.db.drafts.put({
    id: crypto.randomUUID(),
    noteId: note.id,
    baseRevision: before.revision,
    doc: blankDoc(),
    text: "Still typing",
    updatedAt: new Date().toISOString(),
  });
  await a.db.entities.put({
    ...(await a.db.entities.get(note.id))!,
    spaceId: destination.id,
  });
  await run(a);
  await expect(run(b)).rejects.toThrow("editor draft");
  expect(await b.db.entities.get(note.id)).toEqual(before);
});

it("reuses a Keep both copy after publishing succeeds but local application is interrupted", async () => {
  const space = await create(a, entity("space", "Original"));
  await run(a);
  await run(b);
  await rename(a, space.id, "Cloud version");
  await rename(b, space.id, "Local version");
  await run(a);
  const first = await run(b);
  if (first.synced) throw Error("Expected conflict");
  let calls = 0;
  await expect(
    synchronize(
      b,
      dav,
      target,
      pass,
      async (job) => {
        if (++calls === 3) throw new Error("Interrupted after publication");
        return job();
      },
      { token: first.review.token, choices: { [space.id]: "both" } },
    ),
  ).rejects.toThrow("Interrupted after publication");
  const retry = await run(b);
  if (retry.synced) throw Error("Expected unresolved original conflict");
  await run(b, { token: retry.review.token, choices: { [space.id]: "both" } });
  expect(
    (await b.list()).filter(
      (e) => e.kind === "space" && e.name === "Local version (Conflict copy)",
    ),
  ).toHaveLength(1);
  await run(a);
  await run(b);
  const settled = dav.writes;
  await run(a);
  await run(b);
  expect(dav.writes).toBe(settled);
});

it("never overwrites a previously published conflict copy edited by another device", async () => {
  const space = await create(a, entity("space", "Original"));
  await run(a);
  await run(b);
  await rename(a, space.id, "Cloud branch");
  await rename(b, space.id, "Local branch");
  await run(a);
  const first = await run(b);
  if (first.synced) throw Error("Expected conflict");
  let calls = 0;
  await expect(
    synchronize(
      b,
      dav,
      target,
      pass,
      async (job) => {
        if (++calls === 3) throw new Error("Interrupted");
        return job();
      },
      { token: first.review.token, choices: { [space.id]: "both" } },
    ),
  ).rejects.toThrow("Interrupted");
  await run(a);
  const copy = (await a.list()).find(
    (e) => e.name === "Local branch (Conflict copy)",
  )!;
  await rename(a, copy.id, "Someone edited this copy");
  await run(a);
  const next = await run(b);
  if (next.synced) throw Error("Expected original conflict");
  const writes = dav.writes;
  await expect(
    run(b, { token: next.review.token, choices: { [space.id]: "both" } }),
  ).rejects.toThrow("previous conflict copy has changed");
  expect(dav.writes).toBe(writes);
});

it("propagates permanent removal with tombstones and never resurrects it from an unchanged offline device", async () => {
  const space = await create(a, entity("space", "Remove"));
  await run(a);
  await run(b);
  await a.db.entities.delete(space.id);
  await run(a);
  await run(b);
  await run(a);
  expect(await b.db.entities.get(space.id)).toBeUndefined();
  const decoded = await decodeDocument(
    dav.data.get("manifest.json")!.bytes,
    pass,
  );
  expect(decoded.value.entries[space.id]).toBeNull();
});

it("blocks incoming live tab replacement and draft collisions before publishing", async () => {
  const space = await create(a, entity("space", "Open"));
  const note = await create(
    a,
    entity("note", "Note", { spaceId: space.id, doc: blankDoc() }),
  );
  await run(a);
  await run(b);
  await b.db.meta.put({
    id: "session:registry",
    value: { bindings: [{ spaceId: space.id, windowId: 123, parked: false }] },
  });
  await create(
    a,
    entity("savedTab", "New tab", {
      spaceId: space.id,
      url: "https://example.org",
    }),
  );
  await run(a);
  const writes = dav.writes;
  await expect(run(b)).rejects.toThrow("Close Space");
  expect(dav.writes).toBe(writes);
  await b.db.meta.delete("session:registry");
  await run(b);
  await a.db.entities.put({
    ...(await a.db.entities.get(note.id))!,
    doc: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "remote" }] },
      ],
    },
  });
  await run(a);
  await b.db.drafts.put({
    id: crypto.randomUUID(),
    noteId: note.id,
    baseRevision: 1,
    doc: blankDoc(),
    text: "local draft",
    updatedAt: new Date().toISOString(),
  });
  await expect(run(b)).rejects.toThrow("editor draft");
  expect(await b.db.drafts.count()).toBe(1);
});

it("handles conditional-write races, missing cloud libraries and interrupted local application safely", async () => {
  await create(a, entity("space", "Initial"));
  await run(a);
  await run(b);
  await create(b, entity("space", "Only B"));
  const write = dav.write.bind(dav);
  dav.write = async (path, bytes, etag) => {
    if (path === "manifest.json") throw new RemoteChanged();
    return write(path, bytes, etag);
  };
  await expect(run(b)).rejects.toThrow("Cloud data changed");
  dav.write = write;
  const originalQueue = async <T>(job: () => Promise<T>) => job();
  let calls = 0;
  await expect(
    synchronize(b, dav, target, pass, async (job) => {
      if (++calls === 3)
        await create(b, entity("space", "Edited while uploading"));
      return originalQueue(job);
    }),
  ).rejects.toThrow("Local content changed");
  expect(
    (await b.list()).some((e) => e.name === "Edited while uploading"),
  ).toBe(true);
  dav.data.delete("manifest.json");
  await expect(run(a)).rejects.toThrow("cloud library is missing");
});

it("rejects unsafe WebDAV addresses and enforces strong ETags and conditional writes", async () => {
  for (const url of [
    "http://cloud.test/",
    "https://user:password@cloud.test/",
    "https://cloud.test/?token=secret",
  ])
    expect(() => folderUrl(url)).toThrow();
  const requests: RequestInit[] = [];
  const transport = new WebDAV(
    "https://cloud.test/TabSpace",
    "user",
    "app-password",
    (async (_, init) => {
      requests.push(init!);
      if (init?.method === "PROPFIND")
        return new Response(null, { status: 405 });
      return new Response("test", { headers: { ETag: '"v1"' } });
    }) as typeof fetch,
  );
  await transport.read("manifest.json", 4);
  await transport.write("manifest.json", new Uint8Array([1]), '"v1"');
  expect(
    (requests.find((r) => r.method === "PUT")!.headers as any)["If-Match"],
  ).toBe('"v1"');
  expect(requests[0].redirect).toBe("error");
  expect(requests[0].credentials).toBe("omit");
  await expect(transport.read("manifest.json", 2)).rejects.toThrow(
    "safe processing size",
  );
  expect(await digest(new TextEncoder().encode("test"))).toHaveLength(64);
});

it("preserves files referenced by sync recovery and refuses incomplete or corrupted cloud blobs", async () => {
  const space = await create(a, entity("space", "Files"));
  const file = await a.attachment(
    new Blob(["important file"]),
    "important.txt",
  );
  const resource = await create(
    a,
    entity("resource", "File", { spaceId: space.id, attachmentIds: [file.id] }),
  );
  await run(a);
  const path = `blobs/${file.id}-${file.hash}.bin`,
    original = dav.data.get(path)!;
  dav.data.delete(path);
  await expect(run(b)).rejects.toThrow("cloud attachment is incomplete");
  expect(await b.db.entities.get(space.id)).toBeUndefined();
  dav.data.set(path, {
    ...original,
    bytes: new Uint8Array(original.bytes.length),
  });
  await expect(run(b)).rejects.toThrow("decrypt");
  expect(await b.db.attachments.count()).toBe(0);
  dav.data.set(path, original);
  await run(b);
  await a.db.entities.delete(resource.id);
  await a.db.journal.clear();
  await run(a);
  expect((await storageInfo(a)).unusedIds).not.toContain(file.id);
  await cleanUnusedFiles(a, [file.id]);
  expect(await a.db.attachments.get(file.id)).toBeDefined();
});

it("resumes safely after a blob upload succeeds but publishing the manifest fails", async () => {
  const space = await create(a, entity("space", "Retry"));
  const file = await a.attachment(new Blob(["retry file"]), "retry.txt");
  await create(
    a,
    entity("resource", "Retry file", {
      spaceId: space.id,
      attachmentIds: [file.id],
    }),
  );
  const write = dav.write.bind(dav);
  let manifests = 0;
  dav.write = async (path, bytes, etag) => {
    if (path === "manifest.json" && ++manifests > 1) throw new Error("Offline");
    return write(path, bytes, etag);
  };
  await expect(run(a)).rejects.toThrow("Offline");
  expect(dav.data.size).toBe(2);
  dav.write = write;
  expect((await run(a)).synced).toBe(true);
  await run(b);
  expect(await (await b.db.attachments.get(file.id))!.blob.text()).toBe(
    "retry file",
  );
  expect(await a.db.entities.get(space.id)).toBeDefined();
});

it("rejects a replayed cloud manifest rather than rolling a known device backwards", async () => {
  const space = await create(a, entity("space", "Before"));
  await run(a);
  const earlier = dav.data.get("manifest.json")!;
  await rename(a, space.id, "After");
  await run(a);
  dav.data.set("manifest.json", { ...earlier, etag: '"replayed"' });
  await expect(run(a)).rejects.toThrow("history moved backwards");
  expect((await a.db.entities.get(space.id))?.name).toBe("After");
});
