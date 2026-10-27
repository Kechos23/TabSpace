import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import {
  blankDoc,
  plainDoc,
  documentText,
  markdown,
  safeUrl,
  type Doc,
  type Entity,
} from "../../../../packages/domain/model";
import * as client from "../client";
import { repository } from "../../../../packages/persistence/repository";
import { Button, FormDialog, Modal, download } from "./components";
export default function NoteEditor({
  note,
  onSaved,
  inline = false,
  onTrash,
}: {
  note: Entity;
  onSaved: () => void;
  inline?: boolean;
  onTrash?: (note: Entity) => void;
}) {
  const [status, setStatus] = useState("Saved"),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(note.revision),
    [history, setHistory] = useState(false),
    [linkDialog, setLinkDialog] = useState(false),
    [focusMode, setFocusMode] = useState(false),
    [versions, setVersions] = useState<
      { id: string; revision: number; doc: Doc; createdAt: string }[]
    >([]);
  const [title, setTitle] = useState(note.name);
  const [attachments, setAttachments] = useState<
    { id: string; filename: string }[]
  >([]);
  useEffect(() => {
    let active = true;
    void repository.db.attachments.bulkGet(note.attachmentIds).then((files) => {
      if (active)
        setAttachments(
          files.flatMap((file) =>
            file ? [{ id: file.id, filename: file.filename }] : [],
          ),
        );
    });
    return () => {
      active = false;
    };
  }, [note.attachmentIds.join(":")]);
  const titleRef = useRef(note.name);
  const latest = useRef(note),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    pending = useRef<Doc | undefined>(undefined),
    saving = useRef(false),
    mounted = useRef(true),
    commandId = useRef<string | undefined>(undefined),
    session = useRef(crypto.randomUUID());
  const persistDraft = async (doc: Doc) => {
    await client.draft({
      id: `${note.id}:${session.current}`,
      noteId: note.id,
      baseRevision: latest.current.revision,
      doc,
      text: documentText(doc),
      updatedAt: new Date().toISOString(),
    });
  };
  const save = async () => {
    if (saving.current || !pending.current) return;
    saving.current = true;
    const doc = pending.current;
    pending.current = undefined;
    commandId.current ??= crypto.randomUUID();
    let succeeded = false;
    try {
      await persistDraft(doc);
      const result = await client.command(
        {
          type: "update",
          id: note.id,
          expectedRevision: latest.current.revision,
          patch: {
            ...(note.kind === "note"
              ? { name: titleRef.current.trim() || "Untitled note" }
              : {}),
            doc,
            text: documentText(doc),
            ...(note.kind === "task" ? { description: documentText(doc) } : {}),
          },
        },
        commandId.current,
      );
      latest.current = result[0];
      commandId.current = undefined;
      succeeded = true;
      const savedDraft = await repository.db.drafts.get(
        `${note.id}:${session.current}`,
      );
      if (savedDraft && JSON.stringify(savedDraft.doc) === JSON.stringify(doc))
        await repository.db.drafts.delete(savedDraft.id);
      if (mounted.current) {
        setRevision(result[0].revision);
        setError("");
        setStatus(pending.current ? "Saving…" : "Saved");
        onSaved();
      }
    } catch (e) {
      pending.current ??= doc;
      if (mounted.current) {
        setStatus("Draft preserved");
        setError(e instanceof Error ? e.message : "Save failed.");
      }
    } finally {
      saving.current = false;
      if (pending.current && succeeded && mounted.current)
        timer.current = setTimeout(() => void save(), 400);
    }
  };
  const editor = useEditor({
    shouldRerenderOnTransaction: true,
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          protocols: ["http", "https"],
          isAllowedUri: (url) => {
            try {
              safeUrl(url);
              return true;
            } catch {
              return false;
            }
          },
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
    content:
      note.doc ??
      (note.kind === "task" ? plainDoc(note.description) : blankDoc()),
    editorProps: {
      attributes: {
        "aria-label": `${note.name} content`,
        role: "textbox",
        "aria-multiline": "true",
      },
    },
    onUpdate: ({ editor }) => {
      const doc = editor.getJSON() as Doc;
      pending.current = doc;
      commandId.current = undefined;
      setStatus("Saving…");
      setError("");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), 400);
      clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(
        () =>
          void persistDraft(doc).catch(() => {
            setStatus("Unsaved");
            setError("Could not persist the draft. Export it before closing.");
          }),
        100,
      );
    },
    onBlur: () => void save(),
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      clearTimeout(draftTimer.current);
      if (pending.current)
        void persistDraft(pending.current)
          .then(() => save())
          .catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    if (!pending.current && !saving.current) {
      const content =
        note.doc ??
        (note.kind === "task" ? plainDoc(note.description) : blankDoc());
      if (
        editor &&
        editor.isInitialized &&
        !editor.isDestroyed &&
        JSON.stringify(editor.getJSON()) !== JSON.stringify(content)
      )
        editor.commands.setContent(content, {
          emitUpdate: false,
        });
      latest.current = note;
      titleRef.current = note.name;
      setTitle(note.name);
      setRevision(note.revision);
    }
  }, [note.revision, editor]);
  if (!editor) return null;
  const toolbar: [string, string, () => void, boolean?][] = [
    [
      "Heading 1",
      "H1",
      () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
      editor.isActive("heading", { level: 1 }),
    ],
    [
      "Heading 2",
      "H2",
      () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
      editor.isActive("heading", { level: 2 }),
    ],
    [
      "Bullet list",
      "• List",
      () => editor.chain().focus().toggleBulletList().run(),
      editor.isActive("bulletList"),
    ],
    [
      "Numbered list",
      "1. List",
      () => editor.chain().focus().toggleOrderedList().run(),
      editor.isActive("orderedList"),
    ],
    [
      "Checklist",
      "☑",
      () => editor.chain().focus().toggleTaskList().run(),
      editor.isActive("taskList"),
    ],
    [
      "Quote",
      "❞",
      () => editor.chain().focus().toggleBlockquote().run(),
      editor.isActive("blockquote"),
    ],
    [
      "Bold",
      "B",
      () => editor.chain().focus().toggleBold().run(),
      editor.isActive("bold"),
    ],
    [
      "Italic",
      "I",
      () => editor.chain().focus().toggleItalic().run(),
      editor.isActive("italic"),
    ],
    [
      "Underline",
      "U",
      () => editor.chain().focus().toggleUnderline().run(),
      editor.isActive("underline"),
    ],
    [
      "Strikethrough",
      "S̶",
      () => editor.chain().focus().toggleStrike().run(),
      editor.isActive("strike"),
    ],
    [
      "Inline code",
      "<>",
      () => editor.chain().focus().toggleCode().run(),
      editor.isActive("code"),
    ],
    [
      "Code block",
      "{ }",
      () => editor.chain().focus().toggleCodeBlock().run(),
      editor.isActive("codeBlock"),
    ],
    ["Link", "↗", () => setLinkDialog(true), editor.isActive("link")],
    [
      "Clear formatting",
      "Tx",
      () => editor.chain().focus().unsetAllMarks().clearNodes().run(),
    ],
    ["Undo", "↶", () => editor.chain().focus().undo().run()],
    ["Redo", "↷", () => editor.chain().focus().redo().run()],
  ];
  return (
    <div
      className={`note-editor${inline ? " inline-note-editor" : ""}${focusMode ? " editor-focus-mode" : ""}`}
    >
      {inline && (
        <div className="note-editor-header">
          <input
            className="note-title-input"
            aria-label="Note title"
            placeholder="Title"
            maxLength={500}
            value={title === "Untitled note" ? "" : title}
            onChange={(event) => {
              const value = event.target.value;
              setTitle(value);
              titleRef.current = value;
              pending.current = editor.getJSON() as Doc;
              commandId.current = undefined;
              setStatus("Saving…");
              clearTimeout(timer.current);
              timer.current = setTimeout(() => void save(), 400);
            }}
            onBlur={() => void save()}
          />
          <Button
            title={focusMode ? "Leave focus mode" : "Focus editor"}
            onClick={() => setFocusMode(!focusMode)}
          >
            {focusMode ? "↙" : "⛶"}
          </Button>
          {onTrash && (
            <Button
              title="Delete note"
              className="danger"
              onClick={() => {
                void (async () => {
                  clearTimeout(timer.current);
                  while (saving.current)
                    await new Promise((resolve) => setTimeout(resolve, 25));
                  await save();
                  if (pending.current) {
                    setError(
                      "Save your latest changes before deleting this note.",
                    );
                    return;
                  }
                  onTrash(latest.current);
                })();
              }}
            >
              ×
            </Button>
          )}
        </div>
      )}
      <div
        className="editor-toolbar"
        role="toolbar"
        aria-label="Note formatting"
      >
        {toolbar.map(([name, label, fn, active]) => (
          <button
            key={name}
            type="button"
            title={name}
            aria-label={name}
            aria-pressed={active}
            onMouseDown={(event) => event.preventDefault()}
            onClick={fn}
          >
            {label}
          </button>
        ))}
      </div>
      <EditorContent editor={editor} />
      {!!attachments.length && (
        <div className="note-attachments">
          {attachments.map((file) => (
            <Button
              key={file.id}
              title={`Download ${file.filename}`}
              onClick={() => {
                void repository.db.attachments.get(file.id).then((item) => {
                  if (item) download(item.blob, item.filename);
                });
              }}
            >
              ↧ {file.filename}
            </Button>
          ))}
        </div>
      )}
      <div className="editor-footer">
        <span className="editor-status" role="status">
          {status === "Saved" ? "Saved locally" : status}
        </span>
        {!inline && (
          <Button
            title={focusMode ? "Leave focus mode" : "Focus editor"}
            onClick={() => setFocusMode(!focusMode)}
          >
            {focusMode ? "Leave focus" : "Focus mode"}
          </Button>
        )}
        <Button
          onClick={() =>
            download(
              new Blob([markdown(editor.getJSON() as Doc)], {
                type: "text/markdown",
              }),
              `${titleRef.current.trim() || "Untitled note"}.md`,
            )
          }
        >
          Export .md
        </Button>
        <Button
          onClick={() => {
            void repository.db.revisions
              .where("noteId")
              .equals(note.id)
              .reverse()
              .toArray()
              .then((v) => {
                setVersions(v);
                setHistory(true);
              });
          }}
        >
          History
        </Button>
      </div>
      {error && (
        <div className="error" role="alert">
          <p>{error}</p>
          <Button
            onClick={() => {
              setError("");
              void save();
            }}
          >
            Retry save
          </Button>
          <Button
            onClick={() => {
              void client
                .create(
                  note.kind === "task" ? "task" : "note",
                  `${note.name} recovered draft`,
                  {
                    spaceId: note.spaceId,
                    doc: editor.getJSON() as Doc,
                    ...(note.kind === "task"
                      ? { description: documentText(editor.getJSON() as Doc) }
                      : {}),
                  },
                )
                .then(onSaved);
            }}
          >
            Save as separate {note.kind === "task" ? "task" : "note"}
          </Button>
        </div>
      )}
      {linkDialog && (
        <FormDialog
          title="Add a safe link"
          fields={[
            { key: "url", label: "URL (http or https)", required: true },
          ]}
          submit="Add link"
          onClose={() => setLinkDialog(false)}
          onSubmit={async (v) => {
            editor
              .chain()
              .focus()
              .setLink({ href: safeUrl(v.url) })
              .run();
          }}
        />
      )}
      {history && (
        <Modal title="Note revisions" onClose={() => setHistory(false)}>
          {versions.length ? (
            versions.map((v) => (
              <div className="card" key={v.id}>
                <strong>Revision {v.revision}</strong>
                <small>{new Date(v.createdAt).toLocaleString()}</small>
                <p>{documentText(v.doc).slice(0, 300)}</p>
                <Button
                  onClick={() => {
                    editor.commands.setContent(v.doc);
                    pending.current = v.doc;
                    setStatus("Saving…");
                    void save();
                    setHistory(false);
                  }}
                >
                  Restore content
                </Button>
              </div>
            ))
          ) : (
            <p>Earlier content appears here after the first edit.</p>
          )}
        </Modal>
      )}
    </div>
  );
}
