# Release validation

The first public source snapshot is checked as a complete build, independently of earlier development reports. Generated test profiles/logs remain outside Git.

- [Windows gate](windows-gate.json): 30 automated checks, including 140 unit tests, JavaScript lifecycle/policy checks, native policy/protocol, manager/popup/panel, browsing/restore, sync and import regressions.
- [Installer](installer.json): real Setup/uninstaller executable tested with compile-time isolated registration, Unicode paths, repair, ownership preservation and injected failure rollback; includes six installed native-protocol checks.
- [Artifact inventory](artifacts.json): exact release filenames, byte sizes and SHA-256 hashes. Each public release contains only the extension ZIP, shared helper Setup and checksums.
- [Publication audit](publication-audit.json): clean-root history, source scan, links and curated screenshot review.

During preparation, the browser gate exposed a remaining tear-out race: a controller could appear between separate candidate and window-membership reads. The public snapshot filters controller identities on the exact membership snapshot, with a regression and isolated browser verification. No unrelated browser tabs or user-opened managers are retired by this change.

Automated browser/native fixtures are not physical Windows mouse/DPI acceptance. Reported daily use on two PCs and real Nextcloud sync is separate evidence. Clean-machine/VM, broader Windows/display combinations, forced interruption, accessibility and code-signing/SmartScreen acceptance remain documented in [known limitations](../KNOWN_LIMITATIONS.md).
