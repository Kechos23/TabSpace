# Backups and recovery

Export an independent JSON or ZIP backup from Settings → Backup & Recovery before replacing data, downgrading or uninstalling. ZIP includes attachments; portable exports omit device-specific window bindings and sync credentials/cursors. Local exports are not password-encrypted.

Import validates structured content, references, archive bounds and attachment hashes before mutation. Merge preserves existing browsing bindings; Replace coordinates with browser operations, retains a before-import copy and rebuilds live projections. Chrome website tabs are preserved rather than silently discarded.

Startup browsing recovery is a separate, configurable feature for Saved and Unsaved working sessions. It restores URLs and supported metadata or reconnects matching Chrome-restored tabs. Ambiguous recovery remains explicit. Page forms, arbitrary runtime state and authentication are not reconstructed.

Closed disposable Unsaved history defaults to ten sessions / seven days. Open/pending sessions and protected personal content are retained. Completed journals are retained for at least seven days; note history keeps at most 100 prior revisions while retaining the newest ten; three before-import copies are kept. Drafts, unfinished/uncertain commands and protected checkpoints are preserved.

Settings also provides manual unused-file cleanup with reference rechecks and confirmation. It does not automatically delete attachment files or enforce a total storage quota. Before-import and sync recovery copies have no dedicated restore UI.

Attachment ingestion is bounded to 64 MiB per file; in-memory import/export is bounded to 256 MiB. Power loss, forced termination, disk-full/quota faults and large-data streaming require additional acceptance.

Optional encrypted cloud sync is not a backup: propagated edits/deletions can reach all devices. See [sync setup](CLOUD_SYNC.md), [known limitations](KNOWN_LIMITATIONS.md) and [validation](validation/README.md).
