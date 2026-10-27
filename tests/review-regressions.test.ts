// Regression coverage for the six defects found in the 2026-10-19 review.
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { APP_VERSION } from "../packages/domain/version";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  entity,
  assertGraph,
  plainDoc,
  browserLabel,
} from "../packages/domain/model";
import { repository as repo } from "../packages/persistence/repository";
import {
  exportBackup,
  importBackup,
  parseBackup,
} from "../packages/persistence/backup";
import {
  browserAction,
  reconcile,
} from "../apps/extension/src/background/browser";

let tabs: {
  id: number;
  windowId: number;
  index: number;
  groupId: number;
  title: string;
  url: string;
  active: boolean;
  pinned: boolean;
  incognito: boolean;
  autoDiscardable: boolean;
  discarded: boolean;
}[];
let groups: {
  id: number;
  windowId: number;
  title: string;
  color: string;
  collapsed: boolean;
}[];
const create = (item: ReturnType<typeof entity>) =>
  repo.execute({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    type: "create",
    entity: item,
  });
beforeEach(async () => {
  await repo.db.delete();
  await repo.db.open();
  await repo.initialize();
  tabs = [
    {
      id: 1,
      windowId: 1,
      index: 0,
      groupId: -1,
      title: "Original",
      url: "https://example.org/a",
      active: true,
      pinned: false,
      incognito: false,
      autoDiscardable: true,
      discarded: false,
    },
  ];
  groups = [];
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://review/${path}` },
    storage: {
      session: {
        get: async () => ({ browserGeneration: "review" }),
        set: async () => {},
      },
    },
    windows: {
      getAll: async () => [{ id: 1, type: "normal", incognito: false }],
    },
    tabs: {
      query: async () => tabs,
      group: async ({
        tabIds,
        groupId,
      }: {
        tabIds: number[];
        groupId?: number;
      }) => {
        const id = groupId ?? groups.length + 10;
        if (groupId === undefined)
          groups.push({
            id,
            windowId: 1,
            title: "",
            color: "blue",
            collapsed: false,
          });
        for (const tab of tabs) if (tabIds.includes(tab.id)) tab.groupId = id;
        return id;
      },
    },
    tabGroups: {
      query: async () => groups,
      update: async (id: number, patch: object) =>
        Object.assign(
          groups.find((group) => group.id === id)!,
          patch,
        ),
    },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await repo.db.delete();
});

it("R1: reconciliation preserves a concurrent committed tag edit", async () => {
  await browserAction("adopt", { ids: [1], spaceId: await repo.inbox() });
  const saved = (await repo.list()).find((item) => item.kind === "savedTab")!;
  tabs[0].title = "Website changed title";
  const get = repo.db.meta.get.bind(repo.db.meta);
  let injected = false;
  const metadata = repo.db.meta as unknown as {
    get(key: string): Promise<{ id: string; value: unknown } | undefined>;
  };
  vi.spyOn(metadata, "get").mockImplementation(async (key: string) => {
    if (key === "tab:review:1" && !injected) {
      injected = true;
      await repo.execute({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "update",
        id: saved.id,
        expectedRevision: saved.revision,
        patch: { tags: ["new committed tag"] },
      });
    }
    return get(key);
  });
  await reconcile();
  expect(injected).toBe(true);
  const after = (await repo.db.entities.get(saved.id))!;
  expect(after.name).toBe("Website changed title");
  expect(after.tags).toEqual(["new committed tag"]);
  expect(after.revision).toBe(saved.revision + 2);
});

it("R2: adopting an owned group into another Space keeps a valid independent logical group", async () => {
  await browserAction("adopt", { ids: [1], spaceId: await repo.inbox() });
  const destination = entity("space", "Destination");
  await create(destination);
  await browserAction("adopt", {
    ids: [1],
    groupId: groups[0].id,
    spaceId: destination.id,
  });
  expect(
    (await repo.list()).find((item) => item.kind === "savedTab")?.spaceId,
  ).toBe(destination.id);
  tabs[0].title = "A later website title update";
  await reconcile();
  const all = await repo.list();
  expect(() => assertGraph(all)).not.toThrow();
  const saved = all.find((item) => item.kind === "savedTab")!;
  expect(saved.spaceId).toBe(destination.id);
  expect(all.find((item) => item.id === saved.groupId)?.spaceId).toBe(
    destination.id,
  );
  await create(
    entity("note", "Unrelated new note", { spaceId: destination.id }),
  );
});

it("R3: backup merge preserves trash and archive state", async () => {
  const archived = entity("space", "Archived project", {
    archivedAt: new Date().toISOString(),
  });
  await create(archived);
  const trashed = entity("note", "Trashed note", {
    spaceId: await repo.inbox(),
    deletedAt: new Date().toISOString(),
  });
  await create(trashed);
  const parsed = await parseBackup(await exportBackup(repo, "json"));
  await importBackup(repo, parsed, "merge");
  const all = await repo.list();
  expect(
    all.find((item) => item.name === archived.name && item.id !== archived.id)
      ?.archivedAt,
  ).toBe(archived.archivedAt);
  expect(
    all.find((item) => item.name === trashed.name && item.id !== trashed.id)
      ?.deletedAt,
  ).toBe(trashed.deletedAt);
});

