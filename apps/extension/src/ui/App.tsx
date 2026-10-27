import {
  lazy,
  Fragment,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  blankDoc,
  plainDoc,
  colors,
  entity,
  localDate,
  safeUrl,
  views,
  type Entity,
  type View,
  type Snapshot,
} from "../../../../packages/domain/model";
import { SearchIndex } from "../../../../packages/search/index";
import { repository } from "../../../../packages/persistence/repository";
import {
  exportBackup,
  parseBackup,
} from "../../../../packages/persistence/backup";
import * as client from "../client";
import { panelNavigationKey, type PanelNavigation } from "../panel-navigation";
import { Home } from "./Home";
import { Settings } from "./Settings";
import { syncPageIcon } from "./theme-icon";
import { GroupedTabs } from "./GroupedTabs";
import { Recovery } from "./Recovery";
import { ResourceAddMenu, ResourceRow } from "./ResourceItems";
import { TasksWorkspace } from "./TasksWorkspace";
import { hasPersonalContent } from "../../../../packages/domain/browsing";
import {
  Button,
  VirtualList,
  Empty,
  FormDialog,
  LockIcon,
  SpaceIcon,
  CurrentSpaceBadge,
  Logo,
  NavigationIcon,
  TreeChevron,
  TabFavicon,
  TabActionsMenu,
  Modal,
  ScrollArea,
  download,
  type FormField,
} from "./components";

const NotesPane = lazy(() => import("./NotesPane"));
const NoteEditor = lazy(() => import("./NoteEditor"));
type Dialog = {
  title: string;
  fields: FormField[];
  submit: string;
  onSubmit: (values: Record<string, string>) => Promise<void>;
};
type Route =
  | "home"
  | "space"
  | "tasks"
  | "search"
  | "recovery"
  | "settings"
  | "archive"
  | "trash";
const viewName = (v: View) => v[0].toUpperCase() + v.slice(1);
const kindName = (kind: Entity["kind"]) =>
  kind === "sidebar" ? "collection" : kind;
const symbols: Record<View, ReactNode> = {
  tabs: "▱",
  resources: <NavigationIcon name="resources" />,
  notes: "▤",
  tasks: "✓",
};
const sort = (a: Entity, b: Entity) =>
  a.order - b.order || a.id.localeCompare(b.id);
const nameField = (value = ""): FormField => ({
  key: "name",
  label: "Name",
  value,
  required: true,
});
const readStringList = (key: string): string[] => {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value)
      ? value.filter((v) => typeof v === "string").slice(0, 1000)
      : [];
  } catch {
    return [];
  }
};
const initialSpace = () =>
  new URLSearchParams(location.search).get("space") ??
  localStorage.getItem("lastSpace") ??
  "";

