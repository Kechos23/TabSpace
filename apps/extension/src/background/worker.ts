import { createDragGroupIntegration } from "./drag-group";
import { createCloudSync } from "./cloud-sync";
import { syncToolbarIcon } from "./theme-icon";
import { managerIconPath } from "../../../../packages/domain/manager-icons";
import { iconIntentFor } from "./manager-icon-intent";
import { z } from "zod";
import type { State } from "../client";
import {
  commandSchema,
  documentSchema,
  entity,
  entitySchema,
  settingsSchema,
  blankDoc,
} from "../../../../packages/domain/model";
import { repository as repo } from "../../../../packages/persistence/repository";
import {
  maintainHistory,
  storageInfo,
  cleanUnusedFiles,
} from "../../../../packages/persistence/maintenance";
import { browserAction, reconcile, generation } from "./browser";
import { spaceTabTree } from "../../../../packages/domain/space-tabs";
import { recoveryPage } from "../../../../packages/persistence/recovery";
import {
  importBackup,
  parseBackup,
} from "../../../../packages/persistence/backup";
import {
  maintainBrowsing,
  restoreStartupBrowsing,
  browsingWindowClosing,
} from "./browsing";
import {
  activateSession,
  setSpaceTabLock,
  closeSession,
  sessionStatus,
  syncSessions,
  acknowledgeSessionFailure,
  recoverParkingWindows,
  registerRecoveredSession,
  moveTabsToSpace,
  editSavedTabs,
  copyTabsToSpace,
  saveWindowAsSpace,
  noteClosingWindow,
  labelTemporarySpaces,
} from "./sessions";

