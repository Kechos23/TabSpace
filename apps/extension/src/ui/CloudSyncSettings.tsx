import { useEffect, useRef, useState } from "react";
import * as client from "../client";
import { Button, download } from "./components";
import {
  setupLocation,
  type ServerType,
} from "../../../../packages/sync/setup";
import type { ConflictReview, Choices } from "../../../../packages/sync/engine";
import type { Bundle } from "../../../../packages/sync/model";

type Status = {
  configured: boolean;
  url?: string;
  hasAccess: boolean;
  automatic: boolean;
  unlocked: boolean;
  running: boolean;
  lastSynced?: string;
  error: string;
  review?: ConflictReview;
};
const summary = (bundle: Bundle | null) =>
  bundle
    ? `${bundle.session?.tabs.length ?? 0} tabs · ${bundle.entities.filter((e) => e.kind === "note").length} notes · ${bundle.entities.filter((e) => e.kind === "task").length} tasks`
    : "Deleted on this side";
export function CloudSyncSettings() {
  const [status, setStatus] = useState<Status>();
  const [serverType, setServerType] = useState<ServerType>("nextcloud");
  const serial = useRef(0),
    operating = useRef(false),
    lastSuccess = useRef<string | undefined>(undefined);
  const [url, setUrl] = useState(""),
    [username, setUsername] = useState(""),
    [appPassword, setPassword] = useState("");
  const [folder, setFolder] = useState("TabSpace");
  const [passphrase, setPhrase] = useState(""),
    [automatic, setAutomatic] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [choices, setChoices] = useState<Choices>({});
  const [activeAction, setActiveAction] = useState("");
  useEffect(() => setChoices({}), [status?.review?.token]);
  useEffect(() => {
    if (!client.isExtension) return;
    let alive = true;
    const load = async () => {
      if (operating.current) return;
      const id = ++serial.current;
      try {
        const value = await client.request<Status>({ type: "cloudSyncStatus" });
        if (alive && id === serial.current) {
          if (value.lastSynced && value.lastSynced !== lastSuccess.current)
            setError("");
          lastSuccess.current = value.lastSynced;
          setError((previous) =>
            previous.startsWith("Cannot read sync status.") ? "" : previous,
          );
          setStatus(value);
        }
      } catch {
        if (alive && id === serial.current)
          setError("Cannot read sync status. Reload this view and try again.");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      alive = false;
      ++serial.current;
      clearInterval(timer);
    };
  }, []);
  const act = async (
    message: { type: string; [key: string]: unknown },
    reserved = false,
  ) => {
    if (operating.current && !reserved) return;
    operating.current = true;
    ++serial.current;
    setActiveAction(message.type);
    setBusy(true);
    setError("");
    try {
      const value = await client.request<Status>(message);
      lastSuccess.current = value.lastSynced;
      setStatus(value);
      if (
        ["cloudSyncConfigure", "cloudSyncUnlock", "cloudSyncLock"].includes(
          message.type,
        )
      ) {
        setPhrase("");
        setPassword("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      operating.current = false;
      setActiveAction("");
      setBusy(false);
    }
  };
  const connect = async () => {
    if (operating.current) return;
    operating.current = true;
    ++serial.current;
    setBusy(true);
    setError("");
    try {
      const value = setupLocation(serverType, url, username, folder),
        parsed = new URL(value);
      const pattern = `${parsed.protocol}//${parsed.hostname}/*`;
      if (parsed.protocol !== "https:")
        throw new Error("Use an HTTPS WebDAV folder URL.");
      const granted = await chrome.permissions.request({
        origins: [pattern],
      });
      if (!granted)
        throw new Error(
          "Server access was not granted. Local features remain available.",
        );
      await act(
        {
          type: "cloudSyncConfigure",
          url: value,
          username: username.trim(),
          appPassword,
          passphrase,
          automatic,
        },
        true,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cannot connect.");
    } finally {
      operating.current = false;
      setBusy(false);
    }
  };
  const restoreAccess = async () => {
    if (operating.current || !status?.url) return;
    operating.current = true;
    ++serial.current;
    setBusy(true);
    setError("");
    try {
      const target = new URL(status.url);
      if (
        !(await chrome.permissions.request({
          origins: [`${target.protocol}//${target.hostname}/*`],
        }))
      )
        throw new Error("Server access was not granted.");
      await act({ type: "cloudSyncRun" }, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cannot allow server access.");
    } finally {
      operating.current = false;
      setBusy(false);
    }
  };
  let location = "",
    setupError = "";
  try {
    location = setupLocation(serverType, url, username, folder);
  } catch (e) {
    setupError =
      e instanceof Error ? e.message : "Check the connection details.";
  }
  const disabled = busy || status?.running;
  return (
    <section
      id="settings-sync"
      className="card settings-section"
      aria-labelledby="sync-heading"
    >
      <h2 id="sync-heading">Cloud sync</h2>
      <p className="muted">
        Keep your saved work available on your other computers. Everything still
        works offline.
      </p>
      {!client.isExtension ? (
        <p>Cloud sync is available in the Chrome extension.</p>
      ) : !status ? (
        <div>
          <p>Loading sync status…</p>
          {error && <p role="alert">{error}</p>}
        </div>
      ) : (
        <>
          <p
            role="status"
            className="cloud-sync-state"
            data-attention={!!(error || status.error || status.review)}
          >
            {status.configured
              ? status.running || activeAction === "cloudSyncRun"
                ? "Syncing…"
                : !status.hasAccess
                  ? "Server access needed"
                  : status.unlocked
                    ? status.review
                      ? "Choose which version to keep"
                      : error || status.error
                        ? "Needs attention"
                        : "Ready to sync"
                    : "Locked — unlock to sync"
              : "Not connected — all data stays local"}
          </p>
          {!status.configured ? (
            <div className="cloud-sync-form">
              <h3>1. Server connection</h3>
              <label>
                Service
                <select
                  value={serverType}
                  onChange={(e) => setServerType(e.target.value as ServerType)}
                >
                  <option value="nextcloud">Nextcloud</option>
                  <option value="webdav">Other WebDAV server</option>
                </select>
              </label>
              <label>
                {serverType === "nextcloud"
                  ? "Nextcloud address"
                  : "WebDAV address"}
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={
                    serverType === "nextcloud"
                      ? "https://cloud.example.com"
                      : "https://server.example.com/webdav/"
                  }
                  autoComplete="off"
                />
              </label>
              <small className="muted">
                {serverType === "nextcloud"
                  ? "Enter your Nextcloud base address. The complete WebDAV address from Files settings also works; leave out the sync folder."
                  : "Paste the full WebDAV address supplied by your server, without the sync folder."}
              </small>
              <label>
                Sync folder
                <input
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="TabSpace"
                  autoComplete="off"
                />
              </label>
              <small className="muted">
                Use the same folder on every computer. It will be created if
                needed; nested parent folders must already exist.
              </small>
              <label>
                Username
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <small className="muted">
                Your server login name, rather than your display name.
              </small>
              <label>
                App password
                <input
                  type="password"
                  value={appPassword}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <small className="muted">
                {serverType === "nextcloud"
                  ? "Nextcloud → Personal settings → Security → Devices & sessions. Create an app password named TabSpace for this computer."
                  : "Use a dedicated app password or access token from your WebDAV provider."}
              </small>
              {location ? (
                <div className="cloud-sync-location">
                  <small>Files will be stored in</small>
                  <code>{location}</code>
                </div>
              ) : (
                url.includes("://") &&
                username &&
                folder && <small className="muted">{setupError}</small>
              )}
              <h3>2. Sync encryption</h3>
              <label>
                Sync password
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPhrase(e.target.value)}
                  minLength={12}
                  autoComplete="new-password"
                />
              </label>
              <p className="muted">
                Choose your own password of at least 12 characters. This is
                separate from your server password. On another computer, enter
                the exact same sync password. Keep it in your password manager;
                TabSpace cannot recover it.
              </p>
              <label className="cloud-sync-toggle">
                <input
                  type="checkbox"
                  checked={automatic}
                  onChange={(e) => setAutomatic(e.target.checked)}
                />{" "}
                Automatic sync — every 5 minutes while unlocked
              </label>
              <Button
                disabled={
                  disabled ||
                  !location ||
                  !username ||
                  !appPassword ||
                  !folder ||
                  passphrase.length < 12
                }
                onClick={() => void connect()}
              >
                Save connection
              </Button>
              <p className="muted">
                Save the setup, then use Sync now to send or receive your
                library. Only the selected server needs access permission.
              </p>
            </div>
          ) : (
            <>
              <div className="cloud-sync-location">
                <small>Sync location</small>
                <code>{status.url}</code>
              </div>
              <p className="muted">
                {status.lastSynced
                  ? `Last successful sync: ${new Date(status.lastSynced).toLocaleString()}`
                  : "No successful sync yet — use Sync now to start"}{" "}
                · {status.automatic ? "Automatic sync enabled" : "Manual sync"}
              </p>
              {(!status.unlocked ||
                status.error.includes("Cannot decrypt")) && (
                <div className="cloud-sync-form">
                  <label>
                    Sync password
                    <input
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPhrase(e.target.value)}
                      autoComplete="current-password"
                    />
                  </label>
                  <small className="muted">
                    Enter the encryption password you chose for this sync
                    folder, not the Nextcloud app password. It is requested
                    again after Chrome exits or the extension reloads.
                  </small>
                  <Button
                    disabled={disabled || passphrase.length < 12}
                    onClick={() =>
                      void act({ type: "cloudSyncUnlock", passphrase })
                    }
                  >
                    Unlock sync
                  </Button>
                </div>
              )}
              {!status.hasAccess && (
                <Button
                  disabled={disabled || !status.unlocked}
                  onClick={() => void restoreAccess()}
                >
                  Allow server access and sync
                </Button>
              )}
              <div className="cloud-sync-controls">
                <label className="cloud-sync-toggle">
                  <input
                    type="checkbox"
                    checked={status.automatic}
                    disabled={disabled}
                    onChange={(e) =>
                      void act({
                        type: "cloudSyncAutomatic",
                        enabled: e.target.checked,
                      })
                    }
                  />{" "}
                  Automatic sync — every 5 minutes while unlocked
                </label>
                <div className="cloud-sync-buttons">
                  <Button
                    disabled={disabled || !status.unlocked || !status.hasAccess}
                    onClick={() => void act({ type: "cloudSyncRun" })}
                  >
                    Sync now
                  </Button>
                  <Button
                    disabled={disabled || !status.unlocked}
                    onClick={() => void act({ type: "cloudSyncLock" })}
                  >
                    Lock sync
                  </Button>
                  <Button
                    disabled={disabled}
                    onClick={() => void act({ type: "cloudSyncDisconnect" })}
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
              <p className="muted">
                Disconnect removes this computer’s connection. Your local work
                and cloud files remain.
              </p>
            </>
          )}
          <details className="cloud-sync-help">
            <summary>What syncs between computers?</summary>
            <p>
              Saved Spaces, Inbox, Collections, Notes, Resources, Tasks and
              attached files. Unsaved Spaces and open browser windows stay on
              each computer. Incoming tab changes wait until the affected Space
              is closed here.
            </p>
          </details>
          {status.review && (
            <div className="cloud-sync-conflicts">
              <h3>Review conflicting versions</h3>
              <p>
                Nothing has been replaced. Download both versions to inspect
                their content before choosing.
              </p>
              <Button
                onClick={() =>
                  download(
                    new Blob([JSON.stringify(status.review, null, 2)], {
                      type: "application/json",
                    }),
                    "TabSpace-sync-conflicts.json",
                  )
                }
              >
                Download both versions
              </Button>
              {status.review.conflicts.map((c) => (
                <div className="card" key={c.key}>
                  <strong>{c.name}</strong>
                  <p>
                    This device: {summary(c.local)}
                    <br />
                    Cloud: {summary(c.remote)}
                  </p>
                  <label>
                    Version to keep
                    <select
                      value={choices[c.key] ?? ""}
                      onChange={(e) =>
                        setChoices({
                          ...choices,
                          [c.key]: e.target.value as Choices[string],
                        })
                      }
                    >
                      <option value="" disabled>
                        Choose a version
                      </option>
                      <option value="local">Keep this device</option>
                      <option value="remote">Use cloud version</option>
                      {c.local &&
                        c.remote &&
                        !["library", "inbox"].includes(c.key) && (
                          <option value="both">
                            Keep both as separate Spaces
                          </option>
                        )}
                    </select>
                  </label>
                </div>
              ))}
              <Button
                disabled={
                  disabled ||
                  !status.unlocked ||
                  !status.hasAccess ||
                  status.review.conflicts.some((c) => !choices[c.key])
                }
                onClick={() =>
                  void act({
                    type: "cloudSyncRun",
                    resolution: { token: status.review!.token, choices },
                  })
                }
              >
                Sync with these choices
              </Button>
            </div>
          )}
          {(error || status.error) && (
            <p role="alert">{error || status.error}</p>
          )}
        </>
      )}
    </section>
  );
}
