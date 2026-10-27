import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import {
  entity,
  entitySchema,
  commandSchema,
  plainDoc,
} from "../packages/domain/model";
import { Repository, TabSpaceDB } from "../packages/persistence/repository";
import {
  exportBackup,
  parseBackup,
  importBackup,
} from "../packages/persistence/backup";
let repo: Repository;
beforeEach(async () => {
  repo = new Repository(new TabSpaceDB(`retired-${crypto.randomUUID()}`));
  await repo.initialize();
});
afterEach(async () => {
  await repo.db.delete();
});
const legacyFields = {
  templateType: "space",
  templateVersion: 2,
  blueprintIds: [],
};
const root = () => ({
  ...entity("space", "Retired root"),
  ...legacyFields,
  kind: "template",
});
it("migrates legacy storage atomically, removing owned records/files/history but keeping ordinary Spaces, shared definitions and instantiated content", async () => {
  const retired = root(),
    shared = entity("property", "Shared", { propertyType: "text" }),
    exclusive = entity("property", "Retired field", { propertyType: "text" });
  const file = await repo.attachment(new Blob(["shared file"]), "shared.txt"),
    orphan = await repo.attachment(new Blob(["retired file"]), "retired.txt");
  const space = entity("space", "Real {{Client}}", {
    fields: [
      {
        definitionId: shared.id,
        value: "keep",
        required: false,
        visible: true,
        order: 0,
      },
    ],
  });
  const note = entity("note", "Real note", {
    spaceId: space.id,
    doc: plainDoc("Literal {{Client}}"),
    attachmentIds: [file.id],
  });
  const child = entity("note", "Retired note", {
    spaceId: retired.id,
    doc: plainDoc("retired"),
    attachmentIds: [file.id, orphan.id],
  });
  retired.fields = [
    {
      definitionId: shared.id,
      value: "x",
      required: false,
      visible: true,
      order: 0,
    },
    {
      definitionId: exclusive.id,
      value: "y",
      required: false,
      visible: true,
      order: 1,
    },
  ];
  await repo.db.entities.bulkPut([
    retired,
    { ...space, ...legacyFields, provenance: { id: retired.id, version: 2 } },
    note,
    child,
    shared,
    exclusive,
  ] as any);
  await repo.db.drafts.put({
    id: "old-draft",
    noteId: child.id,
    baseRevision: 1,
    doc: plainDoc("old"),
    text: "old",
    updatedAt: new Date().toISOString(),
  });
  await repo.db.revisions.put({
    id: crypto.randomUUID(),
    noteId: child.id,
    revision: 1,
    doc: plainDoc("old"),
    text: "old",
    createdAt: new Date().toISOString(),
  });
  await repo.db.meta.put({ id: `quarantine:${retired.id}`, value: retired });
  await repo.db.meta.put({
    id: "before-import:test",
    value: {
      entities: [retired, child, space, note, shared, exclusive],
      attachments: [file, orphan],
    },
  });
  await repo.db.journal.put({
    id: crypto.randomUUID(),
    intent: "makeTemplate",
    state: "committed",
    createdAt: new Date().toISOString(),
    result: [retired],
  } as any);
  await repo.db.meta.delete("migration:retired-content:v1");
  await repo.initialize();
  expect(
    (await repo.list()).some((e) =>
      [retired.id, child.id, exclusive.id].includes(e.id),
    ),
  ).toBe(false);
  expect(await repo.db.entities.get(space.id)).toEqual(space);
  expect(await repo.db.entities.get(note.id)).toEqual(note);
  expect(await repo.db.attachments.get(orphan.id)).toBeUndefined();
  expect(await (await repo.db.attachments.get(file.id))!.blob.text()).toBe(
    "shared file",
  );
  expect(await repo.db.drafts.count()).toBe(0);
  expect(await repo.db.revisions.count()).toBe(0);
  expect(await repo.db.journal.count()).toBe(0);
  expect(await repo.db.meta.get(`quarantine:${retired.id}`)).toBeUndefined();
  expect(
    JSON.stringify((await repo.db.meta.get("before-import:test"))?.value),
  ).not.toMatch(/templateType|blueprintIds|Retired note/);
  const before = await repo.list();
  await repo.initialize();
  expect(await repo.list()).toEqual(before);
  const duplicate = await repo.execute({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    type: "duplicate",
    id: space.id,
    expectedRevision: 1,
  });
  expect(duplicate[0].name).toBe("Real {{Client}} copy");
  expect(duplicate.find((e) => e.kind === "note")?.doc).toEqual(note.doc);
  await parseBackup(await exportBackup(repo, "zip"));
});
it("imports old full JSON/ZIP backups without resurrecting the retired feature or its exclusive files", async () => {
  const retired = root(),
    child = entity("note", "Retired child", {
      spaceId: retired.id,
      doc: plainDoc("old"),
    });
  const file = await repo.attachment(new Blob(["retired"]), "old.txt");
  child.attachmentIds = [file.id];
  const raw = JSON.parse(await (await exportBackup(repo, "json")).text());
  raw.entities = raw.entities.map((e: any) => ({ ...e, ...legacyFields }));
  raw.entities.push(retired, child);
  const parsed = await parseBackup(new Blob([JSON.stringify(raw)]));
  expect(parsed.data.entities.every((e) => e.kind === "space")).toBe(true);
  expect(parsed.attachments).toHaveLength(0);
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(raw)),
  };
  for (const attachment of raw.attachments)
    files[`attachments/${attachment.id}.bin`] = Uint8Array.from(
      atob(attachment.data),
      (c) => c.charCodeAt(0),
    );
  const zipped = await parseBackup(
    new Blob([new Uint8Array(zipSync(files)).buffer]),
  );
  await importBackup(repo, zipped, "replace");
  expect(
    (await repo.list()).some((e) => e.id === retired.id || e.id === child.id),
  ).toBe(false);
  expect(await repo.db.attachments.count()).toBe(0);
  const exported = await (await exportBackup(repo, "json")).text();
  expect(exported).not.toMatch(
    /templateType|templateVersion|blueprintIds|"kind":"template"/,
  );
  await expect(
    parseBackup(
      new Blob([
        JSON.stringify({
          ...raw,
          purpose: "template",
          rootTemplateId: retired.id,
        }),
      ]),
    ),
  ).rejects.toThrow("retired standalone");
});
it("rejects retired kinds and commands rather than retaining hidden capabilities", () => {
  expect(entitySchema.safeParse(root()).success).toBe(false);
  for (const type of ["makeTemplate", "makeDocumentTemplate", "instantiate"])
    expect(
      commandSchema.safeParse({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type,
      }).success,
    ).toBe(false);
});
