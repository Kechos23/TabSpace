import { z } from "zod";

export const kinds = [
  "space",
  "sidebar",
  "section",
  "resource",
  "note",
  "task",
  "property",
  "savedTab",
  "group",
] as const;
export type Kind = (typeof kinds)[number];
export const views = ["tabs", "resources", "notes", "tasks"] as const;
export type View = (typeof views)[number];
export const colors = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
] as const;
export function safeUrl(value: string): string {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use an http or https link without embedded credentials.");
  return value; // Preserve query strings, fragments and the original link.
}
// External browser labels must fit the persisted entity-name schema.
export function browserLabel(value: string | undefined, fallback: string) {
  let label = (value || fallback).slice(0, 500);
  if (/[\uD800-\uDBFF]$/.test(label)) label = label.slice(0, -1);
  return label;
}
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value;
}
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export const documentSchema: z.ZodType<Doc> = z.lazy(() =>
  z
    .object({
      type: z.enum([
        "doc",
        "paragraph",
        "text",
        "heading",
        "bulletList",
        "orderedList",
        "listItem",
        "taskList",
        "taskItem",
        "codeBlock",
        "blockquote",
        "hardBreak",
        "horizontalRule",
      ]),
      text: z.string().max(2_000_000).optional(),
      attrs: z
        .object({
          level: z.number().int().min(1).max(6).optional(),
          checked: z.boolean().optional(),
          language: z.string().max(80).nullable().optional(),
          start: z.number().int().optional(),
        })
        .strict()
        .optional(),
      marks: z
        .array(
          z
            .object({
              type: z.enum([
                "bold",
                "italic",
                "strike",
                "code",
                "underline",
                "link",
              ]),
              attrs: z
                .object({
                  href: z.string().refine((v) => {
                    try {
                      safeUrl(v);
                      return true;
                    } catch {
                      return false;
                    }
                  }),
                  target: z.string().nullable().optional(),
                  rel: z.string().nullable().optional(),
                  class: z.string().nullable().optional(),
                })
                .strict()
                .optional(),
            })
            .strict(),
        )
        .max(20)
        .optional(),
      content: z.array(documentSchema).max(50_000).optional(),
    })
    .strict(),
);
export type Doc = {
  type: string;
  text?: string;
  attrs?: {
    level?: number;
    checked?: boolean;
    language?: string | null;
    start?: number;
  };
  marks?: {
    type: string;
    attrs?: {
      href: string;
      target?: string | null;
      rel?: string | null;
      class?: string | null;
    };
  }[];
  content?: Doc[];
};
export const blankDoc = (): Doc => ({
  type: "doc",
  content: [{ type: "paragraph" }],
});
export function documentText(doc: Doc): string {
  return [doc.text ?? "", ...(doc.content ?? []).map(documentText)]
    .filter(Boolean)
    .join(" ");
}
export function markdown(doc: Doc): string {
  let text =
    doc.text ??
    (doc.content ?? [])
      .map(markdown)
      .join(
        ["bulletList", "orderedList", "taskList", "doc"].includes(doc.type)
          ? "\n"
          : "",
      );
  for (const mark of doc.marks ?? []) {
    if (mark.type === "bold") text = `**${text}**`;
    if (mark.type === "italic") text = `*${text}*`;
    if (mark.type === "strike") text = `~~${text}~~`;
    if (mark.type === "underline") text = `<u>${text}</u>`;
    if (mark.type === "code") text = `\`${text}\``;
    if (mark.type === "link" && mark.attrs)
      text = `[${text}](${mark.attrs.href})`;
  }
  if (doc.type === "heading")
    return `${"#".repeat(doc.attrs?.level ?? 1)} ${text}\n\n`;
  if (doc.type === "blockquote")
    return (
      text
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n") + "\n\n"
    );
  if (doc.type === "orderedList")
    return (
      (doc.content ?? [])
        .map(
          (child, index) =>
            `${(doc.attrs?.start ?? 1) + index}. ${markdown(child).replace(/^- /, "")}`,
        )
        .join("\n") + "\n"
    );
  if (doc.type === "codeBlock")
    return `\n\`\`\`${doc.attrs?.language ?? ""}\n${text}\n\`\`\`\n`;
  if (doc.type === "listItem") return `- ${text.trim()}`;
  if (doc.type === "taskItem")
    return `- [${doc.attrs?.checked ? "x" : " "}] ${text.trim()}`;
  if (doc.type === "paragraph") return `${text}\n\n`;
  if (doc.type === "hardBreak") return "\n";
  return text;
}
const fieldSchema = z
  .object({
    definitionId: z.string().uuid(),
    value: z.string().max(10000),
    defaultValue: z.string().max(10000).optional(),
    required: z.boolean(),
    visible: z.boolean(),
    order: z.number(),
  })
  .strict();
