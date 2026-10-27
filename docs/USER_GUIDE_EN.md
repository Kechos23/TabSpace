# TabSpace — install, update and helper setup

## Downloads

- **TabSpace-0.18.4.zip** — the recommended extension. It keeps your existing Chrome new-tab page.
- **DragGroup-Helper-Setup-1.0.0.exe** — optional Windows helper installer for integrated or standalone Drag Group.
- **TabSpace-SHA256SUMS.txt** — checksums for these downloads.

Download from the [TabSpace release](https://github.com/Kechos23/TabSpace/releases/tag/tabspace-v0.18.4). Installation guides and validation are linked from its description. Licenses and third-party notices are included inside the extension and helper packages.

## Install TabSpace

1. Extract the extension ZIP into a permanent folder, e.g. `C:\Apps\TabSpace\extension`. Its `manifest.json` must be at that folder's root.
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked** and select that folder. This download is installed unpacked; it is not a Chrome Web Store installation.
3. Open the toolbar popup and choose **Open manager** or **Open side panel**. A helper or cloud account is not required for the organizer.
4. New ordinary windows own Unsaved Spaces. Save a Space to retain it. Resources are durable links/files independent of open browser tabs; Inbox holds links, notes and personal tasks.

**Settings → Manager → Keep a pinned manager in every window** maintains a manager automatically without enabling Drag Group. It defaults off. Drag Group also maintains its required pinned manager; both options share one manager per normal window. Your Chrome new-tab page remains unchanged.

## Enable Drag Group (optional)

1. Pause Drag Group or close Chrome completely. If using integrated Drag Group, disable the standalone extension first.
2. Run **DragGroup-Helper-Setup-1.0.0.exe**. The wizard installs for your Windows account under `%LocalAppData%\TabSpace\DragGroupHelper`; no PowerShell commands are needed.
3. Setup checks **.NET 10 Desktop Runtime x64**. If missing, use **Get .NET from Microsoft**, install the x64 Desktop Runtime and click **Check again**. The runtime installer may need administrator access; this helper installer does not.
4. Confirm replacement if an older portable helper is registered. Its files are preserved and its registration is saved for rollback. Setup is currently unsigned.
5. Enable Drag Group in TabSpace Settings or the standalone popup, approve Chrome's optional helper permission and check its live status. Use one active edition at a time.

The helper adds no Windows service or startup task. Drag an unpinned, ungrouped tab over another in the same window: the paired indicator appears after 16% overlap and 200 ms dwell; release to group or move back to cancel. PWA/incognito, overflow, hidden F11 strips, elevated Chrome, multi-selection and cross-window gestures are outside scope. See [maintenance](HELPER_INSTALLER.md) and [known limitations](KNOWN_LIMITATIONS.md).

## Standalone Drag Group

Download **DragGroup-0.1.21.zip** from the standalone release and Load unpacked the extracted folder containing `manifest.json`. Install the shared **Setup.exe** once; keep TabSpace's integrated Drag Group disabled. Standalone uses its own pinned controller.

## Update, repair and rollback

1. Export an independent JSON/ZIP backup from Settings → Backup & Recovery. Sync is not a backup.
2. Keep the existing extension installation/path, replace its files from the ZIP and use **Reload** in Chrome. Do not Remove it to update: removal clears its active local data.
3. For managed helper update/repair, pause Drag Group or close Chrome and rerun Setup. It refuses changes while the helper is running.
4. Remove the managed helper through **Windows Settings → Apps → Drag Group Helper → Uninstall**. It restores a previous portable registration only if its manifest still exists and this installation still owns the registration. Keep the old portable folder if rollback is desired. An unrelated newer registration is preserved.
5. Reload the extension and check status. Existing working helper 0.1.21 installations do not need an update just for the pinned manager. Future extension downgrades require schema/backup compatibility checks.

## Optional encrypted Nextcloud/WebDAV sync

Settings → Cloud sync separates server connection and sync encryption. Enter a Nextcloud base address (or full DAV address), username, App password and Sync folder. Use the same folder and a separate Sync password of at least 12 characters on every PC. Keep the Sync password safe: TabSpace cannot recover it. Unlock again after browser-session end/reload.

Saved Spaces/content, Inbox and Collections sync. Unsaved browsing, live windows and device UI settings remain local. Disconnect retains local work and cloud files. The popup status is read-only; Ready does not guarantee all local changes have uploaded. See [sync setup](CLOUD_SYNC.md).

## Uninstall

Export your data, pause Drag Group and remove the managed helper through **Windows Settings → Apps**. If still using an older portable installation, use that folder's `Uninstall.ps1 -Apply` before deleting it. Removing the Chrome extension clears its active local data. Disconnecting sync does not delete cloud data.