export function App() {
  useEffect(() => {
    const clear = () => {
      document.body.classList.remove("tabspace-dragging");
      document
        .querySelectorAll(
          ".space-tree.drop-target, .sidebar-section.drop-target, [data-drop-saved].drop-target",
        )
        .forEach((element) =>
          element.classList.remove("drop-target", "drop-copy"),
        );
    };
    const start = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("application/tabspace")) {
        event.dataTransfer.effectAllowed = "copyMove";
        document.body.classList.add("tabspace-dragging");
      }
    };
    document.addEventListener("dragstart", start);
    document.addEventListener("dragend", clear);
    document.addEventListener("drop", clear);
    window.addEventListener("blur", clear);
    return () => {
      clear();
      document.removeEventListener("dragstart", start);
      document.removeEventListener("dragend", clear);
      document.removeEventListener("drop", clear);
      window.removeEventListener("blur", clear);
    };
  }, []);
  const [state, setState] = useState<client.State>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(0),
    [route, setRoute] = useState<Route>(() =>
      history.state?.tabspace === "view"
        ? history.state.route
        : !new URLSearchParams(location.search).has("space") &&
            !/popup|sidepanel|newtab/.test(location.pathname)
          ? "home"
          : "space",
    ),
    [spaceId, setSpaceId] = useState(
      new URLSearchParams(location.search).get("space") ??
        localStorage.getItem("lastSpace") ??
        "",
    ),
    [dialog, setDialog] = useState<Dialog>(),
    [inspect, setInspect] = useState<Entity>(),
    [confirm, setConfirm] = useState<{
      title: string;
      text: string;
      run: () => Promise<void>;
    }>(),
    [selected, setSelected] = useState<Set<string>>(
      () => new Set(readStringList(`selection:${initialSpace()}`)),
    ),
    [favoritesOpen, setFavoritesOpen] = useState(
      () => localStorage.getItem("favoritesOpen") !== "false",
    ),
    [query, setQuery] = useState(""),
    [expandedSpaces, setExpandedSpaces] = useState<Record<string, boolean>>({}),
    [panelDetail, setPanelDetail] = useState(false),
    [panelView, setPanelView] = useState<View>("tabs"),
    [panelTaskFocus, setPanelTaskFocus] = useState<string>(),
    [searchType, setSearchType] = useState(""),
    [searchSpace, setSearchSpace] = useState(""),
    [searchSection, setSearchSection] = useState(""),
    [searchDomain, setSearchDomain] = useState(""),
    [searchTask, setSearchTask] = useState(""),
    [searchArchived, setSearchArchived] = useState(false),
    [searchDueFrom, setSearchDueFrom] = useState(""),
    [searchDueTo, setSearchDueTo] = useState(""),
    [clockNow, setClockNow] = useState(() => new Date()),
    [backgroundImage, setBackgroundImage] = useState(""),
    [historySearch, setHistorySearch] = useState(false),
    [palette, setPalette] = useState(false),
    [expandedNote, setExpandedNote] = useState(""),
    [expandedTask, setExpandedTask] = useState(""),
    [fieldManager, setFieldManager] = useState(false),
    [listLimit, setListLimit] = useState(100),
    [importPreview, setImportPreview] = useState<
      Awaited<ReturnType<typeof parseBackup>> & { file: File }
    >(),
    [restorePreview, setRestorePreview] = useState<string>(),
    [restoreSnapshot, setRestoreSnapshot] = useState<Snapshot>(),
    [restoreError, setRestoreError] = useState(""),
    [restoreRetry, setRestoreRetry] = useState(0),
    [restorePage, setRestorePage] = useState(0),
    [restoreIndices, setRestoreIndices] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (/popup|sidepanel|newtab/.test(location.pathname)) return;
    const viewUrl = location.href;
    const homeUrl = new URL(location.href);
    homeUrl.searchParams.delete("space");
    if (route === "home") {
      if (history.state?.tabspace === "view") {
        history.back();
      } else {
        history.replaceState({ tabspace: "home" }, "", homeUrl);
      }
    } else if (history.state?.tabspace === "view") {
      history.replaceState({ tabspace: "view", route }, "");
    } else {
      history.replaceState({ tabspace: "home" }, "", homeUrl);
      history.pushState({ tabspace: "view", route }, "", viewUrl);
    }
  }, [route]);
  useEffect(() => {
    if (/popup|sidepanel|newtab/.test(location.pathname)) return;
    const backHome = (event: PopStateEvent) => {
      setDialog(undefined);
      setInspect(undefined);
      setConfirm(undefined);
      setPalette(false);
      setRoute(event.state?.tabspace === "view" ? event.state.route : "home");
    };
    window.addEventListener("popstate", backHome);
    return () => window.removeEventListener("popstate", backHome);
  }, []);
  const searchRef = useRef<HTMLInputElement>(null),
    tabSelectionAnchor = useRef<number | undefined>(undefined),
    operationQueue = useRef<Promise<unknown>>(Promise.resolve());
  const stateRef = useRef(state);
  const [presentation, setPresentation] = useState<
    Record<string, Partial<Entity>>
  >({});
  const [settingsEdits, setSettingsEdits] = useState<
    Partial<client.State["settings"]>
  >({});
  const settingsEditSequence = useRef(0);
  const presentationSequence = useRef(new Map<string, number>());
  const presentationPending = useRef(new Map<string, Partial<Entity>>());
  const loading = useRef<Promise<void> | undefined>(undefined);
  const refreshAgain = useRef(false);
  const forceRefresh = useRef(false);
  const recoveryMode = historySearch && (palette || route === "search");
  const recoveryRef = useRef(recoveryMode);
  recoveryRef.current = recoveryMode;
  const publish = useCallback(
    (
      next:
        | client.State
        | ((previous: client.State | undefined) => client.State | undefined),
    ) => {
      stateRef.current =
        typeof next === "function" ? next(stateRef.current) : next;
      setState(stateRef.current);
    },
    [],
  );
  const surface = location.pathname.includes("popup")
    ? "popup"
    : location.pathname.includes("sidepanel")
      ? "panel"
      : location.pathname.includes("newtab")
        ? "newtab"
        : "manager";
  useEffect(() => {
    if (
      surface !== "panel" ||
      !client.isExtension ||
      state?.currentWindowId === undefined
    )
      return;
    const key = panelNavigationKey(state.currentWindowId);
    let disposed = false;
    const handled = new Set<string>();
    const apply = (raw: unknown) => {
      if (disposed || !raw || typeof raw !== "object") return;
      const command = raw as Partial<PanelNavigation>;
      if (
        typeof command.requestId !== "string" ||
        !["tasks", "spaces"].includes(command.destination ?? "") ||
        handled.has(command.requestId)
      )
        return;
      handled.add(command.requestId);
      setPalette(false);
      if (command.destination === "tasks") {
        setRoute("tasks");
        setPanelDetail(true);
        setPanelTaskFocus(command.requestId);
      } else setPanelDetail(false);
      void chrome.storage.session.remove(key).catch(() => undefined);
    };
    const changed = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === "session") apply(changes[key]?.newValue);
    };
    chrome.storage.onChanged.addListener(changed);
    void chrome.storage.session
      .get(key)
      .then((values) => apply(values[key]))
      .catch(() => undefined);
    return () => {
      disposed = true;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, [surface, state?.currentWindowId]);
  const windowSpaceId = state?.sessions.find(
    (s) => s.windowId === state.currentWindowId && !s.parked,
  )?.spaceId;
  const refresh = useCallback(
    (force = false, changed = false): Promise<void> => {
      forceRefresh.current ||= force;
      if (loading.current) {
        refreshAgain.current ||= changed || force;
        return loading.current;
      }
      loading.current = (async () => {
        do {
          refreshAgain.current = false;
          const force = forceRefresh.current;
          forceRefresh.current = false;
          const recovery = recoveryRef.current;
          try {
            const result = await client.loadView(
              stateRef.current,
              recovery,
              force,
            );
            publish((previous) => {
              if (
                !previous ||
                previous === result ||
                previous.collectionGeneration !== result.collectionGeneration
              )
                return result;
              const current = new Map(previous.entities.map((e) => [e.id, e]));
              return {
                ...result,
                entities: result.entities.map((row) => {
                  const newer = current.get(row.id);
                  return newer && newer.revision > row.revision ? newer : row;
                }),
              };
            });
            setError("");
            refreshAgain.current ||= recovery !== recoveryRef.current;
          } catch (e) {
            setError(
              e instanceof Error ? e.message : "Could not load local data.",
            );
          }
        } while (refreshAgain.current);
      })().finally(() => {
        loading.current = undefined;
      });
      return loading.current;
    },
    [publish],
  );
  const run = useCallback(
    (work: () => Promise<unknown>) => {
      const job = async () => {
        setBusy((n) => n + 1);
        try {
          await work();
          await refresh();
        } catch (e) {
          setError(
            e instanceof Error ? e.message : "Could not complete the action.",
          );
        } finally {
          setBusy((n) => n - 1);
        }
      };
      const result = operationQueue.current.then(job, job);
      operationQueue.current = result;
      return result;
    },
    [refresh],
  );
  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = (message: { type?: string; entities?: Entity[] }) => {
      if (message.type !== "tabspace:changed") return;
      if (message.entities?.length && stateRef.current) {
        const updates = new Map(message.entities.map((e) => [e.id, e]));
        publish(
          (previous) =>
            previous && {
              ...previous,
              viewVersion: undefined,
              entities: previous.entities.map((e) => {
                const next = updates.get(e.id);
                return next && next.revision > e.revision ? next : e;
              }),
            },
        );
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(false, true), 100);
    };
    if (client.isExtension) chrome.runtime.onMessage.addListener(changed);
    return () => {
      clearInterval(id);
      if (timer) clearTimeout(timer);
      if (client.isExtension) chrome.runtime.onMessage.removeListener(changed);
    };
  }, [refresh, publish]);
  useEffect(() => {
    void refresh();
  }, [recoveryMode, refresh]);
  useEffect(() => {
    let active = true;
    setRestoreSnapshot(undefined);
    setRestoreError("");
    setRestoreIndices(new Set());
    setRestorePage(0);
    if (restorePreview)
      void client
        .recoverySnapshot(restorePreview)
        .then((snapshot) => {
          if (active) {
            setRestoreSnapshot(snapshot);
            setRestoreIndices(new Set(snapshot.tabs.map((_, i) => i)));
          }
        })
        .catch((error) => {
          if (active)
            setRestoreError(
              error instanceof Error
                ? error.message
                : "Could not load checkpoint.",
            );
        });
    return () => {
      active = false;
    };
  }, [restorePreview, restoreRetry]);
  useEffect(() => {
    const id = setInterval(() => setClockNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    let cancelled = false,
      objectUrl = "";
    setBackgroundImage("");
    const id = state?.settings.backgroundAttachmentId;
    if (id)
      void repository.db.attachments
        .get(id)
        .then((a) => {
          if (a && !cancelled) {
            objectUrl = URL.createObjectURL(a.blob);
            setBackgroundImage(objectUrl);
          }
        })
        .catch(() => setError("Could not load the local background image."));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [state?.settings.backgroundAttachmentId]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
      if (e.key === "Escape") {
        setPalette(false);
        setSelected(new Set());
      }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
  useEffect(() => {
    if (!state) return;
    document.documentElement.dataset.theme = state.settings.theme;
    document.documentElement.dataset.colorTheme = state.settings.colorTheme;
    document.documentElement.style.setProperty(
      "--sidebar-width",
      `${state.settings.sidebarWidth}px`,
    );
  }, [state?.settings]);
  const iconSpace =
    surface === "manager"
      ? state?.entities.find((item) => item.id === windowSpaceId)
      : undefined;
  useEffect(() => {
    if (!state) return;
    if (surface === "manager" && client.isExtension) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      syncPageIcon(
        state.settings.colorTheme,
        iconSpace,
        state.inboxId,
        media.matches ? "dark" : "light",
      );
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [
    state?.settings.colorTheme,
    state?.inboxId,
    surface,
    iconSpace?.id,
    iconSpace?.color,
    iconSpace?.temporary,
    iconSpace?.deletedAt,
    iconSpace?.archivedAt,
  ]);
  const all = useMemo(() => {
      return (state?.entities ?? []).map((e) =>
        presentation[e.id] ? { ...e, ...presentation[e.id] } : e,
      );
    }, [state?.entities, presentation]),
    spaces = all
      .filter((e) => e.kind === "space" && !e.deletedAt && !e.archivedAt)
      .sort(sort);
  const savedSpaces = spaces.filter(
    (item) => item.id !== state?.inboxId && !item.temporary,
  );
  const unsavedSpaces = spaces.filter((item) => item.temporary);
  const openUnsaved = unsavedSpaces.filter(
    (item) =>
      !item.browsingClosedAt ||
      state?.sessions.some((binding) => binding.spaceId === item.id),
  );
  const closedUnsaved = unsavedSpaces
    .filter((item) => !openUnsaved.some((open) => open.id === item.id))
    .sort((a, b) =>
      (b.browsingClosedAt ?? "").localeCompare(a.browsingClosedAt ?? ""),
    );
  const chosenSpace =
    all.find((e) => e.id === spaceId && !e.deletedAt) ?? spaces[0];
  const space =
    chosenSpace && chosenSpace.id === state?.inboxId
      ? {
          ...chosenSpace,
          view:
            chosenSpace.view === "tabs"
              ? ("resources" as const)
              : chosenSpace.view,
          rightView:
            chosenSpace.rightView === "tabs"
              ? ("tasks" as const)
              : chosenSpace.rightView,
        }
      : chosenSpace;
  useEffect(() => {
    if (space && route === "space") {
      localStorage.setItem("lastSpace", space.id);
      if (!spaceId) setSpaceId(space.id);
    }
  }, [space?.id, route]);
  useEffect(() => {
    if (space?.id && route === "space")
      localStorage.setItem(
        `selection:${space.id}`,
        JSON.stringify([...selected].filter((id) => !id.startsWith("tab:"))),
      );
  }, [space?.id, selected, route]);
  const index = useMemo(() => new SearchIndex(), []);
  useMemo(
    () =>
      (palette || route === "search") &&
      index.update(
        all,
        state?.browser.tabs ?? [],
        state?.snapshots ?? [],
        historySearch,
      ),
    [
      all,
      state?.browser,
      state?.snapshots,
      historySearch,
      index,
      palette,
      route,
    ],
  );
  const hits =
    palette || route === "search"
      ? index.search(query, {
          kind: searchType || undefined,
          spaceId: searchSpace || undefined,
          sectionId: searchSection || undefined,
          domain: searchDomain || undefined,
          taskState: searchTask || undefined,
          archived: searchArchived,
          dueFrom: searchDueFrom || undefined,
          dueTo: searchDueTo || undefined,
        })
      : [];
  const navigate = (
    id: string,
    activate = id !== state?.inboxId &&
      state?.entities.some((e) => e.id === id && e.kind === "space"),
  ) => {
    const select = () => {
      tabSelectionAnchor.current = undefined;
      setSpaceId(id);
      setRoute("space");
      setSelected(new Set(readStringList(`selection:${id}`)));
      setListLimit(100);
      if (surface === "panel") {
        setPanelDetail(!activate);
        setPanelView(id === state?.inboxId ? "resources" : "tabs");
      }
    };
    if (client.isExtension && activate) {
      void run(async () => {
        await client.browser("activateSession", {
          spaceId: id,
          windowId: state?.currentWindowId,
        });
        select();
      });
    } else select();
  };
  const highlightedSpaceId =
    route === "space" && space?.kind === "space" ? space.id : windowSpaceId;
  const active = (e: Entity) => e.id === highlightedSpaceId;
  const change = (e: Entity, patch: Partial<Entity>) => {
    if (
      !Object.keys(patch).length ||
      Object.keys(patch).some(
        (key) =>
          !["view", "rightView", "split", "splitRatio", "collapsed"].includes(
            key,
          ),
      )
    )
      return run(() => client.update(e, patch));
    const sequence = (presentationSequence.current.get(e.id) ?? 0) + 1;
    presentationSequence.current.set(e.id, sequence);
    const desired = { ...presentationPending.current.get(e.id), ...patch };
    presentationPending.current.set(e.id, desired);
    setPresentation((previous) => ({ ...previous, [e.id]: desired }));
    setBusy((n) => n + 1);
    const job = async () => {
      try {
        const current = stateRef.current?.entities.find(
          (row) => row.id === e.id,
        );
        if (!current) throw new Error("Item no longer exists.");
        const [saved] = await client.command({
          type: "presentation",
          id: e.id,
          expectedRevision: current.revision,
          patch: desired,
        });
        publish(
          (previous) =>
            previous && {
              ...previous,
              viewVersion: undefined,
              entities: previous.entities.map((row) =>
                row.id === saved.id && saved.revision >= row.revision
                  ? saved
                  : row,
              ),
            },
        );
      } catch (error) {
        await refresh();
        setError(
          error instanceof Error
            ? error.message
            : "Could not save the view preference.",
        );
      } finally {
        if (presentationSequence.current.get(e.id) === sequence) {
          presentationPending.current.delete(e.id);
          setPresentation((previous) => {
            const next = { ...previous };
            delete next[e.id];
            return next;
          });
        }
        setBusy((n) => n - 1);
      }
    };
    const result = operationQueue.current.then(job, job);
    operationQueue.current = result;
    return result;
  };
  const dialogFor = (data: Dialog) =>
    setDialog({
      ...data,
      onSubmit: async (values) => {
        await data.onSubmit(values);
        await refresh();
      },
    });
  const spaceFields = (
    item?: Entity,
    saving = false,
    destination = item?.sidebarId,
  ): FormField[] => {
    const tabs = item ? (state?.spaceTabs[item.id] ?? []) : [];
    const locked = tabs.filter((tab) => tab.lockId).length;
    const unavailable =
      !saving && (!item || item.temporary || item.id === state?.inboxId);
    return [
      nameField(item?.name),
      {
        key: "color",
        label: "Space color",
        type: "spaceColor",
        value: item?.color ?? "blue",
      },
      {
        key: "lockTabs",
        label: "Lock current tabs in Space",
        type: "checkbox",
        value: String(
          saving
            ? (state?.settings.lockTabsByDefault ?? false)
            : tabs.length > 0 && locked === tabs.length,
        ),
        indeterminate: !saving && locked > 0 && locked < tabs.length,
        trackChange: true,
        disabled: unavailable,
        hint: unavailable
          ? item?.temporary
            ? "Available after saving this Space."
            : "Available when this Space has browsing tabs."
          : undefined,
      },
      {
        key: "collection",
        label: "Collection",
        type: "select",
        value: destination ?? "",
        disabled: !saving && (item?.temporary || item?.id === state?.inboxId),
        hint:
          !saving && item?.temporary
            ? "Save this Space to put it in a collection."
            : undefined,
        options: [
          { value: "", label: "No collection" },
          ...all
            .filter(
              (entry) =>
                entry.kind === "sidebar" &&
                !entry.deletedAt &&
                !entry.archivedAt,
            )
            .sort(sort)
            .map((entry) => ({ value: entry.id, label: entry.name })),
        ],
      },
    ];
  };
  const editSpace = (item: Entity) =>
    dialogFor({
      title: `Edit ${kindName(item.kind)}`,
      fields: [
        ...spaceFields(item),
        {
          key: "description",
          label: "Description",
          type: "textarea",
          value: item.description,
        },
      ],
      submit: "Save changes",
      onSubmit: async (values) => {
        await client.update(item, {
          name: values.name.trim(),
          color: values.color as Entity["color"],
          description: values.description,
          ...(!item.temporary && item.id !== state?.inboxId
            ? { sidebarId: values.collection || undefined }
            : {}),
        });
        if (
          values.lockTabsChanged === "true" &&
          !item.temporary &&
          item.id !== state?.inboxId
        )
          await client.browser("setTabLock", {
            spaceId: item.id,
            locked: values.lockTabs === "on",
            all: true,
          });
      },
    });
  const saveSpace = (
    item: Entity,
    destination = item.sidebarId,
    order?: number,
  ) =>
    dialogFor({
      title: "Save Space",
      fields: spaceFields(item, true, destination),
      submit: "Save Space",
      onSubmit: async (values) => {
        await client.update(item, {
          name: values.name.trim(),
          temporary: false,
          color: values.color as Entity["color"],
          browsingClosedAt: undefined,
          sidebarId: values.collection || undefined,
          ...(order !== undefined ? { order } : {}),
        });
        if (values.lockTabs === "on")
          await client.browser("setTabLock", {
            spaceId: item.id,
            locked: true,
            all: true,
          });
      },
    });
  const newSpace = () =>
    dialogFor({
      title: "New Space",
      fields: [
        ...spaceFields(),
        { key: "description", label: "Description", type: "textarea" },
      ],
      submit: "Create Space",
      onSubmit: async (v) => {
        const e = await client.create("space", v.name.trim(), {
          description: v.description,
          temporary: false,
          color: v.color as Entity["color"],
          sidebarId: v.collection || undefined,
        });
        navigate(e.id, true);
      },
    });
  const addSection = (sidebar = false, view?: View) =>
    dialogFor({
      title: sidebar ? "New collection" : "New content section",
      fields: [
        nameField(),
        { key: "description", label: "Description", type: "textarea" },
      ],
      submit: sidebar ? "Create collection" : "Create section",
      onSubmit: async (v) => {
        await client.create(sidebar ? "sidebar" : "section", v.name.trim(), {
          description: v.description,
          ...(sidebar
            ? {}
            : {
                spaceId: space!.id,
                sectionKind: view as "resources" | "notes" | "tasks",
              }),
        });
      },
    });
  const addItem = (view: View, sectionId?: string) => {
    if (!space) return;
    if (view === "tabs") {
      dialogFor({
        title: "Open website",
        fields: [{ key: "url", label: "Website URL", required: true }],
        submit: "Open tab",
        onSubmit: async (v) => {
          await client.browser("open", {
            url: safeUrl(v.url),
            copy: true,
            spaceId: space.kind === "space" ? space.id : undefined,
          });
        },
      });
      return;
    }
    dialogFor({
      title: view === "resources" ? "Add link" : `New ${view.slice(0, -1)}`,
      fields: [
        nameField(),
        ...(view === "resources"
          ? [{ key: "url", label: "URL", required: true } as FormField]
          : []),
        ...(view === "tasks"
          ? [
              {
                key: "dueDate",
                label: "Due date (optional)",
                type: "date",
              } as FormField,
            ]
          : []),
        {
          key: "description",
          label: view === "tasks" ? "Description" : "Description (optional)",
          type: "textarea",
        },
      ],
      submit: view === "resources" ? "Save link" : "Create",
      onSubmit: async (v) => {
        const item = await client.create(
          view.slice(0, -1) as Entity["kind"],
          v.name.trim(),
          {
            spaceId: space.id,
            sectionId,
            description: v.description,
            ...(view === "resources" ? { url: safeUrl(v.url) } : {}),
            ...(view === "notes"
              ? { doc: blankDoc() }
              : view === "tasks"
                ? { doc: plainDoc(v.description) }
                : {}),
            ...(v.dueDate ? { dueDate: v.dueDate } : {}),
          },
        );
        if (view === "notes") setExpandedNote(item.id);
      },
    });
  };
  const edit = (e: Entity) =>
    e.kind === "space"
      ? editSpace(e)
      : dialogFor({
          title: `Edit ${kindName(e.kind)}`,
          fields: [
            nameField(e.name),
            {
              key: "description",
              label: "Description",
              type: "textarea",
              value: e.description,
            },
            ...(e.kind === "resource" && e.url
              ? [
                  {
                    key: "url",
                    label: "URL",
                    value: e.url,
                    required: true,
                  } as FormField,
                  {
                    key: "tags",
                    label: "Tags, comma-separated",
                    value: e.tags.join(", "),
                  } as FormField,
                ]
              : []),
            ...(e.kind === "task"
              ? [
                  {
                    key: "dueDate",
                    label: "Due date",
                    type: "date",
                    value: e.dueDate,
                  } as FormField,
                  {
                    key: "priority",
                    label: "Priority",
                    type: "select",
                    value: e.priority,
                    options: ["none", "low", "medium", "high"].map((value) => ({
                      value,
                      label: value,
                    })),
                  } as FormField,
                ]
              : []),
            ...(e.kind === "property"
              ? [
                  {
                    key: "options",
                    label:
                      "Single-select labels in the same order (renames preserve IDs)",
                    type: "textarea",
                    value: e.options.map((o) => o.label).join("\n"),
                  } as FormField,
                ]
              : []),
            ...(["space", "group"].includes(e.kind)
              ? [
                  {
                    key: "color",
                    label: "Color",
                    type: "spaceColor",
                    value: e.color,
                    options: colors.map((value) => ({ value, label: value })),
                  } as FormField,
                ]
              : []),
          ],
          submit: "Save changes",
          onSubmit: async (v) => {
            await client.update(e, {
              name: v.name.trim(),
              description: v.description,
              ...(e.kind === "property" && e.propertyType === "select"
                ? {
                    options: v.options
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean)
                      .map((label, i) => ({
                        id: e.options[i]?.id ?? crypto.randomUUID(),
                        label,
                      })),
                  }
                : {}),
              ...(e.kind === "resource" && e.url
                ? {
                    url: safeUrl(v.url),
                    tags: v.tags
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    titleMode: "manual" as const,
                  }
                : {}),
              ...(e.kind === "task"
                ? {
                    ...(v.description !== e.description
                      ? { doc: plainDoc(v.description) }
                      : {}),
                    dueDate: v.dueDate || undefined,
                    priority: v.priority as Entity["priority"],
                  }
                : {}),
              ...(v.color ? { color: v.color as Entity["color"] } : {}),
            });
          },
        });
  const trash = (e: Entity) =>
    setConfirm({
      title: `Move ${e.name} to trash?`,
      text:
        e.kind === "space" || e.kind === "section"
          ? "Its contents will remain recoverable in Trash. Browser tabs stay open."
          : "You can restore this item from Trash.",
      run: () =>
        client
          .command({ type: "trash", id: e.id, expectedRevision: e.revision })
          .then(() => undefined),
    });
  const transfer = (items: Entity[], copy = false) =>
    dialogFor({
      title: `${copy ? "Copy" : "Move"} ${items.length} item(s)`,
      fields: [
        {
          key: "spaceId",
          label: "Destination Space",
          type: "select",
          options: spaces.map((e) => ({ value: e.id, label: e.name })),
          required: true,
        },
      ],
      submit: copy ? "Copy" : "Move",
      onSubmit: async (v) => {
        for (const e of items)
          await client.command({
            type: copy ? "duplicate" : "move",
            id: e.id,
            expectedRevision: e.revision,
            targetSpaceId: v.spaceId,
          });
        setSelected(new Set());
      },
    });
  const toggleSelect = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const bulkBrowser = (
    action: string,
    ids: number[],
    payload: Record<string, unknown> = {},
  ) => {
    const work = () => client.browser(action, { ids, ...payload });
    if (action === "close" && ids.length > 1)
      setConfirm({
        title: `Close ${ids.length} tabs?`,
        text: "A protected session checkpoint will be stored first. Reopening restores URLs, not form inputs or page runtime.",
        run: async () => {
          await work();
          setSelected(new Set());
        },
      });
    else void run(work);
  };
  const saveTabs = async (
    ids: number[],
    kind: "resource" | "task",
    sectionId?: string,
  ) => {
    for (const tab of state!.browser.tabs.filter((t) => ids.includes(t.id))) {
      safeUrl(tab.url);
      await client.create(kind, tab.title, {
        spaceId: space!.id,
        sectionId,
        ...(kind === "resource"
          ? { url: tab.url, titleMode: "auto" as const }
          : { description: tab.url }),
      });
    }
  };
  const upload = async (file: File, view: View, sectionId?: string) => {
    const attachment = await repository.attachment(file, file.name);
    const item = await client.create(
      view === "resources" ? "resource" : view === "notes" ? "note" : "task",
      file.name,
      {
        spaceId: space!.id,
        sectionId,
        attachmentIds: [attachment.id],
        ...(view === "notes" ? { doc: blankDoc() } : {}),
      },
    );
    if (view === "notes") setExpandedNote(item.id);
  };
  const attachmentDownload = async (id: string) => {
    const attachment = await repository.db.attachments.get(id);
    if (attachment) download(attachment.blob, attachment.filename);
    else throw new Error("Attachment is missing.");
  };
  const resourceAdd = (sectionId?: string) => (
    <ResourceAddMenu
      tabs={state!.browser.tabs}
      onLink={() => addItem("resources", sectionId)}
      onFile={(file) => void run(() => upload(file, "resources", sectionId))}
      onSaveTabs={async (ids) => {
        await saveTabs(ids, "resource", sectionId);
        await refresh();
      }}
    />
  );
  const itemRow = (e: Entity): ReactNode => (
    <ResourceRow
      key={e.id}
      item={e}
      selected={selected.has(e.id)}
      isOpen={!!e.url && state!.browser.tabs.some((tab) => tab.url === e.url)}
      faviconKey={
        state!.browser.tabs.find((tab) => tab.url === e.url)?.faviconKey
      }
      onSelect={() => toggleSelect(e.id)}
      onOpen={() =>
        void run(() => client.browser("open", { url: e.url, resourceId: e.id }))
      }
      onOpenCopy={() =>
        void run(() =>
          client.browser("open", {
            url: e.url,
            resourceId: e.id,
            copy: true,
          }),
        )
      }
      onDownload={(id) => void run(() => attachmentDownload(id))}
      onEdit={() => edit(e)}
      onMove={() => transfer([e])}
      onTrash={() => trash(e)}
      onDuplicate={() =>
        void run(() =>
          client.command({
            type: "duplicate",
            id: e.id,
            expectedRevision: e.revision,
          }),
        )
      }
      onAttach={(file) =>
        void run(async () => {
          const attachment = await repository.attachment(file, file.name);
          await client.update(e, {
            attachmentIds: [...e.attachmentIds, attachment.id],
          });
        })
      }
      onEarlier={() => {
        const siblings = all
          .filter(
            (other) =>
              other.kind === "resource" &&
              other.spaceId === e.spaceId &&
              other.sectionId === e.sectionId &&
              !other.deletedAt,
          )
          .sort(sort);
        const index = siblings.findIndex((other) => other.id === e.id);
        if (index > 0)
          void change(e, {
            order:
              index > 1
                ? (siblings[index - 2].order + siblings[index - 1].order) / 2
                : siblings[0].order - 1,
          });
      }}
    />
  );
  const tabsPane = () => {
    const tabs = state!.browser.tabs.filter(
      (t) =>
        !space ||
        t.spaceId === space.id ||
        (space.id === state!.inboxId && !t.spaceId),
    );
    const checked = tabs
      .filter((t) => selected.has(`tab:${t.id}`))
      .map((t) => t.id);
    const savedSessionTabs = (state!.spaceTabs[space?.id ?? ""] ?? []).filter(
      (tab) => !tab.live,
    );
    const groupNames = new Map(state!.browser.groups.map((g) => [g.id, g]));
    const rows: {
      key: string;
      savedKey?: string;
      live?: (typeof tabs)[number];
      title: string;
      url: string;
      faviconKey?: string;
      group?: string;
      groupKey?: string;
      groupColor?: string;
      lockId?: string;
    }[] = [
      ...tabs.map((t) => ({
        key: `tab:${t.id}`,
        savedKey: undefined,
        live: t,
        lockId: t.lockId,
        title: t.title,
        url: t.url,
        faviconKey: t.faviconKey,
        group: groupNames.get(t.groupId)?.title,
        groupColor: groupNames.get(t.groupId)?.color,
        groupKey:
          t.groupId >= 0
            ? (groupNames.get(t.groupId)?.logicalId ?? String(t.groupId))
            : undefined,
      })),
      ...savedSessionTabs.map((t) => ({
        key: `saved:${t.savedKey}`,
        savedKey: t.savedKey,
        live: undefined,
        lockId: t.lockId,
        title: t.title,
        url: t.url,
        faviconKey: t.faviconKey,
        group: t.group,
        groupColor: t.groupColor,
        groupKey: t.groupKey,
      })),
    ];
    const selectedRows = rows.filter((row) => selected.has(row.key));
    const groupedSelection = selectedRows.some(
      (row) => row.groupKey !== undefined,
    );
    const oneGroup =
      selectedRows.length > 0 &&
      selectedRows.every(
        (row) =>
          row.groupKey !== undefined &&
          row.groupKey === selectedRows[0].groupKey,
      );
    const canGroupLive =
      checked.length > 0 &&
      selectedRows.every((row) => !row.live?.pinned) &&
      new Set(selectedRows.map((row) => row.live?.windowId)).size === 1;
    const savedChecked = rows
      .filter((row) => !row.live && selected.has(row.key))
      .map((row) => row.savedKey!);
    const savedAction = (
      action: string,
      savedKeys: string[],
      destinationId?: string,
    ) =>
      void run(async () => {
        await client.browser(action, {
          sourceSpaceId: space!.id,
          savedKeys,
          spaceId: destinationId,
        });
        if (action === "groupSavedTabs" || action === "ungroupSavedTabs") {
          const fresh = await client.load();
          const positions = savedSessionTabs.flatMap((tab, index) =>
            savedKeys.includes(tab.savedKey!) ? [index] : [],
          );
          setSelected(
            new Set(
              positions.flatMap((index) =>
                fresh.spaceTabs[space!.id]?.[index]?.savedKey
                  ? [`saved:${fresh.spaceTabs[space!.id][index].savedKey}`]
                  : [],
              ),
            ),
          );
        } else if (action !== "openSavedTabs") setSelected(new Set());
      });
    const saveRows = (values: typeof rows, kind: "resource" | "task") =>
      void run(async () => {
        for (const row of values)
          await client.create(kind, row.title || row.url, {
            spaceId: space!.id,
            ...(kind === "resource"
              ? { url: safeUrl(row.url) }
              : { description: row.url }),
          });
      });
    const moveRows = (values: typeof rows) =>
      dialogFor({
        title: "Move to Space",
        fields: [
          {
            key: "spaceId",
            label: "Destination Space",
            type: "select",
            required: true,
            options: spaces
              .filter((s) => s.id !== space!.id)
              .map((s) => ({ value: s.id, label: s.name })),
          },
        ],
        submit: "Move tabs",
        onSubmit: async (v) => {
          if (values[0]?.live)
            await client.browser("moveToSpace", {
              ids: values.map((row) => row.live!.id),
              spaceId: v.spaceId,
            });
          else
            await client.browser("moveSavedTabs", {
              sourceSpaceId: space!.id,
              savedKeys: values.map((row) => row.savedKey!),
              spaceId: v.spaceId,
            });
          setSelected(new Set());
        },
      });
    const removeSaved = (keys: string[]) =>
      setConfirm({
        title: "Remove saved tabs from Space?",
        text: `Remove ${keys.length} saved tab(s) from this Space. A recovery checkpoint will be kept.`,
        run: async () => {
          await client.browser("removeSavedTabs", {
            sourceSpaceId: space!.id,
            savedKeys: keys,
          });
          setSelected(new Set());
        },
      });
    return (
      <>
        <div className="pane-tools">
          <span>
            {tabs.length
              ? `${tabs.length} open${savedSessionTabs.length ? ` · ${savedSessionTabs.length} closed locked` : ""}`
              : `${savedSessionTabs.length} saved session tabs`}
          </span>
          <Button onClick={() => addItem("tabs")}>+ Open URL</Button>
          <details className="action-menu">
            <summary>Tab tools</summary>
            <Button
              onClick={() => {
                const seen = new Set<string>();
                const duplicateIds = rows
                  .filter((t) => {
                    if (!t.url || t.live?.pinned) return false;
                    if (seen.has(t.url)) return true;
                    seen.add(t.url);
                    return false;
                  })
                  .map((t) => t.key);
                setSelected(new Set(duplicateIds));
                if (!duplicateIds.length)
                  setError("No exact-URL duplicates found.");
              }}
            >
              Review duplicates
            </Button>
            <Button
              onClick={() =>
                void run(() =>
                  client.browser("activateSession", {
                    spaceId: space?.id,
                    windowId: state!.currentWindowId,
                  }),
                )
              }
            >
              Open saved session
            </Button>
            <Button
              disabled={!tabs.length}
              onClick={() =>
                void run(() =>
                  client.browser("focusSpace", { spaceId: space?.id }),
                )
              }
            >
              Focus live tabs
            </Button>
          </details>
        </div>
        {!!savedChecked.length && (
          <div className="selection-bar">
            <strong>{savedChecked.length} selected</strong>
            {!oneGroup && (
              <Button
                onClick={() => savedAction("groupSavedTabs", savedChecked)}
              >
                Group
              </Button>
            )}
            {groupedSelection && (
              <Button
                onClick={() => savedAction("ungroupSavedTabs", savedChecked)}
              >
                Ungroup
              </Button>
            )}

            <Button onClick={() => savedAction("openSavedTabs", savedChecked)}>
              Open tabs
            </Button>
            <Button
              onClick={() =>
                saveRows(
                  rows.filter((r) => selected.has(r.key)),
                  "resource",
                )
              }
            >
              Save links
            </Button>
            <Button
              onClick={() =>
                saveRows(
                  rows.filter((r) => selected.has(r.key)),
                  "task",
                )
              }
            >
              Add tasks
            </Button>
            <Button
              onClick={() => moveRows(rows.filter((r) => selected.has(r.key)))}
            >
              Move to Space
            </Button>
            <Button
              className="danger"
              onClick={() => removeSaved(savedChecked)}
            >
              Remove from Space
            </Button>
          </div>
        )}
        {!!checked.length && (
          <div className="selection-bar">
            <strong>{checked.length} selected</strong>
            {!oneGroup && (
              <Button
                disabled={!canGroupLive}
                title={
                  canGroupLive
                    ? "Group selected tabs"
                    : "Select unpinned tabs in the same window"
                }
                onClick={() =>
                  bulkBrowser("group", checked, { spaceId: space?.id })
                }
              >
                Group
              </Button>
            )}
            {groupedSelection && (
              <Button onClick={() => bulkBrowser("ungroup", checked)}>
                Ungroup
              </Button>
            )}
            <Button
              onClick={() => void run(() => saveTabs(checked, "resource"))}
            >
              Save links
            </Button>
            <Button onClick={() => void run(() => saveTabs(checked, "task"))}>
              Add tasks
            </Button>
            <Button onClick={() => bulkBrowser("duplicate", checked)}>
              Duplicate
            </Button>
            <Button onClick={() => bulkBrowser("discard", checked)}>
              Suspend
            </Button>
            <Button onClick={() => bulkBrowser("close", checked)}>Close</Button>
            <Button
              onClick={() =>
                dialogFor({
                  title: "Move to Space",
                  fields: [
                    {
                      key: "spaceId",
                      label: "Destination Space",
                      type: "select",
                      required: true,
                      options: spaces
                        .filter((s) => s.id !== space?.id)
                        .map((s) => ({ value: s.id, label: s.name })),
                    },
                  ],
                  submit: "Move tabs",
                  onSubmit: async (v) => {
                    await client.browser("moveToSpace", {
                      ids: checked,
                      spaceId: v.spaceId,
                    });
                    setSelected(new Set());
                  },
                })
              }
            >
              Move to Space
            </Button>
            <Button
              onClick={() =>
                dialogFor({
                  title: "Move to window",
                  fields: [
                    {
                      key: "windowId",
                      label: "Destination window",
                      type: "select",
                      options: state!.windows
                        .filter(
                          (w) =>
                            !state!.sessions.some(
                              (s) => s.windowId === w.id && s.parked,
                            ),
                        )
                        .map((w, i) => ({
                          value: String(w.id),
                          label: `${w.id === state!.currentWindowId ? "This window" : `Window ${i + 1}`} · ${w.title.slice(0, 65)} · ${w.tabs} tabs`,
                        })),
                      required: true,
                    },
                  ],
                  submit: "Move tabs",
                  onSubmit: async (v) => {
                    await client.browser("move", {
                      ids: checked,
                      windowId: Number(v.windowId),
                      index: -1,
                    });
                  },
                })
              }
            >
              Move window
            </Button>
          </div>
        )}
        {rows.length ? (
          <GroupedTabs
            key={space?.id ?? "tabs"}
            items={rows.slice(0, listLimit)}
            actions={(row) => {
              const g =
                row.live &&
                state!.browser.groups.find(
                  (group) => group.id === row.live!.groupId,
                );
              if (!g) return null;
              return (
                <TabActionsMenu
                  label={`Actions for group ${g.title || "Unnamed group"}`}
                >
                  <Button
                    onClick={() =>
                      bulkBrowser("groupUpdate", [], {
                        groupId: g.id,
                        collapsed: !g.collapsed,
                      })
                    }
                  >
                    {g.collapsed ? "Expand in Chrome" : "Collapse in Chrome"}
                  </Button>
                  <Button
                    onClick={() =>
                      dialogFor({
                        title: "Native group settings",
                        fields: [
                          nameField(g.title),
                          {
                            key: "color",
                            label: "Color",
                            type: "select",
                            value: g.color,
                            options: colors.map((value) => ({
                              value,
                              label: value,
                            })),
                          },
                        ],
                        submit: "Update group",
                        onSubmit: async (v) => {
                          await client.browser("groupUpdate", {
                            groupId: g.id,
                            name: v.name,
                            color: v.color,
                          });
                        },
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button
                    onClick={() =>
                      bulkBrowser(
                        "adopt",
                        tabs.filter((t) => t.groupId === g.id).map((t) => t.id),
                        { spaceId: space?.id, groupId: g.id },
                      )
                    }
                  >
                    Adopt here
                  </Button>
                </TabActionsMenu>
              );
            }}
            render={(row, index) => {
              const t = row.live;
              return (
                <div
                  className={`item tab-row${!t ? " saved-session-tab" : ""}${selected.has(row.key) ? " selected" : ""}`}
                  data-tab-id={t?.id}
                  key={row.key}
                  draggable
                  onDragStart={(ev) =>
                    ev.dataTransfer.setData(
                      "application/tabspace",
                      JSON.stringify(
                        t
                          ? {
                              type: "tab",
                              id: t.id,
                              ids: selected.has(row.key) ? checked : [t.id],
                            }
                          : {
                              type: "savedTabs",
                              sourceSpaceId: space!.id,
                              savedKeys: selected.has(row.key)
                                ? savedChecked
                                : [row.savedKey],
                            },
                      ),
                    )
                  }
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.title}`}
                    checked={selected.has(row.key)}
                    onChange={(event) => {
                      const anchor = tabSelectionAnchor.current;
                      if (
                        (event.nativeEvent as MouseEvent).shiftKey &&
                        anchor !== undefined &&
                        anchor >= 0 &&
                        anchor < rows.length
                      ) {
                        setSelected(
                          (previous) =>
                            new Set([
                              ...previous,
                              ...rows
                                .slice(
                                  Math.min(anchor, index),
                                  Math.max(anchor, index) + 1,
                                )
                                .map((item) => item.key),
                            ]),
                        );
                      } else toggleSelect(row.key);
                      tabSelectionAnchor.current = index;
                    }}
                  />
                  <TabFavicon url={row.url} faviconKey={row.faviconKey} />
                  <div className="item-main">
                    <Button
                      className="item-name"
                      onClick={() =>
                        t
                          ? bulkBrowser("focus", [t.id])
                          : savedAction("openSavedTabs", [row.savedKey!])
                      }
                    >
                      {row.title || row.url}
                    </Button>
                    <small>
                      {domain(row.url)} ·{" "}
                      {t
                        ? "Open"
                        : row.lockId
                          ? "Closed · Locked in Space"
                          : "Saved"}
                      {t?.pinned ? " · Pinned" : ""}
                      {t?.active ? " · Active" : ""}
                      {t?.muted ? " · Muted" : ""}
                      {t?.discarded ? " · Suspended" : ""}
                      {t?.audible ? " · Playing audio" : ""}
                    </small>
                  </div>
                  <div className="row-actions">
                    {space &&
                      !space.temporary &&
                      space.id !== state!.inboxId &&
                      /^https?:\/\//.test(row.url) &&
                      !t?.pinned && (
                        <Button
                          className={`tab-lock${row.lockId ? " is-locked" : ""}`}
                          aria-label={`${row.lockId ? "Unlock" : "Lock"} ${row.title} in Space`}
                          title={
                            row.lockId ? "Unlock in Space" : "Lock in Space"
                          }
                          aria-pressed={!!row.lockId}
                          onClick={() =>
                            void run(() =>
                              client.browser("setTabLock", {
                                spaceId: space.id,
                                locked: !row.lockId,
                                ...(t
                                  ? { ids: [t.id] }
                                  : { savedKeys: [row.savedKey!] }),
                              }),
                            )
                          }
                        >
                          <LockIcon locked={!!row.lockId} />
                        </Button>
                      )}
                    <Button
                      title={`Save ${row.title}`}
                      onClick={() => saveRows([row], "resource")}
                    >
                      Save
                    </Button>
                    <TabActionsMenu label={`More actions for ${row.title}`}>
                      <Button
                        role="menuitem"
                        onClick={() =>
                          t
                            ? bulkBrowser("duplicate", [t.id])
                            : savedAction("duplicateSavedTabs", [row.savedKey!])
                        }
                      >
                        Duplicate
                      </Button>
                      <Button role="menuitem" onClick={() => moveRows([row])}>
                        Move to Space
                      </Button>
                      <Button
                        role="menuitem"
                        onClick={() => saveRows([row], "task")}
                      >
                        Add task
                      </Button>
                      {t ? (
                        <>
                          <Button
                            role="menuitem"
                            title={`Mute ${t.title}`}
                            onClick={() => bulkBrowser("mute", [t.id])}
                          >
                            {t.muted ? "Unmute" : "Mute"}
                          </Button>
                          <Button
                            role="menuitem"
                            title={`Pin ${t.title}`}
                            onClick={() => bulkBrowser("pin", [t.id])}
                          >
                            {t.pinned ? "Unpin" : "Pin"}
                          </Button>
                          <Button
                            role="menuitem"
                            onClick={() => bulkBrowser("discard", [t.id])}
                          >
                            Suspend
                          </Button>
                          <Button
                            role="menuitem"
                            className="danger"
                            onClick={() => bulkBrowser("close", [t.id])}
                          >
                            Close tab
                          </Button>
                        </>
                      ) : (
                        <Button
                          role="menuitem"
                          className="danger"
                          onClick={() => removeSaved([row.savedKey!])}
                        >
                          Remove from Space
                        </Button>
                      )}
                    </TabActionsMenu>
                  </div>
                </div>
              );
            }}
          />
        ) : (
          <Empty symbol="▱" title="A calm tab strip">
            Open this session to start browsing. New website tabs join the
            active Space automatically; other sessions stay preserved.
          </Empty>
        )}
        {rows.length > listLimit && (
          <Button onClick={() => setListLimit((n) => n + 100)}>
            Show next 100 tabs
          </Button>
        )}
        {space?.id !== state!.inboxId && (
          <details>
            <summary>Unassigned tabs — adopt into this Space</summary>
            {state!.browser.tabs
              .filter((t) => !t.spaceId)
              .map((t) => (
                <div className="item" key={t.id}>
                  <span className="item-main">{t.title}</span>
                  <Button
                    disabled={t.pinned}
                    onClick={() =>
                      bulkBrowser("adopt", [t.id], { spaceId: space?.id })
                    }
                  >
                    {t.pinned ? "Unpin first" : "Adopt"}
                  </Button>
                </div>
              ))}
          </details>
        )}
      </>
    );
  };
  const resourceTools = (resources: Entity[], advanced = false) => {
    const links = resources.filter((e) => e.url),
      resourceIds = resources.map((e) => e.id);
    return (
      <>
        {!advanced && (
          <Button
            disabled={!links.length}
            onClick={() =>
              void run(() => client.browser("openResources", { resourceIds }))
            }
          >
            Open links
          </Button>
        )}
        {advanced && (
          <>
            <Button
              role="menuitem"
              disabled={!links.length}
              onClick={() =>
                setConfirm({
                  title: "Replace website tabs with these links?",
                  text: `Open ${links.length} links in the last focused normal window and close its existing unpinned website tabs, including unmanaged tabs. Pinned tabs and TabSpace stay open. A protected checkpoint is saved first.`,
                  run: () =>
                    client
                      .browser("replaceResources", { resourceIds })
                      .then(() => undefined),
                })
              }
            >
              Replace tabs with links…
            </Button>
            <Button
              role="menuitem"
              disabled={!links.length}
              onClick={() =>
                setConfirm({
                  title: "Close resource-owned tabs?",
                  text: "Close only unchanged, unpinned tabs that TabSpace opened for these resources during this browser session. Existing tabs that were merely focused remain open. A protected checkpoint is saved first.",
                  run: () =>
                    client
                      .browser("closeResources", { resourceIds })
                      .then(() => undefined),
                })
              }
            >
              Close tabs opened from resources…
            </Button>
          </>
        )}
        {!advanced && (
          <>
            <Button
              disabled={!links.length}
              onClick={() =>
                void run(() =>
                  navigator.clipboard.writeText(
                    links.map((e) => e.url).join("\n"),
                  ),
                )
              }
            >
              Copy URLs
            </Button>
            <Button
              disabled={!links.length}
              onClick={() =>
                download(
                  new Blob(
                    [
                      links
                        .map(
                          (e) =>
                            `- [${e.name.replace(/[\\\[\]]/g, "\\$&")}](${e.url})`,
                        )
                        .join("\n"),
                    ],
                    { type: "text/markdown" },
                  ),
                  "TabSpace-links.md",
                )
              }
            >
              Export links
            </Button>
          </>
        )}
      </>
    );
  };
  const viewTasks = (id: string) => {
    const parent = all.find((item) => item.id === id);
    if (parent) void change(parent, { view: "tasks" });
    navigate(id, false);
  };
  const pane = (view: View, right = false) => {
    if (!space) return null;
    const sections = all
      .filter(
        (e) =>
          e.kind === "section" &&
          e.spaceId === space.id &&
          e.sectionKind === view &&
          !e.deletedAt,
      )
      .sort(sort);
    const items = all
      .filter(
        (e) =>
          e.kind === view.slice(0, -1) &&
          e.spaceId === space.id &&
          !e.deletedAt,
      )
      .sort(sort);
    const selection = items.filter((e) => selected.has(e.id));
    return (
      <section
        className="pane"
        aria-label={`${right ? "Right" : "Main"} ${view} pane`}
      >
        <div className="pane-heading">
          <span>{symbols[view]}</span>
          <select
            aria-label={right ? "Right pane view" : "Main pane view"}
            value={view}
            onChange={(event) =>
              surface === "panel"
                ? setPanelView(event.target.value as View)
                : void change(space, {
                    [right ? "rightView" : "view"]: event.target.value,
                  })
            }
          >
            {views
              .filter(
                (value) => space.id !== state!.inboxId || value !== "tabs",
              )
              .map((value) => (
                <option key={value} value={value}>
                  {viewName(value)}
                </option>
              ))}
          </select>
          <span className="count">
            {view === "tabs"
              ? (state!.spaceTabs[space.id]?.length ?? 0)
              : view === "tasks"
                ? items.filter((e) => !e.completedAt).length
                : items.length}
          </span>
          {view === "resources" && (
            <div className="resource-heading-actions">
              {resourceAdd()}
              <TabActionsMenu label="Resources options">
                <Button
                  role="menuitem"
                  onClick={() => addSection(false, "resources")}
                >
                  Add section
                </Button>
                {resourceTools(items, true)}
              </TabActionsMenu>
            </div>
          )}
        </div>
        <ScrollArea storageKey={`scroll:${space.id}:${view}:${right}`}>
          {view === "tabs" ? (
            tabsPane()
          ) : view === "tasks" ? (
            <TasksWorkspace
              key={space.id}
              entities={all}
              space={space}
              inboxId={state!.inboxId}
              onSaved={refresh}
              onViewSpace={viewTasks}
              onConfirm={setConfirm}
              initialTaskId={expandedTask}
            />
          ) : view === "notes" ? (
            <Suspense fallback={<p role="status">Opening notes…</p>}>
              <NotesPane
                key={space.id}
                space={space}
                notes={items}
                sections={sections}
                onSaved={() => void refresh()}
                onTrash={trash}
              />
            </Suspense>
          ) : (
            <>
              <p className="resource-intro muted">
                Keep useful links and files for this Space, independently of
                your open tabs.
              </p>
              {!!selection.length && (
                <div className="selection-bar">
                  <strong>{selection.length} selected</strong>
                  {resourceTools(selection)}
                  <Button onClick={() => transfer(selection)}>Move</Button>
                  <Button onClick={() => transfer(selection, true)}>
                    Copy to Space
                  </Button>
                  <Button
                    onClick={() =>
                      void run(async () => {
                        for (const e of selection)
                          await client.command({
                            type: "duplicate",
                            id: e.id,
                            expectedRevision: e.revision,
                          });
                        setSelected(new Set());
                      })
                    }
                  >
                    Duplicate
                  </Button>
                  <Button
                    className="danger"
                    onClick={() =>
                      setConfirm({
                        title: "Trash selected items?",
                        text: "All selected items will remain recoverable.",
                        run: async () => {
                          for (const e of selection)
                            await client.command({
                              type: "trash",
                              id: e.id,
                              expectedRevision: e.revision,
                            });
                          setSelected(new Set());
                        },
                      })
                    }
                  >
                    Trash
                  </Button>
                  <Button onClick={() => setSelected(new Set())}>
                    Clear selection
                  </Button>
                </div>
              )}
              {[undefined, ...sections].map((section) => {
                const bucket = items.filter((e) => e.sectionId === section?.id);
                return (
                  <div
                    key={section?.id ?? "unsectioned"}
                    className="content-section"
                    onDragOver={(event) => {
                      if (
                        event.dataTransfer.types.includes(
                          "application/tabspace",
                        ) ||
                        event.dataTransfer.types.includes("text/uri-list")
                      )
                        event.preventDefault();
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const raw = event.dataTransfer.getData(
                          "application/tabspace",
                        ),
                        urls = event.dataTransfer.getData("text/uri-list"),
                        copy = event.ctrlKey || event.metaKey;
                      void run(async () => {
                        if (raw) {
                          const data = JSON.parse(raw),
                            item = all.find((e) => e.id === data.id);
                          if (item?.kind === "resource")
                            await client.command({
                              type: copy ? "duplicate" : "move",
                              id: item.id,
                              expectedRevision: item.revision,
                              targetSpaceId: space.id,
                              targetSectionId: section?.id,
                            });
                        } else
                          for (const url of urls
                            .split("\n")
                            .filter((value) => value && !value.startsWith("#")))
                            await client.create("resource", domain(url), {
                              spaceId: space.id,
                              sectionId: section?.id,
                              url: safeUrl(url),
                            });
                      });
                    }}
                  >
                    {section && (
                      <div className="section-heading">
                        <Button
                          title={
                            section.collapsed
                              ? "Expand section"
                              : "Collapse section"
                          }
                          onClick={() =>
                            void change(section, {
                              collapsed: !section.collapsed,
                            })
                          }
                        >
                          <TreeChevron expanded={!section.collapsed} />
                        </Button>
                        <h3>{section.name}</h3>
                        <span>{bucket.length}</span>
                        {resourceAdd(section.id)}
                        <TabActionsMenu
                          label={`Actions for section ${section.name}`}
                        >
                          <Button role="menuitem" onClick={() => edit(section)}>
                            Edit section
                          </Button>
                          <Button
                            role="menuitem"
                            onClick={() => transfer([section])}
                          >
                            Move section
                          </Button>
                          <Button
                            role="menuitem"
                            onClick={() =>
                              void run(() =>
                                client.command({
                                  type: "duplicate",
                                  id: section.id,
                                  expectedRevision: section.revision,
                                }),
                              )
                            }
                          >
                            Duplicate section
                          </Button>
                          <Button
                            role="menuitem"
                            onClick={() =>
                              void change(section, {
                                order: section.order - 1000,
                              })
                            }
                          >
                            Move earlier
                          </Button>
                          <Button
                            role="menuitem"
                            className="danger"
                            onClick={() => trash(section)}
                          >
                            Move section to Trash
                          </Button>
                        </TabActionsMenu>
                      </div>
                    )}
                    {section?.description && (
                      <p className="muted">{section.description}</p>
                    )}
                    {!section?.collapsed && (
                      <VirtualList items={bucket} render={itemRow} />
                    )}
                  </div>
                );
              })}
              {!items.length && !sections.length && (
                <Empty title="Your project references">
                  Use + Add to save a link, keep a local copy of a file, or
                  choose from your open tabs.
                </Empty>
              )}
            </>
          )}
        </ScrollArea>
      </section>
    );
  };
  const onDropSpace = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData("application/tabspace");
    if (!raw) return;
    const copy = e.ctrlKey;
    void run(async () => {
      const d = JSON.parse(raw);
      if (d.type === "savedTabs") {
        await client.browser(copy ? "copySavedTabs" : "moveSavedTabs", {
          sourceSpaceId: d.sourceSpaceId,
          savedKeys: d.savedKeys,
          spaceId: id,
        });
        setSelected(new Set());
      } else if (d.type === "tab")
        await client.browser(copy ? "copyToSpace" : "moveToSpace", {
          ids: Array.isArray(d.ids) ? d.ids : [d.id],
          spaceId: id,
        });
      else {
        const item = all.find((x) => x.id === d.id);
        if (item?.kind === "space") {
          const target = all.find((e) => e.id === id)!;
          if (item.id === target.id) return;
          if (item.temporary) {
            if (!target.temporary)
              saveSpace(item, target.sidebarId ?? "", target.order - 0.5);
            return;
          }
          if (target.temporary) return;
          await client.command({
            type: copy ? "duplicate" : "move",
            id: item.id,
            expectedRevision: item.revision,
            targetSectionId: target.sidebarId,
            patch: { order: target.order - 0.5 },
          });
        } else if (item)
          await client.command({
            type: copy ? "duplicate" : "move",
            id: item.id,
            expectedRevision: item.revision,
            targetSpaceId: id,
          });
      }
    });
  };
  const sidebarDrop = (event: React.DragEvent, destination?: string) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.classList.remove("drop-target");
    const raw = event.dataTransfer.getData("application/tabspace");
    if (!raw) return;
    void run(async () => {
      const data = JSON.parse(raw);
      const item = all.find((entry) => entry.id === data.id);
      if (item?.kind !== "space") return;
      if (item.temporary) {
        saveSpace(item, destination ?? "");
        return;
      }
      await client.command({
        type: "move",
        id: item.id,
        expectedRevision: item.revision,
        targetSectionId: destination,
      });
    });
  };
  const sidebarDragOver = (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("application/tabspace")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    event.currentTarget.classList.add("drop-target");
  };
  const sidebarDragLeave = (event: React.DragEvent) => {
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    )
      return;
    event.currentTarget.classList.remove("drop-target");
  };
  const spaceButton = (s: Entity) => {
    const tabs = state!.spaceTabs[s.id] ?? [];
    const expanded = expandedSpaces[s.id] ?? active(s);
    return (
      <div
        className="space-tree"
        key={s.id}
        data-space-id={s.id}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("application/tabspace"))
            return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = event.ctrlKey ? "copy" : "move";
          event.currentTarget.classList.toggle("drop-copy", event.ctrlKey);
          document.body.classList.add("tabspace-dragging");
          event.currentTarget.classList.add("drop-target");
        }}
        onDragLeave={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          )
            return;
          event.currentTarget.classList.remove("drop-target", "drop-copy");
        }}
        onDrop={(event) => {
          document.body.classList.remove("tabspace-dragging");
          event.currentTarget.classList.remove("drop-target", "drop-copy");
          if (!event.dataTransfer.types.includes("application/tabspace"))
            return;
          event.stopPropagation();
          onDropSpace(event, s.id);
        }}
      >
        <div
          className={`space-row${active(s) ? " active" : ""}${s.id === windowSpaceId ? " is-current" : ""}`}
          data-current={s.id === windowSpaceId || undefined}
          key={s.id}
          draggable
          onDragStart={(e) =>
            e.dataTransfer.setData(
              "application/tabspace",
              JSON.stringify({ type: "entity", id: s.id }),
            )
          }
        >
          <button
            className="space-toggle"
            type="button"
            aria-label={`Tabs in ${s.name}`}
            aria-expanded={expanded}
            onClick={() =>
              setExpandedSpaces((old) => ({ ...old, [s.id]: !expanded }))
            }
          >
            <TreeChevron expanded={expanded} />
          </button>
          <button
            type="button"
            className="space-link"
            aria-current={active(s) ? "page" : undefined}
            onClick={() => navigate(s.id)}
          >
            <span className={`space-icon ${s.color}`}>
              <SpaceIcon temporary={s.temporary} />
            </span>
            <span title={s.name}>{s.name}</span>
            {s.temporary && hasPersonalContent(s, all) && (
              <small
                className="unsaved-content-badge"
                title="Contains saved content; never automatically deleted"
              >
                Keep
              </small>
            )}
            {s.favorite && <span>★</span>}
            {s.id === windowSpaceId && <CurrentSpaceBadge />}
          </button>
          {surface === "panel" ? (
            <Button
              title={`View Space ${s.name}`}
              className="space-window"
              onClick={() => navigate(s.id, false)}
            >
              <NavigationIcon name="view" />
            </Button>
          ) : (
            <Button
              title={`Open ${s.name} in new window`}
              className="space-window"
              onClick={() =>
                void run(() =>
                  client.browser("activateSession", {
                    spaceId: s.id,
                    newWindow: true,
                  }),
                )
              }
            >
              <NavigationIcon name="newWindow" />
            </Button>
          )}
          <Button
            title={`Settings for ${s.name}`}
            className="space-menu"
            onClick={() => setInspect(s)}
          >
            ⋯
          </Button>
        </div>
        <span className="space-drop-hint" aria-hidden="true">
          <span className="drop-move-label">Move to</span>
          <span className="drop-copy-label">Copy to</span> {s.name}
          <span className="drop-copy-help"> · Ctrl: copy</span>
        </span>
        {expanded && (
          <ul className="space-tabs" aria-label={`Tab list for ${s.name}`}>
            <GroupedTabs
              key={s.id}
              sidebar
              items={tabs}
              render={(tab, index) => (
                <li key={`${tab.id ?? tab.url}:${index}`}>
                  <button
                    type="button"
                    title={`${tab.title}\n${tab.url}${tab.live ? "" : "\nSaved session"}\nClick to ${tab.live ? "focus" : "open"} · Middle-click for a background copy`}
                    className={tab.live ? "" : "saved-tab"}
                    onClick={() =>
                      void run(() =>
                        tab.live && tab.id !== undefined
                          ? client.browser("focus", { ids: [tab.id] })
                          : client.browser("openSavedTabs", {
                              sourceSpaceId: s.id,
                              savedKeys: [tab.savedKey!],
                            }),
                      )
                    }
                    onMouseDown={(event) => {
                      if (event.button === 1) event.preventDefault();
                    }}
                    onAuxClick={(event) => {
                      if (event.button !== 1) return;
                      event.preventDefault();
                      event.stopPropagation();
                      void run(() =>
                        tab.live
                          ? client.browser("open", { url: tab.url, copy: true })
                          : client.browser("openSavedTabs", {
                              sourceSpaceId: s.id,
                              savedKeys: [tab.savedKey!],
                              background: true,
                            }),
                      );
                    }}
                  >
                    <TabFavicon url={tab.url} faviconKey={tab.faviconKey} />
                    <span>{tab.title || tab.url}</span>
                  </button>
                  {!s.temporary &&
                    s.id !== state!.inboxId &&
                    /^https?:\/\//.test(tab.url) && (
                      <button
                        type="button"
                        className={`tab-lock${tab.lockId ? " is-locked" : ""}`}
                        aria-label={`${tab.lockId ? "Unlock" : "Lock"} ${tab.title} in Space`}
                        title={tab.lockId ? "Unlock in Space" : "Lock in Space"}
                        aria-pressed={!!tab.lockId}
                        onClick={() =>
                          void run(() =>
                            client.browser("setTabLock", {
                              spaceId: s.id,
                              locked: !tab.lockId,
                              ...(tab.live
                                ? { ids: [tab.id!] }
                                : { savedKeys: [tab.savedKey!] }),
                            }),
                          )
                        }
                      >
                        <LockIcon locked={!!tab.lockId} />
                      </button>
                    )}
                </li>
              )}
            />
            {!tabs.length && <li className="empty-tree">No tabs</li>}
          </ul>
        )}
      </div>
    );
  };
  const addProperty = () =>
    dialogFor({
      title: "Add reusable property",
      fields: [
        {
          key: "definition",
          label: "Definition",
          type: "select",
          options: [
            { value: "", label: "Create a new definition" },
            ...all
              .filter((e) => e.kind === "property" && !e.deletedAt)
              .map((e) => ({
                value: e.id,
                label: `${e.name} (${e.propertyType})`,
              })),
          ],
        },
        {
          ...nameField(),
          required: false,
          label: "Name (for a new definition)",
        },
        {
          key: "type",
          label: "Type",
          type: "select",
          options: [
            { value: "text", label: "Text" },
            { value: "date", label: "Date" },
            { value: "select", label: "Single-select" },
          ],
        },
        { key: "options", label: "Select options, comma-separated" },
        { key: "value", label: "Initial value (date: YYYY-MM-DD)" },
      ],
      submit: "Add property",
      onSubmit: async (v) => {
        const options = v.options
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((label) => ({ id: crypto.randomUUID(), label }));
        const definition =
          all.find((e) => e.id === v.definition) ??
          (await client.create("property", v.name, {
            propertyType: v.type as Entity["propertyType"],
            options,
          }));
        await client.update(space!, {
          fields: [
            ...space!.fields,
            {
              definitionId: definition.id,
              value:
                definition.propertyType === "select"
                  ? (definition.options.find((o) => o.label === v.value)?.id ??
                    "")
                  : v.value,
              required: v.required === "yes",
              visible: true,
              order: space!.fields.length,
            },
          ],
        });
      },
    });
  const properties = () =>
    [...(space?.fields ?? [])]
      .sort((a, b) => a.order - b.order)
      .map((field) => {
        const definition = all.find((e) => e.id === field.definitionId);
        if (!definition || !field.visible) return null;
        return (
          <label className="property" key={field.definitionId}>
            {definition.name}
            {definition.propertyType === "select" ? (
              <select
                value={field.value}
                onChange={(e) =>
                  void change(space, {
                    fields: space.fields.map((f) =>
                      f.definitionId === field.definitionId
                        ? { ...f, value: e.target.value }
                        : f,
                    ),
                  })
                }
              >
                <option value="">Not set</option>
                {definition.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={definition.propertyType === "date" ? "date" : "text"}
                defaultValue={field.value}
                key={field.value}
                onBlur={(e) => {
                  if (e.target.value !== field.value)
                    void change(space, {
                      fields: space.fields.map((f) =>
                        f.definitionId === field.definitionId
                          ? { ...f, value: e.target.value }
                          : f,
                      ),
                    });
                }}
              />
            )}
            <Button
              title={`Remove ${definition.name} field`}
              onClick={() =>
                void change(space, {
                  fields: space.fields.filter(
                    (f) => f.definitionId !== field.definitionId,
                  ),
                })
              }
            >
              ×
            </Button>
          </label>
        );
      });
  const searchUI = () => (
    <>
      <div className="search-box">
        <span aria-hidden="true">⌕</span>
        <input
          ref={searchRef}
          aria-label="Search local collection"
          autoFocus={palette}
          placeholder="Find a Space, link, note or task…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              document
                .querySelector<HTMLButtonElement>(
                  palette ? "dialog .search-result" : ".search-result",
                )
                ?.focus();
            }
          }}
        />
        <kbd>Ctrl K</kbd>
      </div>
      <div className="pane-tools">
        <select
          aria-label="Filter result type"
          value={searchType}
          onChange={(e) => setSearchType(e.target.value)}
        >
          <option value="">All types</option>
          {[
            "space",
            "resource",
            "note",
            "task",
            "savedTab",
            "liveTab",
            "session",
          ].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <select
          aria-label="Filter Space"
          value={searchSpace}
          onChange={(e) => setSearchSpace(e.target.value)}
        >
          <option value="">All Spaces</option>
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="inline">
          <input
            type="checkbox"
            checked={historySearch}
            onChange={(e) => setHistorySearch(e.target.checked)}
          />
          Search session history
        </label>
      </div>
      <details className="search-filters">
        <summary>More filters · Ctrl-click a result to open a copy</summary>
        <div className="pane-tools">
          <input
            aria-label="Filter domain"
            placeholder="Domain"
            value={searchDomain}
            onChange={(e) => setSearchDomain(e.target.value)}
          />
          <select
            aria-label="Filter section"
            value={searchSection}
            onChange={(e) => setSearchSection(e.target.value)}
          >
            <option value="">All sections</option>
            {all
              .filter(
                (e) =>
                  e.kind === "section" &&
                  !e.deletedAt &&
                  (!searchSpace || e.spaceId === searchSpace),
              )
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
          </select>
          <select
            aria-label="Filter task state"
            value={searchTask}
            onChange={(e) => setSearchTask(e.target.value)}
          >
            <option value="">Any task state</option>
            <option value="open">Open tasks</option>
            <option value="completed">Completed tasks</option>
            <option value="starred">Starred tasks</option>
          </select>
          <label>
            Due from
            <input
              type="date"
              value={searchDueFrom}
              onChange={(e) => setSearchDueFrom(e.target.value)}
            />
          </label>
          <label>
            Due through
            <input
              type="date"
              value={searchDueTo}
              onChange={(e) => setSearchDueTo(e.target.value)}
            />
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={searchArchived}
              onChange={(e) => setSearchArchived(e.target.checked)}
            />
            Include archived Spaces
          </label>
        </div>
      </details>
      <div
        className="search-list"
        onKeyDown={(e) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
          const buttons = Array.from(
            e.currentTarget.querySelectorAll<HTMLButtonElement>(
              ".search-result",
            ),
          );
          const current = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? buttons.length - 1
                : Math.max(
                    0,
                    Math.min(
                      buttons.length - 1,
                      current + (e.key === "ArrowDown" ? 1 : -1),
                    ),
                  );
          e.preventDefault();
          buttons[next]?.focus();
        }}
      >
        {hits.length ? (
          hits.slice(0, listLimit).map((hit) => (
            <Button
              className="search-result"
              key={hit.id}
              onClick={(event) => {
                setPalette(false);
                if ((event.ctrlKey || event.metaKey) && hit.url) {
                  void run(() =>
                    client.browser("open", { url: hit.url, copy: true }),
                  );
                  return;
                }
                if (hit.tabId !== undefined) bulkBrowser("focus", [hit.tabId]);
                else if (hit.entity?.kind === "space") navigate(hit.id);
                else if (hit.spaceId) {
                  navigate(hit.spaceId);
                  const s = all.find((e) => e.id === hit.spaceId);
                  if (
                    s &&
                    ["note", "task", "resource", "savedTab"].includes(hit.kind)
                  ) {
                    void change(s, {
                      view:
                        hit.kind === "savedTab"
                          ? "tabs"
                          : (`${hit.kind}s` as View),
                    });
                    if (hit.kind === "note") setExpandedNote(hit.id);
                  }
                } else if (hit.url)
                  void run(() => client.browser("open", { url: hit.url }));
              }}
            >
              <span className="result-kind">{hit.kind}</span>
              <strong>{hit.name}</strong>
              <small>{hit.text.slice(0, 140) || hit.url}</small>
            </Button>
          ))
        ) : (
          <Empty title="Nothing found">
            Try a shorter phrase or remove a filter.
          </Empty>
        )}
      </div>
      {hits.length > listLimit && (
        <Button onClick={() => setListLimit((n) => n + 100)}>
          Show next 100 results
        </Button>
      )}
    </>
  );

  const previewSnapshot =
    restoreSnapshot?.id === restorePreview ? restoreSnapshot : undefined;
  if (!state)
    return (
      <main className="loading">
        <Logo />
        <h1>TabSpace</h1>
        <p role="status">Opening your local collection…</p>
        {error && <p role="alert">{error}</p>}
        <Button onClick={() => void refresh()}>Retry</Button>
      </main>
    );
  if (surface === "popup")
    return (
      <div className="popup">
        <div className="brand">
          <Logo />
          <strong>TabSpace</strong>
          <span className="badge">Local</span>
        </div>
        <h1>Keep it close.</h1>
        <p className="muted">Save this tab to your project.</p>
        <label>
          Space
          <select
            value={space?.id}
            onChange={(e) => setSpaceId(e.target.value)}
          >
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <div className="quick-grid">
          <Button
            className="primary"
            onClick={() =>
              void run(async () => {
                const [tab] = await chrome.tabs.query({
                  active: true,
                  lastFocusedWindow: true,
                });
                if (tab.incognito || !tab.url)
                  throw new Error("Use a normal website tab.");
                await client.create("resource", tab.title || domain(tab.url), {
                  spaceId: space!.id,
                  url: safeUrl(tab.url),
                  titleMode: "auto",
                });
              })
            }
          >
            Save current tab
          </Button>
          <Button
            onClick={() =>
              void run(async () => {
                const [tab] = await chrome.tabs.query({
                  active: true,
                  lastFocusedWindow: true,
                });
                if (tab.incognito || !tab.url)
                  throw new Error("Use a normal website tab.");
                await client.create("task", tab.title || "Follow up", {
                  spaceId: space!.id,
                  description: safeUrl(tab.url),
                });
              })
            }
          >
            Add task from tab
          </Button>
          <Button onClick={() => void run(() => client.browser("manager"))}>
            Open manager
          </Button>
          <Button
            onClick={() =>
              void run(async () => {
                const w = await chrome.windows.getLastFocused();
                await chrome.sidePanel.open({ windowId: w.id! });
              })
            }
          >
            Open side panel
          </Button>
        </div>
        <p role="status">
          {busy ? "Saving…" : error || "Ready · offline organizer"}
        </p>
      </div>
    );
  return (
    <div
      className={`app ${surface}${surface === "panel" ? (panelDetail ? " panel-detail" : " panel-tree") : ""}`}
    >
      <a
        href={surface === "panel" && !panelDetail ? "#panel-spaces" : "#main"}
        className="skip"
      >
        Skip to content
      </a>
      <aside
        id={surface === "panel" ? "panel-spaces" : undefined}
        hidden={surface === "panel" && panelDetail}
        className="sidebar"
        aria-label="Persistent navigation"
      >
        <div className="brand">
          <Logo />
          <strong>TabSpace</strong>
          <span className="badge">Local</span>
          {surface === "panel" && (
            <Button
              title="Open full manager"
              className="panel-open-manager"
              onClick={() => void run(() => client.browser("manager"))}
            >
              <NavigationIcon name="newWindow" />
            </Button>
          )}
        </div>
        {surface === "panel" && error && (
          <div role="alert" className="error-banner">
            {error}
            <Button onClick={() => setError("")}>Dismiss</Button>
          </div>
        )}
        {surface === "panel" &&
          (state.quarantineCount > 0 || state.sessionInterrupted) && (
            <div role="alert" className="error-banner">
              Session management needs attention.
              <Button onClick={() => void run(() => client.browser("manager"))}>
                Open manager
              </Button>
            </div>
          )}
        <Button className="search-trigger" onClick={() => setPalette(true)}>
          ⌕ Search anything <kbd>Ctrl K</kbd>
        </Button>
        <nav aria-label="Library">
          {surface !== "panel" && (
            <>
              <button
                type="button"
                className={`home-link${route === "home" ? " active" : ""}`}
                aria-current={route === "home" ? "page" : undefined}
                onClick={() => setRoute("home")}
              >
                <NavigationIcon name="home" /> Home
              </button>
              <Button
                className={route === "tasks" ? "active" : ""}
                onClick={() => setRoute("tasks")}
              >
                ✓ My Tasks{" "}
                <span className="count">
                  {
                    all.filter(
                      (e) =>
                        e.kind === "task" &&
                        !e.completedAt &&
                        !e.deletedAt &&
                        spaces.some((s) => s.id === e.spaceId),
                    ).length
                  }
                </span>
              </Button>
            </>
          )}
          {surface === "panel" && windowSpaceId && (
            <Button onClick={() => navigate(windowSpaceId, false)}>
              <NavigationIcon name="view" />
              View current Space
            </Button>
          )}
          {surface === "panel" && (
            <Button
              onClick={() => {
                setRoute("tasks");
                setPanelDetail(true);
                setPanelTaskFocus(crypto.randomUUID());
              }}
            >
              ✓ My Tasks
              <span className="count">
                {
                  all.filter(
                    (e) =>
                      e.kind === "task" &&
                      !e.completedAt &&
                      !e.deletedAt &&
                      spaces.some((s) => s.id === e.spaceId),
                  ).length
                }
              </span>
            </Button>
          )}
          <Button
            className={
              route === "space" && space?.id === state.inboxId ? "active" : ""
            }
            onClick={() => navigate(state.inboxId, false)}
          >
            <NavigationIcon name="inbox" /> Inbox
          </Button>
        </nav>
        <hr className="sidebar-workspace-separator" />
        <div className="sidebar-heading">
          <span>SPACES</span>
          <Button title="New Space" onClick={newSpace}>
            +
          </Button>
        </div>
        <div className="space-list">
          <div className="space-subheading unsaved-heading">
            Unsaved <span>{openUnsaved.length}</span>
          </div>
          {openUnsaved.map(spaceButton)}
          {!openUnsaved.length && (
            <p className="spaces-empty-hint">New Chrome windows appear here.</p>
          )}
          <details className="recent-unsaved">
            <summary>
              Recently closed <span>{closedUnsaved.length}</span>
            </summary>
            {closedUnsaved.map(spaceButton)}
          </details>
          <div
            className="space-subheading saved-heading"
            data-drop-saved
            onDragOver={sidebarDragOver}
            onDragLeave={sidebarDragLeave}
            onDrop={(event) => sidebarDrop(event)}
          >
            Saved <span>{savedSpaces.length}</span>
          </div>
          {!savedSpaces.length && (
            <p className="spaces-empty-hint">
              Save a browsing Space to keep it here.
            </p>
          )}
          {savedSpaces.some((s) => s.favorite) && (
            <details
              open={favoritesOpen}
              onToggle={(e) => {
                setFavoritesOpen(e.currentTarget.open);
                localStorage.setItem(
                  "favoritesOpen",
                  String(e.currentTarget.open),
                );
              }}
            >
              <summary className="tree-summary">
                <TreeChevron expanded={favoritesOpen} /> Favorites
              </summary>
              {savedSpaces.filter((s) => s.favorite).map(spaceButton)}
            </details>
          )}
          {[
            undefined,
            ...all
              .filter((e) => e.kind === "sidebar" && !e.deletedAt)
              .sort(sort),
          ].map((section) => (
            <Fragment key={section?.id ?? "root"}>
              <div
                className={`sidebar-section${section ? " collection" : ""}`}
                data-collection-id={section?.id}
                onDragOver={sidebarDragOver}
                onDragLeave={sidebarDragLeave}
                onDrop={(event) => sidebarDrop(event, section?.id)}
              >
                {section && (
                  <div
                    className={`collection-row${savedSpaces.some((s) => s.id === windowSpaceId && s.sidebarId === section.id) ? " contains-current" : ""}`}
                  >
                    <button
                      type="button"
                      className="collection-toggle"
                      aria-expanded={!section.collapsed}
                      aria-controls={`collection-${section.id}`}
                      aria-label={`${section.collapsed ? "Expand" : "Collapse"} collection ${section.name}`}
                      onClick={() =>
                        void change(section, { collapsed: !section.collapsed })
                      }
                    >
                      <TreeChevron expanded={!section.collapsed} />
                      <NavigationIcon name="collection" />
                      <span className="collection-name" title={section.name}>
                        {section.name}
                      </span>
                      <span className="collection-count">
                        {
                          savedSpaces.filter((s) => s.sidebarId === section.id)
                            .length
                        }
                      </span>
                      {savedSpaces.some(
                        (s) =>
                          s.id === windowSpaceId && s.sidebarId === section.id,
                      ) && (
                        <CurrentSpaceBadge
                          label={`Current Space: ${savedSpaces.find((s) => s.id === windowSpaceId)?.name}`}
                        />
                      )}
                    </button>
                    <Button
                      title={`Collection settings for ${section.name}`}
                      className="space-menu"
                      onClick={() => setInspect(section)}
                    >
                      ⋯
                    </Button>
                  </div>
                )}
                <div
                  id={section ? `collection-${section.id}` : undefined}
                  className={section ? "collection-children" : undefined}
                  hidden={!!section?.collapsed}
                >
                  {savedSpaces
                    .filter((s) => s.sidebarId === section?.id)
                    .map(spaceButton)}
                  {section &&
                    !savedSpaces.some((s) => s.sidebarId === section.id) && (
                      <p className="collection-empty">Drop a Space here</p>
                    )}
                </div>
              </div>
              {!section && (
                <>
                  <div className="sidebar-heading collections-heading">
                    <span>COLLECTIONS</span>
                    <Button
                      title="New collection"
                      onClick={() => addSection(true)}
                    >
                      +
                    </Button>
                  </div>
                </>
              )}
            </Fragment>
          ))}
        </div>
        <div
          className="sidebar-footer"
          role="navigation"
          aria-label="Library and settings"
        >
          {surface !== "panel" &&
            (["archive", "trash", "settings"] as Route[]).map((r) => (
              <Button
                key={r}
                className={route === r ? "active" : ""}
                onClick={() => setRoute(r)}
              >
                <NavigationIcon name={r as "archive" | "trash" | "settings"} />
                <span>{r[0].toUpperCase() + r.slice(1)}</span>
              </Button>
            ))}
          <div className="local-status">
            <span className="status-dot" />
            On this device{" "}
            <small>{busy ? "Saving…" : "Local collection"}</small>
          </div>
          <div className="sidebar-credit">
            Designed by <span>kechos</span>
          </div>
        </div>
      </aside>
      {surface !== "panel" && (
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="Sidebar width"
          aria-orientation="vertical"
          tabIndex={0}
          onKeyDown={(e) => {
            if (["ArrowLeft", "ArrowRight"].includes(e.key))
              void run(() =>
                client.settings({
                  sidebarWidth: Math.max(
                    180,
                    Math.min(
                      420,
                      state.settings.sidebarWidth +
                        (e.key === "ArrowRight" ? 16 : -16),
                    ),
                  ),
                }),
              );
          }}
          onPointerDown={(e) => {
            const element = e.currentTarget;
            element.setPointerCapture(e.pointerId);
            const move = (ev: PointerEvent) =>
              document.documentElement.style.setProperty(
                "--sidebar-width",
                `${Math.max(180, Math.min(420, ev.clientX))}px`,
              );
            const up = (ev: PointerEvent) => {
              element.removeEventListener("pointermove", move);
              element.removeEventListener("pointerup", up);
              void run(() =>
                client.settings({
                  sidebarWidth: Math.max(180, Math.min(420, ev.clientX)),
                }),
              );
            };
            element.addEventListener("pointermove", move);
            element.addEventListener("pointerup", up);
          }}
        />
      )}
      {(surface !== "panel" || panelDetail) && (
        <main id="main">
          {surface === "panel" ? (
            <div className="panel-toolbar">
              <Button onClick={() => setPanelDetail(false)}>
                <NavigationIcon name="back" />
                Spaces
              </Button>
              <Button
                title="Open full manager"
                onClick={() => void run(() => client.browser("manager"))}
              >
                <NavigationIcon name="newWindow" />
              </Button>
            </div>
          ) : (
            <div className="topbar">
              <div className="topbar-location">
                {route !== "home" && (
                  <Button
                    className="home-return"
                    title="Back to Home"
                    onClick={() => setRoute("home")}
                  >
                    <NavigationIcon name="back" /> Back to Home
                  </Button>
                )}
                <div className="current-view" aria-label="Current view">
                  <span className="current-view-label">
                    {route === "space" ? "Space" : "Current view"}
                  </span>
                  <strong
                    className="current-view-title"
                    title={route === "space" ? space?.name : undefined}
                  >
                    {route === "space"
                      ? space?.name
                      : route === "tasks"
                        ? "My Tasks"
                        : viewName(route as View)}
                    {route === "space" && space && (
                      <span className="current-view-detail">
                        {" "}
                        · {viewName(space.view)}
                        {space.split ? ` + ${viewName(space.rightView)}` : ""}
                      </span>
                    )}
                  </strong>
                </div>
              </div>
              <div>
                <span role="status" className="save-status">
                  {busy ? "Saving…" : "Saved locally"}
                </span>
                <Button
                  title="Refresh browser state"
                  onClick={() => void refresh(true)}
                >
                  ↻
                </Button>
                <Button
                  title="Toggle light/dark theme"
                  onClick={() =>
                    void run(() =>
                      client.settings({
                        theme:
                          state.settings.theme === "dark" ? "light" : "dark",
                      }),
                    )
                  }
                >
                  ◐
                </Button>
              </div>
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <Button onClick={() => setError("")}>Dismiss</Button>
            </div>
          )}
          {state.quarantineCount > 0 && (
            <div role="alert" className="error-banner">
              {state.quarantineCount} invalid local records are preserved.
              Editing is paused; open Recovery to export diagnostic data or
              import a verified backup from Settings.
              <Button onClick={() => setRoute("recovery")}>
                Open Recovery
              </Button>
            </div>
          )}
          {state.sessionInterrupted && (
            <div role="alert" className="error-banner">
              A Space switch was interrupted. Your checkpoints are kept. Inspect
              the open windows and Recovery before continuing.
              <Button onClick={() => setRoute("recovery")}>
                Open Recovery
              </Button>
              <Button
                onClick={() =>
                  setConfirm({
                    title: "Resume session management",
                    text: "Continue after inspecting your windows. This clears the interrupted-operation marker; it does not replay the switch or close any tabs.",
                    run: async () => {
                      await client.browser("acknowledgeSessionFailure");
                    },
                  })
                }
              >
                I have inspected my windows
              </Button>
            </div>
          )}
          {surface === "newtab" && state.settings.clock && (
            <div className="clock">
              <strong>
                {clockNow.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </strong>
              <span>
                {clockNow.toLocaleDateString([], {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </span>
            </div>
          )}
          {surface === "newtab" && (
            <section
              className="newtab-access"
              style={{
                backgroundColor: state.settings.background,
                backgroundImage: backgroundImage
                  ? `linear-gradient(#14222555,#14222555), url("${backgroundImage}")`
                  : undefined,
              }}
            >
              <h2>Your next useful step</h2>
              <div className="pane-tools">
                {spaces
                  .filter((s) => s.favorite)
                  .map((s) => (
                    <Button key={s.id} onClick={() => navigate(s.id)}>
                      <span className={`space-icon ${s.color}`}>
                        <SpaceIcon temporary={s.temporary} />
                      </span>{" "}
                      {s.name}
                    </Button>
                  ))}
                <Button onClick={() => setPalette(true)}>Search</Button>
                <Button onClick={newSpace}>New Space</Button>
                <Button onClick={() => setRoute("tasks")}>
                  {
                    all.filter(
                      (e) =>
                        e.kind === "task" &&
                        !e.deletedAt &&
                        !e.completedAt &&
                        e.dueDate &&
                        e.dueDate <= localDate(),
                    ).length
                  }{" "}
                  tasks due · My Tasks
                </Button>
              </div>
            </section>
          )}
          {route === "home" && (
            <Home
              spaces={spaces.filter((item) => item.id !== state.inboxId)}
              state={state}
              onOpen={navigate}
              onView={(id) => navigate(id, false)}
              collections={all
                .filter((e) => e.kind === "sidebar" && !e.deletedAt)
                .sort(sort)}
              onCreate={newSpace}
            />
          )}
          {route === "space" && space && (
            <>
              {surface === "panel" ? (
                <header className="panel-space-header">
                  <div className="panel-space-title">
                    <span className={`space-icon ${space.color}`}>
                      {space.id === state.inboxId ? (
                        <NavigationIcon name="inbox" />
                      ) : (
                        <SpaceIcon temporary={space.temporary} />
                      )}
                    </span>
                    <h1>{space.name}</h1>
                    {space.id === windowSpaceId && <CurrentSpaceBadge />}
                  </div>
                  <div className="panel-space-actions">
                    {space.id !== state.inboxId &&
                      space.id !== windowSpaceId && (
                        <Button
                          onClick={() =>
                            void run(() =>
                              client.browser("activateSession", {
                                spaceId: space.id,
                                windowId: state.currentWindowId,
                              }),
                            )
                          }
                        >
                          Open Space
                        </Button>
                      )}
                    {space.temporary && (
                      <Button
                        className="primary"
                        onClick={() => saveSpace(space)}
                      >
                        Save Space
                      </Button>
                    )}
                    {space.id !== state.inboxId && (
                      <Button
                        title="Space actions"
                        onClick={() => setInspect(space)}
                      >
                        ⋯
                      </Button>
                    )}
                  </div>
                </header>
              ) : (
                <>
                  {" "}
                  <header className="space-header">
                    <div className={`hero-icon ${space.color}`}>
                      {space.id === state.inboxId ? (
                        <NavigationIcon name="inbox" />
                      ) : (
                        <SpaceIcon temporary={space.temporary} />
                      )}
                    </div>
                    <div className="space-title">
                      <span className="eyebrow">
                        {space.id === state.inboxId
                          ? "INBOX · CONTENT TO ORGANIZE"
                          : space.temporary
                            ? "SPACE · UNSAVED"
                            : "SPACE · SAVED"}
                      </span>
                      <h1>{space.name}</h1>
                      <p>
                        {space.description ||
                          "A little room for your next big idea."}
                      </p>
                    </div>
                    <div className="header-actions">
                      {space.kind === "space" &&
                        space.id !== state.inboxId &&
                        client.isExtension && (
                          <>
                            <span className="session-label">
                              {state.sessions.some(
                                (s) => s.spaceId === space.id && !s.parked,
                              )
                                ? "Session open"
                                : state.sessions.some(
                                      (s) => s.spaceId === space.id && s.parked,
                                    )
                                  ? "Session preserved"
                                  : "Session closed"}
                            </span>
                            <Button
                              onClick={() =>
                                void run(() =>
                                  client.browser("activateSession", {
                                    spaceId: space.id,
                                    windowId: state.currentWindowId,
                                  }),
                                )
                              }
                            >
                              Open Space
                            </Button>
                            <Button
                              disabled={
                                !state.sessions.some(
                                  (session) => session.spaceId === space.id,
                                )
                              }
                              onClick={() =>
                                setConfirm({
                                  title: "Close Space",
                                  text: "Close this Space's live tabs after saving their website URLs. Resources, notes and tasks stay saved. Unsaved page contents cannot be restored from URLs.",
                                  run: async () => {
                                    await client.browser("closeSession", {
                                      spaceId: space.id,
                                    });
                                  },
                                })
                              }
                            >
                              Close Space
                            </Button>
                          </>
                        )}
                      {space.id !== state.inboxId && (
                        <>
                          <Button
                            title={
                              space.favorite
                                ? "Remove favorite"
                                : "Favorite Space"
                            }
                            onClick={() =>
                              void change(space, { favorite: !space.favorite })
                            }
                          >
                            {space.favorite ? "★" : "☆"}
                          </Button>
                          <Button onClick={() => edit(space)}>Edit</Button>
                        </>
                      )}
                      {space.temporary && (
                        <Button
                          className="primary"
                          onClick={() => saveSpace(space)}
                        >
                          Save Space
                        </Button>
                      )}
                      <Button
                        onClick={() =>
                          void change(space, { split: !space.split })
                        }
                      >
                        {space.split ? "Single view" : "Split view"}
                      </Button>
                      {space.id !== state.inboxId && (
                        <Button
                          title="Space actions"
                          onClick={() => setInspect(space)}
                        >
                          ⋯
                        </Button>
                      )}
                    </div>
                  </header>
                  {space.id !== state.inboxId && (
                    <div className="properties">
                      {properties()}
                      <Button onClick={addProperty}>+ Property</Button>
                      {!!space.fields.length && (
                        <Button onClick={() => setFieldManager(true)}>
                          Manage fields
                        </Button>
                      )}
                    </div>
                  )}
                </>
              )}
              <div
                className="view-nav"
                role="navigation"
                aria-label="Space views"
              >
                {views
                  .filter((v) => space.id !== state.inboxId || v !== "tabs")
                  .map((v) => (
                    <Button
                      key={v}
                      className={
                        (surface === "panel" ? panelView : space.view) === v
                          ? "active"
                          : ""
                      }
                      onClick={(event) => {
                        if (surface === "panel") setPanelView(v);
                        else if (event.ctrlKey)
                          void change(space, { split: true, rightView: v });
                        else void change(space, { view: v });
                      }}
                    >
                      {symbols[v]} {viewName(v)}
                    </Button>
                  ))}
              </div>
              <div
                className={`panes ${space.split && surface !== "panel" ? "split" : ""}`}
                style={
                  {
                    "--split-ratio": `${space.splitRatio}%`,
                  } as React.CSSProperties
                }
              >
                {pane(surface === "panel" ? panelView : space.view)}
                {space.split && surface !== "panel" && (
                  <>
                    <input
                      type="range"
                      className="split-divider"
                      aria-label="Resize content panes"
                      min="25"
                      max="75"
                      defaultValue={space.splitRatio}
                      onChange={(e) =>
                        e.currentTarget.parentElement?.style.setProperty(
                          "--split-ratio",
                          `${e.target.value}%`,
                        )
                      }
                      onPointerUp={(e) =>
                        void change(space, {
                          splitRatio: Number(e.currentTarget.value),
                        })
                      }
                      onKeyUp={(e) =>
                        void change(space, {
                          splitRatio: Number(e.currentTarget.value),
                        })
                      }
                    />
                    {pane(space.rightView, true)}
                  </>
                )}
              </div>
            </>
          )}
          {route === "tasks" && (
            <div className="page task-overview">
              <span className="eyebrow">ONE CHECKLIST, ALL YOUR SPACES</span>
              <h1>My Tasks</h1>
              <TasksWorkspace
                focusNewTask={surface === "panel" ? panelTaskFocus : undefined}
                entities={all}
                inboxId={state.inboxId}
                onSaved={refresh}
                onViewSpace={viewTasks}
                onConfirm={setConfirm}
              />
            </div>
          )}
          {route === "search" && (
            <div className="page">
              <h1>Search</h1>
              {searchUI()}
            </div>
          )}
          {(["archive", "trash"] as Route[]).includes(route) && (
            <div className="page">
              <h1>{route === "archive" ? "Archive" : "Trash"}</h1>
              <p className="muted">
                Your content remains on this device until you deliberately
                remove it.
              </p>
              {route === "trash" && (
                <div className="trash-actions">
                  <Button
                    className="danger empty-trash"
                    disabled={busy > 0 || !all.some((e) => e.deletedAt)}
                    onClick={() =>
                      setConfirm({
                        title: "Empty Trash permanently?",
                        text: "All items currently in Trash will be permanently removed. This cannot be undone from Trash. Independent exports and protected session snapshots are retained.",
                        run: async () => {
                          await client.command({ type: "emptyTrash" });
                        },
                      })
                    }
                  >
                    <NavigationIcon name="trash" /> Empty Trash
                  </Button>
                </div>
              )}
              {route === "trash" && !all.some((e) => e.deletedAt) && (
                <p className="muted">Trash is empty.</p>
              )}
              {all
                .filter((e) =>
                  route === "archive"
                    ? e.kind === "space" && e.archivedAt && !e.deletedAt
                    : !!e.deletedAt,
                )
                .map((e) => (
                  <div className="item" key={e.id}>
                    <div className="item-main">
                      <strong>{e.name}</strong>
                      <small>
                        {kindName(e.kind)} · {e.deletedAt || e.archivedAt}
                      </small>
                    </div>
                    <Button
                      onClick={() =>
                        void run(() =>
                          route === "archive"
                            ? client.update(e, { archivedAt: undefined })
                            : client.command({
                                type: "restore",
                                id: e.id,
                                expectedRevision: e.revision,
                              }),
                        )
                      }
                    >
                      Restore
                    </Button>
                    {route === "trash" && (
                      <Button
                        className="danger"
                        onClick={() =>
                          setConfirm({
                            title: "Permanently remove this trashed content?",
                            text: "The item and its content children will be removed. Independent exports and protected session snapshots are retained. This is not secure disk erasure.",
                            run: async () => {
                              await client.command({
                                type: "purge",
                                id: e.id,
                                expectedRevision: e.revision,
                              });
                            },
                          })
                        }
                      >
                        Remove permanently
                      </Button>
                    )}
                  </div>
                ))}
            </div>
          )}
          {route === "recovery" && (
            <Recovery
              entities={all}
              inboxId={state.inboxId}
              quarantineCount={state.quarantineCount}
              onPreview={setRestorePreview}
              onRefresh={refresh}
              onBack={() => setRoute("settings")}
            />
          )}
          {route === "settings" && (
            <Settings
              settings={{ ...state.settings, ...settingsEdits }}
              newTab={
                client.isExtension &&
                !!chrome.runtime.getManifest().chrome_url_overrides?.newtab
              }
              properties={all.filter(
                (e) => e.kind === "property" && !e.deletedAt,
              )}
              recordCount={all.length}
              snapshotCount={state.snapshotCount ?? state.snapshots.length}
              onChange={(patch) => {
                const sequence = ++settingsEditSequence.current;
                setSettingsEdits((current) => ({ ...current, ...patch }));
                void run(() => client.settings(patch)).then(() => {
                  if (settingsEditSequence.current === sequence)
                    setSettingsEdits({});
                });
              }}
              onRecovery={() => setRoute("recovery")}
              onReset={() =>
                setConfirm({
                  title: "Reset all TabSpace data?",
                  text: "All local TabSpace data and settings will be deleted. Chrome website tabs and the separate Drag Group extension are not removed.",
                  run: async () => {
                    await client.request({ type: "resetCollection" });
                    localStorage.clear();
                    history.replaceState({ tabspace: "home" }, "");
                    location.href = client.isExtension
                      ? chrome.runtime.getURL("index.html")
                      : "/";
                  },
                })
              }
              onExport={(format) =>
                void run(async () =>
                  download(
                    await exportBackup(repository, format),
                    `TabSpace-${localDate()}.${format}`,
                  ),
                )
              }
              onImport={(file) =>
                void run(async () =>
                  setImportPreview({ ...(await parseBackup(file)), file }),
                )
              }
              onBackground={(file) =>
                void run(async () => {
                  if (
                    !["image/png", "image/jpeg", "image/webp"].includes(
                      file.type,
                    ) ||
                    file.size > 10 * 1024 * 1024
                  )
                    throw new Error(
                      "Choose a PNG, JPEG or WebP image up to 10 MiB.",
                    );
                  const attachment = await repository.attachment(
                    file,
                    file.name,
                  );
                  await client.settings({
                    backgroundAttachmentId: attachment.id,
                  });
                })
              }
              onEditProperty={edit}
              onTrashProperty={trash}
            />
          )}
        </main>
      )}
      {dialog && (
        <FormDialog {...dialog} onClose={() => setDialog(undefined)} />
      )}{" "}
      {confirm && (
        <Modal title={confirm.title} onClose={() => setConfirm(undefined)}>
          <p>{confirm.text}</p>
          <footer>
            <Button onClick={() => setConfirm(undefined)}>Cancel</Button>
            <Button
              className="primary"
              onClick={() => {
                const action = confirm.run;
                setConfirm(undefined);
                void run(action);
              }}
            >
              Confirm
            </Button>
          </footer>
        </Modal>
      )}
      {inspect && (
        <Modal title={inspect.name} onClose={() => setInspect(undefined)}>
          <p>{inspect.description || `${kindName(inspect.kind)} actions`}</p>
          <div className="action-grid">
            {inspect.kind === "space" && inspect.temporary && (
              <Button
                className="primary"
                onClick={() => {
                  saveSpace(inspect);
                  setInspect(undefined);
                }}
              >
                Save Space
              </Button>
            )}
            <Button
              onClick={() => {
                edit(inspect);
                setInspect(undefined);
              }}
            >
              Edit details
            </Button>
            <Button
              onClick={() => {
                void run(() =>
                  client.command({
                    type: "duplicate",
                    id: inspect.id,
                    expectedRevision: inspect.revision,
                  }),
                );
                setInspect(undefined);
              }}
            >
              Duplicate
            </Button>
            {inspect.kind === "space" && inspect.id !== state.inboxId && (
              <>
                <Button
                  onClick={() => {
                    navigate(inspect.id, false);
                    setInspect(undefined);
                  }}
                >
                  View Space
                </Button>
                <Button
                  onClick={() => {
                    void change(inspect, {
                      archivedAt: new Date().toISOString(),
                    });
                    setInspect(undefined);
                  }}
                >
                  Archive Space
                </Button>
                <Button
                  onClick={() => {
                    void run(() =>
                      client.browser("openSaved", {
                        spaceId: inspect.id,
                        newWindow: true,
                      }),
                    );
                    setInspect(undefined);
                  }}
                >
                  Open tabs in new window
                </Button>
                <Button
                  onClick={() => {
                    dialogFor({
                      title: "Move Space to collection",
                      fields: [
                        {
                          key: "section",
                          label: "Collection",
                          type: "select",
                          value: inspect.sidebarId ?? "",
                          options: [
                            { value: "", label: "No collection" },
                            ...all
                              .filter(
                                (e) => e.kind === "sidebar" && !e.deletedAt,
                              )
                              .map((e) => ({ value: e.id, label: e.name })),
                          ],
                        },
                      ],
                      submit: "Move",
                      onSubmit: async (v) => {
                        await client.command({
                          type: "move",
                          id: inspect.id,
                          expectedRevision: inspect.revision,
                          targetSectionId: v.section || undefined,
                        });
                      },
                    });
                    setInspect(undefined);
                  }}
                >
                  Move to collection
                </Button>
              </>
            )}
            {inspect.kind === "task" &&
              inspect.description.match(/^https?:\/\//) && (
                <Button
                  onClick={() =>
                    void run(() =>
                      client.browser("open", { url: inspect.description }),
                    )
                  }
                >
                  Open attached tab link
                </Button>
              )}
            <Button
              className="danger"
              onClick={() => {
                trash(inspect);
                setInspect(undefined);
              }}
            >
              Move to trash
            </Button>
          </div>
        </Modal>
      )}
      {palette && (
        <Modal title="Search & quick actions" onClose={() => setPalette(false)}>
          {searchUI()}
          <div className="pane-tools">
            <Button
              onClick={() => {
                setPalette(false);
                newSpace();
              }}
            >
              + Space
            </Button>
            {space &&
              ["notes", "tasks", "resources"].map((v) => (
                <Button
                  key={v}
                  onClick={() => {
                    setPalette(false);
                    addItem(v as View);
                  }}
                >
                  + {v.slice(0, -1)}
                </Button>
              ))}
          </div>
        </Modal>
      )}
      {fieldManager && space && (
        <Modal title="Space properties" onClose={() => setFieldManager(false)}>
          <p className="muted">
            Definitions are reusable. Values belong to this Space. Hiding a
            field keeps its value.
          </p>
          {[...space.fields]
            .sort((a, b) => a.order - b.order)
            .map((field, index) => {
              const definition = all.find((e) => e.id === field.definitionId);
              if (!definition) return null;
              const update = (patch: Partial<typeof field>) =>
                change(space, {
                  fields: space.fields.map((f) =>
                    f.definitionId === field.definitionId
                      ? { ...f, ...patch }
                      : f,
                  ),
                });
              return (
                <section className="card" key={field.definitionId}>
                  <h3>{definition.name}</h3>
                  <div className="pane-tools">
                    <label className="inline">
                      <input
                        type="checkbox"
                        checked={field.visible}
                        onChange={(e) =>
                          void update({ visible: e.target.checked })
                        }
                      />
                      Show in header
                    </label>
                    <Button
                      disabled={index === 0}
                      onClick={() => {
                        const ordered = [...space.fields].sort(
                          (a, b) => a.order - b.order,
                        );
                        [ordered[index - 1], ordered[index]] = [
                          ordered[index],
                          ordered[index - 1],
                        ];
                        void change(space, {
                          fields: ordered.map((f, i) => ({ ...f, order: i })),
                        });
                      }}
                    >
                      Move earlier
                    </Button>
                    <Button onClick={() => edit(definition)}>
                      Edit reusable definition
                    </Button>
                  </div>
                  <Button
                    onClick={() =>
                      void change(space, {
                        fields: space.fields.filter(
                          (f) => f.definitionId !== field.definitionId,
                        ),
                      })
                    }
                  >
                    Remove field from this Space
                  </Button>
                </section>
              );
            })}
        </Modal>
      )}
      {importPreview && (
        <Modal
          title="Review backup import"
          onClose={() => setImportPreview(undefined)}
        >
          <p>
            {importPreview.data.entities.length} records ·{" "}
            {importPreview.attachments.length} verified attachments ·{" "}
            {importPreview.data.snapshots.length} snapshots
          </p>
          <p>
            Merge creates new identities. Replace preserves an internal
            before-import copy and clears live mappings. Export an independent
            backup first.
          </p>
          <footer>
            <Button
              onClick={() =>
                void run(async () => {
                  await client.importCollection(importPreview.file, "merge");
                  setImportPreview(undefined);
                })
              }
            >
              Merge as new records
            </Button>
            <Button
              className="danger"
              onClick={() => {
                const parsed = importPreview;
                setConfirm({
                  title: "Replace your local collection?",
                  text: "Current records will be replaced. Keep an exported backup before continuing.",
                  run: async () => {
                    await client.importCollection(parsed.file, "replace");
                    setImportPreview(undefined);
                    setSpaceId(parsed.data.inboxId!);
                    setRoute("space");
                    setSelected(new Set());
                  },
                });
                setImportPreview(undefined);
              }}
            >
              Replace after backup
            </Button>
          </footer>
        </Modal>
      )}
      {restorePreview && (
        <Modal
          title="Restore session additively"
          onClose={() => setRestorePreview(undefined)}
        >
          {restoreError && (
            <div role="alert">
              <p>{restoreError}</p>
              <Button onClick={() => setRestoreRetry((n) => n + 1)}>
                Retry checkpoint
              </Button>
            </div>
          )}
          {!previewSnapshot && !restoreError && (
            <p role="status">Loading checkpoint…</p>
          )}
          {previewSnapshot && (
            <div className="recovery-selection">
              <span>
                {previewSnapshot.tabs.length} tabs · {restoreIndices.size}{" "}
                selected
              </span>
              <Button
                onClick={() =>
                  setRestoreIndices(
                    new Set(previewSnapshot.tabs.map((_, i) => i)),
                  )
                }
              >
                Select all tabs
              </Button>
              <Button onClick={() => setRestoreIndices(new Set())}>
                Clear selection
              </Button>
            </div>
          )}
          {previewSnapshot?.tabs
            .slice(restorePage * 50, (restorePage + 1) * 50)
            .map((t, row) => {
              const i = restorePage * 50 + row;
              return (
                <label className="restore-tab inline" key={i}>
                  <input
                    type="checkbox"
                    checked={restoreIndices.has(i)}
                    onChange={() =>
                      setRestoreIndices((s) => {
                        const n = new Set(s);
                        n.has(i) ? n.delete(i) : n.add(i);
                        return n;
                      })
                    }
                  />
                  <span>
                    {t.title}
                    <small>
                      {t.windowKey ?? "Original window unknown"} · {t.url}
                    </small>
                  </span>
                </label>
              );
            })}
          {previewSnapshot && previewSnapshot.tabs.length > 50 && (
            <div
              className="recovery-pagination"
              role="navigation"
              aria-label="Checkpoint tabs pages"
            >
              <Button
                disabled={restorePage === 0}
                onClick={() => setRestorePage((n) => n - 1)}
              >
                Previous tabs
              </Button>
              <span>
                {restorePage * 50 + 1}–
                {Math.min((restorePage + 1) * 50, previewSnapshot.tabs.length)}{" "}
                of {previewSnapshot.tabs.length}
              </span>
              <Button
                disabled={(restorePage + 1) * 50 >= previewSnapshot.tabs.length}
                onClick={() => setRestorePage((n) => n + 1)}
              >
                Next tabs
              </Button>
            </div>
          )}
          <footer>
            <Button
              disabled={!previewSnapshot || !restoreIndices.size}
              onClick={() =>
                void run(async () => {
                  await client.browser("restoreSession", {
                    snapshotId: restorePreview,
                    indices: Array.from(restoreIndices),
                    newWindow: true,
                  });
                  setRestorePreview(undefined);
                })
              }
            >
              Restore in new window
            </Button>
            <Button
              className="primary"
              disabled={!previewSnapshot || !restoreIndices.size}
              onClick={() =>
                void run(async () => {
                  await client.browser("restoreSession", {
                    snapshotId: restorePreview,
                    indices: Array.from(restoreIndices),
                  });
                  setRestorePreview(undefined);
                })
              }
            >
              Restore selected tabs
            </Button>
            <Button
              disabled={!previewSnapshot || !restoreIndices.size}
              onClick={() => {
                const snapshotId = restorePreview,
                  indices = [...restoreIndices];
                setRestorePreview(undefined);
                dialogFor({
                  title: "Recover selected tabs as a Space",
                  fields: [nameField("Recovered session")],
                  submit: "Recover Space",
                  onSubmit: async (v) => {
                    await client.browser("restoreSession", {
                      snapshotId,
                      indices,
                      recoveredSpaceName: v.name,
                      newWindow: true,
                    });
                  },
                });
              }}
            >
              Recover as Space
            </Button>
            <Button
              disabled={!previewSnapshot || !restoreIndices.size}
              onClick={() =>
                void run(async () => {
                  await client.browser("restoreSession", {
                    snapshotId: restorePreview,
                    indices: [...restoreIndices],
                    restoreWindows: true,
                  });
                  setRestorePreview(undefined);
                })
              }
            >
              Restore original windows
            </Button>
            <Button
              disabled={!previewSnapshot || !restoreIndices.size}
              className="danger"
              onClick={() => {
                const snapshotId = restorePreview,
                  indices = [...restoreIndices];
                setRestorePreview(undefined);
                setConfirm({
                  title: "Replace current website tabs?",
                  text: "A protected checkpoint is saved first. Selected URLs are restored, then existing unpinned website tabs in the last focused normal window are closed. Pinned, browser-internal and TabSpace tabs remain open.",
                  run: () =>
                    client
                      .browser("restoreSession", {
                        snapshotId,
                        indices,
                        replace: true,
                      })
                      .then(() => undefined),
                });
              }}
            >
              Replace current tabs
            </Button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
function domain(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "Unavailable URL";
  }
}
