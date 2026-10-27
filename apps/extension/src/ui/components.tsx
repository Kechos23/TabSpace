import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useId,
  type ReactNode,
  type MouseEvent,
} from "react";
import {
  blankDoc,
  documentText,
  markdown,
  safeUrl,
  colors,
  type Doc,
  type Entity,
} from "../../../../packages/domain/model";
import * as client from "../client";
import { repository } from "../../../../packages/persistence/repository";
import { useVirtualizer } from "@tanstack/react-virtual";

// Space state determines the symbol; legacy stored glyphs must not survive Save.
export function SpaceIcon({ temporary }: { temporary: boolean }) {
  return (
    <svg
      className="space-state-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-space-state={temporary ? "unsaved" : "saved"}
    >
      <path
        data-layer="upper"
        d="M11.1 3.4a2 2 0 0 1 1.8 0l8.5 4.2a.9.9 0 0 1 0 1.6l-8.5 4.2a2 2 0 0 1-1.8 0L2.6 9.2a.9.9 0 0 1 0-1.6Z"
        fill={temporary ? "none" : "currentColor"}
        strokeDasharray={temporary ? "3 2.5" : undefined}
      />
      <path data-layer="lower" d="m2 16 9.1 4.5a2 2 0 0 0 1.8 0L22 16" />
    </svg>
  );
}
export function CurrentSpaceBadge({
  label = "Current Space in this window",
}: {
  label?: string;
}) {
  return (
    <span
      className="current-space-badge"
      role="img"
      aria-label={label}
      title={label}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="m4 8 2.5 2.5L12 5" />
      </svg>
    </span>
  );
}

export function TabActionsMenu({
  label,
  children,
  triggerText = "⋯",
  triggerId,
  disabled,
}: {
  label: string;
  children: ReactNode;
  triggerText?: ReactNode;
  triggerId?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const place = () => {
    if (!trigger.current || !popup.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const menu = popup.current;
    const width = Math.min(210, window.innerWidth - 16);
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${window.innerHeight - 16}px`;
    const height = menu.getBoundingClientRect().height;
    menu.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, anchor.bottom + height + 6 <= window.innerHeight - 8 ? anchor.bottom + 6 : anchor.top - height - 6)}px`;
  };
  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        id={triggerId}
        disabled={disabled}
        type="button"
        className="tab-actions-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          const menu = popup.current!;
          if (menu.matches(":popover-open")) menu.hidePopover();
          else {
            menu.showPopover();
            place();
            menu
              .querySelector<HTMLButtonElement>("button:not(:disabled)")
              ?.focus();
          }
        }}
      >
        {triggerText}
      </button>
      <div
        ref={popup}
        id={id}
        popover="auto"
        role="menu"
        aria-label={label}
        className="tab-actions-popup"
        onToggle={(event) => setOpen(event.newState === "open")}
        onClick={(event) => {
          if ((event.target as Element).closest("button:not(:disabled)"))
            popup.current?.hidePopover();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ),
          ];
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          let next: number | undefined;
          if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
          if (event.key === "ArrowUp")
            next = (index - 1 + buttons.length) % buttons.length;
          if (event.key === "Home") next = 0;
          if (event.key === "End") next = buttons.length - 1;
          if (next !== undefined) {
            event.preventDefault();
            buttons[next]?.focus();
          }
        }}
      >
        {children}
      </div>
    </>
  );
}

