import { sameMembers, sameOrder } from "./policy.js";
import { applyGesture } from "./grouping.js";
export async function startDragGroupController(dragConfig) {
  const documentUI = !dragConfig.manager;
  const fields = {};
  const $ = (id) =>
    documentUI ? document.getElementById(id) : (fields[id] ??= {});
  $("identity").textContent = chrome.runtime.id;
  $("version").textContent = chrome.runtime.getManifest().version;
  const captures = new Map();
  const request = (type, data = {}) =>
    chrome.runtime.sendMessage({
      type: dragConfig.messagePrefix + type,
      ...data,
    });
  function trace(message) {
    if (!documentUI) return;
    $("gesture").textContent = message;
    const item = document.createElement("li");
    item.textContent = new Date().toLocaleTimeString() + " · " + message;
    $("trace").prepend(item);
    while ($("trace").children.length > 12)
      $("trace").lastElementChild.remove();
  }
  let port,
    nonce,
    timer,
    refreshTimer,
    sending = Promise.resolve(),
    accepted,
    session,
    busy = false,
    stopped = true;
  let desiredEnabled = false,
    closing = false,
    retryTimer,
    retryDelay = 1000,
    generation = 0;
  const context = await chrome.tabs.getCurrent();
  if (!context?.id || context.incognito)
    throw new Error("A normal controller tab is required.");
  const windowId = context.windowId,
    beaconId = context.id;
  const stateText = (text) => {
    $("status").textContent = text;
  };
  const snapshot = async () => {
    const window = await chrome.windows.get(windowId);
    if (window.incognito || window.type !== "normal")
      throw new Error("Use a normal window.");
    const gate = dragConfig.integrated
      ? await request("context", { windowId, beaconId })
      : undefined;
    if (gate?.error || gate?.allowed === false)
      throw new Error(
        gate.error || "TabSpace is busy; drag grouping is paused.",
      );
    const tabs = (await chrome.tabs.query({ windowId })).sort(
      (a, b) => a.index - b.index,
    );
    if (!tabs.some((t) => t.id === beaconId && t.pinned))
      throw new Error("Keep the controller pinned in its original window.");
    return {
      windowId,
      beaconId,
      ...(gate ? { epoch: gate.epoch } : {}),
      tabs: tabs.map((t) => ({
        id: t.id,
        index: t.index,
        pinned: t.pinned,
        groupId: t.groupId,
        highlighted: t.highlighted,
      })),
    };
  };
  function transmit(message) {
    if (port && !stopped)
      port.postMessage({ protocolVersion: 1, session, ...message });
  }
  async function update() {
    if (stopped || !nonce) return;
    const { epoch, ...state } = await snapshot();
    if (accepted && !sameMembers(accepted.tabs, state.tabs)) {
      accepted = undefined;
      captures.clear();
    }
    transmit({ type: "snapshot", nonce, ...state });
  }
  function schedule() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      sending = sending.then(update).catch((e) => {
        stateText(e.message);
        disable();
        if (dragConfig.integrated) reconnectLater();
      });
    }, 60);
  }
  function disable() {
    generation++;
    clearTimeout(retryTimer);
    stopped = true;
    clearInterval(timer);
    clearTimeout(refreshTimer);
    accepted = undefined;
    captures.clear();
    nonce = undefined;
    if (port) {
      try {
        port.postMessage({ protocolVersion: 1, type: "shutdown", session });
      } catch {}
      port.disconnect();
      port = undefined;
    }
    document.title = dragConfig.manager ? "TabSpace" : "Drag Group controller";
    $("enable").disabled = false;
    $("disable").disabled = true;
  }
  function reconnectLater() {
    if (!desiredEnabled || closing) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (desiredEnabled && !closing) void enable();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  }
  async function group(message) {
    if (busy || stopped || message.session !== session) return;
    const capture = captures.get(message.mapId);
    if (!capture) {
      trace(
        "Grouping cancelled: the native gesture has no matching acknowledged map.",
      );
      return;
    }
    busy = true;
    captures.delete(message.mapId);
    accepted = undefined;
    try {
      await applyGesture(message, capture, {
        snapshot,
        focused: async () => (await chrome.windows.get(windowId)).focused,
        enabled: () => !stopped,
        createGroup: async (options) => {
          if (!dragConfig.integrated) return chrome.tabs.group(options);
          const result = await request("gesture", { intent: message, capture });
          if (result.error) throw new Error(result.error);
          return result.groupId;
        },
      });
      $("result").textContent =
        "Created a real Chrome group from the two intended tabs.";
      trace("Chrome confirmed the new group.");
      transmit({ type: "result", ok: true });
    } catch (e) {
      $("result").textContent = `Grouping cancelled: ${e.message}`;
      trace(`Grouping cancelled: ${e.message}`);
      transmit({ type: "result", ok: false });
    } finally {
      busy = false;
      schedule();
    }
  }
  async function enable() {
    if (!stopped || closing || !desiredEnabled) return;
    disable();
    stopped = false;
    const attempt = generation;
    session = crypto.randomUUID();
    $("enable").disabled = true;
    $("disable").disabled = false;
    try {
      if (dragConfig.manager) {
        const registration = await request("controllerReady");
        if (registration.error) throw Error(registration.error);
        if (!registration.primary || !registration.enabled) {
          disable();
          stateText(
            registration.enabled
              ? "Another manager handles this window."
              : "Paused in all windows.",
          );
          return;
        }
      }
      await chrome.tabs.update(beaconId, {
        pinned: true,
        autoDiscardable: false,
      });
      if (stopped || attempt !== generation) return;
      await snapshot();
      if (stopped || attempt !== generation) return;
      port = chrome.runtime.connectNative("com.tabspace.draggroup");
      const connection = port;
      port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError?.message;
        if (connection !== port) return;
        disable();
        stateText(error ? `Helper unavailable: ${error}` : "Helper stopped.");
        reconnectLater();
      });
      port.onMessage.addListener((message) => {
        void (async () => {
          if (
            message.protocolVersion !== 1 ||
            message.session !== session ||
            stopped
          )
            return;
          if (
            message.type === "challenge" &&
            /^[a-f0-9]{32}$/.test(message.nonce)
          ) {
            if (message.build !== dragConfig.expectedHelperBuild) {
              disable();
              stateText(
                "Extension/helper versions differ. Reload the extension, close the old controller, then Enable again.",
              );
              return;
            }
            nonce = message.nonce;
            retryDelay = 1000;
            document.title = dragConfig.manager
              ? `TabSpace · DG:${nonce}`
              : `DG:${nonce}`;
            await update();
            timer = setInterval(() => schedule(), 750);
          } else if (message.type === "status") stateText(message.message);
          else if (message.type === "requestSnapshot") {
            sending = sending.then(update).catch((e) => {
              stateText(e.message);
              disable();
              if (dragConfig.integrated) reconnectLater();
            });
          } else if (message.type === "trace") trace(message.message);
          else if (message.type === "mapped") {
            const current = await snapshot();
            if (
              !sameOrder(message.tabs, current.tabs) ||
              message.windowId !== windowId
            ) {
              schedule();
              return;
            }
            accepted = {
              ...current,
              mapId: message.mapId,
              capturedAt: Date.now(),
              tabs: message.tabs,
            };
            captures.set(message.mapId, accepted);
            while (captures.size > 16)
              captures.delete(captures.keys().next().value);
            transmit({ type: "mapAck", mapId: message.mapId });
          } else if (message.type === "gesture") await group(message);
        })().catch((e) => {
          if (connection !== port) return;
          disable();
          stateText(e.message);
          reconnectLater();
        });
      });
      transmit({ type: "hello" });
      stateText("Connecting to local helper…");
    } catch (e) {
      if (attempt !== generation) return;
      disable();
      stateText(e.message);
      reconnectLater();
    }
  }
  $("enable").onclick = () => request("setEnabled", { enabled: true });
  $("disable").onclick = () => request("setEnabled", { enabled: false });
  function applyPreference(value) {
    desiredEnabled = value;
    if (value) void enable();
    else {
      disable();
      stateText("Paused in all windows. Automatic operation is off.");
    }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[dragConfig.preferenceKey])
      applyPreference(changes[dragConfig.preferenceKey].newValue === true);
  });
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (
      dragConfig.manager &&
      message.type === dragConfig.messagePrefix + "recheckController" &&
      message.tabId === beaconId
    ) {
      if (stopped || message.enabled === false)
        applyPreference(message.enabled === true);
    }
    if (message.type === dragConfig.messagePrefix + "invalidate") {
      disable();
      stateText("Paused while TabSpace updates its session.");
      reconnectLater();
    }
    if (
      message.type === dragConfig.messagePrefix + "getWindowStatus" &&
      message.windowId === windowId &&
      (message.tabId === undefined || message.tabId === beaconId)
    ) {
      reply({
        windowId,
        tabId: beaconId,
        status: $("status").textContent,
        running: !stopped,
      });
    }
  });
  $("fixtures").onclick = async () => {
    $("fixtures").disabled = true;
    try {
      for (const name of ["A", "B"])
        await chrome.tabs.create({
          windowId,
          url: new URL(`fixture.html?name=${name}`, location.href).href,
          active: false,
        });
    } finally {
      $("fixtures").disabled = false;
    }
  };
  for (const event of [
    chrome.tabs.onCreated,
    chrome.tabs.onRemoved,
    chrome.tabs.onMoved,
    chrome.tabs.onAttached,
    chrome.tabs.onDetached,
    chrome.tabs.onUpdated,
    chrome.tabs.onHighlighted,
    chrome.tabGroups.onUpdated,
  ])
    event.addListener(schedule);
  addEventListener("pagehide", () => {
    closing = true;
    disable();
  });
  try {
    const registration = await request("controllerReady");
    if (registration.error) throw new Error(registration.error);
    if (registration.primary) applyPreference(registration.enabled);
  } catch (error) {
    stateText(error.message);
  }
}
