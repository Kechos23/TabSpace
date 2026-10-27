import { validateIntent } from "./policy.js";
// Shared browser-side executor: every attempt rechecks the real Chrome state.
export async function applyGesture(message, capture, adapter) {
  for (let i = 0; i < 5; i++) {
    if (!adapter.enabled()) throw new Error("Disabled before grouping.");
    const current = await adapter.snapshot(),
      focused = await adapter.focused();
    validateIntent(message, capture, current, focused);
    if (!adapter.enabled()) throw new Error("Disabled before grouping.");
    try {
      const group = await adapter.createGroup({
        tabIds: [message.sourceId, message.targetId],
        createProperties: { windowId: current.windowId },
      });
      if (!Number.isInteger(group)) throw new Error("No group acknowledgment.");
      return group;
    } catch (e) {
      if (i === 4 || !String(e).includes("Tabs cannot be edited right now"))
        throw e;
      await new Promise((r) => setTimeout(r, 75 * (i + 1)));
    }
  }
  throw new Error("Chrome is still dragging; grouping cancelled.");
}
