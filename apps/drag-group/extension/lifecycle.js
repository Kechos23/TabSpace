// One lifecycle implementation for standalone Drag Group and TabSpace.
export function startDragGroupWorker({
  controllerPath = "controller.html",
  reusePages = false,
  preferenceKey = "enabled",
  defaultEnabled = true,
  messagePrefix = "",
  eligible = async () => true,
  blockedReason = async () => undefined,
  keepPages = async () => false,
  onPreference = async () => {},
  onContext,
  onGesture,
} = {}) {
  const controllerUrl = chrome.runtime.getURL(controllerPath);
  const pending = new Map();
  const retiring = new Set();
  let lifecycle = Promise.resolve();
  const enqueue = (operation) => {
    lifecycle = lifecycle.then(operation).catch(console.error);
  };
  // Session storage survives worker suspension, but never browser-session restore.
  // Eligibility requires the same tab's detach AND attach into a newly born window.
  async function markTearOut(tabId, windowId) {
    const birthKey = `born:${windowId}`;
    const attachKey = `attached:${windowId}`;
    if (tabId !== undefined) {
      const key = `detached:${tabId}`;
      const detached = (await chrome.storage.session.get(key))[key];
      await chrome.storage.session.remove(key);
      if (!detached || Date.now() - detached.at > 10000) return;
      if (detached.controller) return;
      await chrome.storage.session.set({
        [attachKey]: { at: Date.now(), tabId },
      });
    }
    const birth = (await chrome.storage.session.get(birthKey))[birthKey];
    const attached = (await chrome.storage.session.get(attachKey))[attachKey];
    if (
      birth &&
      attached &&
      Math.abs(birth.at - attached.at) < 10000 &&
      birth.tabs.every((id) => id === attached.tabId)
    )
      await chrome.storage.session.set({ [`tearout:${windowId}`]: true });
  }
  const baseUrl = (url) => url?.split(/[?#]/)[0];
  const matches = (url) => baseUrl(url) === controllerUrl;
  async function pageCandidates(windowId) {
    return (await chrome.tabs.query({ windowId }))
      .filter((t) => matches(t.url) || matches(t.pendingUrl))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.id - b.id);
  }
  async function retireEmptyTearOut(windowId) {
    const key = `tearout:${windowId}`;
    if (!(await chrome.storage.session.get(key))[key]) return false;
    if (reusePages && !(await eligible(windowId))) return false;
    const active = await contexts(windowId);
    const owned = new Set();
    for (const c of active) {
      if (
        !reusePages ||
        (await chrome.storage.session.get(`owned:${c.tabId}`))[
          `owned:${c.tabId}`
        ]
      )
        owned.add(c.tabId);
    }
    // Query membership only. Ownership comes exclusively from our exact contexts.
    const tabs = await chrome.tabs.query({ windowId });
    if (!tabs.length) return true;
    if (!owned.size || tabs.some((tab) => !owned.has(tab.id))) return false;
    retiring.add(windowId);
    try {
      // A new user tab appearing here must prevent cleanup. Never remove a window
      // or any tab whose ownership we have not proven.
      const current = await chrome.tabs.query({ windowId });
      if (current.some((tab) => !owned.has(tab.id))) return false;
      const stillOwned = new Set(
        (await contexts(windowId)).map((c) => c.tabId),
      );
      if (current.some((tab) => !stillOwned.has(tab.id))) return false;
      await chrome.tabs.remove(current.map((tab) => tab.id));
      try {
        return (await chrome.tabs.query({ windowId })).length === 0;
      } catch {
        return true; // Chrome closed the now-empty window naturally.
      }
    } finally {
      retiring.delete(windowId);
    }
  }
  const isController = (context) => matches(context.documentUrl);
  const enabled = async () =>
    (await chrome.storage.local.get(preferenceKey))[preferenceKey] ??
    defaultEnabled;
  // Page lifetime and native gesture permission are separate. A manager may be
  // retained without enabling Drag Group or connecting to a native host.
  const pagesEnabled = async () =>
    (await enabled()) || (reusePages && (await keepPages()));
  async function contexts(windowId) {
    return (
      await chrome.runtime.getContexts({
        contextTypes: ["TAB"],
        ...(windowId === undefined ? {} : { windowIds: [windowId] }),
      })
    ).filter(isController);
  }
  async function ensureWindow(windowId) {
    if (retiring.has(windowId)) return;
    if (pending.has(windowId)) return pending.get(windowId);
    const operation = (async () => {
      const delays = [0, 100, 200, 400, 800, 1600, 2400, 3200, 4000, 5000];
      for (let attempt = 0; attempt < delays.length; attempt++) {
        if (delays[attempt])
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        if (retiring.has(windowId)) return;
        try {
          if (await retireEmptyTearOut(windowId)) return;
        } catch {
          // A drag may lock removal too. Retry the same bounded lifecycle check.
          continue;
        }
        if (!(await pagesEnabled())) return;
        let window;
        try {
          window = await chrome.windows.get(windowId);
        } catch {
          return;
        }
        if (
          window.incognito ||
          window.type !== "normal" ||
          !(await eligible(windowId))
        )
          return;
        if (reusePages) {
          const existing = (await pageCandidates(windowId))[0];
          if (existing) {
            try {
              if (!existing.pinned)
                await chrome.tabs.update(existing.id, { pinned: true });
              void chrome.runtime
                .sendMessage({
                  type: messagePrefix + "recheckController",
                  tabId: existing.id,
                  enabled: await enabled(),
                })
                .catch(() => undefined);
              return;
            } catch {
              continue;
            }
          }
        } else if ((await contexts(windowId)).length) return;
        // An in-flight tab may not have loaded its extension context yet.
        const key = `creating:${windowId}`,
          previous = (await chrome.storage.session.get(key))[key];
        if (previous) {
          try {
            const tab = await chrome.tabs.get(previous);
            if (tab.windowId === windowId) return;
          } catch {}
        }
        if (!(await pagesEnabled())) return;
        try {
          const tab = await chrome.tabs.create({
            windowId,
            url: controllerUrl,
            pinned: true,
            active: false,
          });
          await chrome.storage.session.set({
            [key]: tab.id,
            [`owned:${tab.id}`]: true,
          });
          return;
        } catch {
          // Chrome locks tab edits while a tab is being detached/dragged. All of
          // created/attached/focus events may arrive during that same lock. Retry
          // after it settles, checking preference, window and ownership each time.
        }
      }
    })();
    pending.set(windowId, operation);
    try {
      await operation;
    } finally {
      pending.delete(windowId);
    }
  }
  async function reconcile() {
    if (!(await pagesEnabled())) return;
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    await Promise.all(
      windows.filter((w) => !w.incognito).map((w) => ensureWindow(w.id)),
    );
  }
  async function register(sender) {
    if (
      sender.id !== chrome.runtime.id ||
      !matches(sender.url) ||
      !sender.tab ||
      sender.tab.incognito
    )
      throw new Error("Invalid controller.");
    const window = await chrome.windows.get(sender.tab.windowId);
    if (window.type !== "normal" || window.incognito)
      throw new Error("Use a normal window.");
    // Startup/session restoration can race. Only remove duplicate contexts of our
    // exact page, never infer ownership from a user's tab title or URL.
    if (reusePages) {
      const candidates = await pageCandidates(window.id);
      const primary = candidates[0]?.id;
      await chrome.storage.session.remove(`creating:${window.id}`);
      return { primary: sender.tab.id === primary, enabled: await enabled() };
    }
    const candidates = (await contexts(window.id)).sort(
      (a, b) => a.tabId - b.tabId,
    );
    const primary = candidates[0]?.tabId ?? sender.tab.id;
    await chrome.storage.session.set({ [`owned:${sender.tab.id}`]: true });
    for (const duplicate of candidates.filter((c) => c.tabId !== primary)) {
      try {
        await chrome.tabs.remove(duplicate.tabId);
      } catch {}
    }
    await chrome.storage.session.remove(`creating:${window.id}`);
    enqueue(() => ensureWindow(window.id));
    return { primary: sender.tab.id === primary, enabled: await enabled() };
  }
  async function getState() {
    const windows = (
        await chrome.windows.getAll({ windowTypes: ["normal"] })
      ).filter((w) => !w.incognito),
      active = await contexts();
    const states = await Promise.all(
      windows.map(async (window) => {
        const primary = reusePages
          ? (await pageCandidates(window.id))[0]?.id
          : undefined;
        const controller = active.find(
          (c) =>
            c.windowId === window.id && (!reusePages || c.tabId === primary),
        );
        let state;
        if (controller) {
          try {
            state = await chrome.runtime.sendMessage({
              type: messagePrefix + "getWindowStatus",
              windowId: window.id,
              tabId: controller.tabId,
            });
          } catch {}
        }
        return {
          windowId: window.id,
          tabId: controller?.tabId,
          status:
            state?.status ?? (await blockedReason(window.id)) ?? "Starting…",
          running: state?.running ?? false,
        };
      }),
    );
    return {
      enabled: await enabled(),
      windows: states,
      version: chrome.runtime.getManifest().version,
    };
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      sender.id !== chrome.runtime.id ||
      typeof message?.type !== "string" ||
      (messagePrefix && !message.type.startsWith(messagePrefix))
    )
      return;
    message = { ...message, type: message.type.slice(messagePrefix.length) };
    let work;
    if (message.type === "controllerReady") work = register(sender);
    else if (message.type === "getState") work = getState();
    else if (
      message.type === "setEnabled" &&
      typeof message.enabled === "boolean"
    )
      work = (async () => {
        await onPreference(message.enabled);
        await chrome.storage.local.set({ [preferenceKey]: message.enabled });
        await reconcile();
        return getState();
      })();
    else if (message.type === "context" && onContext)
      work = onContext(message, sender);
    else if (message.type === "gesture" && onGesture)
      work = onGesture(message, sender);
    else if (message.type === "openController")
      work = (async () => {
        await ensureWindow(message.windowId);
        const controller = (await contexts(message.windowId))[0];
        if (controller) {
          await chrome.tabs.update(controller.tabId, { active: true });
          await chrome.windows.update(message.windowId, { focused: true });
        }
        return { opened: !!controller };
      })();
    else return;
    work
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  });
  chrome.runtime.onInstalled.addListener(() => {
    void reconcile();
  });
  chrome.runtime.onStartup.addListener(() => {
    void reconcile();
  });
  chrome.windows.onCreated.addListener((window) => {
    if (!window.incognito && window.type === "normal") {
      enqueue(async () => {
        // Do not wait for controller-creation retries here: detach/attach
        // provenance must be recorded while those events are still fresh.
        const own = new Set((await contexts(window.id)).map((c) => c.tabId));
        const tabs = await chrome.tabs.query({ windowId: window.id });
        await chrome.storage.session.set({
          [`born:${window.id}`]: {
            at: Date.now(),
            // Inspect URLs on this exact snapshot: a manager may appear between
            // separate candidate/membership reads before its TAB context exists.
            // Retirement still requires the separate ownership marker and context.
            tabs: tabs.filter((tab) => !own.has(tab.id) && !matches(tab.url) && !matches(tab.pendingUrl)).map((tab) => tab.id),
          },
        });
        await markTearOut(undefined, window.id);
        void ensureWindow(window.id);
      });
    }
  });
  chrome.windows.onRemoved.addListener((windowId) => {
    enqueue(async () => {
      for (const prefix of ["creating", "born", "attached", "tearout"])
        await chrome.storage.session.remove(`${prefix}:${windowId}`);
    });
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId >= 0) void ensureWindow(windowId);
  });
  chrome.windows.onBoundsChanged.addListener((window) => {
    if (!window.incognito && window.type === "normal")
      void ensureWindow(window.id);
  });
  chrome.tabs.onActivated.addListener((info) => {
    void ensureWindow(info.windowId);
  });
  chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
    if (change.status === "complete" || change.pinned !== undefined)
      void ensureWindow(tab.windowId);
  });
  chrome.tabs.onCreated.addListener((tab) => {
    enqueue(async () => {
      // Wait out removal/creation already in flight before reconsidering a new tab.
      await pending.get(tab.windowId);
      await ensureWindow(tab.windowId);
    });
  });
  chrome.tabs.onRemoved.addListener((_tabId, info) => {
    void chrome.storage.session.remove(`owned:${_tabId}`);
    if (!info.isWindowClosing)
      enqueue(async () => {
        await chrome.storage.session.remove(`creating:${info.windowId}`);
        await ensureWindow(info.windowId);
      });
  });
  chrome.tabs.onDetached.addListener((tabId, info) => {
    enqueue(async () => {
      const own = await contexts();
      const key = `owned:${tabId}`;
      await chrome.storage.session.set({
        [`detached:${tabId}`]: {
          at: Date.now(),
          controller:
            !!(await chrome.storage.session.get(key))[key] ||
            own.some((c) => c.tabId === tabId),
        },
      });
      void ensureWindow(info.oldWindowId);
    });
  });
  chrome.tabs.onAttached.addListener((tabId, info) => {
    enqueue(async () => {
      await markTearOut(tabId, info.newWindowId);
      if ((await contexts(info.newWindowId)).some((c) => c.tabId === tabId))
        await chrome.tabs.reload(tabId);
      void ensureWindow(info.newWindowId);
    });
  });
  void reconcile();

  return {
    reconcile,
    ensureWindow,
    contexts,
    enabled,
    getState,
    invalidate: () =>
      chrome.runtime
        .sendMessage({ type: messagePrefix + "invalidate" })
        .catch(() => undefined),
  };
}
