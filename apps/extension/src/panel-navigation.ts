export type PanelDestination = "tasks" | "spaces";
export type PanelNavigation = {
  destination: PanelDestination;
  requestId: string;
};
export const panelNavigationKey = (windowId: number) =>
  `panel:navigation:${windowId}`;

export async function openSidePanel(
  windowId: number,
  destination: PanelDestination,
) {
  // Keep open() before any await: Chrome requires the popup's user gesture.
  await chrome.sidePanel.open({ windowId });
  await chrome.storage.session.set({
    [panelNavigationKey(windowId)]: {
      destination,
      requestId: crypto.randomUUID(),
    } satisfies PanelNavigation,
  });
}
