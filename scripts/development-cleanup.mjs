import {
  readdir,
  lstat,
  realpath,
  readFile,
  writeFile,
  mkdir,
  open,
  rm,
} from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const HOUR = 3600000;
const prefixes = [
  "browsing-profile-",
  "cloud-sync-",
  "collections-profile-",
  "copy-sidebar-profile-",
  "drag-group-auto-profile-",
  "drag-group-test-profile-",
  "drag-integration-",
  "dropdown-profile-",
  "fresh-profile-",
  "groups-profile-",
  "home-profile-",
  "import-coordination-",
  "load-profile-",
  "lock-space-",
  "manager-icons-",
  "manager-lifecycle-",
  "notes-profile-",
  "packaged-core-",
  "panel-tasks-",
  "performance-profile-",
  "popup-profile-",
  "pwa-lifecycle-",
  "readme-preview-",
  "recovery-profile-",
  "reload-extension-",
  "resources-profile-",
  "review-browser-",
  "review-fixes-",
  "review-title-profile-",
  "saved-view-profile-",
  "session-profile-",
  "settings-core-",
  "settings-newtab-",
  "sidebar-drop-",
  "sidebar-profile-",
  "sidepanel-profile-",
  "space-details-",
  "space-icons-profile-",
  "storage-maintenance-",
  "tab-actions-profile-",
  "tab-group-profile-",
  "tasks-profile-",
  "test-profile-",
  "theme-icons-profile-",
  "themes-profile-",
  "toggle-",
  "trash-profile-",
  "ui-audit-",
  "variant-debug-",
  "showcase-",
];
function family(name, area) {
  if (area === ".cache")
    return /^cloud-sync-extension-\d{13}$/.test(name)
      ? "cloud-sync-extension-"
      : null;
  const prefix = prefixes.find(
    (p) => name.startsWith(p) && /^\d{13}(?:$|-)/.test(name.slice(p.length)),
  );
  if (prefix) return prefix;
  return /^variant-comparison-\d+\.\d+\.\d+-\d{13}(?:$|-)/.test(name)
    ? "variant-comparison-"
    : null;
}
function inside(base, path) {
  const rel = relative(base, path);
  return (
    rel !== "" &&
    !isAbsolute(rel) &&
    rel !== ".." &&
    !rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/"))
  );
}
async function json(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}
function processCommands() {
  // Fail closed if process inspection is unavailable; never guess that a profile is idle.
  return process.platform === "win32"
    ? execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { $_.CommandLine }",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 20000,
          maxBuffer: 16 * 1024 * 1024,
        },
      ).toLowerCase()
    : execFileSync("ps", ["-eo", "args="], {
        encoding: "utf8",
        timeout: 10000,
      }).toLowerCase();
}
async function installedPaths() {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return [];
  const userData = join(process.env.LOCALAPPDATA, "Google/Chrome/User Data");
  const paths = [];
  let profiles;
  try {
    profiles = await readdir(userData);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  for (const profile of profiles.filter((n) =>
    /^(Default|Profile \d+)$/.test(n),
  )) {
    for (const file of ["Preferences", "Secure Preferences"]) {
      let prefs;
      try {
        prefs = JSON.parse(
          await readFile(join(userData, profile, file), "utf8"),
        );
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      for (const extension of Object.values(prefs.extensions?.settings ?? {}))
        if (extension.path && isAbsolute(extension.path))
          paths.push(resolve(extension.path));
    }
  }
  return paths;
}
async function disposableTree(path, cutoff) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || info.mtimeMs > cutoff) return false;
  if (!info.isDirectory()) return true;
  for (const child of await readdir(path)) {
    if (child === ".git" || child === ".hg" || child === ".svn") return false;
    if (!(await disposableTree(join(path, child), cutoff))) return false;
  }
  return true;
}

