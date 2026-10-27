# Drag Group 0.1.21

Create native Chrome tab groups by dragging one ordinary tab over another. Standalone Drag Group shares the Windows helper with TabSpace but has its own settings and extension identity.

## Downloads

- **DragGroup-0.1.21.zip** — standalone Chrome extension; extract it into a permanent folder.
- **DragGroup-Helper-Setup-1.0.0.exe** — shared helper Setup. Install it once even if both products are present.
- **DragGroup-SHA256SUMS.txt** — checksums for those downloads.

At `chrome://extensions`, enable Developer mode and **Load unpacked** the extracted folder containing `manifest.json`. Run Setup, complete its runtime checks and inspect the standalone popup status. Disable TabSpace's integrated Drag Group when using standalone. Keep the pinned controller open.

Requires Windows x64, Chrome 116+ and .NET 10 Desktop Runtime x64. The installer is per-user and currently unsigned. It installs no Windows service or startup task. Rerun it to repair/update; uninstall through Windows Settings → Apps. The helper installer does not install a Chrome extension.

## Gesture

Drag one selected, unpinned, ungrouped tab over another eligible tab in the same visible horizontal strip. At 16% overlap and 200 ms dwell, paired feedback appears. Release to group or move back to cancel. Passing a neighbor clears it and starts a new dwell on the next target. Each hold is bounded to 30 seconds.

Window identity, tab order, focus and geometry must remain verifiable. Incognito, overflow, hidden F11 strips, elevated Chrome, multiple selection and cross-window dragging are excluded. A rare initial-position outline flash and wider physical DPI/multi-monitor behavior remain documented acceptance items.

See [installation](../USER_GUIDE_EN.md), [integration details](../drag-group-integration.md), [validation](../validation/README.md) and [known limits](../KNOWN_LIMITATIONS.md). This fresh GPL-3.0-only public package is built from the shared public source, with matching GitHub/Gitea downloads. It is installed unpacked and updated manually; no Store approval is implied.
