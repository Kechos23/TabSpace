import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { entity, defaults, settingsSchema } from "../packages/domain/model";
import {
  expiredUnsaved,
  hasPersonalContent,
} from "../packages/domain/browsing";
import { Repository, TabSpaceDB } from "../packages/persistence/repository";

const closed = (name: string, days: number) =>
  entity("space", name, {
    temporary: true,
    browsingClosedAt: new Date(Date.now() - days * 86400000).toISOString(),
  });
it("expires only closed URL-only Unsaved sessions, applying both limits and protecting open/startup/content", () => {
  const newest = closed("New", 1),
    older = closed("Old", 2),
    expired = closed("Expired", 20),
    active = closed("Open", 30),
    startup = closed("Startup", 30),
    content = closed("Content", 30);
  const all = [
    newest,
    older,
    expired,
    active,
    startup,
    content,
    entity("task", "Keep", { spaceId: content.id }),
  ];
  expect(
    new Set(
      expiredUnsaved(all, new Set([active.id]), new Set([startup.id]), 1, 7),
    ),
  ).toEqual(new Set([older.id, expired.id]));
  expect(hasPersonalContent(content, all)).toBe(true);
});
it("preserves content even when trashed or attached to the Space itself", () => {
  const space = closed("Draft", 50),
    note = entity("note", "Trashed note", {
      spaceId: space.id,
      deletedAt: new Date().toISOString(),
    });
  expect(expiredUnsaved([space, note], new Set(), new Set(), 0, 1)).toEqual([]);
  expect(
    hasPersonalContent({ ...space, attachmentIds: [crypto.randomUUID()] }, [
      space,
    ]),
  ).toBe(true);
});
it("defaults old settings to startup restore and a 10 session / 7 day history", () => {
  const { restoreBrowsing, unsavedLimit, unsavedDays, ...legacy } = defaults;
  expect(settingsSchema.parse(legacy)).toMatchObject({
    restoreBrowsing: true,
    unsavedLimit: 10,
    unsavedDays: 7,
  });
});
it("prunes only eligible Spaces transactionally and resets the collection independently of Chrome", async () => {
  const repo = new Repository(
    new TabSpaceDB(`browsing-${crypto.randomUUID()}`),
  );
  try {
    await repo.initialize();
    const discard = closed("Discard", 30),
      keep = closed("Keep", 30),
      archived = {
        ...closed("Archived", 30),
        archivedAt: new Date().toISOString(),
      },
      trashed = {
        ...closed("Trashed", 30),
        deletedAt: new Date().toISOString(),
      },
      note = entity("note", "Protected note", { spaceId: keep.id });
    for (const item of [discard, keep, archived, trashed, note])
      await repo.execute({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: item,
      });
    await repo.removeEmptyUnsaved(
      [discard.id, keep.id, archived.id, trashed.id],
      new Set(),
      new Set(),
    );
    expect(await repo.db.entities.get(discard.id)).toBeUndefined();
    expect(await repo.db.entities.get(note.id)).toBeDefined();
    expect(await repo.db.entities.get(archived.id)).toBeDefined();
    expect(await repo.db.entities.get(trashed.id)).toBeDefined();
    await repo.resetCollection();
    const entities = await repo.list();
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({
      name: "Inbox",
      view: "resources",
      temporary: false,
    });
    expect(await repo.db.attachments.count()).toBe(0);
    expect(await repo.db.snapshots.count()).toBe(0);
    expect(await repo.settings()).toEqual(defaults);
  } finally {
    await repo.db.delete();
  }
});
