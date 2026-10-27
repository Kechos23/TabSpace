import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { defaults, settingsSchema } from "../packages/domain/model";
import { Repository, TabSpaceDB } from "../packages/persistence/repository";
import {
  exportBackup,
  parseBackup,
  importBackup,
} from "../packages/persistence/backup";

it("defaults older settings to Green while preserving their appearance preference", () => {
  const { colorTheme, ...old } = defaults;
  expect(settingsSchema.parse({ ...old, theme: "dark" })).toMatchObject({
    colorTheme: "green",
    theme: "dark",
  });
  expect(
    settingsSchema.safeParse({ ...defaults, colorTheme: "unknown" }).success,
  ).toBe(false);
});

it("persists palette independently of appearance and restores it from a complete backup", async () => {
  const repo = new Repository(new TabSpaceDB(`themes-${crypto.randomUUID()}`));
  try {
    await repo.initialize();
    await repo.setSettings({
      ...defaults,
      colorTheme: "purple",
      theme: "light",
    });
    const exported = await exportBackup(repo, "json");
    const parsed = await parseBackup(exported);
    await repo.setSettings(defaults);
    await importBackup(repo, parsed, "replace");
    expect(await repo.settings()).toMatchObject({
      colorTheme: "purple",
      theme: "light",
    });
  } finally {
    await repo.db.delete();
  }
});
