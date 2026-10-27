# Privacy and data handling

TabSpace and standalone Drag Group have no analytics, advertising or developer-operated collection endpoint. Their ordinary operation is local to the Chrome profile and, for optional Drag Group, a local Windows process.

## Local organizer data

TabSpace stores Space names, website URLs/titles, saved tab blueprints, Notes, Resources, Tasks, user-selected attachment files, settings, drafts and recovery history in extension-local storage. Local profile data is not encrypted by the application. Anyone with access to the unlocked profile/device may be able to read it. The extension uses browser permissions for the visible tab-management features; it does not need to read website page contents to organize tabs.

Uninstalling the extension removes its active local data. Export JSON or ZIP backups before uninstalling or replacing an installation. Backups may contain sensitive browsing/project contents and are not password-encrypted. Deleting a visible item does not guarantee secure erasure from prior backups or recovery history.

## Optional cloud sync

Off by default. When configured, TabSpace sends encrypted Saved Spaces, Inbox, Collections, Notes, Resources, Tasks and attachment data to the selected Nextcloud/WebDAV server. Unsaved Spaces, open browser windows and device UI preferences remain local. It requests runtime access to the selected server. The server operator sees connection/account information, file sizes, timing and encrypted objects. Transport uses HTTPS; content encryption uses the separate user-chosen Sync password.

Server credentials are kept in the local Chrome profile, not exported as organizer content. The Sync password is held in browser-session storage and must be entered again after browser-session end/reload. Losing it can make encrypted cloud data unrecoverable. Disconnect removes this computer's configuration but does not delete local organizer content or cloud files. No developer can recover the user's Sync password. The popup indicator reads local status only and never starts transfer merely by opening the popup.

## Optional native Drag Group

Windows UI Automation and Native Messaging verify a particular Chrome window and its tab-strip geometry. The local pipe carries tab IDs/order, grouping/pin/selection state and random controller identity tokens; it does not send website URLs or page contents to a server. Mouse/Escape observations are local and are used only while the helper is connected. The helper does not inject input, install a Windows startup service, or require a developer account. Standalone and integrated editions use the same helper and must not be enabled together.

## External services and updates

Loading websites uses those websites normally and is subject to their policies. The optional Nextcloud/WebDAV provider is chosen and controlled by the user. The GitHub/Gitea downloads are installed unpacked and updated manually; they do not imply Chrome Web Store registration or automatic Store updates. Any future Google Drive or Store distribution will require corresponding disclosures and separate setup.

For issues, use the repository issue tracker and redact website titles/URLs, account details, credentials, backups and cloud data before attaching logs. This document describes the current release, not a claim that every listed acceptance test has passed.
