# Graphical Windows helper installer

`DragGroup-Helper-Setup-1.0.0.exe` installs one shared **Drag Group native helper 0.1.21** for TabSpace and standalone Drag Group. The installer version is independent of the extension and native-protocol versions. Download it from the [TabSpace 0.18.4 release](https://github.com/Kechos23/TabSpace/releases/tag/tabspace-v0.18.4). The same installer supports both products; download it only once.

## Install

1. Pause Drag Group in every relevant extension, or close Chrome completely.
2. Run Setup, read the license and continue through the checks.
3. If .NET is missing, use **Get .NET from Microsoft**, install **.NET 10 Desktop Runtime x64**, then click **Check again**. The helper installer does not download or install a runtime automatically. Microsoft's runtime installer may request administrator access; this helper's installer does not.
4. If an older portable helper is registered, explicitly confirm its replacement. Its files remain untouched and the old registration is saved for uninstall.
5. Finish, then enable Drag Group in TabSpace Settings or the standalone popup. Use one active edition at a time and check its live status in Chrome.

Default location: `%LocalAppData%\TabSpace\DragGroupHelper`. Setup changes only this user's helper installation and Chrome native-host registration. It adds no Windows service, startup task or Chrome extension, and never changes browser data or Spaces. Setup checks installed file hashes, the runtime and registration. Chrome remains responsible for confirming the actual extension connection.

## Update, repair and uninstall

Run Setup again to update or repair the same managed installation. It replaces the exact known payload and retains the original registration backup. It refuses to alter files while the installed helper is running; it never kills Chrome or helper processes.

Use **Windows Settings → Apps → Drag Group Helper → Uninstall** to remove it. Uninstall restores the saved prior registration only while this installation still owns the current registration and the prior manifest exists. If the prior file disappeared, it removes its own registration rather than restoring a dangling path. If another installation took ownership, it leaves that registration alone. Unknown files in the installation folder are retained.

An installation error returns a nonzero exit code. Registration and known payload files are restored from snapshots; a failed first install can leave an incomplete Windows Apps entry, which can be removed or repaired by rerunning Setup. Failure messages do not report a successful connection. Rollback errors are reported rather than hidden. Abrupt process termination, OS/power loss and broader filesystem/registry failure drills are not certified by the normal rollback tests.

The executable is currently unsigned. Public distribution, code signing/SmartScreen acceptance and a clean second-machine/VM test remain separate steps. Store extension identities must be checked before future Web Store distribution; the installer currently permits exactly the two versioned public identities.

## Build

Requires Windows x64, Node 24+, the .NET 10 SDK, existing generated product icons in `dist/core` and dependency notices in `artifacts`. The compiler is Inno Setup 7.1.0, downloaded from the official immutable release and checked against its pinned SHA-256 and Authenticode publisher. Portable compiler files remain under `.cache`.

```powershell
.\scripts\get-inno-setup.ps1 -Download
$env:DOTNET_CLI_HOME=(Join-Path $PWD '.cache/dotnet-home')
$env:NUGET_PACKAGES=(Join-Path $PWD '.cache/nuget')
.\.cache\dotnet\dotnet.exe publish apps/drag-group/native/DragGroup.Native.csproj -c Release -r win-x64 --self-contained false -o artifacts/release-native/native
node scripts/build.mjs
node scripts/package.mjs
node scripts/build-helper-installer.mjs
```

Output: `artifacts/helper-installer/release/`, including the Setup EXE, SHA-256 and exact payload manifest. Never publish native binaries over an active installation. `DRAG_GROUP_INSTALLER_NATIVE_DIR` and `INNO_SETUP_COMPILER` may select existing local build inputs. No installer build command registers or starts the helper.

## Focused acceptance

```powershell
.\scripts\helper-installer-test.ps1 -NodeExecutable node
```

The test builds a separate executable with a compile-time test AppId and a private test registry namespace. It installs only under workspace artifacts and verifies the actual Chrome registration remains unchanged. Test-only missing-runtime and failure-injection parameters are absent from production builds. No production extension permission or registry redirect is exposed at runtime.

Coverage includes simulated missing-runtime blocking, real per-user install, Unicode paths, corrupted-file repair, six installed-native protocol checks, active-helper refusal, missing ownership refusal, portable migration/rollback, foreign ownership preservation, injected failure recovery, byte-for-byte failed-repair recovery and owned-only uninstall. Evidence is in `VALIDATION_HELPER_INSTALLER.json`. The generated fixture directories retain logs; compiler caches, executables and private registry state stay outside Git.

Official references: [Inno Setup](https://jrsoftware.org/isinfo.php), [portable compiler extraction](https://jrsoftware.org/ishelp/topic_technotes.htm), [per-user privileges](https://jrsoftware.org/ishelp/topic_setup_privilegesrequired.htm), [Microsoft runtime installation](https://learn.microsoft.com/en-us/dotnet/core/install/windows).
