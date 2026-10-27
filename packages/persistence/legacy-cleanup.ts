// Compatibility cleanup for retired storage. No retired kind/command is
// accepted by the current domain or exposed by the application.
const obsoleteFields = new Set([
  "templateVersion",
  "templateType",
  "blueprintIds",
  "provenance",
  "rootTemplateId",
]);
const obsoleteCommands = new Set([
  "makeTemplate",
  "makeDocumentTemplate",
  "instantiate",
]);
type Row = Record<string, any>;
const plain = (value: unknown): value is Row =>
  !!value && Object.getPrototypeOf(value) === Object.prototype;
const list = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter(plain) : [];
export function cleanLegacyBackup(input: unknown) {
  if (plain(input) && input.purpose === "template")
    throw new Error(
      "This retired standalone archive cannot be imported. Use a full collection backup.",
    );
  return cleanRetiredData(input);
}
export function cleanRetiredData<T>(input: T): {
  value: T;
  removedIds: Set<string>;
} {
  const rows: Row[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (plain(value)) {
      rows.push(value);
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(input);
  const removed = new Set<string>(
    rows
      .filter((row) => row.kind === "template" && typeof row.id === "string")
      .map((row) => row.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (
        typeof row.id === "string" &&
        row.kind &&
        !removed.has(row.id) &&
        [row.spaceId, row.sectionId].some((id) => removed.has(id))
      ) {
        removed.add(row.id);
        changed = true;
      }
    }
  }
  const entities = rows.filter((row) => row.kind && typeof row.id === "string");
  const usedFields = new Set(
    entities
      .filter((row) => !removed.has(row.id))
      .flatMap((row) => list(row.fields).map((field) => field.definitionId)),
  );
  for (const row of entities.filter((row) => removed.has(row.id)))
    for (const field of list(row.fields)) {
      if (!usedFields.has(field.definitionId)) removed.add(field.definitionId);
    }
  const retainedFiles = new Set(
    entities
      .filter((row) => !removed.has(row.id))
      .flatMap((row) =>
        Array.isArray(row.attachmentIds) ? row.attachmentIds : [],
      ),
  );
  for (const row of rows)
    if (row.backgroundAttachmentId)
      retainedFiles.add(row.backgroundAttachmentId);
  for (const row of entities.filter((row) => removed.has(row.id)))
    for (const id of Array.isArray(row.attachmentIds) ? row.attachmentIds : [])
      if (!retainedFiles.has(id)) removed.add(id);
  const clean = (value: any): any => {
    if (Array.isArray(value))
      return value.map(clean).filter((item) => item !== undefined);
    if (!plain(value)) return value;
    if (
      removed.has(value.id) ||
      removed.has(value.noteId) ||
      removed.has(value.spaceId) ||
      obsoleteCommands.has(value.intent) ||
      obsoleteCommands.has(value.type)
    )
      return undefined;
    if (
      typeof value.id === "string" &&
      value.id.split(":").some((part: string) => removed.has(part))
    )
      return undefined;
    const output: Row = {};
    for (const [key, item] of Object.entries(value)) {
      if (obsoleteFields.has(key) || (key === "purpose" && item === "template"))
        continue;
      const next = clean(item);
      if (next !== undefined) output[key] = next;
    }
    if (Array.isArray(output.tabs) && Array.isArray(output.groups)) {
      const keys = new Set(
        output.tabs.map((tab: Row) => tab.groupKey ?? tab.groupId),
      );
      output.groups = output.groups.filter((group: Row) =>
        keys.has(group.key ?? group.id),
      );
    }
    return output;
  };
  return { value: clean(input), removedIds: removed };
}
