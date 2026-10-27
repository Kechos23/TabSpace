import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { Repository, TabSpaceDB } from "../packages/persistence/repository";
import { defaults, settingsSchema } from "../packages/domain/model";
it("defaults automatic manager off when reading older settings", () => {
  const { autoOpenManager, ...older } = defaults;
  expect(settingsSchema.parse(older).autoOpenManager).toBe(false);
  expect(
    settingsSchema.parse({ ...older, autoOpenManager: true }).autoOpenManager,
  ).toBe(true);
});
it("atomically merges concurrent preference patches from independent connections", async () => {
  const name = `preferences-${crypto.randomUUID()}`;
  const a = new Repository(new TabSpaceDB(name)),
    b = new Repository(new TabSpaceDB(name));
  try {
    await a.initialize();
    await Promise.all([
      a.patchSettings({ colorTheme: "blue" }),
      b.patchSettings({ restoreBrowsing: false }),
      a.patchSettings({ dragGroupEnabled: true }),
    ]);
    expect(await a.settings()).toMatchObject({
      colorTheme: "blue",
      restoreBrowsing: false,
      dragGroupEnabled: true,
    });
    await expect(a.patchSettings({ sidebarWidth: 5 })).rejects.toThrow();
    await expect(a.patchSettings({ schemaVersion: 1 })).rejects.toThrow();
    await expect(a.patchSettings({ unknown: true } as never)).rejects.toThrow();
    expect((await b.settings()).colorTheme).toBe("blue");
  } finally {
    b.db.close();
    await a.db.delete();
  }
});
