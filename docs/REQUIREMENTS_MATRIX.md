# Capabilities and validation map

This document maps the current products to implementation and regression evidence. It describes TabSpace's own capabilities; it is not a competitive feature-parity checklist. Tests listed for an area do not certify all hardware or failure scenarios.

| Capability | Implementation | Evidence / boundary |
| --- | --- | --- |
| Spaces, Collections and navigation | `apps/extension/src/ui`, `packages/domain`, `packages/persistence` | Home, sidebar, space-details, drag/drop and session browser fixtures |
| Saved/Unsaved lifecycle and restore | `apps/extension/src/background`, `packages/domain/browsing.ts` | Normal-window lifecycle, app-like-window isolation, restart and session fixtures; ambiguous restoration remains explicit |
| Tabs, groups, move/copy and locking | Browser coordinator, `packages/domain/space-tabs.ts` and lock policy | Grouped-tab UI, lock, transfer and session tests; internal/pinned tabs have documented exclusions |
| Resources, Notes and Tasks | UI panes, domain records and persistence | Resource/note/task browser tests; durable revisions and draft/conflict tests |
| Search and performance | `packages/search`, virtualized UI lists | Search tests and synthetic-dataset benchmarks; not a universal latency guarantee |
| Popup and Chrome side panel | `popup.tsx`, panel navigation and UI | Popup, panel and quick-action browser fixtures; installed Chrome owns surface placement |
| Local backup and recovery | Persistence/import coordination and recovery UI | JSON/ZIP roundtrips, attachment validation, interrupted operation and retention tests |
| Optional encrypted sync | `packages/sync`, background sync controller and Settings | Two-profile synthetic DAV fixtures, conflict/interruption/control tests; owner reports successful use across two PCs |
| Theme and Space indicators | UI tokens, icon policy and generator | Theme/icon browser tests and light/dark inspection |
| Integrated Drag Group | Shared controller plus TabSpace bridge | Isolated integration fixture and freshly built helper protocol tests |
| Standalone Drag Group | `apps/drag-group/extension` | JavaScript lifecycle/protocol fixtures; independent extension identity |
| Shared Windows helper | `apps/drag-group/core`, `apps/drag-group/native` | Native policy/protocol tests; real mouse/DPI/monitor combinations remain a separate acceptance matrix |
| Release packaging | `scripts/prepare-release.mjs` and archive audits | Explicit inventories, fresh-host checks and SHA-256 verification; user installation is explicit |

The 30-check Windows gate and focused helper-installer evidence are recorded in [validation](validation/README.md). Reported two-PC use is separate from automated fixture coverage.

Google Drive, hosted collaboration and Chrome Web Store distribution are separate future decisions. They are not prerequisites for the implemented local organizer or self-hosted synchronization.
