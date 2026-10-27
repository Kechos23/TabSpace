# Drag Group

Create native Chrome tab groups by dragging one ordinary tab over another. Drag Group is available standalone or inside TabSpace, using one shared Windows helper.

## Install standalone

1. Download **DragGroup-0.1.21.zip** and **DragGroup-Helper-Setup-1.0.0.exe** from [releases](https://github.com/Kechos23/TabSpace/releases/tag/drag-group-v0.1.21).
2. Extract the extension ZIP into a permanent folder. In `chrome://extensions`, enable Developer mode, choose **Load unpacked** and select the folder containing `manifest.json`.
3. Run the helper Setup and complete its .NET/runtime checks. The installer is per-user and is currently unsigned.
4. Disable TabSpace's integrated Drag Group if enabled. Check the standalone popup status and keep its pinned controller open.

Use one active edition. Requires Windows x64, Chrome 116+ and .NET 10 Desktop Runtime x64. The organizer itself works without this helper.

## Use

Drag a single unpinned, ungrouped tab over an eligible tab in the same visible strip. Feedback appears after a short dwell; release to group or move back to cancel. Holds are bounded to 30 seconds. Incognito, overflow, hidden F11 strips, elevated Chrome, multiple selection and cross-window dragging are excluded.

For repair/update, pause Drag Group and rerun Setup. Remove the managed helper through Windows Settings → Apps. Your Chrome data and TabSpace collection are not removed by helper uninstall.

See the root [README](../../README.md), [installation guide](../../docs/USER_GUIDE_EN.md), [integration details](../../docs/drag-group-integration.md) and [known limits](../../docs/KNOWN_LIMITATIONS.md). Source is GPL-3.0-only.
