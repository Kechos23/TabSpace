import { DragGroupQuickControl } from "./ui/DragGroupQuickControl";
import { CloudSyncIndicator } from "./ui/CloudSyncIndicator";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import * as client from "./client";
import { openSidePanel } from "./panel-navigation";
import { safeUrl, colors } from "../../../packages/domain/model";
import { Button, Logo, LockIcon, SpaceColorPicker } from "./ui/components";
import "./ui/style.css";

function Popup() {
  const [state, setState] = useState<client.PopupState>();
  const [spaceId, setSpaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [windowSave, setWindowSave] = useState<{
    id: string;
    name: string;
    locked: boolean;
    color: (typeof colors)[number];
    collection: string;
  }>();
  const refresh = async () => {
    try {
      const next = await client.loadPopup();
      setState(next);
      setSpaceId((current) => {
        const candidates = [
          current,
          next.activeSpaceId,
          localStorage.getItem("lastSpace"),
          next.inboxId,
        ];
        return (
          candidates.find((id) => next.spaces.some((s) => s.id === id)) ??
          next.spaces[0]?.id ??
          ""
        );
      });
      document.documentElement.dataset.theme = next.settings.theme;
      document.documentElement.dataset.colorTheme = next.settings.colorTheme;
      setError("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not open quick actions.",
      );
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not complete the action.",
      );
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!state?.spaces.some((s) => s.id === spaceId))
      throw new Error("Choose an available Space.");
    const [tab] = await chrome.tabs.query({
      active: true,
      windowId: state.windowId,
    });
    if (!tab || tab.incognito || !tab.url)
      throw new Error("Use a normal website tab.");
    const url = safeUrl(tab.url);
    await client.create("resource", tab.title?.slice(0, 500) || "Saved tab", {
      spaceId,
      url,
      titleMode: "auto",
    });
  };
  const canSaveWindow =
    state?.windowId !== undefined &&
    !state.spaces.some(
      (space) =>
        space.id === state.activeSpaceId &&
        space.id !== state.inboxId &&
        !space.temporary,
    );
  return (
    <main className="popup popup-shell" aria-busy={!state || busy}>
      <div className="brand">
        <Logo />
        <strong>TabSpace</strong>
        <span className="badge">Local</span>
      </div>
      <h1>Your Tabs</h1>
      <p className="popup-intro">Your Workspace</p>
      <label>
        Space
        <select
          disabled={!state || busy}
          value={spaceId}
          onChange={(e) => setSpaceId(e.target.value)}
        >
          {!state && <option value="">Loading Spaces…</option>}
          {state?.spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div className="quick-grid">
        {canSaveWindow && (
          <button
            className="popup-save-window"
            disabled={busy}
            aria-expanded={!!windowSave}
            aria-controls="popup-window-save"
            onClick={() =>
              setWindowSave((current) =>
                current
                  ? undefined
                  : {
                      id: crypto.randomUUID(),
                      name: "",
                      color: "blue",
                      collection: "",
                      locked: state?.settings.lockTabsByDefault ?? false,
                    },
              )
            }
          >
            Save window as Space
          </button>
        )}
        {state?.canLock &&
          state.spaces.some(
            (space) =>
              space.id === state.activeSpaceId &&
              !space.temporary &&
              space.id !== state.inboxId,
          ) && (
            <Button
              className="popup-tab-lock"
              aria-label={state.tabLocked ? "Unlock in Space" : "Lock in Space"}
              disabled={busy}
              aria-pressed={!!state.tabLocked}
              title={`Current tab in ${state.spaces.find((space) => space.id === state.activeSpaceId)?.name}`}
              onClick={() =>
                void run(async () => {
                  await client.browser("setTabLock", {
                    spaceId: state.activeSpaceId,
                    ids: [state.activeTabId!],
                    locked: !state.tabLocked,
                  });
                  await refresh();
                })
              }
            >
              <LockIcon locked={!!state.tabLocked} />{" "}
              {state.tabLocked ? "Unlock in Space" : "Lock in Space"}
            </Button>
          )}
        <Button
          disabled={!state || busy}
          onClick={() => void run(() => client.browser("manager"))}
        >
          Open manager
        </Button>
        <Button
          className="primary"
          disabled={!spaceId || busy}
          onClick={() => void run(save)}
        >
          Save current tab
        </Button>
        <Button
          disabled={state?.windowId === undefined || busy}
          onClick={() =>
            void run(async () => {
              await openSidePanel(state!.windowId!, "tasks");
              window.close();
            })
          }
        >
          Add task
        </Button>
        <Button
          disabled={state?.windowId === undefined || busy}
          onClick={() =>
            void run(async () => {
              await openSidePanel(state!.windowId!, "spaces");
              window.close();
            })
          }
        >
          Open side panel
        </Button>
      </div>
      {canSaveWindow && windowSave && (
        <form
          id="popup-window-save"
          className="popup-window-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const saved = await client.browser("saveWindowSpace", {
                windowId: state!.windowId,
                spaceId: windowSave.id,
                name: windowSave.name.trim(),
                locked: windowSave.locked,
                color: windowSave.color,
                collectionId: windowSave.collection || undefined,
              });
              await refresh();
              setSpaceId(
                saved &&
                  typeof saved === "object" &&
                  "spaceId" in saved &&
                  typeof saved.spaceId === "string"
                  ? saved.spaceId
                  : windowSave.id,
              );
              setWindowSave(undefined);
              setNotice(`Saved as ${windowSave.name.trim()}.`);
            });
          }}
        >
          <label>
            Space name
            <input
              autoFocus
              required
              maxLength={500}
              value={windowSave.name}
              disabled={busy}
              onChange={(event) =>
                setWindowSave({ ...windowSave, name: event.target.value })
              }
            />
          </label>
          <fieldset className="popup-color-field" disabled={busy}>
            <legend>Space color</legend>
            <SpaceColorPicker
              value={windowSave.color}
              onChange={(color) => setWindowSave({ ...windowSave, color })}
              disabled={busy}
            />
          </fieldset>
          <label className="inline">
            <input
              type="checkbox"
              checked={windowSave.locked}
              disabled={busy}
              onChange={(event) =>
                setWindowSave({ ...windowSave, locked: event.target.checked })
              }
            />
            Lock current tabs in Space
          </label>
          <label>
            Collection
            <select
              aria-label="Collection"
              value={windowSave.collection}
              disabled={busy}
              onChange={(event) =>
                setWindowSave({ ...windowSave, collection: event.target.value })
              }
            >
              <option value="">No collection</option>
              {state?.collections?.map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            Saves a copy of this window’s websites, including pinned sites. Your
            open tabs stay as they are.
          </p>
          <div className="quick-grid">
            <button
              type="button"
              disabled={busy}
              onClick={() => setWindowSave(undefined)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={busy || !windowSave.name.trim()}
            >
              Save Space
            </button>
          </div>
        </form>
      )}
      <DragGroupQuickControl windowId={state?.windowId} />
      <div className="popup-footer">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <Button onClick={() => void refresh()}>Retry</Button>
          </>
        ) : (
          <p role="status" className="popup-status">
            {busy
              ? "Saving…"
              : state
                ? notice || "Ready · saved locally"
                : "Opening quick actions…"}
          </p>
        )}
        <CloudSyncIndicator />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Popup />);