it("R4: empty attachments round-trip through both JSON and ZIP", async () => {
  const attachment = await repo.attachment(new Blob([]), "empty.txt");
  await create(
    entity("resource", "Empty file", {
      spaceId: await repo.inbox(),
      attachmentIds: [attachment.id],
    }),
  );
  const json = await exportBackup(repo, "json");
  expect((await parseBackup(json)).attachments[0].size).toBe(0);
  const zip = await parseBackup(await exportBackup(repo, "zip"));
  expect(zip.attachments[0].size).toBe(0);
});

it("R5: export captures one coherent snapshot while an independent transaction writes", async () => {
  const settings = repo.settings.bind(repo);
  let injected = false;
  let writer: Promise<void> | undefined;
  vi.spyOn(repo, "settings").mockImplementation(async () => {
    if (!injected) {
      injected = true;
      const note = entity("note", "Created during export", {
        spaceId: await repo.inbox(),
        doc: plainDoc("Draft"),
      });
      writer = Dexie.ignoreTransaction(async () => {
        await create(note);
        await repo.saveDraft({
          id: crypto.randomUUID(),
          noteId: note.id,
          baseRevision: 1,
          doc: plainDoc("New draft"),
          text: "New draft",
          updatedAt: new Date().toISOString(),
        });
      });
    }
    return settings();
  });
  const archive = await exportBackup(repo, "zip");
  await writer;
  expect(injected).toBe(true);
  const parsed = await parseBackup(archive);
  expect(parsed.data.drafts).toHaveLength(0);
  expect(
    parsed.data.entities.some((item) => item.name === "Created during export"),
  ).toBe(false);
  expect(
    (await repo.list()).some((item) => item.name === "Created during export"),
  ).toBe(true);
});

it("R6: a long website title remains bounded and does not block editing", async () => {
  const inbox = await repo.inbox();
  await browserAction("adopt", { ids: [1], spaceId: inbox });
  tabs[0].title = "x".repeat(501);
  await reconcile();
  await repo.list();
  expect(await repo.db.meta.where("id").startsWith("quarantine:").count()).toBe(
    0,
  );
  expect(
    (await repo.list()).find((item) => item.kind === "savedTab")?.name,
  ).toHaveLength(500);
  await create(entity("note", "Unrelated note", { spaceId: inbox }));
});

it("patch-version exports retain schema-1 compatibility with existing 0.1.0 backups", async () => {
  const blob = await exportBackup(repo, "json");
  const current = JSON.parse(await blob.text());
  expect(current.appVersion).toBe(APP_VERSION);
  current.appVersion = "0.1.0";
  const legacy = await parseBackup(new Blob([JSON.stringify(current)]));
  expect(legacy.data.schemaVersion).toBe(1);
  await importBackup(repo, legacy, "replace");
  expect((await repo.list()).some((item) => item.name === "Inbox")).toBe(true);
});

it("R6: long initial tab/group labels remain valid in session backups", async () => {
  tabs[0].title = "😀".repeat(501);
  const inbox = await repo.inbox();
  await browserAction("adopt", { ids: [1], spaceId: inbox });
  groups[0].title = "g".repeat(501);
  await reconcile();
  expect((await repo.list()).every((item) => item.name.length <= 500)).toBe(
    true,
  );
  expect(browserLabel("a" + "😀".repeat(300), "Untitled").length).toBe(499);
  const parsed = await parseBackup(await exportBackup(repo, "zip"));
  expect(
    parsed.data.snapshots.every((snapshot) =>
      snapshot.groups.every((group) => group.title.length <= 500),
    ),
  ).toBe(true);
});

it("R6: upgrades repair only known oversized browser labels and preserve raw evidence", async () => {
  await browserAction("adopt", { ids: [1], spaceId: await repo.inbox() });
  const saved = (await repo.list()).find((item) => item.kind === "savedTab")!;
  await repo.db.entities.put({ ...saved, name: "x".repeat(501) });
  await repo.list();
  await repo.db.meta.delete("repair:browser-labels:v1");
  await repo.initialize();
  expect((await repo.db.entities.get(saved.id))?.name).toHaveLength(500);
  expect(
    (await repo.db.meta.get(`repair:browser-label:${saved.id}`))?.value,
  ).toMatchObject({ record: { name: "x".repeat(501) } });
  expect(await repo.db.meta.get(`quarantine:${saved.id}`)).toBeUndefined();
});

it("R1: an import replacing the collection during refresh cannot resurrect old browser records", async () => {
  const empty = await parseBackup(await exportBackup(repo, "zip"));
  await browserAction("adopt", { ids: [1], spaceId: await repo.inbox() });
  tabs[0].title = "Changed after collection read";
  const get = repo.db.meta.get.bind(repo.db.meta);
  const metadata = repo.db.meta as unknown as {
    get(key: string): Promise<{ id: string; value: unknown } | undefined>;
  };
  let imported = false;
  vi.spyOn(metadata, "get").mockImplementation(async (key: string) => {
    if (key === "tab:review:1" && !imported) {
      imported = true;
      await importBackup(repo, empty, "replace");
    }
    return get(key);
  });
  await reconcile();
  expect(imported).toBe(true);
  const all = await repo.list();
  expect(
    all.some((item) => item.kind === "savedTab" || item.kind === "group"),
  ).toBe(false);
  expect(() => assertGraph(all)).not.toThrow();
});
