export function applyGesture(
  message: any,
  capture: any,
  adapter: {
    snapshot(): Promise<any>;
    focused(): Promise<boolean>;
    enabled(): boolean;
    createGroup(options: chrome.tabs.GroupOptions): Promise<number>;
  },
): Promise<number>;
