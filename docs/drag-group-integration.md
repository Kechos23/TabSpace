# Drag Group for Windows

TabSpace's optional integration and standalone Drag Group share a local Windows helper. Use one active edition at a time. Windows x64, Chrome 116+ and .NET 10 Desktop Runtime x64 are required.

## Setup

Download the shared Setup EXE from either product release. Pause Drag Group or close Chrome, run Setup and follow the runtime/registration checks. An older registration is replaced only after confirmation. Enable Drag Group in TabSpace Settings or the standalone popup and accept Chrome's helper permission.

The helper installer is per-user and adds no Windows startup task or service. Rerun Setup for repair/update; remove it through Windows Settings → Apps. See [installer guide](HELPER_INSTALLER.md).

## Group tabs

Drag one selected, unpinned, ungrouped tab over another eligible tab in the same visible horizontal strip. At 16% overlap and 200 ms dwell, the paired feedback appears. Release to group or move back to cancel. Passing a tab clears the target and starts a fresh dwell on the next eligible neighbor. Each mouse hold is bounded to 30 seconds.

The native helper verifies window identity, tab order and accessibility geometry. It does not receive website URLs/content or inject input. Ambiguous state cancels.

## Manager/controller lifetime

Integration uses one primary pinned TabSpace manager per normal window; standalone uses its own pinned controller. Secondary manager views remain supported. A manager can also be maintained independently through **Settings → Manager → Keep a pinned manager in every window**, without the helper or Drag Group permission. Both preferences share one page lifecycle.

Automatically created managers/controllers in proven tear-out windows retire when the final browsing tab leaves; independently opened managers are preserved. Preserved windows, app-like windows and imports/session changes have explicit guards. Pausing Drag Group leaves managers open while stopping native connections.

## Supported scope

Only ordinary visible, unpinned/ungrouped pairs in the same verified window are supported. Incognito, overflow, hidden F11 strips, elevated Chrome, multiple selected tabs and cross-window gestures are excluded. Broader physical mouse/DPI/multi-monitor acceptance is separate from automated protocol/policy/browser tests. See [known limits](KNOWN_LIMITATIONS.md) and [validation](validation/README.md).
