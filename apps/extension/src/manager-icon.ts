import { setPageIconPath } from "./ui/theme-icon";

// Runs independently of React, manager hydration and the full browser view queue.
const appearance = window.matchMedia("(prefers-color-scheme: dark)");
let paths: { light: string; dark: string } | undefined;
let pending = false,
  dirty = false,
  revision = 0,
  disposed = false;
const apply = () => {
  if (paths && !disposed)
    setPageIconPath(appearance.matches ? paths.dark : paths.light);
};
async function refresh() {
  revision++;
  if (pending) {
    dirty = true;
    return;
  }
  pending = true;
  try {
    do {
      dirty = false;
      const requested = revision;
      try {
        const response = await chrome.runtime.sendMessage({
          type: "managerIcon",
        });
        if (response?.ok && requested === revision && !disposed) {
          paths = response.value;
          apply();
        }
      } catch {
        /* Cosmetic only; the next session/view event retries. */
      }
    } while (dirty && !disposed);
  } finally {
    pending = false;
  }
}
const changed = (message: { type?: string }) => {
  if (
    message.type === "tabspace:changed" ||
    message.type === "tabspace:iconChanged"
  )
    void refresh();
};
chrome.runtime.onMessage.addListener(changed);
appearance.addEventListener("change", apply);
void refresh();
void chrome.tabs.getCurrent().then((tab) => {
  if (!tab?.id || disposed) return;
  const attached = (id: number) => {
    if (id === tab.id) void refresh();
  };
  chrome.tabs.onAttached.addListener(attached);
  window.addEventListener(
    "pagehide",
    () => chrome.tabs.onAttached.removeListener(attached),
    { once: true },
  );
});
window.addEventListener(
  "pagehide",
  () => {
    disposed = true;
    chrome.runtime.onMessage.removeListener(changed);
    appearance.removeEventListener("change", apply);
  },
  { once: true },
);
