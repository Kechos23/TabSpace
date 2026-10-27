import { readFile, writeFile, mkdir, cp, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { zipSync, unzipSync } from "fflate";
import { APP_VERSION } from "../packages/domain/version.ts";
const root = resolve(import.meta.dirname, ".."),
  artifacts = join(root, "artifacts");
const drag = JSON.parse(
  await readFile(join(root, "apps/drag-group/extension/manifest.json"), "utf8"),
);
const installer = JSON.parse(
  await readFile(join(root, "apps/drag-group/installer/version.json"), "utf8"),
);
assert.equal(installer.helperVersion, drag.version);
const directories = (await readdir(artifacts))
  .filter((n) => n.startsWith("validation-"))
  .sort();
const gate = JSON.parse(
  await readFile(join(artifacts, directories.at(-1), "summary.json"), "utf8"),
);
assert.equal(gate.version, APP_VERSION);
assert.equal(gate.quick, false);
assert.equal(gate.results.length, 30);
assert(gate.results.every((c) => c.passed));
function run(script) {
  const p = spawnSync(
    process.execPath,
    [join(root, "scripts", script + ".mjs")],
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
  assert.equal(p.status, 0, script + " failed");
}
for (const script of [
  "audit-source",
  "package",
  "audit-package",
  "package-drag-group",
  "audit-drag-group",
])
  run(script);
const nativeFiles = [
  "DragGroup.Native.exe",
  "DragGroup.Native.dll",
  "DragGroup.Native.deps.json",
  "DragGroup.Native.runtimeconfig.json",
  "DragGroup.Core.dll",
];
const nativeDirectory = join(artifacts, "release-native/native");
await mkdir(nativeDirectory, { recursive: true });
for (const name of nativeFiles)
  await cp(
    join(artifacts, "drag-group/native", name),
    join(nativeDirectory, name),
  );
run("build-helper-installer");
const test = spawnSync(
  "pwsh",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(root, "scripts/helper-installer-test.ps1"),
    "-NodeExecutable",
    process.execPath,
  ],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
assert.equal(test.status, 0, "Isolated installer acceptance failed");
const installerTests = JSON.parse(
  (
    await readFile(join(root, "docs/VALIDATION_HELPER_INSTALLER.json"), "utf8")
  ).replace(/^\uFEFF/, ""),
);
assert.equal(installerTests.passed, true);
const out = join(artifacts, "public-release");
await mkdir(out, { recursive: true });
const tabName = "TabSpace-" + APP_VERSION + ".zip",
  dragName = "DragGroup-" + drag.version + ".zip",
  setupName = "DragGroup-Helper-Setup-" + installer.version + ".exe";
await cp(
  join(artifacts, "TabSpace-" + APP_VERSION + "-core.zip"),
  join(out, tabName),
);
await cp(
  join(artifacts, "helper-installer/release", setupName),
  join(out, setupName),
);
const extensionFiles = [
  "manifest.json",
  "worker.js",
  "lifecycle.js",
  "config.js",
  "popup.html",
  "popup.js",
  "popup.css",
  "controller.html",
  "controller.js",
  "runtime.js",
  "policy.js",
  "grouping.js",
  "style.css",
  "fixture.html",
  "fixture.js",
];
const contents = {};
for (const name of extensionFiles)
  contents[name] = new Uint8Array(
    await readFile(join(artifacts, "drag-group/extension", name)),
  );
contents["LICENSE.txt"] = new Uint8Array(await readFile(join(root, "LICENSE")));
contents["README.md"] = new Uint8Array(
  await readFile(join(root, "apps/drag-group/README.md")),
);
contents["THIRD_PARTY_NOTICES.txt"] = new Uint8Array(
  await readFile(join(artifacts, "THIRD_PARTY_NOTICES.txt")),
);
await writeFile(join(out, dragName), zipSync(contents, { level: 9 }));
const unpacked = unzipSync(new Uint8Array(await readFile(join(out, dragName))));
assert.deepEqual(Object.keys(unpacked).sort(), Object.keys(contents).sort());
for (const [name, bytes] of Object.entries(contents))
  assert.deepEqual(unpacked[name], bytes);
const manifest = JSON.parse(
  new TextDecoder().decode(unpacked["manifest.json"]),
);
assert.equal(manifest.version, drag.version);
assert.equal(manifest.name, "Drag Group");
assert(!manifest.host_permissions);
const tab = unzipSync(new Uint8Array(await readFile(join(out, tabName))));
assert(tab["LICENSE.txt"] && tab["THIRD_PARTY_NOTICES.txt"]);
assert.equal(
  JSON.parse(new TextDecoder().decode(tab["manifest.json"]))
    .chrome_url_overrides,
  undefined,
);
const files = [];
for (const name of [tabName, dragName, setupName]) {
  const b = await readFile(join(out, name));
  files.push({
    name,
    bytes: b.length,
    sha256: createHash("sha256").update(b).digest("hex"),
  });
}
const setup = JSON.parse(
  await readFile(
    join(artifacts, "helper-installer/release", setupName + ".json"),
    "utf8",
  ),
);
assert.equal(files.find((f) => f.name === setupName).sha256, setup.sha256);
for (const f of setup.payload.filter((f) => f.file.startsWith("native/"))) {
  const b = await readFile(join(artifacts, "release-native", f.file));
  assert.equal(createHash("sha256").update(b).digest("hex"), f.sha256);
}
const releases = [
  {
    tag: "tabspace-v" + APP_VERSION,
    title: "TabSpace " + APP_VERSION,
    files: [tabName, setupName],
    checksum: "TabSpace-SHA256SUMS.txt",
    notes: "docs/releases/tabspace-v" + APP_VERSION + ".md",
  },
  {
    tag: "drag-group-v" + drag.version,
    title: "Drag Group " + drag.version,
    files: [dragName, setupName],
    checksum: "DragGroup-SHA256SUMS.txt",
    notes: "docs/releases/drag-group-v" + drag.version + ".md",
  },
];
for (const release of releases)
  await writeFile(
    join(out, release.checksum),
    files
      .filter((f) => release.files.includes(f.name))
      .map((f) => f.sha256 + "  " + f.name)
      .join("\n") + "\n",
  );
const report = {
  date: new Date().toISOString(),
  tabSpaceVersion: APP_VERSION,
  dragGroupVersion: drag.version,
  installerVersion: installer.version,
  prerelease: !process.argv.includes("--stable"),
  validation: { checks: 30, passed: true },
  installerChecks: installerTests.checks.length,
  installedNativeProtocolChecks: 6,
  files,
  releases,
};
await writeFile(
  join(out, "release-manifest.json"),
  JSON.stringify(report, null, 2),
);
await mkdir(join(root, "docs/validation"), { recursive: true });
await writeFile(
  join(root, "docs/validation/artifacts.json"),
  JSON.stringify(report, null, 2) + "\n",
);
await writeFile(
  join(root, "docs/validation/windows-gate.json"),
  JSON.stringify(
    {
      ...gate,
      results: gate.results.map((c) => ({
        name: c.name,
        passed: c.passed,
        milliseconds: c.milliseconds,
      })),
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  join(root, "docs/validation/installer.json"),
  JSON.stringify(
    {
      installerVersion: installer.version,
      helperVersion: installer.helperVersion,
      passed: true,
      scope: installerTests.scope,
      checks: installerTests.checks,
      manualLimits: installerTests.manualLimits,
    },
    null,
    2,
  ) + "\n",
);
console.log("Audited public releases: " + out);
