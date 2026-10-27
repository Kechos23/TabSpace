# Data model and invariants

Entity kinds: space, sidebar, section, resource, note, task, property, savedTab, group. One task record is used in its Space and My Tasks. Attachments are IndexedDB blobs with UUID, size, SHA-256, safe filename, media type and UTC date. Cloned entities can share immutable blobs. Garbage collection is conservative and accounts for trash, history and backups.

Schema 1. Stable entity UUIDs, UTC created/updated timestamps, optimistic revision, numeric fractional ordering, and recoverable deletion timestamps. `packages/domain/model.ts` is the executable schema. Space owns content; content section belongs to the same parent and has matching kind. Sidebar sections and content sections are distinct. Reusable property options have UUID identities; removing an option with existing values is rejected by graph validation. Task due dates remain ISO **calendar dates**, not UTC midnight timestamps.


Notes store schema-validated Tiptap JSON plus searchable text, revisions, and per-editor-session drafts. Draft records are distinct from acknowledged commits. A conflict never silently overwrites the other editor. Recovered drafts can become separate notes. Saved tabs preserve URLs/order/pin/mute/logical group references; they do not preserve DOM or form state. Browser mappings are tagged by Chrome storage.session generation and rebuilt from real browser state. HWND/UIA identities are never durable entity identities.

Commands have schemaVersion, commandId and expectedRevision. Entity mutation and journal acknowledgment commit in one IndexedDB transaction. Browser effects use planned/executing/applied/failed/uncertain journals; uncertain tab opens are not replayed blindly. Completed command IDs deduplicate retries. There is no schema migration from previous TabSpace releases yet. Future schema changes require before-migration backup and read-only recovery on failure.

Malformed entities are copied to local quarantine while the original record is retained. Editing pauses until a verified replacement backup resolves corruption. Quarantine exports are explicitly labeled sensitive. Internal before-import copies retain raw records/settings/blobs, including quarantine, independently of imported replacements.
