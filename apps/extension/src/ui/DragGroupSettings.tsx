import { useEffect, useState } from "react";
import { Button } from "./components";
type State = {
  enabled: boolean;
  windows: { windowId: number; status: string; running: boolean }[];
};
export function DragGroupSettings({ enabled }: { enabled: boolean }) {
  const [state, setState] = useState<State>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() {
    try {
      const s = await chrome.runtime.sendMessage({
        type: "dragGroup:getState",
      });
      if (s.error) throw Error(s.error);
      setState(s);
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void refresh();
  }, [enabled]);
  async function toggle() {
    setBusy(true);
    setError("");
    try {
      // Permission request must remain directly attached to the user's click.
      if (
        !enabled &&
        !(await chrome.permissions.request({
          permissions: ["nativeMessaging"],
        }))
      )
        throw Error("Helper access was not granted.");
      const s = await chrome.runtime.sendMessage({
        type: "dragGroup:setEnabled",
        enabled: !enabled,
      });
      if (s.error) throw Error(s.error);
      setState(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      id="settings-drag-group"
      className="card settings-section"
      aria-label="Drag Group settings"
    >
      <h2>Drag Group</h2>
      <p>
        Overlap two ungrouped tabs and hold briefly to create a Chrome group.
        Windows only.
      </p>
      <div className="settings-actions">
        <Button disabled={busy} onClick={() => void toggle()}>
          {enabled ? "Pause Drag Group" : "Enable Drag Group"}
        </Button>
        <Button onClick={() => void refresh()}>Refresh status</Button>
      </div>
      <p role="status">
        {error ||
          (state?.enabled ? "Enabled for normal Chrome windows" : "Paused")}
      </p>
      {state?.enabled &&
        state.windows.map((w) => (
          <p key={w.windowId}>
            Window {w.windowId}: {w.status}
          </p>
        ))}
      <details className="settings-help">
        <summary>Windows helper setup</summary>
        <p>
          Install the TabSpace Drag Group helper with Install.ps1 -Apply from
          its extracted folder, then enable this option. Keep the pinned
          TabSpace manager open in each window.
        </p>
        <p>
          Disable the standalone Drag Group extension before using the
          integration. Both editions use the same helper; enable only one
          edition at a time.
        </p>
        <p>
          Pausing leaves manager tabs open. The feature starts with Chrome
          once enabled. Private, PWA and internally preserved windows are
          excluded.
        </p>
      </details>
    </section>
  );
}