export function SpaceColorPicker({
  value,
  onChange,
  name,
  id,
  disabled,
  label = "Space color",
}: {
  value: Entity["color"];
  onChange: (color: Entity["color"]) => void;
  name?: string;
  id?: string;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="space-color-picker">
      {name && <input type="hidden" name={name} value={value} />}
      <TabActionsMenu
        label={label}
        triggerId={id}
        disabled={disabled}
        triggerText={
          <>
            <span className="popup-color-value">
              <span
                className="popup-color-swatch"
                aria-hidden="true"
                style={{ background: `var(--tab-group-${value})` }}
              />
              {value[0].toUpperCase() + value.slice(1)}
            </span>
            <span aria-hidden="true">⌄</span>
          </>
        }
      >
        {colors.map((color) => (
          <button
            type="button"
            role="menuitemradio"
            key={color}
            aria-checked={value === color}
            onClick={() => onChange(color)}
          >
            <span
              className="popup-color-swatch"
              aria-hidden="true"
              style={{ background: `var(--tab-group-${color})` }}
            />
            {color[0].toUpperCase() + color.slice(1)}
          </button>
        ))}
      </TabActionsMenu>
    </div>
  );
}
function SpaceColorFormField({
  field,
  id,
  disabled,
}: {
  field: FormField;
  id: string;
  disabled: boolean;
}) {
  const [color, setColor] = useState<Entity["color"]>(
    colors.includes(field.value as Entity["color"])
      ? (field.value as Entity["color"])
      : "blue",
  );
  return (
    <SpaceColorPicker
      id={id}
      name={field.key}
      label={field.label}
      value={color}
      onChange={setColor}
      disabled={disabled}
    />
  );
}
export function NavigationIcon({
  name,
}: {
  name:
    | "home"
    | "inbox"
    | "trash"
    | "archive"
    | "settings"
    | "resources"
    | "newWindow"
    | "back"
    | "collection"
    | "site"
    | "view";
}) {
  return (
    <svg
      className="navigation-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {name === "home" ? (
        <path d="m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9" />
      ) : name === "inbox" ? (
        <path d="M4 4h16l2 12v4H2v-4L4 4ZM2 14h6l2 3h4l2-3h6" />
      ) : name === "archive" ? (
        <>
          <path d="M3 3h18v5H3zM5 8v13h14V8M9 12h6" />
        </>
      ) : name === "settings" ? (
        <>
          <path
            d="m9 3-.7 2.2-2 .9L4.2 6 2.7 8.6l1.5 1.7v2.4l-1.5 1.7L4.2 17l2.1-.1 2 .9L9 20h3l.7-2.2 2-.9 2.1.1 1.5-2.6-1.5-1.7v-2.4l1.5-1.7L16.8 6l-2.1.1-2-.9L12 3Z"
            transform="translate(1.5 .5)"
          />
          <circle cx="12" cy="12" r="3" />
        </>
      ) : name === "back" ? (
        <path d="M20 12H4m7-7-7 7 7 7" />
      ) : name === "view" ? (
        <>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      ) : name === "site" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c5 5 5 13 0 18M12 3c-5 5-5 13 0 18" />
        </>
      ) : name === "collection" ? (
        <path d="M3 7V4h6l3 3h9v13H3V7Z" />
      ) : name === "resources" ? (
        <path d="M6 3h12v18l-6-4-6 4V3Z" />
      ) : name === "newWindow" ? (
        <path d="M14 3h7v7M21 3l-9 9M10 5H3v16h16v-7" />
      ) : (
        <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
      )}
    </svg>
  );
}

