import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { repository } from "../packages/persistence/repository";
import { entity } from "../packages/domain/model";
import { exportBackup } from "../packages/persistence/backup";
import { importCollection, isExtension } from "../apps/extension/src/client";
it("keeps portable backup import available in local development preview without a Chrome worker", async () => {
  expect(isExtension).toBe(false);
  try {
    await repository.initialize();
    const space = entity("space", "Preview import");
    await repository.execute({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "create",
      entity: space,
    });
    const backup = await exportBackup(repository, "json");
    await repository.db.entities.delete(space.id);
    await importCollection(backup, "replace");
    expect((await repository.db.entities.get(space.id))?.name).toBe(space.name);
    expect(
      await repository.db.meta
        .where("id")
        .startsWith("pending-import:")
        .count(),
    ).toBe(0);
  } finally {
    await repository.db.delete();
  }
});
