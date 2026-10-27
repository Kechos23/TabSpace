import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  blankDoc,
  localDate,
  type Entity,
} from "../../../../packages/domain/model";
import { repository } from "../../../../packages/persistence/repository";
import * as client from "../client";
import {
  Button,
  Empty,
  FormDialog,
  Modal,
  TabActionsMenu,
  TreeChevron,
  VirtualList,
} from "./components";
const NoteEditor = lazy(() => import("./NoteEditor"));
const order = (a: Entity, b: Entity) =>
  a.order - b.order || a.id.localeCompare(b.id);
type Confirmation = { title: string; text: string; run: () => Promise<void> };

function AddTask({
  label,
  onAdd,
  focusRequest,
}: {
  label: string;
  focusRequest?: string;
  onAdd: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(""),
    [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (focusRequest) input.current?.focus();
  }, [focusRequest]);
  useEffect(() => {
    if (!saving && refocus.current) {
      refocus.current = false;
      if (
        document.activeElement === document.body ||
        document.activeElement === input.current
      )
        input.current?.focus();
    }
  }, [saving]);
  return (
    <form
      className="task-add"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim() || saving) return;
        setSaving(true);
        refocus.current = true;
        try {
          await onAdd(name.trim());
          setName("");
        } catch {
          /* Workspace displays the save error; retain the input. */
        } finally {
          setSaving(false);
        }
      }}
    >
      <span aria-hidden="true">+</span>
      <input
        ref={input}
        aria-label={label}
        placeholder="Add task"
        maxLength={500}
        value={name}
        disabled={saving}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.nativeEvent.isComposing)
            event.preventDefault();
        }}
      />
      {!!name.trim() && (
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Add ↵"}
        </button>
      )}
    </form>
  );
}

function TaskRow({
  task,
  selecting,
  checked,
  details,
  onSelect,
  onComplete,
  onTitle,
  onDetails,
  onMove,
  onDuplicate,
  onTrash,
  onDrop,
}: {
  task: Entity;
  selecting: boolean;
  checked: boolean;
  details: boolean;
  onSelect: () => void;
  onComplete: (completed: boolean) => Promise<void>;
  onTitle: (name: string) => Promise<void>;
  onDetails: () => void;
  onMove: () => void;
  onDuplicate: () => void;
  onTrash: () => void;
  onDrop: (event: DragEvent) => void;
}) {
  const [title, setTitle] = useState(task.name);
  const [done, setDone] = useState(!!task.completedAt),
    [completing, setCompleting] = useState(false);
  useEffect(() => setTitle(task.name), [task.name]);
  useEffect(() => setDone(!!task.completedAt), [task.completedAt]);
  return (
    <div
      className={`checklist-task ${task.completedAt ? "is-completed" : ""} ${checked && selecting ? "is-selected" : ""}`}
      data-task-id={task.id}
      draggable={!selecting}
      onDragStart={(event) => {
        event.dataTransfer.setData(
          "application/tabspace",
          JSON.stringify({ type: "entity", id: task.id }),
        );
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event) => {
        if (
          !selecting &&
          event.dataTransfer.types.includes("application/tabspace")
        ) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          event.currentTarget.classList.add("task-drop-before");
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          event.currentTarget.classList.remove("task-drop-before");
      }}
      onDrop={(event) => {
        event.currentTarget.classList.remove("task-drop-before");
        onDrop(event);
      }}
      onDragEnd={(event) =>
        event.currentTarget.classList.remove("task-drop-before")
      }
    >
      <input
        type="checkbox"
        aria-label={`${selecting ? "Select" : "Complete"} ${task.name}`}
        checked={selecting ? checked : done}
        disabled={!selecting && completing}
        onChange={async (event) => {
          if (selecting) {
            onSelect();
            return;
          }
          const next = event.currentTarget.checked;
          setDone(next);
          setCompleting(true);
          try {
            await onComplete(next);
          } catch {
            setDone(!!task.completedAt);
          } finally {
            setCompleting(false);
          }
        }}
      />
      <input
        className="checklist-title"
        aria-label={`Task title: ${task.name}`}
        value={title}
        maxLength={500}
        readOnly={selecting}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={(event) => {
          const name = event.currentTarget.value.trim();
          if (!name) setTitle(task.name);
          else if (name !== task.name) void onTitle(name).catch(() => {});
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setTitle(task.name);
            event.currentTarget.value = task.name;
            event.currentTarget.blur();
          }
        }}
      />
      {task.dueDate && (
        <span
          className={`task-date ${!task.completedAt && task.dueDate < localDate() ? "overdue" : ""}`}
          title={
            !task.completedAt && task.dueDate < localDate()
              ? "Overdue"
              : "Due date"
          }
        >
          {task.dueDate}
        </span>
      )}
      {!selecting && (
        <>
          <button
            type="button"
            className={`task-details-toggle ${details ? "active" : ""}`}
            aria-expanded={details}
            aria-label={`Details for ${task.name}`}
            onClick={onDetails}
          >
            Details
            {task.description || task.text || task.attachmentIds.length
              ? " ·"
              : ""}
          </button>
          <TabActionsMenu label={`Actions for task ${task.name}`}>
            <Button role="menuitem" onClick={onMove}>
              Move to Space or section
            </Button>
            <Button role="menuitem" onClick={onDuplicate}>
              Duplicate
            </Button>
            <Button role="menuitem" className="danger" onClick={onTrash}>
              Move to Trash
            </Button>
          </TabActionsMenu>
        </>
      )}
    </div>
  );
}

