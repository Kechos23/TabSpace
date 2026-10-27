import type { Entity, Settings } from "./model";

// Darker fills retain a legible white TabSpace glyph, including yellow/cyan.
export const spaceIconColors: Record<Entity["color"], string> = {
  grey: "#525862",
  blue: "#315f9c",
  red: "#bd464d",
  yellow: "#a07710",
  green: "#28796c",
  pink: "#aa3e75",
  purple: "#76509c",
  cyan: "#167c91",
  orange: "#b86316",
};
export type IconAppearance = "light" | "dark";
export function savedSpaceIconPath(
  color: Entity["color"],
  appearance: IconAppearance,
  size = 32,
) {
  return `icons/spaces/${color}/${appearance}/icon${size}.png`;
}
export function managerIconPath(
  theme: Settings["colorTheme"],
  space?: Entity,
  inboxId?: string,
  appearance: IconAppearance = "dark",
) {
  return space?.kind === "space" &&
    !space.temporary &&
    !space.deletedAt &&
    !space.archivedAt &&
    space.id !== inboxId
    ? savedSpaceIconPath(space.color, appearance)
    : `icons/${theme}/icon32.png`;
}