const browserSchema = z
  .object({
    type: z.literal("browser"),
    commandId: z.string().uuid(),
    action: z.enum([
      "open",
      "manager",
      "checkpoint",
      "saveWindowSpace",
      "restoreSession",
      "openSaved",
      "focusSpace",
      "activateSession",
      "setTabLock",
      "closeSession",
      "acknowledgeSessionFailure",
      "moveToSpace",
      "openSavedTabs",
      "moveSavedTabs",
      "copySavedTabs",
      "copyToSpace",
      "removeSavedTabs",
      "duplicateSavedTabs",
      "groupSavedTabs",
      "ungroupSavedTabs",
      "groupUpdate",
      "focus",
      "close",
      "discard",
      "duplicate",
      "pin",
      "mute",
      "move",
      "ungroup",
      "adopt",
      "group",
      "sortTitle",
      "sortDomain",
      "openResources",
      "replaceResources",
      "closeResources",
    ]),
    payload: z
      .object({
        ids: z.array(z.number().int().nonnegative()).max(1000).optional(),
        spaceId: z.string().uuid().optional(),
        collectionId: z.string().uuid().optional(),
        sourceSpaceId: z.string().uuid().optional(),
        savedKeys: z
          .array(z.string().min(1).max(200))
          .min(1)
          .max(1000)
          .optional(),
        resourceId: z.string().uuid().optional(),
        resourceIds: z.array(z.string().uuid()).max(100000).optional(),
        groupId: z.number().int().nonnegative().optional(),
        name: z.string().min(1).max(500).optional(),
        color: z
          .enum([
            "grey",
            "blue",
            "red",
            "yellow",
            "green",
            "pink",
            "purple",
            "cyan",
            "orange",
          ])
          .optional(),
        collapsed: z.boolean().optional(),
        locked: z.boolean().optional(),
        all: z.boolean().optional(),
        windowId: z.number().int().nonnegative().optional(),
        index: z.number().int().min(-1).optional(),
        url: z.string().max(20000).optional(),
        copy: z.boolean().optional(),
        background: z.boolean().optional(),
        snapshotId: z.string().uuid().optional(),
        indices: z.array(z.number().int().nonnegative()).max(100000).optional(),
        newWindow: z.boolean().optional(),
        recoveredSpaceName: z.string().trim().min(1).max(500).optional(),
        replace: z.boolean().optional(),
        restoreWindows: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("load") }).strict(),
  z
    .object({
      type: z.literal("view"),
      recovery: z.boolean(),
      force: z.boolean(),
      knownVersion: z.string().max(10000).optional(),
    })
    .strict(),
  z.object({ type: z.literal("popup") }).strict(),
  z.object({ type: z.literal("managerIcon") }).strict(),
  z
    .object({
      type: z.literal("recoveryList"),
      offset: z.number().int().min(0).max(10000000),
      draftOffset: z.number().int().min(0).max(10000000),
    })
    .strict(),
  z
    .object({ type: z.literal("recoverySnapshot"), id: z.string().uuid() })
    .strict(),
  z
    .object({
      type: z.literal("recoveryDraft"),
      id: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("recoveryProtect"),
      id: z.string().uuid(),
      protected: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("command"), command: commandSchema }).strict(),
  z
    .object({ type: z.literal("ensureSpaceNote"), spaceId: z.string().uuid() })
    .strict(),
  browserSchema,
  z
    .object({
      type: z.literal("draft"),
      draft: z
        .object({
          id: z.string().max(200),
          noteId: z.string().uuid(),
          baseRevision: z.number().int().positive(),
          doc: documentSchema,
          text: z.string().max(2_000_000),
          updatedAt: z.string().datetime(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal("settings"), value: settingsSchema }).strict(),
  z
    .object({
      type: z.literal("settingsPatch"),
      patch: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z.object({ type: z.literal("resetCollection") }).strict(),
  z.object({ type: z.literal("storageInfo") }).strict(),
  z.object({ type: z.literal("cloudSyncStatus") }).strict(),
  z.object({ type: z.literal("cloudSyncSummary") }).strict(),
  z
    .object({
      type: z.literal("cloudSyncConfigure"),
      url: z.string().max(2000),
      username: z.string().min(1).max(200),
      appPassword: z.string().min(1).max(2000),
      passphrase: z.string().min(12).max(2000),
      automatic: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("cloudSyncUnlock"),
      passphrase: z.string().min(12).max(2000),
    })
    .strict(),
  z.object({ type: z.literal("cloudSyncLock") }).strict(),
  z.object({ type: z.literal("cloudSyncDisconnect") }).strict(),
  z
    .object({ type: z.literal("cloudSyncAutomatic"), enabled: z.boolean() })
    .strict(),
  z
    .object({
      type: z.literal("cloudSyncRun"),
      resolution: z
        .object({
          token: z.string().regex(/^[a-f0-9]{64}$/),
          choices: z.record(
            z.string().max(80),
            z.enum(["local", "remote", "both"]),
          ),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("cleanUnusedFiles"),
      ids: z.array(z.string().uuid()).max(100000),
    })
    .strict(),
  z
    .object({
      type: z.literal("importCollection"),
      token: z.string().uuid(),
      mode: z.enum(["merge", "replace"]),
    })
    .strict(),
  z.object({ type: z.literal("helper"), enabled: z.boolean() }).strict(),
]);
let native: chrome.runtime.Port | undefined;
let helperStatus = "Disabled — native gesture feasibility is pending";
let effects: Promise<unknown> = Promise.resolve();
let hydration: Promise<void> | undefined;
let viewEpoch = 0;
let initialView: Promise<unknown> | undefined;
let viewCache: State | undefined;
let importing = false;
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const result = effects.then(job, job);
  effects = result.catch(() => undefined);
  return result;
}
function notifyViews(entities?: State["entities"]) {
  viewEpoch++;
  viewCache = undefined;
  void chrome.runtime
    .sendMessage({ type: "tabspace:changed", entities })
    .catch(() => undefined);
}
const cloudSync = createCloudSync(enqueue, () => notifyViews(), () => syncSessions());
const dragGroup = createDragGroupIntegration(
  enqueue,
  notifyViews,
  () => importing,
);
function hydrate() {
  return (hydration ??= (async () => {
    await repo.initialize();
    await cloudSync.initialize();
    await syncToolbarIcon((await repo.settings()).colorTheme);
    await labelTemporarySpaces();
    await chrome.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    if (!(await chrome.alarms.get("tabspace-checkpoint")))
      await chrome.alarms.create("tabspace-checkpoint", { periodInMinutes: 5 });
    if (!(await chrome.alarms.get("tabspace-history")))
      await chrome.alarms.create("tabspace-history", {
        delayInMinutes: 1,
        periodInMinutes: 60,
      });
    await repo.db.journal
      .where("state")
      .anyOf("planned", "executing")
      .modify((j) => {
        j.state = "uncertain";
      });
    await recoverParkingWindows();
    await restoreStartupBrowsing();
    await syncSessions();
    await maintainBrowsing();
    await dragGroup.initialize();
  })().catch((error) => {
    hydration = undefined;
    throw error;
  }));
}
async function handle(raw: unknown, sourceWindowId?: number) {
  const m = messageSchema.parse(raw);
  if (m.type === "managerIcon") {
    if (sourceWindowId === undefined)
      throw new Error("Manager icon requires its own window.");
    const [settings, inboxId, bindings] = await Promise.all([
      repo.settings(),
      repo.inbox(),
      sessionStatus(),
    ]);
    const id =
      iconIntentFor(sourceWindowId) ??
      bindings.find(
        (binding) => binding.windowId === sourceWindowId && !binding.parked,
      )?.spaceId;
    const record = id
      ? entitySchema.safeParse(await repo.db.entities.get(id))
      : undefined;
    const space = record?.success ? record.data : undefined;
    return {
      light: managerIconPath(settings.colorTheme, space, inboxId, "light"),
      dark: managerIconPath(settings.colorTheme, space, inboxId, "dark"),
    };
  }
  await hydrate();
  if (m.type === "cloudSyncStatus") return cloudSync.status();
  if (m.type === "cloudSyncSummary") return cloudSync.summary();
  if (m.type === "cloudSyncConfigure")
    return cloudSync.configure(
      {
        url: m.url,
        username: m.username,
        appPassword: m.appPassword,
        automatic: m.automatic,
      },
      m.passphrase,
    );
  if (m.type === "cloudSyncUnlock") return cloudSync.unlock(m.passphrase);
  if (m.type === "cloudSyncLock") return cloudSync.lock();
  if (m.type === "cloudSyncDisconnect") return cloudSync.disconnect();
  if (m.type === "cloudSyncAutomatic") return cloudSync.setAutomatic(m.enabled);
  if (m.type === "cloudSyncRun") {
    if (importing)
      throw new Error("Wait for the backup import to finish before syncing.");
    return cloudSync.run(m.resolution);
  }
  if (
    importing &&
    [
      "command",
      "settings",
      "settingsPatch",
      "draft",
      "ensureSpaceNote",
    ].includes(m.type)
  )
    throw new Error(
      "A backup is being imported. Please retry after it finishes.",
    );
  if (m.type === "storageInfo") return storageInfo(repo);
  if (m.type === "cleanUnusedFiles")
    return enqueue(async () => {
      const value = await cleanUnusedFiles(repo, m.ids);
      notifyViews();
      return value;
    });
  if (m.type === "importCollection")
    return enqueue(async () => {
      await cloudSync.pause();
      const id = `pending-import:${m.token}`;
      const stage = (await repo.db.meta.get(id))?.value as
        { file?: Blob } | undefined;
      if (!(stage?.file instanceof Blob))
        throw new Error(
          "The import file is no longer available. Select it again.",
        );
      if (m.mode === "merge" && (await repo.db.meta.get("session:operation")))
        throw new Error(
          "Inspect the interrupted Space operation before merging a backup.",
        );
      importing = true;
      dragGroup.invalidate();
      try {
        const parsed = await parseBackup(stage.file);
        await importBackup(repo, parsed, m.mode);
        initialView = undefined;
        viewCache = undefined;
        if (m.mode === "replace") {
          native?.disconnect();
          native = undefined;
          helperStatus = "Disabled";
        }
        await reconcile("Backup imported");
        await syncSessions();
        await maintainBrowsing();
        await syncToolbarIcon((await repo.settings()).colorTheme);
        initialView = Promise.resolve();
        return true;
      } finally {
        importing = false;
        await repo.db.meta.delete(id);
        await dragGroup.sync();
        notifyViews();
      }
    });
  if (m.type === "recoveryList")
    return recoveryPage(repo.db, m.offset, m.draftOffset);
  if (m.type === "recoverySnapshot") return repo.db.snapshots.get(m.id);
  if (m.type === "recoveryDraft") return repo.db.drafts.get(m.id);
  if (m.type === "recoveryProtect") {
    if (!(await repo.db.snapshots.update(m.id, { protected: m.protected })))
      throw new Error("Checkpoint no longer exists.");
    viewCache = undefined;
    void chrome.runtime
      .sendMessage({ type: "tabspace:recoveryChanged" })
      .catch(() => undefined);
    return true;
  }
  if (m.type === "view") {
    // Only initial hydration and explicit refresh need native reconciliation.
    await (initialView ??= enqueue(() =>
      reconcile("initial manager view"),
    ).catch((error) => {
      initialView = undefined;
      throw error;
    }));
    return enqueue(async () => {
      if (m.force || !(await repo.db.browser.get("browser"))) {
        await reconcile("explicit manager refresh");
        viewCache = undefined;
      }
      const stampData = JSON.stringify([
        viewEpoch,
        helperStatus,
        m.recovery ? crypto.randomUUID() : "normal",
        await repo.db.meta.bulkGet([
          "indexRevision",
          "collectionGeneration",
          "settings",
          "session:registry",
          "session:operation",
        ]),
        (await repo.db.browser.get("browser"))?.updatedAt,
        await repo.db.meta.where("id").startsWith("quarantine:").count(),
      ]);
      const stamp = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(stampData),
          ),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      let cached = viewCache;
      if (
        !cached ||
        cached.viewVersion !== stamp ||
        cached.recoveryLoaded !== m.recovery
      ) {
        const epoch = viewEpoch;
        const sessions = await sessionStatus();
        cached = await repo.db.transaction(
          "rw",
          [
            repo.db.entities,
            repo.db.meta,
            repo.db.browser,
            repo.db.snapshots,
            repo.db.drafts,
          ],
          async () => {
            const entities = await repo.list();
            const browser = (await repo.db.browser.get("browser"))!;
            return {
              entities,
              browser,
              viewVersion: stamp,
              recoveryLoaded: m.recovery,
              collectionGeneration: (
                await repo.db.meta.get("collectionGeneration")
              )?.value as string | undefined,
              spaceTabs: spaceTabTree(
                entities,
                browser,
                await repo.db.meta
                  .where("id")
                  .startsWith("session:checkpoint:")
                  .toArray(),
              ),
              settings: await repo.settings(),
              inboxId: await repo.inbox(),
              helperStatus,
              snapshots: m.recovery
                ? await repo.db.snapshots
                    .orderBy("capturedAt")
                    .reverse()
                    .toArray()
                : [],
              drafts: m.recovery ? await repo.db.drafts.toArray() : [],
              snapshotCount: await repo.db.snapshots.count(),
              draftCount: await repo.db.drafts.count(),
              quarantineCount: await repo.db.meta
                .where("id")
                .startsWith("quarantine:")
                .count(),
              sessions,
              browsingUnresolved:
                ((await repo.db.meta.get("browsing:unresolved"))
                  ?.value as string[]) ?? [],
              sessionInterrupted:
                !!(await repo.db.meta.get("session:operation")),
              windows: [],
            };
          },
        );
        await syncToolbarIcon(cached.settings.colorTheme);
        cached.windows = (
          await chrome.windows.getAll({
            windowTypes: ["normal"],
            populate: true,
          })
        )
          .filter((w) => !w.incognito)
          .map((w) => ({
            id: w.id!,
            tabs: w.tabs?.length ?? 0,
            title: w.tabs?.find((t) => t.active)?.title ?? "Chrome window",
          }));
        if (epoch === viewEpoch) viewCache = cached;
      }
      if (!m.force && m.knownVersion === stamp) return { unchanged: true };
      return {
        ...cached,
        currentWindowId:
          sourceWindowId ??
          (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id,
      };
    });
  }
  if (m.type === "popup") {
    // Toolbar opening needs only Space names/settings, not browser reconciliation,
    // snapshots, rich notes or the serialized browser-operation queue.
    const [rows, settings, inboxId, bindings, window, collections] =
      await Promise.all([
        repo.db.entities.where("kind").equals("space").toArray(),
        repo.settings(),
        repo.inbox(),
        sessionStatus(),
        chrome.windows.getLastFocused({ windowTypes: ["normal"] }),
        repo.db.entities.where("kind").equals("sidebar").toArray(),
      ]);
    const spaces = rows
      .flatMap((row) => {
        const parsed = entitySchema.safeParse(row);
        return parsed.success &&
          !parsed.data.deletedAt &&
          !parsed.data.archivedAt
          ? [parsed.data]
          : [];
      })
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const [activeTab] = await chrome.tabs.query({
      active: true,
      windowId: window.id,
    });
    const current =
      activeTab?.id === undefined
        ? undefined
        : (await repo.db.meta.get(`tab:${await generation()}:${activeTab.id}`))
            ?.value;
    const lockedTab =
      typeof current === "string"
        ? await repo.db.entities.get(current)
        : undefined;
    return {
      spaces,
      collections: collections
        .filter((item) => !item.deletedAt && !item.archivedAt)
        .map(({ id, name }) => ({ id, name })),
      settings,
      inboxId,
      windowId: window.id,
      activeSpaceId: bindings.find((b) => b.windowId === window.id && !b.parked)
        ?.spaceId,
      activeTabId: activeTab?.id,
      canLock:
        !!activeTab &&
        !activeTab.pinned &&
        /^https?:\/\//.test(activeTab.url ?? ""),
      tabLocked: !!lockedTab?.locked,
    };
  }
  if (m.type === "command") {
    const execute = async () => {
      const value = await repo.execute(m.command);
      notifyViews(m.command.type === "presentation" ? value : undefined);
      return value;
    };
    if (
      m.command.type === "duplicate" &&
      (await repo.db.entities.get(m.command.id!))?.kind === "space"
    )
      return enqueue(async () => {
        await reconcile("Before duplicating Space");
        await syncSessions();
        return execute();
      });
    return execute();
  }
  if (m.type === "ensureSpaceNote")
    return enqueue(async () => {
      const space = await repo.db.entities.get(m.spaceId);
      if (
        !space ||
        space.kind !== "space" ||
        space.deletedAt ||
        space.archivedAt
      )
        throw new Error("Choose an available Space.");
      const existing = (await repo.list()).find(
        (e) => e.kind === "note" && e.spaceId === m.spaceId && !e.deletedAt,
      );
      if (existing) return existing;
      const note = entity("note", "Untitled note", {
        spaceId: m.spaceId,
        doc: blankDoc(),
      });
      await repo.execute({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: note,
      });
      notifyViews();
      return note;
    });
  if (m.type === "draft") {
    await repo.saveDraft(m.draft);
    if (viewCache?.recoveryLoaded) viewCache = undefined;
    return true;
  }
  if (m.type === "settings" || m.type === "settingsPatch")
    return enqueue(async () => {
      const wasLockDefault = (await repo.settings()).lockTabsByDefault;
      const value =
        m.type === "settingsPatch"
          ? await repo.patchSettings(m.patch)
          : (await repo.setSettings(m.value), m.value);
      await dragGroup.sync();
      await syncToolbarIcon(value.colorTheme);
      const inbox = await repo.inbox();
      if (!wasLockDefault && value.lockTabsByDefault)
        for (const space of (await repo.list()).filter(
          (item) =>
            item.kind === "space" &&
            !item.temporary &&
            !item.deletedAt &&
            !item.archivedAt &&
            item.id !== inbox,
        ))
          await setSpaceTabLock(space.id, true, [], [], true);
      await maintainBrowsing();
      notifyViews();
      return true;
    });
  if (m.type === "resetCollection")
    return enqueue(async () => {
      await cloudSync.pause();
      dragGroup.invalidate();
      await repo.resetCollection();
      await dragGroup.sync();
      await syncToolbarIcon((await repo.settings()).colorTheme);
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      await maintainBrowsing();
      initialView = undefined;
      viewCache = undefined;
      notifyViews();
      return true;
    });
  if (m.type === "helper") {
    native?.disconnect();
    native = undefined;
    if (m.enabled) {
      if (
        !(await chrome.permissions.contains({
          permissions: ["nativeMessaging"],
        }))
      )
        throw new Error(
          "Enable the optional Native Messaging permission first.",
        );
      helperStatus = "Connecting";
      native = chrome.runtime.connectNative("com.tabspace.native");
      native.onMessage.addListener((raw: unknown) => {
        const status = z
          .object({
            protocolVersion: z.literal(1),
            type: z.enum(["capabilities", "status"]),
            message: z.string().max(300),
            gestureEnabled: z.literal(false),
          })
          .strict()
          .safeParse(raw);
        helperStatus = status.success
          ? status.data.message
          : "Host returned an unsupported protocol message";
      });
      native.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        native = undefined;
        helperStatus = "Disconnected — organizer remains available";
      });
      native.postMessage({
        protocolVersion: 1,
        type: "hello",
        requestId: crypto.randomUUID(),
      });
    } else helperStatus = "Disabled — native gesture feasibility is pending";
    await repo.patchSettings({ helperEnabled: m.enabled });
    return helperStatus;
  }
  if (m.type === "browser") {
    dragGroup.invalidate();
    const job = async () => {
      const existing = await repo.db.journal.get(m.commandId);
      if (existing) {
        if (existing.state === "applied") return true;
        throw new Error(
          "This browser operation has an uncertain or failed outcome. Inspect live tabs before trying a new operation.",
        );
      }
      await repo.db.journal.add({
        id: m.commandId,
        intent: m.action,
        state: "planned",
        createdAt: new Date().toISOString(),
      });
      const journal = (await repo.db.journal.get(m.commandId))!;
      await repo.db.journal.put({ ...journal, state: "executing" });
      try {
        if (m.action === "saveWindowSpace") {
          if (
            m.payload.windowId === undefined ||
            !m.payload.spaceId ||
            !m.payload.name?.trim()
          )
            throw new Error("Choose a window and a Space name.");
          await saveWindowAsSpace(
            m.payload.windowId,
            m.payload.spaceId,
            m.payload.name,
            m.payload.locked ?? (await repo.settings()).lockTabsByDefault,
            m.payload.color,
            m.payload.collectionId,
          );
        } else if (m.action === "setTabLock")
          await setSpaceTabLock(
            m.payload.spaceId!,
            m.payload.locked ?? true,
            m.payload.ids,
            m.payload.savedKeys,
            m.payload.all,
          );
        else if (m.action === "activateSession")
          await activateSession(
            m.payload.spaceId!,
            m.payload.windowId ?? sourceWindowId,
            m.payload.newWindow,
          );
        else if (m.action === "closeSession")
          await closeSession(m.payload.spaceId!);
        else if (m.action === "acknowledgeSessionFailure")
          await acknowledgeSessionFailure();
        else if (
          m.action === "openSavedTabs" ||
          m.action === "moveSavedTabs" ||
          m.action === "copySavedTabs" ||
          m.action === "removeSavedTabs" ||
          m.action === "duplicateSavedTabs" ||
          m.action === "groupSavedTabs" ||
          m.action === "ungroupSavedTabs"
        )
          await editSavedTabs(
            m.action,
            m.payload.sourceSpaceId!,
            m.payload.savedKeys ?? [],
            m.payload.spaceId,
            sourceWindowId,
            m.payload.background,
          );
        else if (m.action === "copyToSpace")
          await copyTabsToSpace(m.payload.ids ?? [], m.payload.spaceId!);
        else if (m.action === "moveToSpace")
          await moveTabsToSpace(m.payload.ids ?? [], m.payload.spaceId!);
        else {
          const recoveredWindow =
            m.action === "restoreSession" &&
            !!m.payload.recoveredSpaceName &&
            !m.payload.replace &&
            !m.payload.restoreWindows;
          let destination = m.payload.windowId;
          if (m.action === "open" && m.payload.spaceId) {
            await activateSession(
              m.payload.spaceId,
              destination ?? sourceWindowId,
            );
            destination = (await sessionStatus()).find(
              (b) => b.spaceId === m.payload.spaceId && !b.parked,
            )?.windowId;
          }
          const result = await browserAction(m.action, {
            ...m.payload,
            newWindow: recoveredWindow || m.payload.newWindow,
            windowId:
              destination ??
              (["open", "openSaved", "restoreSession"].includes(m.action) &&
              !m.payload.newWindow &&
              !recoveredWindow &&
              !m.payload.restoreWindows
                ? sourceWindowId
                : undefined),
          });
          if (m.action === "restoreSession")
            await registerRecoveredSession(result);
        }
        await maintainBrowsing();
        await repo.db.journal.put({ ...journal, state: "applied" });
        notifyViews();
        return true;
      } catch {
        await repo.db.journal.put({
          ...journal,
          state: "failed",
          error:
            "Browser operation failed; inspect actual tabs before retrying.",
        });
        throw new Error(
          "Chrome could not complete this operation. Refresh live tabs before retrying; some changes may have applied.",
        );
      }
    };
    return enqueue(job);
  }
  return enqueue(async () => {
    const browser = await reconcile("view refresh");
    const entities = await repo.list();
    return {
      entities,
      spaceTabs: spaceTabTree(
        entities,
        browser,
        await repo.db.meta
          .where("id")
          .startsWith("session:checkpoint:")
          .toArray(),
      ),
      settings: await repo.settings(),
      browser,
      snapshots: await repo.db.snapshots
        .orderBy("capturedAt")
        .reverse()
        .toArray(),
      drafts: await repo.db.drafts.toArray(),
      helperStatus,
      inboxId: await repo.inbox(),
      quarantineCount: await repo.db.meta
        .where("id")
        .startsWith("quarantine:")
        .count(),
      sessions: await sessionStatus(),
      browsingUnresolved:
        ((await repo.db.meta.get("browsing:unresolved"))?.value as string[]) ??
        [],
      sessionInterrupted: !!(await repo.db.meta.get("session:operation")),
      currentWindowId:
        sourceWindowId ??
        (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id,
      windows: (
        await chrome.windows.getAll({ windowTypes: ["normal"], populate: true })
      )
        .filter((w) => !w.incognito)
        .map((w) => ({
          id: w.id!,
          tabs: w.tabs?.length ?? 0,
          title: w.tabs?.find((t) => t.active)?.title ?? "Chrome window",
        })),
    };
  });
}
// Register synchronously before opening any database or awaiting hydration.
chrome.runtime.onMessage.addListener((raw: unknown, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.tab?.incognito ||
    !sender.url?.startsWith(chrome.runtime.getURL(""))
  )
    return false;
  if (
    ["tabspace:changed", "tabspace:iconChanged"].includes(
      (raw as { type?: string })?.type ?? "",
    )
  )
    return false;
  if (
    typeof (raw as { type?: unknown })?.type === "string" &&
    (raw as { type: string }).type.startsWith("dragGroup:")
  )
    return false;
  handle(raw, sender.tab?.windowId)
    .then((value) => respond({ ok: true, value }))
    .catch((error) =>
      respond({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not save. Your edit remains available.",
      }),
    );
  return true;
});
let eventTimer: ReturnType<typeof setTimeout> | undefined;
let eventQueued = false;
let eventDirty = false;
const attachedWindows = new Set<number>();
const checkpoint = () => {
  eventDirty = true;
  if (eventQueued || eventTimer) return;
  eventTimer = setTimeout(() => {
    eventTimer = undefined;
    eventQueued = true;
    void enqueue(async () => {
      eventDirty = false;
      const destinations = [...attachedWindows];
      attachedWindows.clear();
      await hydrate();
      await syncSessions();
      for (const windowId of destinations) await syncSessions(windowId);
      await reconcile();
      await maintainBrowsing();
      notifyViews();
    })
      .catch(() => undefined)
      .finally(() => {
        eventQueued = false;
        if (eventDirty) checkpoint();
      });
  }, 100);
};
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.incognito) return;
  checkpoint();
  if (!tab.openerTabId || tab.pinned) return;
  void (async () => {
    await hydrate();
    if (
      (await repo.settings()).inheritOpener &&
      tab.openerTabId &&
      !tab.pinned
    ) {
      await enqueue(async () => {
        const prior = await repo.db.browser.get("browser");
        const parent = prior?.tabs.find((t) => t.id === tab.openerTabId);
        if (parent?.spaceId && parent.groupId >= 0)
          await browserAction("adopt", {
            ids: [tab.id!],
            spaceId: parent.spaceId,
            groupId: parent.groupId,
          });
      });
    }
  })().catch(() => undefined);
});
chrome.tabs.onUpdated.addListener(checkpoint);
chrome.tabs.onMoved.addListener(checkpoint);
chrome.tabs.onRemoved.addListener((_id, info) => {
  if (info.isWindowClosing) {
    noteClosingWindow(info.windowId);
    browsingWindowClosing(info.windowId);
  }
  checkpoint();
});
chrome.tabs.onActivated.addListener(checkpoint);
chrome.tabs.onAttached.addListener((_id, info) => {
  attachedWindows.add(info.newWindowId);
  checkpoint();
});
chrome.tabs.onDetached.addListener(checkpoint);
chrome.tabs.onReplaced.addListener(checkpoint);
chrome.tabGroups.onCreated.addListener(checkpoint);
chrome.tabGroups.onUpdated.addListener(checkpoint);
chrome.tabGroups.onMoved.addListener(checkpoint);
chrome.tabGroups.onRemoved.addListener(checkpoint);
chrome.windows.onRemoved.addListener(
  (id) => {
    noteClosingWindow(id);
    browsingWindowClosing(id);
    checkpoint();
    setTimeout(checkpoint, 2700);
  },
  { windowTypes: ["normal"] },
);
chrome.windows.onFocusChanged.addListener(checkpoint, {
  windowTypes: ["normal"],
});
chrome.windows.onCreated.addListener(checkpoint, { windowTypes: ["normal"] });
async function bootstrap() {
  await hydrate();
  await reconcile("startup reconciliation");
}
chrome.runtime.onStartup.addListener(() => {
  void bootstrap().catch(() => undefined);
});
chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await bootstrap();
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: "save-resource",
      title: "Save to TabSpace Inbox",
      contexts: ["page", "link"],
    });
    chrome.contextMenus.create({
      id: "add-task",
      title: "Add task to TabSpace Inbox",
      contexts: ["page"],
    });
  })().catch(() => undefined);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tabspace-sync")
    void hydrate()
      .then(() => (importing ? undefined : cloudSync.automatic()))
      .catch(() => undefined);
  if (alarm.name === "tabspace-history")
    void hydrate()
      .then(async () => {
        await maintainHistory(repo, (await repo.settings()).retentionDays);
      })
      .catch(() => undefined);
  if (alarm.name === "tabspace-checkpoint")
    void enqueue(async () => {
      await hydrate();
      await syncSessions();
      await maintainBrowsing();
      await reconcile("periodic checkpoint");
      notifyViews();
    }).catch(() => undefined);
});
chrome.commands.onCommand.addListener((command) => {
  void (async () => {
    await repo.initialize();
    if (command === "open-manager") await browserAction("manager", {});
    if (command === "save-tab") {
      const [tab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (tab && !tab.incognito && tab.url) {
        const item = entity("resource", tab.title || "Saved link", {
          spaceId: await repo.inbox(),
          url: tab.url,
          titleMode: "auto",
        });
        await repo.execute({
          schemaVersion: 1,
          commandId: crypto.randomUUID(),
          type: "create",
          entity: item,
        });
      }
    }
  })().catch(() => undefined);
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.incognito) return;
  void (async () => {
    await repo.initialize();
    const url = info.linkUrl || tab?.url;
    if (!url) return;
    const item = entity(
      info.menuItemId === "add-task" ? "task" : "resource",
      tab?.title || "Saved link",
      {
        spaceId: await repo.inbox(),
        ...(info.menuItemId === "add-task"
          ? { description: url }
          : { url, titleMode: "auto" as const }),
      },
    );
    await repo.execute({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "create",
      entity: item,
    });
  })().catch(() => undefined);
});
