import { z } from "zod";
import { repository as repo } from "../../../../packages/persistence/repository";
import { startDragGroupWorker } from "../../../drag-group/extension/lifecycle.js";
import { validateIntent } from "../../../drag-group/extension/policy.js";
import { applyGesture } from "../../../drag-group/extension/grouping.js";
import { bindDragGroup, live, registerManagerLifecycle } from "./browser";
import { sessionStatus, syncSessions } from "./sessions";
declare const __DRAG_GROUP_STANDALONE_ID__: string;
const controllerPath = "index.html";
const id = z.number().int().nonnegative();
const tabSchema = z
  .object({
    id,
    index: id,
    pinned: z.boolean(),
    groupId: z.number().int().min(-1),
    highlighted: z.boolean(),
  })
  .strict();
const snapshotSchema = z.object({
  windowId: id,
  beaconId: id,
  tabs: z.array(tabSchema).max(100),
});
const contextSchema = z
  .object({ type: z.literal("context"), windowId: id, beaconId: id })
  .strict();
const gestureSchema = z
  .object({
    type: z.literal("gesture"),
    intent: z
      .object({
        protocolVersion: z.literal(1),
        type: z.literal("gesture"),
        session: z.string().uuid(),
        mapId: z.string().min(1).max(200),
        windowId: id,
        sourceId: id,
        targetId: id,
      })
      .strict(),
    capture: snapshotSchema
      .extend({
        mapId: z.string().min(1).max(200),
        capturedAt: z.number().int().nonnegative(),
        epoch: id,
      })
      .strict(),
  })
  .strict();
