import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { blankDoc, type Entity } from "../../../../packages/domain/model";
import * as client from "../client";
import { Button, TreeChevron } from "./components";
const NoteEditor = lazy(() => import("./NoteEditor"));
export default function NotesPane({
  space,
  notes,
  sections,
  onSaved,
  onTrash,
}: {
  space: Entity;
  notes: Entity[];
  sections: Entity[];
  onSaved: () => void;
  onTrash: (note: Entity) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const initializing = useRef(false);
  useEffect(() => {
    if (notes.length || initializing.current) return;
    initializing.current = true;
    void client
      .request<Entity>({ type: "ensureSpaceNote", spaceId: space.id })
      .then(() => {
        onSaved();
      })
      .catch((e) => {
        setError(String(e));
      })
      .finally(() => {
        initializing.current = false;
      });
  }, [notes.length, space.id]);
  const add = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const note = await client.create("note", "Untitled note", {
        spaceId: space.id,
        doc: blankDoc(),
      });
      setExpanded((previous) => ({ ...previous, [note.id]: true }));
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="notes-workspace">
      <p className="notes-hint muted">
        Write freely — Markdown shortcuts such as # headings, **bold** and -
        lists work as you type. Changes save on this device.
      </p>
      {error && (
        <p role="alert">
          {error} <Button onClick={() => void add()}>Create note</Button>
        </p>
      )}
      {!notes.length && !error && <p role="status">Preparing your note…</p>}
      {notes.map((note, index) => {
        const open = expanded[note.id] ?? index === 0;
        const section = sections.find((s) => s.id === note.sectionId);
        return (
          <section className="note-card" key={note.id} data-note-id={note.id}>
            <div className="note-card-toggle">
              <button
                type="button"
                aria-label={`${open ? "Collapse" : "Expand"} note ${note.name}`}
                aria-expanded={open}
                onClick={() =>
                  setExpanded((previous) => ({ ...previous, [note.id]: !open }))
                }
              >
                <TreeChevron expanded={open} />
                {open ? "Note" : note.name}
              </button>
              {section && <small className="muted">{section.name}</small>}
            </div>
            {open && (
              <Suspense fallback={<p role="status">Opening editor…</p>}>
                <NoteEditor
                  key={note.id}
                  note={note}
                  onSaved={onSaved}
                  onTrash={onTrash}
                  inline
                />
              </Suspense>
            )}
          </section>
        );
      })}
      <Button className="add-note" disabled={busy} onClick={() => void add()}>
        + Add note
      </Button>
    </div>
  );
}
