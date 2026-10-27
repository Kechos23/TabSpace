# Architecture

TabSpace is a local-first Chrome Manifest V3 extension. The same application provides a full-page manager, compact side panel, toolbar popup and alternative new-tab entry point. Standalone Drag Group is a separate extension that shares the gesture controller and Windows helper, but has its own identity and settings.

## Application surfaces

React and TypeScript implement the manager and quick actions. Vite builds the local UI; esbuild bundles the service worker separately so event listeners are registered during worker startup. All executable code is bundled. Tiptap provides structured note editing, and MiniSearch maintains a rebuildable local search index.

The side panel defaults to navigation and tab trees with optional detail views. Opening a Space view and activating its browser session are distinct operations. The public download keeps Chrome's existing new-tab page. An experimental development variant is not part of the public downloads.

## Durable data

Dexie/IndexedDB stores entities, attachments, drafts, revisions, session checkpoints and command journals. Zod validates commands, stored records and imports. Transactional content updates use revisions and command identities to handle retries and concurrent editors. Acknowledgment follows durable commit; conflicts preserve drafts instead of replacing the editor's input.

Backups are user-triggered external JSON/ZIP files. Imports validate the graph before committing, support Merge/Replace and retain an internal before-import copy. Internal recovery is separate from an independent backup and does not protect against uninstall or disk loss.

## Browser coordination

The service worker serializes browser operations and reconciles Chrome events with durable Space ownership. Each managed normal window has one active Space. Existing native groups and unowned/pinned/internal tabs require explicit boundaries; arbitrary browsing is not silently grouped or discarded.

Session checkpoints retain website URLs, ordering, supported group metadata and lock state. Numeric Chrome tab/window IDs are scoped to the browser session, not portable durable identities. Switching behavior can preserve live pages in real minimized parking windows or checkpoint/close outgoing pages for later URL restoration. Restore does not recreate arbitrary page runtime, form or DOM state.

New normal windows receive Unsaved Spaces. Startup recovery considers normal Chrome windows independently of app-like windows. Ambiguous restoration preserves recoverable data instead of blindly duplicating tabs. Chrome API effects and IndexedDB commits are not one atomic transaction, so protected checkpoints, operation markers and interruption handling bridge that boundary.

## Optional encrypted sync

A provider-independent synchronization engine projects Saved Space/content data, Inbox and Collections into an encrypted remote manifest with separately encrypted file objects. The current transport is Nextcloud/WebDAV over HTTPS, using conditional version checks to prevent silent overwrites. Different records merge; same-record conflicts require a choice. Conflict copies have stable identities for safe retries.

Live browser windows, Unsaved Spaces, helper state and local UI settings are excluded. Incoming changes that conflict with open/parked sessions or active drafts wait until safe. Server credentials stay local; the separate Sync password is kept only for the browser session. The popup reads a restricted status projection and does not initiate a network sync when opened.

## Optional Windows helper

`apps/drag-group/core` holds gesture policy; `apps/drag-group/native` provides Windows UI Automation, native protocol handling and feedback rendering. Native Messaging exchanges bounded, validated messages with explicit extension-origin constraints. A random controller token and ordered tab identities bind a connection to a verified Chrome window; ambiguous geometry or state cancels.

The integrated edition hosts the controller in its pinned manager. Standalone uses a dedicated pinned controller. The shared helper can recognize both extension identities, but one edition should be active at a time. No browser patch, injected mouse input, administrator registration or Windows startup service is required. The older `apps/native-helper` diagnostic host is development-only and is excluded from user releases.

## Validation and distribution

The full Windows gate covers type checking, domain and JavaScript/native tests, builds, manifest/CSP audits and isolated Chromium regression fixtures. Release assembly verifies the exact archive inventories, freshly built native protocol behavior and checksums. Physical mouse/DPI and clean-machine acceptance are recorded separately; automated fixtures do not certify every desktop configuration.

See [capability map](REQUIREMENTS_MATRIX.md), [known limitations](KNOWN_LIMITATIONS.md), [test plan](TEST_PLAN.md) and [release layout](REPOSITORY_LAYOUT.md).
