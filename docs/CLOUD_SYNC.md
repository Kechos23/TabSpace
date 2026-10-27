# Optional encrypted cloud sync

TabSpace works locally without an account. Optional synchronization uses the user's Nextcloud/WebDAV server and folder; it is disabled until configured.

In Settings → Cloud sync, choose Nextcloud or WebDAV, enter the server address, username, dedicated App password/access token and folder. Nextcloud setup derives the DAV address; WebDAV also accepts a complete DAV URL. Approve access to that server when Chrome requests it.

Choose a separate Sync password of at least 12 characters and keep it safe. Use the same server/folder and Sync password on every device. TabSpace cannot recover a lost Sync password. The browser session must be unlocked again after it ends; server credentials stay local to the profile.

Saved Spaces, Collections, Inbox, Notes, Resources, Tasks and their attached files synchronize. Unsaved browsing, live browser windows, native-helper state and device UI preferences remain local. The transport uses version checks to detect concurrent writes. Different records merge; changes to the same record require an explicit conflict choice. Incoming tab changes for open/parked Spaces and draft collisions wait until safe.

Automatic sync runs periodically while unlocked; Sync now requests a manual cycle. The popup shows a compact state and last-success information without starting a transfer just by opening it. Ready is not proof that every local change has already uploaded. Disconnect keeps both local work and cloud files.

Keep independent backups. Cloud history/tombstone/blob compaction, Google Drive and lost-key recovery are not implemented. See [privacy](PRIVACY.md), [backups](BACKUP_AND_RECOVERY.md) and [known limits](KNOWN_LIMITATIONS.md).