export function createDragGroupIntegration(
  queue: <T>(job: () => Promise<T>) => Promise<T>,
  notify: () => void,
  collectionBusy: () => boolean = () => false,
) {
  let ready = false,
    epoch = 0;
  const used = new Map<string, number>();
  async function migrateLegacyControllers(windowId?: number) {
    // Convert the previous dedicated controller in place, or retire it when
    // this window already has a manager. Never navigate an unrelated tab.
    const legacy = chrome.runtime.getURL("drag-group/controller.html");
    for (const old of (
      await chrome.tabs.query(windowId === undefined ? {} : { windowId })
    ).filter(
      (t) =>
        t.pinned &&
        t.url?.split(/[?#]/)[0] === legacy &&
        t.pendingUrl?.split(/[?#]/)[0] !==
          chrome.runtime.getURL(controllerPath),
    )) {
      try {
        const managers = (
          await chrome.tabs.query({ windowId: old.windowId })
        ).filter(
          (t) =>
            t.url?.split(/[?#]/)[0] === chrome.runtime.getURL(controllerPath),
        );
        if (managers.length) await chrome.tabs.remove(old.id!);
        else
          await chrome.tabs.update(old.id!, {
            url: chrome.runtime.getURL(controllerPath),
          });
      } catch {
        /* Chrome may temporarily lock a dragged tab; no unrelated tabs are touched. */
      }
    }
  }
  async function managerBlockedReason(windowId: number) {
    if (collectionBusy()) return "Paused while TabSpace imports a backup.";
    if (!ready) return "Starting TabSpace…";
    if (await repo.db.meta.get("session:operation"))
      return "Paused while TabSpace changes its session.";
    if (
      (await sessionStatus()).some((s) => s.windowId === windowId && s.parked)
    )
      return "Preserved window — Drag Group is paused.";
  }
  async function blockedReason(windowId: number) {
    const managerReason = await managerBlockedReason(windowId);
    if (managerReason) return managerReason;
    if (
      !(await chrome.permissions.contains({ permissions: ["nativeMessaging"] }))
    )
      return "Enable Drag Group to grant helper access.";
    const standaloneId =
      typeof __DRAG_GROUP_STANDALONE_ID__ === "string"
        ? __DRAG_GROUP_STANDALONE_ID__
        : "";
    if (
      standaloneId &&
      (await chrome.tabs.query({ windowId })).some(
        (t) =>
          t.url?.split("?")[0] ===
          `chrome-extension://${standaloneId}/controller.html`,
      )
    )
      return "Standalone Drag Group detected. Disable its extension before enabling integration.";
  }
  async function trusted(
    sender: chrome.runtime.MessageSender,
    windowId: number,
    beaconId: number,
  ) {
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab?.id !== beaconId ||
      sender.tab?.windowId !== windowId ||
      sender.tab?.incognito ||
      sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL(controllerPath)
    )
      throw Error("Unverified Drag Group controller.");
    const tab = await chrome.tabs.get(beaconId);
    if (
      !tab.pinned ||
      tab.windowId !== windowId ||
      tab.url?.split(/[?#]/)[0] !== chrome.runtime.getURL(controllerPath)
    )
      throw Error("Controller identity changed.");
    const w = await chrome.windows.get(windowId);
    if (w.incognito || w.type !== "normal")
      throw Error("A normal Chrome window is required.");
    if (!(await repo.settings()).dragGroupEnabled)
      throw Error("Drag Group is paused.");
    const primary = (await chrome.tabs.query({ windowId }))
      .filter(
        (t) =>
          t.url?.split(/[?#]/)[0] === chrome.runtime.getURL(controllerPath),
      )
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.id! - b.id!)[0];
    if (primary?.id !== beaconId)
      throw Error("Another manager handles this window.");
    const reason = await blockedReason(windowId);
    if (reason) throw Error(reason);
  }
  const service = startDragGroupWorker({
    controllerPath,
    reusePages: true,
    preferenceKey: "dragGroupEnabled",
    defaultEnabled: false,
    messagePrefix: "dragGroup:",
    keepPages: async () =>
      !!(await chrome.storage.local.get("autoOpenManager")).autoOpenManager,
    eligible: async (windowId) => {
      const automatic = (await repo.settings()).autoOpenManager;
      if (
        await (automatic
          ? managerBlockedReason(windowId)
          : blockedReason(windowId))
      )
        return false;
      await migrateLegacyControllers(windowId);
      return true;
    },
    blockedReason,
    onPreference: async (enabled) => {
      await repo.initialize();
      invalidate();
      await repo.patchSettings({ dragGroupEnabled: enabled });
      notify();
    },
    onContext: async (raw, sender) => {
      const m = contextSchema.parse(raw);
      await trusted(sender, m.windowId, m.beaconId);
      return { allowed: true, epoch };
    },
    onGesture: async (raw, sender) => {
      const m = gestureSchema.parse(raw);
      await trusted(sender, m.capture.windowId, m.capture.beaconId);
      const ticket = `${m.intent.session}:${m.intent.mapId}`;
      if (used.has(ticket)) throw Error("Gesture already consumed.");
      if (m.capture.epoch !== epoch || m.capture.capturedAt > Date.now())
        throw Error("TabSpace session changed during the gesture.");
      used.set(ticket, Date.now());
      while (used.size > 128) used.delete(used.keys().next().value!);
      return queue(async () => {
        await trusted(sender, m.capture.windowId, m.capture.beaconId);
        const unchanged = () => ready && m.capture.epoch === epoch;
        const groupId = await applyGesture(m.intent, m.capture, {
          enabled: unchanged,
          snapshot: async () => {
            await trusted(sender, m.capture.windowId, m.capture.beaconId);
            const tabs = (
              await chrome.tabs.query({ windowId: m.capture.windowId })
            ).sort((a, b) => a.index - b.index);
            return {
              windowId: m.capture.windowId,
              beaconId: m.capture.beaconId,
              tabs: tabs.map((t) => ({
                id: t.id!,
                index: t.index,
                pinned: t.pinned,
                groupId: t.groupId,
                highlighted: t.highlighted,
              })),
            };
          },
          focused: async () =>
            (await chrome.windows.get(m.capture.windowId)).focused,
          createGroup: async (options) => {
            if (!unchanged())
              throw Error("TabSpace session changed during the gesture.");
            const before = await live();
            const owners = new Set(
              before.tabs
                .filter(
                  (t) =>
                    t.id === m.intent.sourceId || t.id === m.intent.targetId,
                )
                .map((t) => t.spaceId),
            );
            if (owners.size > 1)
              throw Error("Tabs belong to different Spaces.");
            if (!unchanged())
              throw Error("TabSpace session changed during the gesture.");
            const tabs = (
              await chrome.tabs.query({ windowId: m.capture.windowId })
            ).sort((a, b) => a.index - b.index);
            const focused = (await chrome.windows.get(m.capture.windowId))
              .focused;
            validateIntent(
              m.intent,
              m.capture,
              {
                windowId: m.capture.windowId,
                beaconId: m.capture.beaconId,
                tabs,
              },
              focused,
            );
            if (!unchanged())
              throw Error("TabSpace session changed during the gesture.");
            const created = await chrome.tabs.group(options);
            await bindDragGroup(created, [...owners][0]);
            await syncSessions();
            notify();
            return created;
          },
        });
        return { groupId };
      });
    },
  });
  registerManagerLifecycle(service.ensureWindow);
  function invalidate() {
    epoch++;
    void service.invalidate();
  }
  async function sync() {
    const settings = await repo.settings();
    await chrome.storage.local.set({
      dragGroupEnabled: settings.dragGroupEnabled,
      autoOpenManager: settings.autoOpenManager ?? false,
    });
    if (ready) void service.reconcile().catch(() => undefined);
  }
  return {
    invalidate,
    sync,
    initialize: async () => {
      await migrateLegacyControllers();
      ready = true;
      await sync();
    },
  };
}
