import { expect, it, vi } from "vitest";
import {
  themeIconColors,
  themeToolbarIcons,
} from "../packages/domain/theme-icons";
import { colors, entity } from "../packages/domain/model";
import {
  managerIconPath,
  savedSpaceIconPath,
  spaceIconColors,
} from "../packages/domain/manager-icons";

it("uses the actual Saved Space color across the complete supported palette", () => {
  expect(Object.keys(spaceIconColors).sort()).toEqual([...colors].sort());
  expect(new Set(Object.values(spaceIconColors)).size).toBe(colors.length);
  for (const color of colors)
    for (const appearance of ["light", "dark"] as const) {
      const saved = entity("space", "Saved", { color, temporary: false });
      expect(managerIconPath("blue", saved, undefined, appearance)).toBe(
        savedSpaceIconPath(color, appearance),
      );
    }
});
it("falls back to the theme for Unsaved, Inbox, unavailable and non-Space records", () => {
  const saved = entity("space", "Saved");
  for (const space of [
    undefined,
    { ...saved, temporary: true },
    { ...saved, deletedAt: new Date().toISOString() },
    { ...saved, archivedAt: new Date().toISOString() },
    entity("resource", "Link"),
  ])
    expect(managerIconPath("blue", space)).toBe("icons/blue/icon32.png");
  expect(managerIconPath("purple", saved, saved.id)).toBe(
    "icons/purple/icon32.png",
  );
});

it("supplies a distinct icon palette and all toolbar resolutions for each theme", () => {
  expect(new Set(Object.values(themeIconColors)).size).toBe(5);
  for (const theme of Object.keys(
    themeIconColors,
  ) as (keyof typeof themeIconColors)[]) {
    expect(Object.keys(themeToolbarIcons(theme))).toEqual([
      "16",
      "24",
      "32",
      "48",
    ]);
  }
});
it("serializes changes, avoids redundant updates, and reapplies after a fresh worker", async () => {
  const setIcon = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("chrome", { action: { setIcon } });
  try {
    vi.resetModules();
    const { syncToolbarIcon } =
      await import("../apps/extension/src/background/theme-icon");
    await Promise.all([
      syncToolbarIcon("blue"),
      syncToolbarIcon("purple"),
      syncToolbarIcon("purple"),
    ]);
    expect(setIcon).toHaveBeenCalledTimes(2);
    expect(setIcon).toHaveBeenLastCalledWith({
      path: themeToolbarIcons("purple"),
    });
    vi.resetModules();
    await (
      await import("../apps/extension/src/background/theme-icon")
    ).syncToolbarIcon("purple");
    expect(setIcon).toHaveBeenCalledTimes(3);
  } finally {
    vi.unstubAllGlobals();
  }
});
it("keeps icon errors cosmetic and retries the same theme", async () => {
  const setIcon = vi
    .fn()
    .mockRejectedValueOnce(Error("temporary icon failure"))
    .mockResolvedValue(undefined);
  vi.stubGlobal("chrome", { action: { setIcon } });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    vi.resetModules();
    const { syncToolbarIcon } =
      await import("../apps/extension/src/background/theme-icon");
    await expect(syncToolbarIcon("sand")).resolves.toBeUndefined();
    await syncToolbarIcon("sand");
    expect(setIcon).toHaveBeenCalledTimes(2);
  } finally {
    warning.mockRestore();
    vi.unstubAllGlobals();
  }
});
