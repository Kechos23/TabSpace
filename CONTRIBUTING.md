# Contributing

Use GitHub issues and pull requests for bugs and changes; Gitea hosts the matching source and downloads. Include product/version, Chrome and OS versions, reproduction steps and whether sync or the Windows helper is involved. Redact credentials and browsing data.

Before changing behavior, discuss large UX, storage, browser-session or sync changes. Keep the local-first behavior and explicit permission boundaries. Preserve third-party notices and license contributions under GPL-3.0-only, consistent with this repository.

See [development](docs/DEVELOPMENT.md) for setup and [test plan](docs/TEST_PLAN.md) for focused checks. Use isolated test profiles rather than a personal Chrome profile. Never commit builds, caches, registrations, credentials or real browsing exports. Include a focused regression for meaningful behavior changes and state which browser/native/manual scenarios were actually exercised.
