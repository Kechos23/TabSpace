import "./development-maintenance.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { APP_VERSION } from "../packages/domain/version.ts";

const root = resolve(import.meta.dirname, "..");
const temp = resolve(root, ".cache/test-temp");
await mkdir(temp, { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "-");
const directory = resolve(root, "artifacts", `validation-${stamp}`);
await mkdir(directory, { recursive: true });
const env = {
  ...process.env,
  TEMP: temp,
  TMP: temp,
  PLAYWRIGHT_BROWSERS_PATH: resolve(root, ".cache/browsers"),
  DOTNET_CLI_HOME: resolve(root, ".cache/dotnet-home"),
  NUGET_PACKAGES: resolve(root, ".cache/nuget"),
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
};
const checks = [
  [
    "typecheck",
    process.execPath,
    ["node_modules/typescript/bin/tsc", "--noEmit"],
  ],
  [
    "domain tests",
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "vitest.config.ts",
      "--no-cache",
      "--maxWorkers=1",
    ],
  ],
  [
    "Drag Group JavaScript",
    process.execPath,
    [
      "--test",
      "tests/drag-group.test.mjs",
      "tests/drag-group-startup.test.mjs",
    ],
  ],
  ["build", process.execPath, ["scripts/build.mjs"]],
  ["manifest/CSP", process.execPath, ["scripts/audit.mjs"]],
];
if (!process.argv.includes("--quick")) {
  const sdk = resolve(root, ".cache/dotnet/dotnet.exe");
  if (process.platform !== "win32" || !existsSync(sdk))
    throw Error(
      "Full Windows gate requires the local .NET SDK and built Drag Group host. See docs/DEVELOPMENT.md; --quick runs the JS/type/build checks only.",
    );
  checks.push([
    "Drag Group native core",
    sdk,
    [
      "run",
      "--project",
      "apps/drag-group/tests/DragGroup.Tests.csproj",
      "-c",
      "Release",
      "--no-restore",
    ],
  ]);
  checks.push([
    "Drag Group native protocol",
    process.execPath,
    ["--test", "tests/drag-group-native.test.mjs"],
  ]);
  for (const name of [
    "import-coordination-test",
    "storage-maintenance-browser-test",
    "cloud-sync-browser-test",
    "review-fixes-browser-test",
    "browsing-lifecycle-test",
    "browsing-pwa-test",
    "session-browser-test",
    "notes-workspace-test",
    "resources-browser-test",
    "tasks-workspace-test",
    "performance-browser-test",
    "recovery-browser-test",
    "lock-space-test",
    "popup-browser-test",
    "space-details-browser-test",
    "sidebar-ui-test",
    "sidebar-space-drop-test",
    "copy-sidebar-test",
    "sidepanel-ui-test",
    "grouped-tabs-ui-test",
    "manager-icons-browser-test",
    "manager-lifecycle-browser-test",
    "drag-group-integration-browser-test",
  ])
    checks.push([name, process.execPath, [`scripts/${name}.mjs`]]);
}
const results = [];
for (const [name, command, args] of checks) {
  const started = Date.now();
  console.log(`Checking ${name}…`);
  let output = "";
  const code = await new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.on("error", (error) => {
      output += error.stack;
    });
    const deadline = setTimeout(() => {
      output += "\nValidation exceeded ten minutes.\n";
      child.kill();
    }, 600000);
    child.on("close", (value) => {
      clearTimeout(deadline);
      resolveResult(value ?? 1);
    });
  });
  const log = resolve(
    directory,
    `${results.length + 1}-${name.replaceAll(/[^a-z0-9]+/gi, "-")}.log`,
  );
  await writeFile(log, output);
  results.push({
    name,
    passed: code === 0,
    exitCode: code,
    milliseconds: Date.now() - started,
    log,
  });
  await writeFile(
    resolve(directory, "summary.json"),
    JSON.stringify(
      {
        version: APP_VERSION,
        quick: process.argv.includes("--quick"),
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    `${code === 0 ? "PASS" : "FAIL"} ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
  if (code !== 0) {
    console.log(output.slice(-7000));
    process.exitCode = 1;
    break;
  }
}
console.log(`Validation report: ${directory}`);
