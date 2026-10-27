import { DragGroupSettings } from "./DragGroupSettings";
import { StorageMaintenance } from "./StorageMaintenance";
import { CloudSyncSettings } from "./CloudSyncSettings";
import { useEffect, useId, useState, type ReactNode } from "react";
import type {
  Entity,
  Settings as Preferences,
} from "../../../../packages/domain/model";
import { APP_VERSION } from "../../../../packages/domain/version";
import { Button } from "./components";

type Props = {
  settings: Preferences;
  newTab: boolean;
  properties: Entity[];
  recordCount: number;
  snapshotCount: number;
  onChange: (patch: Partial<Preferences>) => void;
  onRecovery: () => void;
  onReset: () => void;
  onExport: (format: "zip" | "json") => void;
  onImport: (file: File) => void;
  onBackground: (file: File) => void;
  onEditProperty: (property: Entity) => void;
  onTrashProperty: (property: Entity) => void;
};
function Row({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        {id ? (
          <label htmlFor={id}>{title}</label>
        ) : (
          <span className="setting-label">{title}</span>
        )}
        {description && <p id={id ? `${id}-help` : undefined}>{description}</p>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}
function Toggle({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <Row id={id} title={title} description={description}>
      <input
        className="settings-toggle"
        id={id}
        type="checkbox"
        checked={checked}
        aria-describedby={`${id}-help`}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
    </Row>
  );
}
function NumberRow({
  title,
  description,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  title: string;
  description: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <Row id={id} title={title} description={description}>
      <div className="settings-number">
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          step="1"
          value={draft}
          aria-describedby={`${id}-help`}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          onBlur={() => {
            if (!draft.trim() || !Number.isFinite(Number(draft))) {
              setDraft(String(value));
              return;
            }
            const next = Math.max(
              min,
              Math.min(max, Math.trunc(Number(draft))),
            );
            setDraft(String(next));
            if (next !== value) onChange(next);
          }}
        />
        <span>{unit}</span>
      </div>
    </Row>
  );
}
export function Settings({
  settings: s,
  newTab,
  properties,
  recordCount,
  snapshotCount,
  onChange,
  onRecovery,
  onReset,
  onExport,
  onImport,
  onBackground,
  onEditProperty,
  onTrashProperty,
}: Props) {
  const sections = [
    ["appearance", "Appearance"],
    ["browsing", "Browsing & Spaces"],
    ["unsaved", "Unsaved Spaces"],
    ["manager", "Manager"],
    ...(newTab ? [["newtab", "New Tab"]] : []),
    ["backup", "Backup & Recovery"],
    ["sync", "Cloud sync"],
    ["drag-group", "Drag Group"],
    ["advanced", "Advanced"],
    ["about", "About"],
  ];
  return (
    <div className="page settings">
      <header className="settings-heading">
        <h1>Settings</h1>
        <p className="muted">Changes save automatically.</p>
      </header>
      <nav className="settings-nav" aria-label="Settings sections">
        {sections.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() =>
              document.getElementById(`settings-${id}`)?.scrollIntoView({
                behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
                  ? "instant"
                  : "smooth",
                block: "start",
              })
            }
          >
            {label}
          </button>
        ))}
      </nav>
      <section
        id="settings-appearance"
        className="card settings-section"
        aria-label="Appearance settings"
      >
        <h2 id="appearance-heading">Appearance</h2>
        <Row
          id="settings-mode"
          title="Appearance"
          description="Follow your system, or choose a light or dark interface."
        >
          <select
            id="settings-mode"
            aria-describedby="settings-mode-help"
            value={s.theme}
            onChange={(e) =>
              onChange({ theme: e.currentTarget.value as Preferences["theme"] })
            }
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </Row>
        <fieldset className="color-themes">
          <legend>Color theme</legend>
          <p className="muted">Also updates the manager and extension icons.</p>
          <div className="color-theme-options">
            {(
              [
                ["green", "Green · Default"],
                ["blue", "Blue"],
                ["purple", "Purple"],
                ["graphite", "Graphite"],
                ["sand", "Warm Sand"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="color-theme-option"
                data-color-theme={value}
                aria-pressed={s.colorTheme === value}
                onClick={() => onChange({ colorTheme: value })}
              >
                <span className="theme-swatch" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </fieldset>
      </section>
      <section
        id="settings-browsing"
        className="card settings-section"
        aria-labelledby="browsing-heading"
      >
        <h2 id="browsing-heading">Browsing & Spaces</h2>
        <Toggle
          title="Restore browsing on startup"
          description="Continue your last Chrome session, including Unsaved Spaces. Tabs already restored by Chrome are reconnected."
          checked={s.restoreBrowsing}
          onChange={(restoreBrowsing) => onChange({ restoreBrowsing })}
        />
        <Row
          id="settings-switching"
          title="When switching Spaces"
          description={
            s.preserveLiveTabs
              ? "Previous tabs stay loaded in a separate minimized window. Applies on the next switch."
              : "Previous tabs are saved and closed. Pages reload when you return; unsaved page contents are not preserved. Applies on the next switch."
          }
        >
          <select
            id="settings-switching"
            value={s.preserveLiveTabs ? "preserve" : "close"}
            aria-describedby="settings-switching-help"
            onChange={(e) =>
              onChange({
                preserveLiveTabs: e.currentTarget.value === "preserve",
              })
            }
          >
            <option value="close">Save and close previous tabs</option>
            <option value="preserve">Keep tabs in a minimized window</option>
          </select>
        </Row>
        <Toggle
          title="Lock tabs in Saved Spaces by default"
          description="Locks existing and new tabs in Saved Spaces. You can unlock each tab. Turning this off keeps existing locks."
          checked={s.lockTabsByDefault}
          onChange={(lockTabsByDefault) => onChange({ lockTabsByDefault })}
        />
        <Toggle
          title="New tabs from a managed tab inherit its group"
          description="A tab opened from a grouped tab joins the same Chrome group."
          checked={s.inheritOpener}
          onChange={(inheritOpener) => onChange({ inheritOpener })}
        />
      </section>
      <section
        id="settings-unsaved"
        className="card settings-section"
        aria-labelledby="unsaved-heading"
      >
        <h2 id="unsaved-heading">Unsaved Spaces</h2>
        <p className="settings-intro">
          Limits apply to recently closed Unsaved Spaces.
        </p>
        <NumberRow
          title="Closed Unsaved Spaces to keep"
          description="Keep the most recent ones. Set to 0 to keep no unprotected closed Spaces."
          value={s.unsavedLimit}
          min={0}
          max={100}
          unit="Spaces"
          onChange={(unsavedLimit) => onChange({ unsavedLimit })}
        />
        <NumberRow
          title="Keep closed Unsaved Spaces for"
          description="Closed Spaces are cleaned up when either limit is reached."
          value={s.unsavedDays}
          min={1}
          max={365}
          unit="days"
          onChange={(unsavedDays) => onChange({ unsavedDays })}
        />
        <p className="settings-footnote">
          Open Spaces, pending startup sessions and Spaces containing notes,
          tasks, resources or files are protected. Empty closed Spaces are
          removed.
        </p>
      </section>
      <section
        id="settings-manager"
        className="card settings-section"
        aria-labelledby="manager-heading"
      >
        <h2 id="manager-heading">Manager</h2>
        <Toggle
          title="Keep a pinned manager in every window"
          description="Automatically opens a pinned manager in each normal Chrome window and reopens it if closed. Works without Drag Group or the Windows helper. Turning this off leaves existing managers open; Drag Group still keeps the manager it needs while enabled."
          checked={s.autoOpenManager}
          onChange={(autoOpenManager) => onChange({ autoOpenManager })}
        />
        <Toggle
          title="Pin the manager when opened"
          description="Pins the manager when you explicitly open it. Manual unpinning is respected unless automatic manager or Drag Group is enabled."
          checked={s.pinManager}
          onChange={(pinManager) => onChange({ pinManager })}
        />
        <details className="settings-help">
          <summary>Side panel placement</summary>
          <p>Choose left or right in Chrome’s Appearance settings.</p>
        </details>
      </section>
      {newTab && (
        <section
          id="settings-newtab"
          className="card settings-section"
          aria-labelledby="newtab-heading"
        >
          <h2 id="newtab-heading">New Tab</h2>
          <Toggle
            title="Show clock"
            description="Display the time on your TabSpace New Tab page."
            checked={s.clock}
            onChange={(clock) => onChange({ clock })}
          />
          <Row id="settings-background" title="Background color">
            <input
              id="settings-background"
              type="color"
              value={s.background}
              onChange={(e) => onChange({ background: e.currentTarget.value })}
            />
          </Row>
          <Row
            title="Background image"
            description="Choose a local PNG, JPEG or WebP image up to 10 MiB."
          >
            <div className="settings-actions">
              <label className="file-button">
                Choose image
                <input
                  aria-label="Choose background image"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0];
                    e.currentTarget.value = "";
                    if (file) onBackground(file);
                  }}
                />
              </label>
              {s.backgroundAttachmentId && (
                <Button
                  onClick={() =>
                    onChange({ backgroundAttachmentId: undefined })
                  }
                >
                  Remove image
                </Button>
              )}
            </div>
          </Row>
        </section>
      )}
      <section
        id="settings-backup"
        className="card settings-section"
        aria-labelledby="backup-heading"
      >
        <h2 id="backup-heading">Backup & Recovery</h2>
        <Row
          title="Export backup"
          description="Save a complete backup outside Chrome. ZIP is compressed; JSON includes attachments in a single portable file."
        >
          <div className="settings-actions">
            <Button className="primary" onClick={() => onExport("zip")}>
              Export ZIP
            </Button>
            <Button onClick={() => onExport("json")}>Export JSON</Button>
          </div>
        </Row>
        <Row
          title="Import backup"
          description="Review a backup before merging it or replacing your local collection."
        >
          <label className="file-button">
            Import backup
            <input
              aria-label="Import backup file"
              type="file"
              accept=".json,.zip"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (file) onImport(file);
              }}
            />
          </label>
        </Row>
        <Row
          title="Recovery"
          description="Restore earlier tab checkpoints or recover editor drafts stored in this Chrome profile."
        >
          <Button onClick={onRecovery}>Open Recovery</Button>
        </Row>
        <NumberRow
          title="Keep automatic checkpoints for"
          description="Protected checkpoints and the latest nonempty recovery version are preserved."
          value={s.retentionDays}
          min={1}
          max={36500}
          unit="days"
          onChange={(retentionDays) => onChange({ retentionDays })}
        />
        <p className="settings-footnote">
          Internal Recovery is not an independent backup. Export a file to
          protect against extension removal.
        </p>
        <StorageMaintenance />
      </section>
      <CloudSyncSettings />
      <DragGroupSettings enabled={s.dragGroupEnabled} />
      <section
        id="settings-advanced"
        className="card settings-section"
        aria-labelledby="advanced-heading"
      >
        <h2 id="advanced-heading">Advanced</h2>
        <details className="settings-help">
          <summary>
            Reusable properties{" "}
            <span className="count">{properties.length}</span>
          </summary>
          <p>
            Manage custom fields that can be reused across your Spaces and
            content.
          </p>
          {!properties.length && (
            <p className="muted">
              No custom properties yet. Add one with + Property in a Space.
            </p>
          )}
          {properties.map((p) => (
            <div className="item" key={p.id}>
              <div className="item-main">
                <strong>{p.name}</strong>
                <small>
                  {p.propertyType}
                  {p.options.length
                    ? ` · ${p.options.map((o) => o.label).join(", ")}`
                    : ""}
                </small>
              </div>
              <div className="settings-actions">
                <Button onClick={() => onEditProperty(p)}>Rename</Button>
                <Button onClick={() => onTrashProperty(p)}>
                  Trash unused definition
                </Button>
              </div>
            </div>
          ))}
        </details>
      </section>
      <section
        id="settings-about"
        className="card settings-section"
        aria-labelledby="about-heading"
      >
        <h2 id="about-heading">About & Privacy</h2>
        <p>TabSpace {APP_VERSION}</p>
        <p>
          Your Spaces and content stay in this Chrome profile. No account, cloud
          sync or telemetry. Incognito activity is excluded.
        </p>
        <p className="settings-footnote">
          Data is not application-encrypted. Removing the extension clears its
          local storage.
        </p>
        <details className="settings-help">
          <summary>Diagnostic information</summary>
          <p>
            Version {APP_VERSION} · schema 1 · {recordCount} records ·{" "}
            {snapshotCount} snapshots
          </p>
          <p className="muted">Development build.</p>
        </details>
      </section>
      <section
        className="card settings-section settings-reset"
        aria-labelledby="reset-heading"
      >
        <h2 id="reset-heading">Reset data</h2>
        <Row
          title="Reset TabSpace data"
          description="Permanently remove all Spaces, content, recovery history and settings. Chrome website tabs stay open and become fresh Unsaved browsing."
        >
          <Button className="danger" onClick={onReset}>
            Reset TabSpace data
          </Button>
        </Row>
      </section>
    </div>
  );
}