export function TasksWorkspace({
  entities,
  space,
  inboxId,
  onSaved,
  onViewSpace,
  onConfirm,
  initialTaskId,
  focusNewTask,
}: {
  entities: Entity[];
  space?: Entity;
  inboxId: string;
  onSaved: () => Promise<unknown>;
  onViewSpace: (id: string) => void;
  onConfirm: (confirmation: Confirmation) => void;
  initialTaskId?: string;
  focusNewTask?: string;
}) {
  const [filter, setFilter] = useState<"todo" | "completed">("todo"),
    [spaceFilter, setSpaceFilter] = useState("");
  const [addSpace, setAddSpace] = useState(inboxId),
    [expanded, setExpanded] = useState(initialTaskId ?? ""),
    [selecting, setSelecting] = useState(false),
    [selected, setSelected] = useState<Set<string>>(new Set());
  const [completedOpen, setCompletedOpen] = useState(false),
    [error, setError] = useState("");
  const [sectionDialog, setSectionDialog] = useState<{
      parent: string;
      section?: Entity;
    }>(),
    [moving, setMoving] = useState<Entity[]>();
  const [moveSpace, setMoveSpace] = useState(""),
    [moveSection, setMoveSection] = useState(""),
    [moveBusy, setMoveBusy] = useState(false);
  const queue = useRef(Promise.resolve());
  useEffect(() => {
    if (initialTaskId) setExpanded(initialTaskId);
  }, [initialTaskId]);
  useEffect(() => {
    if (focusNewTask) {
      setFilter("todo");
      setSelecting(false);
      setSelected(new Set());
    }
  }, [focusNewTask]);
  const index = useMemo(() => {
    const spaces = entities
      .filter((e) => e.kind === "space" && !e.deletedAt && !e.archivedAt)
      .sort(order);
    const ids = new Set(spaces.map((e) => e.id));
    const tasks = entities
      .filter((e) => e.kind === "task" && !e.deletedAt && ids.has(e.spaceId!))
      .sort(order);
    const sections = entities
      .filter(
        (e) =>
          e.kind === "section" &&
          e.sectionKind === "tasks" &&
          !e.deletedAt &&
          ids.has(e.spaceId!),
      )
      .sort(order);
    const bySpace = new Map<string, Entity[]>(),
      sectionsBySpace = new Map<string, Entity[]>();
    for (const task of tasks) {
      const list = bySpace.get(task.spaceId!) ?? [];
      list.push(task);
      bySpace.set(task.spaceId!, list);
    }
    for (const section of sections) {
      const list = sectionsBySpace.get(section.spaceId!) ?? [];
      list.push(section);
      sectionsBySpace.set(section.spaceId!, list);
    }
    return { spaces, tasks, sections, bySpace, sectionsBySpace };
  }, [entities]);
  const execute = (work: () => Promise<unknown>): Promise<void> => {
    const job = queue.current.then(async () => {
      setError("");
      await work();
      await onSaved();
    });
    queue.current = job.catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
    return job;
  };
  const act = (work: () => Promise<unknown>) => {
    void execute(work).catch(() => {});
  };
  const current = async (id: string) => {
    const row = await repository.db.entities.get(id);
    if (!row || row.deletedAt)
      throw new Error("This item is no longer available.");
    return row;
  };
  const update = (id: string, patch: Partial<Entity>) =>
    execute(async () => client.update(await current(id), patch));
  const command = async (task: Entity, type: "duplicate" | "trash") => {
    const row = await current(task.id);
    return client.command({ type, id: row.id, expectedRevision: row.revision });
  };
  const addTask = (name: string, parent: string, sectionId?: string) =>
    execute(() =>
      client.create("task", name, {
        spaceId: parent,
        sectionId,
        doc: blankDoc(),
      }),
    );
  const openMove = (rows: Entity[]) => {
    setMoving(rows);
    setMoveSpace(rows[0]?.spaceId ?? inboxId);
    setMoveSection("");
  };
  const trash = (rows: Entity[]) =>
    onConfirm({
      title:
        rows[0]?.kind === "section"
          ? "Move section and its tasks to Trash?"
          : "Move tasks to Trash?",
      text: "These items remain recoverable in Trash.",
      run: () =>
        execute(async () => {
          for (const row of rows) await command(row, "trash");
          setSelected(new Set());
        }),
    });
  const drop = (
    event: DragEvent,
    parent: string,
    sectionId?: string,
    before?: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget
      .closest(".tasks-workspace")
      ?.querySelectorAll(".task-drop-target,.task-drop-before")
      .forEach((element) =>
        element.classList.remove("task-drop-target", "task-drop-before"),
      );
    if (selecting) return;
    const raw = event.dataTransfer.getData("application/tabspace");
    if (!raw) return;
    act(async () => {
      const data = JSON.parse(raw);
      if (data.type !== "entity" || data.id === before) return;
      const source = await current(data.id);
      if (source.kind !== "task") return;
      const siblings = (await repository.list())
        .filter(
          (e) =>
            e.kind === "task" &&
            e.spaceId === parent &&
            e.sectionId === sectionId &&
            !e.deletedAt &&
            e.id !== source.id,
        )
        .sort(order);
      const at = before
        ? siblings.findIndex((e) => e.id === before)
        : siblings.length;
      const nextOrder =
        at < 0 || at === siblings.length
          ? (siblings.at(-1)?.order ?? Date.now()) + 1024
          : at === 0
            ? siblings[0].order - 1024
            : (siblings[at - 1].order + siblings[at].order) / 2;
      await client.command({
        type: "move",
        id: source.id,
        expectedRevision: source.revision,
        targetSpaceId: parent,
        targetSectionId: sectionId,
        patch: { order: nextOrder },
      });
    });
  };
  const selectedTasks = index.tasks.filter((e) => selected.has(e.id));
  const renderTask = (task: Entity) => (
    <div key={task.id} className="checklist-entry">
      <TaskRow
        task={task}
        selecting={selecting}
        checked={selected.has(task.id)}
        details={expanded === task.id}
        onSelect={() =>
          setSelected((old) => {
            const next = new Set(old);
            next.has(task.id) ? next.delete(task.id) : next.add(task.id);
            return next;
          })
        }
        onComplete={(done) =>
          update(task.id, {
            completedAt: done ? new Date().toISOString() : undefined,
          })
        }
        onTitle={(name) => update(task.id, { name })}
        onDetails={() => setExpanded(expanded === task.id ? "" : task.id)}
        onMove={() => openMove([task])}
        onDuplicate={() => act(() => command(task, "duplicate"))}
        onTrash={() => trash([task])}
        onDrop={(event) => drop(event, task.spaceId!, task.sectionId, task.id)}
      />
      {expanded === task.id && !selecting && (
        <div className="task-details" aria-label={`Task details: ${task.name}`}>
          <div className="task-detail-fields">
            <label>
              Due date
              <input
                type="date"
                aria-label={`Due date for ${task.name}`}
                value={task.dueDate ?? ""}
                onChange={(event) => {
                  const dueDate = event.currentTarget.value;
                  void update(task.id, { dueDate: dueDate || undefined }).catch(
                    () => {},
                  );
                }}
              />
            </label>
            <label className="file-button">
              Attach file
              <input
                type="file"
                aria-label={`Attach file to task ${task.name}`}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file)
                    act(async () => {
                      const attachment = await repository.attachment(
                          file,
                          file.name,
                        ),
                        row = await current(task.id);
                      await client.update(row, {
                        attachmentIds: [...row.attachmentIds, attachment.id],
                      });
                    });
                }}
              />
            </label>
            <Button onClick={() => setExpanded("")}>Close details</Button>
          </div>
          <Suspense fallback={<p role="status">Opening details…</p>}>
            <NoteEditor note={task} onSaved={() => void onSaved()} />
          </Suspense>
        </div>
      )}
    </div>
  );
  const renderSection = (
    parent: Entity,
    section: Entity | undefined,
    tasks: Entity[],
  ) => (
    <section
      key={section?.id ?? "tasks"}
      className="task-checklist"
      aria-label={section?.name ?? "Tasks"}
      data-task-section={section?.id ?? "unsectioned"}
      onDragOver={(event) => {
        if (
          !selecting &&
          event.dataTransfer.types.includes("application/tabspace")
        ) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          event.currentTarget.classList.add("task-drop-target");
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          event.currentTarget.classList.remove("task-drop-target");
      }}
      onDrop={(event) => drop(event, parent.id, section?.id)}
    >
      <header className="task-section-header">
        {section && (
          <Button
            title={
              section.collapsed
                ? "Expand task section"
                : "Collapse task section"
            }
            onClick={() => {
              void update(section.id, { collapsed: !section.collapsed }).catch(
                () => {},
              );
            }}
          >
            <TreeChevron expanded={!section.collapsed} />
          </Button>
        )}
        <h3>{section?.name ?? "Tasks"}</h3>
        <span className="task-section-count">{tasks.length}</span>
        {section && (
          <TabActionsMenu label={`Actions for task section ${section.name}`}>
            <Button
              role="menuitem"
              onClick={() => setSectionDialog({ parent: parent.id, section })}
            >
              Edit section
            </Button>
            <Button role="menuitem" onClick={() => openMove([section])}>
              Move section
            </Button>
            <Button
              role="menuitem"
              className="danger"
              onClick={() => trash([section])}
            >
              Move section to Trash
            </Button>
          </TabActionsMenu>
        )}
      </header>
      {!section?.collapsed && (
        <>
          {section?.description && (
            <p className="muted task-section-description">
              {section.description}
            </p>
          )}
          <VirtualList items={tasks} render={renderTask} />
          {space && !selecting && (
            <AddTask
              label={`Add task to ${section?.name ?? "Tasks"}`}
              onAdd={(name) => addTask(name, parent.id, section?.id)}
            />
          )}
        </>
      )}
    </section>
  );
  const parentSpaces = space
    ? [space]
    : index.spaces.filter((e) => !spaceFilter || e.id === spaceFilter);
  let rendered = 0;
  return (
    <div
      className={`tasks-workspace ${space ? "space-tasks" : "all-tasks"}`}
      onDragEnd={(event) =>
        event.currentTarget
          .querySelectorAll(".task-drop-target,.task-drop-before")
          .forEach((element) =>
            element.classList.remove("task-drop-target", "task-drop-before"),
          )
      }
    >
      {!space && (
        <>
          <div className="task-overview-filters">
            <div
              className="task-filter-tabs"
              role="group"
              aria-label="Task status"
            >
              <button
                type="button"
                aria-pressed={filter === "todo"}
                onClick={() => {
                  setFilter("todo");
                  setSelected(new Set());
                }}
              >
                To do
              </button>
              <button
                type="button"
                aria-pressed={filter === "completed"}
                onClick={() => {
                  setFilter("completed");
                  setSelected(new Set());
                }}
              >
                Completed
              </button>
            </div>
            <label>
              Space
              <select
                aria-label="Filter tasks by Space"
                value={spaceFilter}
                onChange={(event) => {
                  setSpaceFilter(event.target.value);
                  if (event.target.value) setAddSpace(event.target.value);
                  setSelected(new Set());
                }}
              >
                <option value="">All Spaces</option>
                {index.spaces.map((parent) => (
                  <option key={parent.id} value={parent.id}>
                    {parent.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {filter === "todo" && !selecting && (
            <div className="task-quick-add">
              <label>
                Save in
                <select
                  aria-label="Space for new task"
                  value={addSpace}
                  onChange={(event) => setAddSpace(event.target.value)}
                >
                  {index.spaces.map((parent) => (
                    <option key={parent.id} value={parent.id}>
                      {parent.name}
                      {parent.id === inboxId && parent.name !== "Inbox"
                        ? " · Inbox"
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
              <AddTask
                label="Add task from My Tasks"
                focusRequest={focusNewTask}
                onAdd={(name) => addTask(name, addSpace)}
              />
            </div>
          )}
        </>
      )}
      <div className="task-workspace-tools">
        <p className="muted">
          {space
            ? "Write a task and press Enter. Check it off when you're done."
            : "One checklist across your Spaces. Changes update the original task."}
        </p>
        <TabActionsMenu label="Tasks options">
          {space && (
            <Button
              role="menuitem"
              onClick={() => setSectionDialog({ parent: space.id })}
            >
              Add section
            </Button>
          )}
          <Button
            role="menuitem"
            onClick={() => {
              setSelecting(!selecting);
              setSelected(new Set());
            }}
          >
            {selecting ? "Finish selecting" : "Select tasks"}
          </Button>
        </TabActionsMenu>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {selecting && (
        <div className="task-selection-bar">
          <strong>Select tasks · {selectedTasks.length} selected</strong>
          <span>Checkboxes select items in this mode.</span>
          <Button
            disabled={!selectedTasks.length}
            onClick={() => openMove(selectedTasks)}
          >
            Move
          </Button>
          <Button
            disabled={!selectedTasks.length}
            onClick={() =>
              act(async () => {
                for (const task of selectedTasks)
                  await command(task, "duplicate");
                setSelected(new Set());
              })
            }
          >
            Duplicate
          </Button>
          <Button
            className="danger"
            disabled={!selectedTasks.length}
            onClick={() => trash(selectedTasks)}
          >
            Trash
          </Button>
          <Button
            onClick={() => {
              setSelecting(false);
              setSelected(new Set());
            }}
          >
            Done selecting
          </Button>
        </div>
      )}
      {parentSpaces.map((parent) => {
        const allTasks = index.bySpace.get(parent.id) ?? [],
          completed = allTasks.filter((e) => !!e.completedAt);
        const visible = allTasks.filter((e) =>
          space
            ? !e.completedAt
            : filter === "completed"
              ? !!e.completedAt
              : !e.completedAt,
        );
        if (!space && !visible.length) return null;
        rendered += visible.length;
        const sections = index.sectionsBySpace.get(parent.id) ?? [];
        return (
          <div
            key={parent.id}
            className="tasks-space-group"
            data-task-space={parent.id}
          >
            {!space && (
              <header className="tasks-space-header">
                <button
                  type="button"
                  onClick={() => onViewSpace(parent.id)}
                  title={`View ${parent.name} without switching tabs`}
                >
                  {parent.name}
                </button>
                <span>{visible.length}</span>
              </header>
            )}
            {[undefined, ...sections].map((section) => {
              const tasks = visible.filter((e) => e.sectionId === section?.id);
              if (!space && !tasks.length) return null;
              return renderSection(parent, section, tasks);
            })}
            {space && !!completed.length && (
              <section className="completed-task-list">
                <button
                  type="button"
                  className="completed-task-toggle"
                  aria-expanded={completedOpen}
                  onClick={() => setCompletedOpen(!completedOpen)}
                >
                  <TreeChevron expanded={completedOpen} />
                  Completed <span>{completed.length}</span>
                </button>
                {completedOpen && (
                  <VirtualList items={completed} render={renderTask} />
                )}
              </section>
            )}
          </div>
        );
      })}
      {!space && !rendered && (
        <Empty
          title={
            filter === "completed"
              ? "No completed tasks"
              : "You're all caught up"
          }
        >
          {filter === "completed"
            ? "Completed tasks from the selected Spaces will appear here."
            : "Add a task above or in any Space to get started."}
        </Empty>
      )}
      {sectionDialog && (
        <FormDialog
          title={
            sectionDialog.section ? "Edit task section" : "New task section"
          }
          fields={[
            {
              key: "name",
              label: "Name",
              value: sectionDialog.section?.name,
              required: true,
            },
            {
              key: "description",
              label: "Description (optional)",
              type: "textarea",
              value: sectionDialog.section?.description,
            },
          ]}
          submit={sectionDialog.section ? "Save section" : "Create section"}
          onClose={() => setSectionDialog(undefined)}
          onSubmit={async (values) => {
            if (sectionDialog.section)
              await update(sectionDialog.section.id, {
                name: values.name.trim(),
                description: values.description,
              });
            else
              await execute(() =>
                client.create("section", values.name.trim(), {
                  spaceId: sectionDialog.parent,
                  sectionKind: "tasks",
                  description: values.description,
                }),
              );
          }}
        />
      )}
      {moving && (
        <Modal
          title={moving[0]?.kind === "section" ? "Move section" : "Move tasks"}
          onClose={() => {
            if (!moveBusy) setMoving(undefined);
          }}
        >
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setMoveBusy(true);
              try {
                await execute(async () => {
                  for (const item of moving) {
                    const row = await current(item.id);
                    await client.command({
                      type: "move",
                      id: row.id,
                      expectedRevision: row.revision,
                      targetSpaceId: moveSpace,
                      targetSectionId: moveSection || undefined,
                    });
                  }
                  setSelected(new Set());
                });
                setMoving(undefined);
              } catch {
                /* Preserve the destination for retry. */
              } finally {
                setMoveBusy(false);
              }
            }}
          >
            <label>
              Destination Space
              <select
                aria-label="Destination Space"
                value={moveSpace}
                disabled={moveBusy}
                onChange={(event) => {
                  setMoveSpace(event.target.value);
                  setMoveSection("");
                }}
              >
                {index.spaces.map((parent) => (
                  <option key={parent.id} value={parent.id}>
                    {parent.name}
                  </option>
                ))}
              </select>
            </label>
            {moving[0]?.kind !== "section" && (
              <label>
                Section
                <select
                  aria-label="Destination task section"
                  value={moveSection}
                  disabled={moveBusy}
                  onChange={(event) => setMoveSection(event.target.value)}
                >
                  <option value="">Tasks</option>
                  {(index.sectionsBySpace.get(moveSpace) ?? []).map(
                    (section) => (
                      <option key={section.id} value={section.id}>
                        {section.name}
                      </option>
                    ),
                  )}
                </select>
              </label>
            )}
            {error && <p role="alert">{error}</p>}
            <footer>
              <Button disabled={moveBusy} onClick={() => setMoving(undefined)}>
                Cancel
              </Button>
              <button
                type="submit"
                className="primary"
                disabled={moveBusy || !moveSpace}
              >
                {moveBusy ? "Moving…" : "Move"}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
