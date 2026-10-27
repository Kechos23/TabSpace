import type { Entity, Settings } from "../../../../packages/domain/model";
import {
  managerIconPath,
  type IconAppearance,
} from "../../../../packages/domain/manager-icons";

export function syncPageIcon(
  theme: Settings["colorTheme"],
  space?: Entity,
  inboxId?: string,
  appearance: IconAppearance = "dark",
) {
  setPageIconPath(managerIconPath(theme, space, inboxId, appearance));
}

export function setPageIconPath(path: string) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.append(link);
  }
  link.type = "image/png";
  link.sizes = "32x32";
  const href = new URL(path, document.baseURI).href;
  if (link.href !== href) link.href = href;
}
