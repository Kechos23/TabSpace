# TabSpace 0.18.5

Save the current window as a Space and continue browsing immediately.

## Fixed

- **Save window as Space** now promotes the current Unsaved Space in place, instead of creating a separate closed copy. The existing window immediately belongs to the Saved Space.
- Loaded tabs keep their documents, native groups, order, mute state and physical tab identities. Saving does not reload, recreate or move them.
- The pinned manager favicon immediately reflects the selected Space color after the save commits.
- Existing Notes, Resources and Tasks remain attached to the same Space. The chosen Collection and Lock current tabs options are preserved, with separate identities for duplicate URLs.
- An unbound ordinary window is saved and attached in place. A stale save on an already Saved window is rejected.

Development commands also clean up old allowlisted test fixtures with age, ownership and retention safeguards. This maintenance runs only during development, not inside the installed extension.

## Downloads and update

- **TabSpace-0.18.5.zip** — one extension package, keeping the normal Chrome new-tab page.
- **DragGroup-Helper-Setup-1.0.0.exe** — the unchanged optional Windows helper installer.
- **TabSpace-SHA256SUMS.txt** — SHA-256 checksums for both files.

Export a backup, keep the existing unpacked-extension folder, replace its files and choose **Reload** at `chrome://extensions`. Do not remove the extension to update it. The helper and standalone Drag Group remain unchanged at Setup 1.0.0 / native 0.1.21; an existing working helper does not need reinstalling.

Fresh installation: extract the extension to a permanent folder, enable Developer mode at `chrome://extensions` and choose **Load unpacked** for the folder containing `manifest.json`.

## Validation

See the [0.18.5 validation and artifact inventory](../validation/tabspace-0.18.5.json). The popup browser regression verifies live session adoption, document markers surviving the save, the selected manager favicon, duplicates, groups, locks, collection selection and later reopening. Automated isolated-browser checks complement user acceptance on installed Chrome.

Guides: [English](../USER_GUIDE_EN.md), [Ελληνικά](../USER_GUIDE_EL.md), [helper setup](../HELPER_INSTALLER.md), [known limitations](../KNOWN_LIMITATIONS.md).

GPL-3.0-only. The installer remains unsigned; downloads are installed unpacked and updated manually. Chrome Web Store distribution and Google Drive sync remain outside this release.