export async function cleanupDevelopment({
  root = resolve(import.meta.dirname, ".."),
  apply = false,
  force = false,
  now = Date.now(),
  commands,
  protectedPaths,
  retentionMs = 48 * HOUR,
  keep = 2,
} = {}) {
  root = await realpath(root);
  const artifacts = join(root, "artifacts");
  try {
    if (
      (await lstat(artifacts)).isSymbolicLink() ||
      (await realpath(artifacts)) !== artifacts
    )
      throw Error("Cleanup artifacts directory must not be a link");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stateDir = join(root, "artifacts/.development-cleanup");
  try {
    if ((await lstat(stateDir)).isSymbolicLink())
      throw Error("Cleanup metadata must not be a link");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(stateDir, { recursive: true });
  // Metadata must also stay within this checkout, even if someone replaces artifacts with a link.
  if (!inside(root, await realpath(stateDir)))
    throw Error("Cleanup metadata escaped repository");
  const stateFile = join(stateDir, "state.json");
  const previous = await json(stateFile, {});
  if (apply && !force && previous.lastRun && now - previous.lastRun < HOUR)
    return { throttled: true, removed: [] };
  const lockPath = join(stateDir, "lock.json");
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = await json(lockPath, {});
    try {
      process.kill(owner.pid, 0);
      return { busy: true, removed: [] };
    } catch (error) {
      if (error.code !== "ESRCH") return { busy: true, removed: [] };
    }
    // Only reclaim a dead owner's metadata lock. Every target is independently revalidated.
    await rm(lockPath, { force: true });
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if (error.code === "EEXIST") return { busy: true, removed: [] };
      throw error;
    }
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, started: now }));
  const report = {
    date: new Date(now).toISOString(),
    apply,
    retentionHours: retentionMs / HOUR,
    keepPerFamily: keep,
    candidates: [],
    removed: [],
    skipped: [],
    errors: [],
  };
  try {
    const injectedCommands = commands !== undefined;
    let inspectedAt = Date.now();
    commands ??= processCommands();
    protectedPaths ??= await installedPaths();
    for (const area of ["artifacts", ".cache"]) {
      const base = join(root, area);
      try {
        if (
          (await lstat(base)).isSymbolicLink() ||
          (await realpath(base)) !== base
        )
          continue;
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const groups = new Map();
      for (const entry of await readdir(base, { withFileTypes: true })) {
        const key = family(entry.name, area);
        if (!key || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        const path = resolve(base, entry.name);
        if (dirname(path) !== base || !inside(root, path))
          throw Error("Cleanup target escaped allowed base");
        const info = await lstat(path);
        const group = groups.get(key) ?? [];
        group.push({ path, modified: info.mtimeMs });
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        group.sort(
          (a, b) => b.modified - a.modified || a.path.localeCompare(b.path),
        );
        for (const item of group.slice(keep)) {
          const { path } = item;
          if (item.modified > now - retentionMs) continue;
          if (!injectedCommands && Date.now() - inspectedAt > 5000) {
            commands = processCommands();
            inspectedAt = Date.now();
          }
          const protectedPath = protectedPaths.some(
            (p) => p === path || inside(path, p) || inside(p, path),
          );
          if (
            protectedPath ||
            commands.includes(path.toLowerCase()) ||
            commands.includes(path.replaceAll("\\", "/").toLowerCase())
          ) {
            report.skipped.push({ path, reason: "Installed or in use" });
            continue;
          }
          try {
            if (!(await disposableTree(path, now - retentionMs))) {
              report.skipped.push({
                path,
                reason: "Recent contents, link or repository",
              });
              continue;
            }
            report.candidates.push(path);
            if (apply) {
              // Recheck the exact resolved target and current process ownership immediately before removal.
              if ((await realpath(path)) !== path || dirname(path) !== base)
                throw Error("Target changed during cleanup");
              await rm(path, { recursive: true, force: false, maxRetries: 0 });
              report.removed.push(path);
            }
          } catch (error) {
            report.errors.push({ path, code: error.code ?? error.message });
          }
        }
      }
    }
    await writeFile(
      join(stateDir, "last-report.json"),
      JSON.stringify(report, null, 2),
    );
    if (apply) await writeFile(stateFile, JSON.stringify({ lastRun: now }));
    return report;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const report = await cleanupDevelopment({
      apply: process.argv.includes("--apply"),
      force: true,
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.errors?.length || report.staleLock) process.exitCode = 1;
  } catch (error) {
    console.error("Development cleanup skipped:", error.message);
    process.exitCode = 1;
  }
}
