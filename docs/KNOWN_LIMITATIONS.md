# Known limitations

## Installation and platform

Public downloads are installed unpacked using Chrome Developer mode. They are not Chrome Web Store packages and do not update automatically. Chrome 116 or newer is required. TabSpace's organizer does not require the optional native helper.

Drag Group requires Windows x64, .NET 10 Desktop Runtime x64 and its local helper. The Setup EXE is currently unsigned. Clean-machine/VM, signing/SmartScreen, managed-device and wider Windows version acceptance remain separate from automated tests.

## Browsing and restore

Each ordinary window owns a Saved or Unsaved Space. Viewing a Space and activating its browser tabs are different actions. Restore preserves URLs, ordering, groups and supported metadata, not arbitrary page runtime, form contents or authentication state.

Exact Chrome-restored matches reconnect; uncertain partial matches remain available for explicit recovery. Internal pages, pinned tabs and mixed groups have transfer/recovery exclusions. The preserve-live-tabs setting uses real minimized windows, which remain visible to Windows window management. App-like/PWA windows are excluded by Chrome window type; every installed PWA and startup preference has not been individually certified.

Other extensions that move/group the same tabs may interfere. One active Drag Group edition should be used at a time. There is no continuing focus loop fighting other extensions after startup.

## Drag Group

Supported gestures involve one selected, unpinned, ungrouped source and an ungrouped target in the same verified visible horizontal strip. Incognito, overflow, hidden F11 strips, elevated Chrome, multi-selection and cross-window dragging are outside scope. A mouse hold is bounded to 30 seconds.

Automated policy, native protocol and Chromium fixtures do not simulate every physical mouse/DPI/multi-monitor interaction. A rare initial-position outline flash remains an investigation item. No universal CPU/memory or hardware latency guarantee is claimed.

## Storage, backups and sync

Local profile data and exported backups are not encrypted by the application. Uninstalling the extension clears active local data. Sync is optional and complements an independent JSON/ZIP backup.

Attachment ingestion is bounded to 64 MiB per file and in-memory backup/import processing to 256 MiB. Remote sync uses a complete encrypted metadata manifest with separately encrypted files and provider version checks. Different records merge; simultaneous changes to the same record require a decision. Incoming changes wait when a Space is open or a draft conflicts.

Cloud tombstones/blob history and local sync recovery copies are not automatically compacted. Before-import copies and sync recovery records have no dedicated restore UI. Quota/disk corruption, forced OS/process termination and very large/partial-transfer scenarios need broader acceptance. Google Drive and hosted collaboration are not implemented.

## Validation

The automated Windows gate and focused installer acceptance are recorded in [validation](validation/README.md). Reported use across two PCs and a real Nextcloud account is separate evidence from synthetic server/browser fixtures. Keyboard/screen-reader/contrast and wider physical desktop scenarios remain a manual acceptance matrix.
