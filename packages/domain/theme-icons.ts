import type { Settings } from "./model";

// Stable palette hues keep the browser icon legible regardless of Chrome's own theme.
export const themeIconColors: Record<Settings["colorTheme"], string> = {
  green: "#28796c",
  blue: "#315f9c",
  purple: "#76509c",
  graphite: "#525862",
  sand: "#87602e",
};
export function themeIconPath(theme: Settings["colorTheme"], size: number) {
  return `icons/${theme}/icon${size}.png`;
}
export function themeToolbarIcons(theme: Settings["colorTheme"]) {
  return Object.fromEntries(
    [16, 24, 32, 48].map((size) => [size, themeIconPath(theme, size)]),
  );
}
