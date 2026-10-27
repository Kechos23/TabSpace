import { it, expect, vi } from "vitest";
import {
  beginIconIntent,
  endIconIntent,
  iconIntentFor,
} from "../apps/extension/src/background/manager-icon-intent";
it("keeps activation hints scoped to their window and cleans only the matching operation", () => {
  vi.stubGlobal("chrome", {
    runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) },
  });
  try {
    const old = Symbol(),
      current = Symbol(),
      other = Symbol();
    beginIconIntent(10, "first", old);
    beginIconIntent(11, "other", other);
    beginIconIntent(10, "second", current);
    endIconIntent(old);
    expect(iconIntentFor(10)).toBe("second");
    expect(iconIntentFor(11)).toBe("other");
    endIconIntent(current);
    expect(iconIntentFor(10)).toBeUndefined();
    expect(iconIntentFor(11)).toBe("other");
    endIconIntent(other);
    expect(iconIntentFor(11)).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});
