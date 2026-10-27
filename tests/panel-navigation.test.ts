import { expect, it, vi } from "vitest";
import {
  openSidePanel,
  panelNavigationKey,
} from "../apps/extension/src/panel-navigation";

it("opens with the user gesture before writing the window-specific destination", async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const open = vi.fn(() => {
    calls.push("open");
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const set = vi.fn(async () => {
    calls.push("destination");
  });
  vi.stubGlobal("chrome", {
    sidePanel: { open },
    storage: { session: { set } },
  });
  try {
    const result = openSidePanel(42, "tasks");
    expect(calls).toEqual(["open"]);
    finish();
    await result;
    expect(calls).toEqual(["open", "destination"]);
    expect(set).toHaveBeenCalledWith({
      [panelNavigationKey(42)]: {
        destination: "tasks",
        requestId: expect.any(String),
      },
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
it("does not enqueue navigation if Chrome cannot open the panel", async () => {
  const set = vi.fn();
  vi.stubGlobal("chrome", {
    sidePanel: { open: vi.fn().mockRejectedValue(Error("no gesture")) },
    storage: { session: { set } },
  });
  try {
    await expect(openSidePanel(42, "spaces")).rejects.toThrow("no gesture");
    expect(set).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