export type Field = z.infer<typeof fieldSchema>;
export function plainDoc(text: string): Doc {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}
export const entitySchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(kinds),
    name: z.string().min(1).max(500),
    description: z.string().max(2_000_000).default(""),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    browsingClosedAt: z.string().datetime().optional(),
    revision: z.number().int().min(1),
    order: z.number().finite(),
    spaceId: z.string().uuid().optional(),
    sectionId: z.string().uuid().optional(),
    sidebarId: z.string().uuid().optional(),
    deletedAt: z.string().datetime().optional(),
    archivedAt: z.string().datetime().optional(),
    color: z.enum(colors).default("blue"),
    icon: z.string().max(8).default("◈"),
    favorite: z.boolean().default(false),
    temporary: z.boolean().default(false),
    collapsed: z.boolean().default(false),
    view: z.enum(views).default("resources"),
    rightView: z.enum(views).default("tasks"),
    split: z.boolean().default(false),
    splitRatio: z.number().min(25).max(75).default(55),
    url: z
      .string()
      .max(20000)
      .refine((v) => {
        try {
          safeUrl(v);
          return true;
        } catch {
          return false;
        }
      })
      .optional(),
    titleMode: z.enum(["auto", "manual"]).default("manual"),
    tags: z.array(z.string().max(100)).max(100).default([]),
    sectionKind: z.enum(["resources", "notes", "tasks"]).optional(),
    doc: documentSchema.optional(),
    text: z.string().max(2_000_000).default(""),
    attachmentIds: z.array(z.string().uuid()).max(10000).default([]),
    dueDate: z.string().refine(validDate).optional(),
    completedAt: z.string().datetime().optional(),
    starred: z.boolean().default(false),
    priority: z.enum(["none", "low", "medium", "high"]).default("none"),
    propertyType: z.enum(["text", "date", "select"]).optional(),
    options: z
      .array(
        z
          .object({ id: z.string().uuid(), label: z.string().min(1).max(300) })
          .strict(),
      )
      .max(1000)
      .default([]),
    fields: z.array(fieldSchema).max(1000).default([]),
    groupId: z.string().uuid().optional(),
    pinned: z.boolean().default(false),
    muted: z.boolean().default(false),
    locked: z.boolean().default(false),
  })
  .strict();
