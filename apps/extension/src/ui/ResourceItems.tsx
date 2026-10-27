import { useEffect, useRef, useState } from "react";
import type { Entity, LiveTab } from "../../../../packages/domain/model";
import { repository } from "../../../../packages/persistence/repository";
import { Button, Modal, TabActionsMenu, TabFavicon } from "./components";

const host = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};
const fileType = (name: string) =>
  name.includes(".")
    ? name.split(".").at(-1)!.toUpperCase().slice(0, 12)
    : "File";
const sizeLabel = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${Math.ceil(bytes / 1024)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;

export function ResourceAddMenu({
  tabs,
  onLink,
  onFile,
  onSaveTabs,
}: {
  tabs: LiveTab[];
  onLink: () => void;
  onFile: (file: File) => void;
  onSaveTabs: (ids: number[]) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false),
    [selected, setSelected] = useState<Set<number>>(new Set()),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const candidates = tabs.filter((tab) => /^https?:\/\//i.test(tab.url));
  return (
    <>
      <TabActionsMenu label="Add resource" triggerText="+ Add">
        <Button role="menuitem" onClick={onLink}>
          Add link
        </Button>
        <Button role="menuitem" onClick={() => input.current?.click()}>
          Add file
        </Button>
        <Button
          role="menuitem"
          disabled={!candidates.length}
          onClick={() => {
            setSelected(new Set());
            setError("");
            setPicking(true);
          }}
        >
          Save from open tabs
        </Button>
      </TabActionsMenu>
      <input
        ref={input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label="Add resource file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onFile(file);
        }}
      />
      {picking && (
        <Modal
          title="Save from open tabs"
          onClose={() => {
            if (!saving) setPicking(false);
          }}
        >
          <p className="muted">
            Choose links to keep in this Space. The original tabs stay open.
          </p>
          <div className="resource-tab-picker">
            {candidates.map((tab) => (
              <label key={tab.id} className="resource-picker-row">
                <input
                  type="checkbox"
                  checked={selected.has(tab.id)}
                  disabled={saving}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(tab.id)) next.delete(tab.id);
                      else next.add(tab.id);
                      return next;
                    })
                  }
                />
                <TabFavicon url={tab.url} faviconKey={tab.faviconKey} />
                <span>
                  <strong>{tab.title || host(tab.url)}</strong>
                  <small>{host(tab.url)}</small>
                </span>
              </label>
            ))}
          </div>
          {error && <p role="alert">{error}</p>}
          <footer>
            <Button disabled={saving} onClick={() => setPicking(false)}>
              Cancel
            </Button>
            <Button
              className="primary"
              disabled={saving || !selected.size}
              onClick={async () => {
                setSaving(true);
                setError("");
                try {
                  await onSaveTabs([...selected]);
                  setPicking(false);
                } catch (error) {
                  setError(
                    error instanceof Error ? error.message : String(error),
                  );
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving
                ? "Saving…"
                : `Save ${selected.size || ""} ${selected.size === 1 ? "link" : "links"}`}
            </Button>
          </footer>
        </Modal>
      )}
    </>
  );
}

export function ResourceRow({
  item,
  selected,
  isOpen,
  faviconKey,
  onSelect,
  onOpen,
  onOpenCopy,
  onDownload,
  onEdit,
  onMove,
  onDuplicate,
  onAttach,
  onEarlier,
  onTrash,
}: {
  item: Entity;
  selected: boolean;
  isOpen: boolean;
  faviconKey?: string;
  onSelect: () => void;
  onOpen: () => void;
  onOpenCopy: () => void;
  onDownload: (id: string) => void;
  onEdit: () => void;
  onMove: () => void;
  onDuplicate: () => void;
  onAttach: (file: File) => void;
  onEarlier: () => void;
  onTrash: () => void;
}) {
  const [files, setFiles] = useState<
    { id: string; filename: string; size: number }[]
  >([]);
  const attachmentKey = item.attachmentIds.join(",");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    void repository.db.attachments
      .bulkGet(item.attachmentIds)
      .then((rows) => {
        if (active)
          setFiles(
            rows.flatMap((row) =>
              row
                ? [{ id: row.id, filename: row.filename, size: row.size }]
                : [],
            ),
          );
      })
      .catch(() => {
        if (active) setFiles([]);
      });
    return () => {
      active = false;
    };
  }, [attachmentKey]);
  const first = files[0];
  return (
    <div
      className={`resource-row ${selected ? "selected" : ""}`}
      data-resource-id={item.id}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(
          "application/tabspace",
          JSON.stringify({ type: "entity", id: item.id }),
        );
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <input
        type="checkbox"
        aria-label={`Select ${item.name}`}
        checked={selected}
        onChange={onSelect}
      />
      {item.url ? (
        <TabFavicon url={item.url} faviconKey={faviconKey} />
      ) : (
        <svg
          className="resource-file-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 3h9l5 5v13H5V3Z M14 3v6h5 M8 13h8 M8 17h6" />
        </svg>
      )}
      <div className="resource-main">
        <button
          type="button"
          className="resource-title"
          title={item.url ? `Open ${item.name}` : `Download ${item.name}`}
          disabled={!item.url && !item.attachmentIds.length}
          onClick={item.url ? onOpen : () => onDownload(item.attachmentIds[0])}
        >
          {item.name}
        </button>
        <small>
          {item.url
            ? host(item.url)
            : first
              ? `${fileType(first.filename)} · ${sizeLabel(first.size)} · Stored locally`
              : "Local file"}
        </small>
        {item.description && (
          <p className="item-description">{item.description.slice(0, 200)}</p>
        )}
        {files
          .filter((_, index) => !!item.url || index > 0)
          .map((file) => (
            <button
              key={file.id}
              type="button"
              className="resource-attachment"
              onClick={() => onDownload(file.id)}
            >
              ↓ {file.filename} <small>{sizeLabel(file.size)}</small>
            </button>
          ))}
      </div>
      {isOpen && (
        <span
          className="badge resource-open"
          title="This link is open in Chrome"
        >
          Open
        </span>
      )}
      <TabActionsMenu label={`Actions for ${item.name}`}>
        {item.url && (
          <Button role="menuitem" onClick={onOpenCopy}>
            Open copy
          </Button>
        )}
        <Button role="menuitem" onClick={onEdit}>
          Edit
        </Button>
        <Button role="menuitem" onClick={onMove}>
          Move to Space
        </Button>
        <Button role="menuitem" onClick={onDuplicate}>
          Duplicate
        </Button>
        <Button role="menuitem" onClick={() => input.current?.click()}>
          Attach file
        </Button>
        <Button role="menuitem" onClick={onEarlier}>
          Move earlier
        </Button>
        <Button role="menuitem" className="danger" onClick={onTrash}>
          Move to Trash
        </Button>
      </TabActionsMenu>
      <input
        ref={input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label={`Attach file to ${item.name}`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onAttach(file);
        }}
      />
    </div>
  );
}
