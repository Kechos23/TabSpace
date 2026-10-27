# TabSpace 0.18.4

Your Tabs. Your Workspace. A local-first Chrome organizer for Spaces, Collections, tabs, Resources, Notes and Tasks, with optional encrypted Nextcloud/WebDAV sync and Windows Drag Group.

## Downloads

- **TabSpace-0.18.4.zip** — the extension. It keeps your existing Chrome new-tab page.
- **DragGroup-Helper-Setup-1.0.0.exe** — optional Windows helper installer for Drag Group. The organizer and independent pinned manager work without it.
- **TabSpace-SHA256SUMS.txt** — checksums for those downloads.

Install the extension by extracting it to a permanent folder, enabling Developer mode at `chrome://extensions` and choosing **Load unpacked** for the folder containing `manifest.json`. For updates, export a backup, preserve the installed path, replace files and choose **Reload**. Do not Remove the extension to update it; removal clears active local data.

Guides: [English](../USER_GUIDE_EN.md) · [Ελληνικά](../USER_GUIDE_EL.md) · [Helper setup](../HELPER_INSTALLER.md). Licenses and notices are bundled inside the packages.

## Included

- Saved and Unsaved browsing, configurable startup recovery and Lock in Space.
- A full manager, compact Chrome side panel and popup quick actions.
- Formatted Notes, Resources, checklists, Collections and local backup/import.
- Optional encrypted sync to your own Nextcloud/WebDAV server.
- Optional Drag Group integration and an independent automatic pinned manager; both share one manager lifecycle without duplicate controllers.
- Snapshot-consistent tear-out cleanup, preserving unrelated tabs and user-opened managers.

## Windows helper

Pause Drag Group or close Chrome, run Setup and follow its runtime/registration checks. Requires Windows x64 and .NET 10 Desktop Runtime x64. Setup is per-user, supports repair/update and Windows Apps uninstall, and is currently unsigned. Use one active Drag Group edition. Installer version 1.0.0 contains native helper build 0.1.21.

## Validation and limits

See [automated evidence](../validation/README.md) and [exact artifact inventory](../validation/artifacts.json). The full Windows gate and isolated installer/native checks passed for the public snapshot. Real-account/two-PC use is reported separately from synthetic fixtures.

Unpacked downloads are updated manually; no Chrome Web Store listing is implied. Restore preserves URLs/order and supported metadata, not arbitrary page/form runtime. Sync is not an independent backup. Google Drive is not implemented. Broader clean-machine, physical DPI/multi-monitor, accessibility and failure acceptance remain visible in [known limitations](../KNOWN_LIMITATIONS.md).

This is the first public GPL-3.0-only snapshot. The matching source and downloads are published on GitHub and Gitea with fresh public history.
