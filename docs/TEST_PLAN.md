# Validation and acceptance

Run `node scripts/validate.mjs` on Windows after building the local native fixtures. It performs 30 checks across TypeScript, unit tests, Drag Group JavaScript/native checks, both development builds, manifest/CSP audit and isolated Chromium regressions. `--quick` omits native/browser checks and is not a release gate.

Run `scripts/helper-installer-test.ps1` for isolated real installer/uninstaller acceptance. Its compile-time test identity and registry namespace are separate from Chrome's actual helper registration.

Public evidence in [validation](validation/README.md) distinguishes these automated fixtures from reported real-account/two-PC use. Screenshots use synthetic project data. No personal browser profile is needed for automated checks.

Manual acceptance should record OS/Chrome/runtime versions, physical monitor/DPI setup and exact outcomes for:

- Fresh install, update, repair, uninstall and rollback on a second machine/VM.
- Physical drag, skipped neighboring tabs, cancellation, maximized top edge, long holds and multiple monitors.
- Startup/restore with ordinary Chrome windows, app-like windows and other pinned extensions.
- Keyboard, screen-reader, contrast and narrow side-panel flows.
- Offline/conflicting sync, server permissions, partial transfer and large files.
- Abrupt interruption, storage corruption, quotas/full disk and backup recovery.

A passing automated suite does not certify every item above. Current supported limits remain visible in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