export type Entity = z.infer<typeof entitySchema>;
export function entity(
  kind: Kind,
  name: string,
  overrides: Partial<Entity> = {},
): Entity {
  const now = new Date().toISOString();
  return entitySchema.parse({
    id: crypto.randomUUID(),
    kind,
    name,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    order: Date.now(),
    ...overrides,
  });
}
export const settingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    theme: z.enum(["light", "dark", "system"]),
    colorTheme: z
      .enum(["green", "blue", "purple", "graphite", "sand"])
      .default("green"),
    pinManager: z.boolean(),
    autoOpenManager: z.boolean().default(false),
    inheritOpener: z.boolean(),
    preserveLiveTabs: z.boolean().default(true),
    restoreBrowsing: z.boolean().default(true),
    lockTabsByDefault: z.boolean().default(false),
    unsavedLimit: z.number().int().min(0).max(100).default(10),
    unsavedDays: z.number().int().min(1).max(365).default(7),
    retentionDays: z.number().int().min(1).max(36500),
    showCompleted: z.boolean(),
    sidebarWidth: z.number().min(180).max(420),
    clock: z.boolean(),
    background: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    backgroundAttachmentId: z.string().uuid().optional(),
    helperEnabled: z.boolean(),
    dragGroupEnabled: z.boolean().default(false),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export const defaults: Settings = {
  schemaVersion: 1,
  theme: "system",
  colorTheme: "green",
  pinManager: false,
  autoOpenManager: false,
  inheritOpener: false,
  preserveLiveTabs: true,
  restoreBrowsing: true,
  lockTabsByDefault: false,
  unsavedLimit: 10,
  unsavedDays: 7,
  retentionDays: 90,
  showCompleted: false,
  sidebarWidth: 248,
  clock: true,
  background: "#edf5f3",
  helperEnabled: false,
  dragGroupEnabled: false,
};
export type LiveTab = {
  faviconKey?: string;
  id: number;
  windowId: number;
  index: number;
  groupId: number;
  title: string;
  url: string;
  active: boolean;
  pinned: boolean;
  audible: boolean;
  discarded: boolean;
  autoDiscardable: boolean;
  muted: boolean;
  spaceId?: string;
  lockId?: string;
  recordId?: string;
  openerTabId?: number;
};
export type LiveGroup = {
  id: number;
  windowId: number;
  title: string;
  color: (typeof colors)[number];
  collapsed: boolean;
  spaceId?: string;
  logicalId?: string;
};
export const tabBlueprintSchema = z
  .object({
    lockId: z.string().uuid().optional(),
    recordId: z.string().uuid().optional(),
    url: z
      .string()
      .max(20000)
      .refine((v) => {
        try {
          safeUrl(v);
          return true;
        } catch {
          return false;
        }
      }),
    title: z.string().max(10000),
    spaceId: z.string().uuid().optional(),
    groupKey: z.string().optional(),
    windowKey: z.string().max(100).optional(),
    pinned: z.boolean(),
    muted: z.boolean(),
  })
  .strict();
