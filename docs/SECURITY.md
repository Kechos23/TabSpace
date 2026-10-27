# Security model

TabSpace treats imports, remote sync data, extension messages and native frames as untrusted inputs.

- Commands and data use strict schema validation, revision checks and transactional reference updates.
- Imported notes accept known structured nodes and safe links; arbitrary HTML is not evaluated.
- JSON/ZIP backups validate entries, bounds, file sizes and attachment hashes before commit. Duplicate, traversal, encrypted and unsupported archive entries are rejected.
- The organizer loads bundled scripts under its extension CSP. It exposes no external message listener or content scripts.
- Optional HTTPS host access is requested for a user-selected sync server. Sync encrypts its content and uses conditional writes; live browser sessions and device settings are excluded.
- The Windows host accepts only the two packaged extension origins. Strict UTF-8 and bounded native frames carry verified tab identities and grouping state. Unknown/ambiguous gesture state cancels rather than guessing.
- The installer writes per-user files and an owned Chrome registration. It refuses active-helper changes, retains rollback state and preserves another installation's registration. It does not install a service, inject browser code or patch Chrome.

Local profile data and exported backups are not application-encrypted. Recovery is not an independent backup or secure erasure. In-memory processing bounds, crash/quota drills, malicious-input fuzzing and wider OS/device acceptance have documented limits.

For confidential reports, see the repository's [security policy](../SECURITY.md). Do not include live credentials, real browsing exports or private account data in a public issue.
