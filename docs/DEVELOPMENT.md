# Development

Requirements: Node.js 24+, npm, PowerShell 7+, Windows x64 for the helper, .NET 10 SDK for native builds and Playwright Chromium for browser fixtures.

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run audit:manifest
```

Load `dist/core` into an isolated Chrome profile. The release uses this build. A separate new-tab development build remains available for regression coverage but is not offered as a public download.

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH=(Join-Path $PWD '.cache/browsers')
node node_modules/playwright/cli.js install chromium
.\scripts\get-dotnet-sdk.ps1 -Download
.\scripts\build-drag-group.ps1
node scripts/package-drag-group.mjs
node scripts/validate.mjs
```

The full gate stops on the first failure and records logs under `artifacts/validation-*`. The native test host is under `artifacts/drag-group/native`. Native builds must never overwrite a running installed helper. `apps/native-helper` and its old diagnostic package are development fixtures, not the supported Drag Group installation.

For the graphical installer, follow [HELPER_INSTALLER.md](HELPER_INSTALLER.md). Its package version is independent of native protocol version. The compiler bootstrap is pinned and verified and extracts in portable mode under `.cache`.

After successful validation, `node scripts/prepare-public-release.mjs --stable` builds the public release inventories. It includes one TabSpace ZIP, standalone Drag Group ZIP, the shared Setup EXE and per-product checksums. It audits exact bytes and runs the installer fixtures. It does not register a production helper, create repositories or publish assets.

`node scripts/capture-showcase.mjs` captures current product images with synthetic data and a disposable profile. See [test plan](TEST_PLAN.md), [architecture](ARCHITECTURE.md) and [release layout](REPOSITORY_LAYOUT.md).

No build/test step should modify a personal Chrome profile. Never commit generated builds, caches, credentials, registrations or real browsing exports.

## Automatic development cleanup

Development/build/test entry points and direct browser-test scripts run best-effort local maintenance, at most once per hour. It removes only allowlisted timestamped test profiles, extracted package fixtures and cloud-sync test build copies older than 48 hours, preserving the two newest folders per test family. Recently modified contents, running-process references, installed Chrome extension paths, links and nested repositories are protected. Unknown directories are never selected.

This is a development operation, not an extension feature or scheduled Windows task. It runs again when development resumes. The extension's Chrome-profile data, `dist`, dependencies, SDK/browser/compiler caches, release packages, validation logs and both source repositories are not cleanup targets. Public and private checkouts maintain their own state; linked caches are not traversed.

- `npm run cleanup:dev` previews eligible folders without deleting them.
- `npm run cleanup:dev:apply` runs cleanup immediately, keeping the same age and retention safeguards.
- `npm run test:cleanup` checks deletion and preservation behavior using disposable fixtures.

The latest local report is `artifacts/.development-cleanup/last-report.json`. Failed deletions are reported and retried on a later run; maintenance failures do not prevent development commands from running. No reports or generated profiles belong in Git.