export const snapshotSchema = z
  .object({
    id: z.string().uuid(),
    capturedAt: z.string().datetime(),
    reason: z.string().max(300),
    protected: z.boolean(),
    tabs: z.array(tabBlueprintSchema).max(100000),
    groups: z
      .array(
        z
          .object({
            key: z.string(),
            windowKey: z.string().max(100).optional(),
            title: z.string().max(500),
            color: z.enum(colors),
            collapsed: z.boolean(),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Attachment = {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  hash: string;
  blob: Blob;
  createdAt: string;
};
export type Draft = {
  id: string;
  noteId: string;
  baseRevision: number;
  doc: Doc;
  text: string;
  updatedAt: string;
};
export type NoteRevision = {
  id: string;
  noteId: string;
  revision: number;
  doc: Doc;
  text: string;
  createdAt: string;
};
export type Journal = {
  id: string;
  state:
    "committed" | "planned" | "executing" | "applied" | "failed" | "uncertain";
  createdAt: string;
  intent: string;
  result?: Entity[];
  error?: string;
};
export type BrowserState = {
  id: "browser";
  generation: string;
  tabs: LiveTab[];
  groups: LiveGroup[];
  updatedAt: string;
};
// Do not use entitySchema.partial(): entity defaults must never reset unrelated
// fields during a patch. Explicit null means clear an optional persisted value.
const clearable = <T extends z.ZodType>(schema: T) =>
  schema.nullable().optional();
export const patchSchema = z
  .object({
    name: z.string().min(1).max(500).optional(),
    description: z.string().max(2_000_000).optional(),
    order: z.number().finite().optional(),
    color: z.enum(colors).optional(),
    icon: z.string().max(8).optional(),
    favorite: z.boolean().optional(),
    locked: z.boolean().optional(),
    groupId: clearable(z.string().uuid()),
    temporary: z.boolean().optional(),
    browsingClosedAt: clearable(z.string().datetime()),
    collapsed: z.boolean().optional(),
    view: z.enum(views).optional(),
    rightView: z.enum(views).optional(),
    split: z.boolean().optional(),
    splitRatio: z.number().min(25).max(75).optional(),
    archivedAt: clearable(z.string().datetime()),
    deletedAt: clearable(z.string().datetime()),
    sidebarId: clearable(z.string().uuid()),
    url: clearable(
      z
        .string()
        .max(20000)
        .refine((v) => {
          try {
            safeUrl(v);
            return true;
          } catch {
            return false;
          }
        }),
    ),
    titleMode: z.enum(["auto", "manual"]).optional(),
    tags: z.array(z.string().max(100)).max(100).optional(),
    doc: documentSchema.optional(),
    text: z.string().max(2_000_000).optional(),
    attachmentIds: z.array(z.string().uuid()).max(10000).optional(),
    dueDate: clearable(z.string().refine(validDate)),
    completedAt: clearable(z.string().datetime()),
    starred: z.boolean().optional(),
    priority: z.enum(["none", "low", "medium", "high"]).optional(),
    fields: z.array(fieldSchema).max(1000).optional(),
    options: z
      .array(
        z
          .object({ id: z.string().uuid(), label: z.string().min(1).max(300) })
          .strict(),
      )
      .max(1000)
      .optional(),
    propertyType: z.enum(["text", "date", "select"]).optional(),
  })
  .strict();
export const commandSchema = z
  .object({
    schemaVersion: z.literal(1),
    commandId: z.string().uuid(),
    type: z.enum([
      "create",
      "update",
      "trash",
      "restore",
      "move",
      "duplicate",
      "purge",
      "emptyTrash",
      "presentation",
    ]),
    entity: entitySchema.optional(),
    id: z.string().uuid().optional(),
    expectedRevision: z.number().int().positive().optional(),
    patch: patchSchema.optional(),
    targetSpaceId: z.string().uuid().optional(),
    targetSectionId: z.string().uuid().optional(),
  })
  .strict();
export type Command = z.infer<typeof commandSchema>;
export function assertGraph(
  entities: Entity[],
  attachmentIds: Set<string> = new Set(),
): void {
  const map = new Map(entities.map((e) => [e.id, e]));
  if (map.size !== entities.length)
    throw new Error("Duplicate entity identities.");
  for (const e of entities) {
    if (
      ["resource", "note", "task", "section", "savedTab", "group"].includes(
        e.kind,
      ) &&
      (!e.spaceId || map.get(e.spaceId)?.kind !== "space")
    )
      throw new Error("Missing content parent.");
    if (e.sectionId) {
      const s = map.get(e.sectionId);
      if (
        s?.kind !== "section" ||
        s.spaceId !== e.spaceId ||
        s.sectionKind !== `${e.kind}s`
      )
        throw new Error("Invalid content section.");
    }
    if (e.sidebarId && map.get(e.sidebarId)?.kind !== "sidebar")
      throw new Error("Invalid sidebar section.");
    if (
      e.groupId &&
      (map.get(e.groupId)?.kind !== "group" ||
        map.get(e.groupId)?.spaceId !== e.spaceId)
    )
      throw new Error("Invalid logical group.");
    for (const id of e.attachmentIds)
      if (!attachmentIds.has(id)) throw new Error("Missing attachment.");
    if (new Set(e.fields.map((f) => f.definitionId)).size !== e.fields.length)
      throw new Error("A definition can appear only once in a Space.");
    for (const f of e.fields) {
      const p = map.get(f.definitionId);
      if (p?.kind !== "property")
        throw new Error("Missing property definition.");
      for (const value of [f.value, f.defaultValue]) {
        if (value && p.propertyType === "date" && !validDate(value))
          throw new Error("Invalid property date.");
        if (
          value &&
          p.propertyType === "select" &&
          !p.options.some((o) => o.id === value)
        )
          throw new Error("Invalid select option.");
      }
    }
  }
}
export function remapEntities(input: Entity[]): Entity[] {
  const ids = new Map(input.map((e) => [e.id, crypto.randomUUID()]));
  return input.map((e) => ({
    ...e,
    id: ids.get(e.id)!,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: undefined,
    archivedAt: undefined,
    spaceId: e.spaceId ? (ids.get(e.spaceId) ?? e.spaceId) : undefined,
    sectionId: e.sectionId ? (ids.get(e.sectionId) ?? e.sectionId) : undefined,
    sidebarId: e.sidebarId ? (ids.get(e.sidebarId) ?? e.sidebarId) : undefined,
    groupId: e.groupId ? ids.get(e.groupId) : undefined,
    fields: e.fields.map((field) => ({
      ...field,
      definitionId: ids.get(field.definitionId) ?? field.definitionId,
    })),
  }));
}
