export function startDragGroupWorker(options?: {
  controllerPath?: string;
  reusePages?: boolean;
  preferenceKey?: string;
  defaultEnabled?: boolean;
  messagePrefix?: string;
  eligible?: (windowId: number) => Promise<boolean>;
  blockedReason?: (windowId: number) => Promise<string | undefined>;
  keepPages?: () => Promise<boolean>;
  onPreference?: (enabled: boolean) => Promise<void>;
  onContext?: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ) => Promise<unknown>;
  onGesture?: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ) => Promise<unknown>;
}): {
  reconcile(): Promise<void>;
  ensureWindow(windowId: number): Promise<void>;
  contexts(windowId?: number): Promise<chrome.runtime.ExtensionContext[]>;
  enabled(): Promise<boolean>;
  invalidate(): Promise<unknown>;
  getState(): Promise<{
    enabled: boolean;
    version: string;
    windows: {
      windowId: number;
      tabId?: number;
      status: string;
      running: boolean;
    }[];
  }>;
};
