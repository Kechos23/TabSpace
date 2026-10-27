import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { repository } from "../packages/persistence/repository";
import { synchronize } from "../packages/sync/engine";
import { createCloudSync } from "../apps/extension/src/background/cloud-sync";
vi.mock("../packages/sync/engine", () => ({ synchronize: vi.fn() }));
let local: Record<string, unknown>, session: Record<string, unknown>;
const queue = async <T>(job: () => Promise<T>) => job();
const settings = {
  url: "https://cloud.test/dav/TabSpace/",
  username: "test",
  appPassword: "test-app-password",
  automatic: false,
};
const passphrase = "test passphrase only";
it("projects read-only popup status without server details or conflict contents", async () => {
  const sync = createCloudSync(queue, () => undefined);
  expect((await sync.summary()).configured).toBe(false);
  await sync.configure(settings, passphrase);
  await repository.db.meta.put({
    id: "sync:conflicts",
    value: { privateContent: "private document" },
  });
  const summary = await sync.summary();
  expect(summary).toEqual({
    configured: true,
    hasAccess: true,
    automatic: false,
    unlocked: true,
    running: false,
    lastSynced: undefined,
    needsAttention: false,
    hasConflicts: true,
  });
  for (const privateValue of [
    settings.url,
    settings.username,
    settings.appPassword,
    passphrase,
    "private document",
  ])
    expect(JSON.stringify(summary)).not.toContain(privateValue);
  expect(synchronize).not.toHaveBeenCalled();
  await sync.lock();
  expect((await sync.summary()).unlocked).toBe(false);
});
beforeEach(async () => {
  local = {};
  session = {};
  const store = (data: Record<string, unknown>) => ({
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (patch: Record<string, unknown>) => Object.assign(data, patch),
    remove: async (key: string) => {
      delete data[key];
    },
  });
  vi.stubGlobal("chrome", {
    storage: { local: store(local), session: store(session) },
    permissions: {
      contains: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    },
    alarms: {
      create: vi.fn(async () => undefined),
      clear: vi.fn(async () => true),
      get: vi.fn(async () => undefined),
    },
  });
  await repository.db.open();
  await repository.initialize();
  vi.mocked(synchronize).mockReset();
});
afterEach(async () => {
  await repository.db.delete();
  vi.unstubAllGlobals();
});

it("keeps app credentials out of status and local DB metadata, and forgets the passphrase when locked", async () => {
  const sync = createCloudSync(queue, () => undefined);
  await sync.configure(settings, passphrase);
  expect(chrome.permissions.contains).toHaveBeenCalledWith({
    origins: ["https://cloud.test/*"],
  });
  expect(JSON.stringify(await sync.status())).not.toContain(passphrase);
  expect(JSON.stringify(await repository.db.meta.toArray())).not.toContain(
    "test-app-password",
  );
  expect(session.cloudSyncPassphrase).toBe(passphrase);
  await sync.lock();
  expect(session.cloudSyncPassphrase).toBeUndefined();
  await expect(sync.run()).rejects.toThrow("Unlock");
  expect(synchronize).not.toHaveBeenCalled();
});

it("reserves sync before its first await, preventing reset/configuration/disconnect races", async () => {
  const sync = createCloudSync(queue, () => undefined);
  await sync.configure(settings, passphrase);
  let finish!: (value: any) => void;
  vi.mocked(synchronize).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = sync.run();
  await expect(sync.run()).rejects.toThrow("already running");
  await expect(sync.pause()).rejects.toThrow("Wait");
  await expect(sync.disconnect()).rejects.toThrow("Wait");
  await expect(sync.unlock(passphrase)).rejects.toThrow("Wait");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  finish({ synced: true, spaces: 1 });
  await pending;
  expect((await sync.status()).running).toBe(false);
  await sync.pause();
  expect((await sync.status()).automatic).toBe(false);
  expect((await sync.status()).unlocked).toBe(false);
});

it("does not store credentials before permission approval and leaves data intact on disconnect", async () => {
  const sync = createCloudSync(queue, () => undefined);
  (chrome.permissions.contains as any).mockResolvedValueOnce(false);
  await expect(sync.configure(settings, passphrase)).rejects.toThrow(
    "not granted",
  );
  expect(local.cloudSync).toBeUndefined();
  await sync.configure(settings, passphrase);
  await sync.setAutomatic(true);
  expect((await sync.status()).automatic).toBe(true);
  await repository.db.meta.put({
    id: "sync:base:target",
    value: { retained: true },
  });
  const count = await repository.db.entities.count();
  await sync.disconnect();
  expect(local.cloudSync).toBeUndefined();
  expect(await repository.db.entities.count()).toBe(count);
  expect(await repository.db.meta.get("sync:base:target")).toBeDefined();
});

it("refreshes browsing through the same serialized preparation for manual and automatic sync", async () => {
  const order: string[] = [];
  const sync = createCloudSync(
    queue,
    () => undefined,
    async () => {
      order.push("capture browsing");
    },
  );
  await sync.configure({ ...settings, automatic: true }, passphrase);
  vi.mocked(synchronize).mockImplementation(async () => {
    order.push("sync library");
    return { synced: true, spaces: 0 };
  });
  await sync.run();
  await sync.automatic();
  expect(order).toEqual([
    "capture browsing",
    "sync library",
    "capture browsing",
    "sync library",
  ]);
});

it("reports revoked server access without exposing or deleting the saved connection", async () => {
  const sync = createCloudSync(queue, () => undefined);
  await sync.configure(settings, passphrase);
  (chrome.permissions.contains as any).mockResolvedValue(false);
  const status = await sync.status();
  expect(status.configured).toBe(true);
  expect(status.hasAccess).toBe(false);
  await expect(sync.run()).rejects.toThrow("Grant access");
  expect(synchronize).not.toHaveBeenCalled();
});
