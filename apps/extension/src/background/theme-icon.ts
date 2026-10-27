import type { Settings } from "../../../../packages/domain/model";
import { themeToolbarIcons } from "../../../../packages/domain/theme-icons";

let applied: Settings["colorTheme"] | undefined;
let pending = Promise.resolve();
export function syncToolbarIcon(theme: Settings["colorTheme"]) {
  // Serialize changes so rapid palette changes cannot leave an older icon behind.
  pending = pending
    .then(async () => {
      if (applied === theme) return;
      await chrome.action.setIcon({ path: themeToolbarIcons(theme) });
      applied = theme;
    })
    .catch((error) => {
      // A cosmetic failure must not interrupt session recovery or saving settings.
      console.warn("Could not update the TabSpace toolbar icon", error);
    });
  return pending;
}
