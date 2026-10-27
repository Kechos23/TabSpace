# Repository and releases

The same reviewed source is published at [GitHub](https://github.com/Kechos23/TabSpace) and [Gitea](https://gitea.kechos.com/Kechos23/TabSpace). Both public repositories start with a fresh initial commit and normal public history from that point onward.

| Path | Purpose |
| --- | --- |
| apps/extension | TabSpace manager, popup, side panel and integrated Drag Group |
| apps/drag-group/extension | Standalone Drag Group |
| apps/drag-group/core and native | Shared native gesture policy and Windows helper |
| apps/drag-group/installer | Shared graphical installer |
| packages | Domain, persistence, search and encrypted sync |
| scripts and tests | Builds, packaging, audits and regression fixtures |
| docs | User/developer documentation and curated release evidence |
| apps/native-helper | Development-only protocol fixture; excluded from user downloads |

Public identity keys are deliberately versioned and are not private signing keys. Builds, tool caches, profiles, credentials and registration backups are excluded from Git.

The two initial product tags are `tabspace-v0.18.4` and `drag-group-v0.1.21`. The shared installer has its own version, 1.0.0, while the native helper protocol build remains 0.1.21.

Each product release contains only its extension ZIP, the shared Setup EXE and product checksums. Guides, notices and validation are linked from the release notes or bundled where required; diagnostic hosts and development profiles are not release assets. There is one public TabSpace download that leaves Chrome's new-tab page unchanged.

See [development](DEVELOPMENT.md), [license](../LICENSE) and [validation](validation/README.md).