export function TreeChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`tree-chevron${expanded ? " expanded" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

export function TabFavicon({
  url,
  faviconKey,
}: {
  url: string;
  faviconKey?: string;
}) {
  const [failed, setFailed] = useState("");
  const source =
    client.isExtension && /^https?:\/\//.test(url)
      ? `${chrome.runtime.getURL("/_favicon/")}?${new URLSearchParams({ pageUrl: url, size: "32", ...(faviconKey ? { v: faviconKey } : {}) })}`
      : "";
  return (
    <span className="tab-favicon" aria-hidden="true">
      {source && failed !== source ? (
        <img
          src={source}
          alt=""
          width="16"
          height="16"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(source)}
        />
      ) : (
        <NavigationIcon name="site" />
      )}
    </span>
  );
}

export function VirtualList<T extends { id: string }>({
  items,
  render,
}: {
  items: T[];
  render: (item: T) => ReactNode;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 96,
    getItemKey: (i) => items[i].id,
    overscan: 8,
    enabled: items.length > 200,
    useFlushSync: false,
  });
  if (items.length <= 200) return <>{items.map(render)}</>;
  return (
    <div
      ref={parent}
      className="virtual-list"
      tabIndex={0}
      role="list"
      aria-label={`${items.length} items; use arrow keys to scroll`}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const index = Math.max(
          0,
          Math.floor((parent.current?.scrollTop ?? 0) / 96),
        );
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          virtual.scrollToIndex(
            Math.max(
              0,
              Math.min(
                items.length - 1,
                index + (event.key === "ArrowDown" ? 1 : -1),
              ),
            ),
          );
        }
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          virtual.scrollToIndex(event.key === "Home" ? 0 : items.length - 1);
        }
      }}
    >
      <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
        {virtual.getVirtualItems().map((row) => (
          <div
            key={row.key}
            role="listitem"
            aria-posinset={row.index + 1}
            aria-setsize={items.length}
            data-index={row.index}
            ref={virtual.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${row.start}px)`,
            }}
          >
            {render(items[row.index])}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Logo() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <rect x="2" y="2" width="36" height="36" rx="12" fill="currentColor" />
      <path
        d="M12 12h16v5H12zm0 9h7v7h-7zm12 0h4v7h-4z"
        fill="var(--surface)"
      />
    </svg>
  );
}
export function Button({
  "aria-label": ariaLabel,
  "aria-pressed": ariaPressed,
  children,
  role,
  onClick,
  title,
  className = "",
  disabled = false,
}: {
  children: ReactNode;
  "aria-label"?: string;
  "aria-pressed"?: boolean;
  role?: "menuitem";
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  title?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      role={role}
      type="button"
      title={title}
      aria-label={ariaLabel ?? title}
      aria-pressed={ariaPressed}
      className={className}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function ScrollArea({
  storageKey,
  children,
}: {
  storageKey: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current)
      ref.current.scrollTop = Number(localStorage.getItem(storageKey) ?? 0);
  }, [storageKey]);
  return (
    <div
      ref={ref}
      className="pane-content"
      onScroll={(e) =>
        localStorage.setItem(storageKey, String(e.currentTarget.scrollTop))
      }
    >
      {children}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    d.showModal();
    return () => {
      d.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="dialog-title"
    >
      <header>
        <h2 id="dialog-title">{title}</h2>
        <Button title="Close dialog" onClick={onClose}>
          ×
        </Button>
      </header>
      {children}
    </dialog>
  );
}
export function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg
      className="lock-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path
        d={locked ? "M8 10V6a4 4 0 0 1 8 0v4" : "M8 10V6a4 4 0 0 1 7.5-2"}
      />
      <path d="M12 14v3" />
    </svg>
  );
}
export type FormField = {
  key: string;
  label: string;
  value?: string;
  type?:
    | "text"
    | "date"
    | "textarea"
    | "select"
    | "color"
    | "checkbox"
    | "spaceColor";
  disabled?: boolean;
  hint?: string;
  indeterminate?: boolean;
  trackChange?: boolean;
  required?: boolean;
  options?: { value: string; label: string }[];
};
export function FormDialog({
  title,
  fields,
  submit,
  onSubmit,
  onClose,
}: {
  title: string;
  fields: FormField[];
  submit: string;
  onSubmit: (values: Record<string, string>) => Promise<void>;
  onClose: () => void;
}) {
  const formId = useId();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState<Set<string>>(() => new Set());
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSubmit(
              Object.fromEntries([
                ...new FormData(e.currentTarget).entries(),
                ...fields
                  .filter((f) => f.trackChange && changed.has(f.key))
                  .map((f) => [`${f.key}Changed`, "true"]),
              ]) as Record<string, string>,
            );
            onClose();
          } catch (err) {
            setError(String(err instanceof Error ? err.message : err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {fields.map((f) => (
          <div key={f.key} className="form-field">
            <label htmlFor={`${formId}-${f.key}`}>{f.label}</label>
            {f.type === "checkbox" ? (
              <input
                id={`${formId}-${f.key}`}
                name={f.key}
                type="checkbox"
                defaultChecked={f.value === "true"}
                disabled={busy || f.disabled}
                ref={(node) => {
                  if (node)
                    node.indeterminate =
                      !!f.indeterminate && !changed.has(f.key);
                }}
                onChange={() =>
                  setChanged((previous) => new Set([...previous, f.key]))
                }
              />
            ) : f.type === "spaceColor" ? (
              <SpaceColorFormField
                field={f}
                id={`${formId}-${f.key}`}
                disabled={busy || !!f.disabled}
              />
            ) : f.type === "textarea" ? (
              <textarea
                id={`${formId}-${f.key}`}
                name={f.key}
                defaultValue={f.value}
                required={f.required}
                disabled={busy || f.disabled}
                aria-label={f.label}
                rows={5}
              />
            ) : f.type === "select" ? (
              <select
                id={`${formId}-${f.key}`}
                name={f.key}
                defaultValue={f.value}
                required={f.required}
                disabled={busy || f.disabled}
                aria-label={f.label}
              >
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`${formId}-${f.key}`}
                name={f.key}
                type={f.type ?? "text"}
                disabled={busy || f.disabled}
                defaultValue={f.value}
                required={f.required}
                maxLength={f.key === "description" ? 100000 : 20000}
              />
            )}
            {f.hint && <small className="muted">{f.hint}</small>}
          </div>
        ))}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <footer>
          <Button onClick={onClose}>Cancel</Button>
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : submit}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function Empty({
  symbol = "◇",
  title,
  children,
}: {
  symbol?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <span aria-hidden="true">{symbol}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
