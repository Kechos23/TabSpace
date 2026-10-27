import { repository as repo } from "../../../../packages/persistence/repository";
import { synchronize, type Choices } from "../../../../packages/sync/engine";
import { WebDAV, folderUrl } from "../../../../packages/sync/webdav";
import type { CloudSyncSummary } from "../../../../packages/sync/status";

const CONFIG = "cloudSync",
  SECRET = "cloudSyncPassphrase";
type Config = {
  url: string;
  username: string;
  appPassword: string;
  automatic: boolean;
  lastSynced?: string;
};
export function createCloudSync(
  queue: <T>(job: () => Promise<T>) => Promise<T>,
  changed: () => void,
  prepare: () => Promise<unknown> = async () => undefined,
) {
  let running: Promise<unknown> | undefined,
    error = "";
  let changing = false;
  const config = async () =>
    (await chrome.storage.local.get(CONFIG))[CONFIG] as Config | undefined;
  const phrase = async () =>
    (await chrome.storage.session.get(SECRET))[SECRET] as string | undefined;
  const origin = (url: string) => {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/*`;
  };
  async function status() {
    const value = await config();
    return {
      configured: !!value,
      url: value?.url,
      hasAccess: value
        ? await chrome.permissions.contains({ origins: [origin(value.url)] })
        : false,
      automatic: value?.automatic ?? false,
      unlocked: !!(await phrase()),
      running: !!running || changing,
      lastSynced: value?.lastSynced,
      error,
      review: (await repo.db.meta.get("sync:conflicts"))?.value,
    };
  }
  async function run(resolution?: { token: string; choices: Choices }) {
    if (running || changing)
      throw new Error("A sync operation is already running.");
    error = "";
    running = (async () => {
      // A multi-file user operation can exceed the MV3 idle deadline. Keep only
      // this active operation alive with an extension API call; always stop it.
      const heartbeat = setInterval(() => {
        void chrome.runtime?.getPlatformInfo().catch(() => undefined);
      }, 20000);
      try {
        const value = await config(),
          passphrase = await phrase();
        if (!value || !passphrase)
          throw new Error("Unlock cloud sync in Settings first.");
        if (
          !(await chrome.permissions.contains({ origins: [origin(value.url)] }))
        )
          throw new Error("Grant access to the configured sync server first.");
        const target = `${value.url}|${value.username}`;
        await queue(prepare);
        const result = await synchronize(
          repo,
          new WebDAV(value.url, value.username, value.appPassword),
          target,
          passphrase,
          queue,
          resolution,
        );
        if (result.synced) {
          await chrome.storage.local.set({
            [CONFIG]: { ...value, lastSynced: new Date().toISOString() },
          });
          changed();
        }
      } catch (e) {
        error =
          e instanceof Error
            ? e.message
            : "Sync failed. Local data is preserved.";
        throw new Error(error);
      } finally {
        clearInterval(heartbeat);
        running = undefined;
      }
    })();
    await running;
    return status();
  }
  async function change(job: () => Promise<void>) {
    if (running || changing)
      throw new Error("Wait for the current sync operation to finish.");
    changing = true;
    try {
      await job();
      error = "";
    } finally {
      changing = false;
    }
    return status();
  }
  return {
    status,
    async summary(): Promise<CloudSyncSummary> {
      const value = await status();
      return {
        configured: value.configured,
        hasAccess: value.hasAccess,
        automatic: value.automatic,
        unlocked: value.unlocked,
        running: value.running,
        lastSynced: value.lastSynced,
        needsAttention: !!value.error,
        hasConflicts: !!value.review,
      };
    },
    run,
    async initialize() {
      if ((await config()) && !(await chrome.alarms.get("tabspace-sync")))
        await chrome.alarms.create("tabspace-sync", { periodInMinutes: 5 });
    },
    configure: (value: Config, passphrase: string) =>
      change(async () => {
        const url = folderUrl(value.url);
        new WebDAV(url, value.username, value.appPassword);
        if (passphrase.length < 12)
          throw new Error("Use a sync passphrase of at least 12 characters.");
        if (!(await chrome.permissions.contains({ origins: [origin(url)] })))
          throw new Error("Server access was not granted.");
        await chrome.storage.local.set({ [CONFIG]: { ...value, url } });
        await chrome.storage.session.set({ [SECRET]: passphrase });
        await repo.db.meta.delete("sync:conflicts");
        await chrome.alarms.create("tabspace-sync", { periodInMinutes: 5 });
      }),
    unlock: (passphrase: string) =>
      change(async () => {
        if (passphrase.length < 12)
          throw new Error(
            "Enter the sync passphrase used on your other device.",
          );
        await chrome.storage.session.set({ [SECRET]: passphrase });
      }),
    lock: () =>
      change(async () => {
        await chrome.storage.session.remove(SECRET);
      }),
    setAutomatic: (automatic: boolean) =>
      change(async () => {
        const value = await config();
        if (!value) throw new Error("Connect cloud sync first.");
        await chrome.storage.local.set({ [CONFIG]: { ...value, automatic } });
      }),
    pause: () =>
      change(async () => {
        const value = await config();
        if (value)
          await chrome.storage.local.set({
            [CONFIG]: { ...value, automatic: false },
          });
        await chrome.storage.session.remove(SECRET);
      }),
    disconnect: () =>
      change(async () => {
        const value = await config();
        await chrome.storage.local.remove(CONFIG);
        await chrome.storage.session.remove(SECRET);
        if (value)
          await chrome.permissions
            .remove({ origins: [origin(value.url)] })
            .catch(() => false);
        await chrome.alarms.clear("tabspace-sync");
        await repo.db.meta.delete("sync:conflicts");
      }),
    async automatic() {
      if (
        !running &&
        !changing &&
        (await config())?.automatic &&
        (await phrase())
      )
        await run().catch(() => undefined);
    },
  };
}
