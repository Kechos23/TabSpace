import { useEffect, useRef, useState } from "react";
type DragState = {
  enabled: boolean;
  windows: { windowId: number; status: string; running: boolean }[];
};
export function DragGroupQuickControl({
  windowId,
}: {
  windowId: number | undefined;
}) {
  const [state, setState] = useState<DragState>();
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    let closed = false;
    const refresh = async () => {
      const request = ++revision.current;
      try {
        const next = await chrome.runtime.sendMessage({
          type: "dragGroup:getState",
        });
        if (next?.error || !next)
          throw Error(next?.error || "Could not read Drag Group status.");
        if (!closed && request === revision.current) {
          setState(next);
          setStatusError("");
        }
      } catch (e) {
        if (!closed && request === revision.current)
          setStatusError(
            e instanceof Error ? e.message : "Could not read status.",
          );
      }
    };
    if (busy) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    const changed = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === "local" && changes.dragGroupEnabled) void refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => {
      closed = true;
      clearInterval(timer);
      chrome.storage.onChanged.removeListener(changed);
    };
  }, [busy, windowId]);
  async function toggle() {
    if (busy || !state) return;
    const enabled = !state.enabled;
    revision.current++;
    setBusy(true);
    setError("");
    try {
      // Keep the optional permission request within the original user gesture.
      if (
        enabled &&
        !(await chrome.permissions.request({
          permissions: ["nativeMessaging"],
        }))
      )
        throw Error(
          "Helper access was not granted. Drag Group remains paused.",
        );
      const next = await chrome.runtime.sendMessage({
        type: "dragGroup:setEnabled",
        enabled,
      });
      if (next?.error || !next)
        throw Error(next?.error || "Could not change Drag Group.");
      setState(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change Drag Group.");
    } finally {
      setBusy(false);
    }
  }
  const current = state?.windows.find((w) => w.windowId === windowId);
  const ready =
    !!state?.enabled &&
    !!current?.running &&
    /^(Ready\b|Group created\. Ready\b)/i.test(current.status);
  const status = !state
    ? "Checking…"
    : !state.enabled
      ? "Paused"
      : current?.status || "Unavailable in this window";
  return (
    <section className="popup-drag-group" aria-label="Drag Group controls">
      <label className="popup-drag-toggle">
        <span>
          <strong>Drag Group</strong>
          <small>Enable in all Chrome windows</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label="Drag Group"
          className="settings-toggle"
          checked={state?.enabled ?? false}
          disabled={!state || busy}
          onChange={() => void toggle()}
        />
      </label>
      <p
        role="status"
        className="popup-drag-status"
        data-ready={ready}
        title={status}
      >
        <span aria-hidden="true" className="popup-drag-dot" />
        {busy ? "Updating…" : ready ? "Ready in this window" : status}
      </p>
      {(error || statusError) && (
        <p role="alert" className="popup-drag-error">
          {error || statusError}
        </p>
      )}
    </section>
  );
}
