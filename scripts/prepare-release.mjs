import { readFile, writeFile, mkdir, cp, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import { APP_VERSION } from "../packages/domain/version.ts";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "artifacts");
const stable = process.argv.includes("--stable");
const tabSpaceOnly = process.argv.includes("--tabspace-only");
const manifest = JSON.parse(
  await readFile(
    resolve(root, "apps/drag-group/extension/manifest.json"),
    "utf8",
  ),
);
const helperVersion = manifest.version;
const nativeProject = await readFile(
  resolve(root, "apps/drag-group/native/DragGroup.Native.csproj"),
  "utf8",
);
assert(
  nativeProject.includes(`<Version>${helperVersion}</Version>`),
  "Native and standalone versions must match",
);
const validationDirs = (await readdir(artifacts))
  .filter((name) => name.startsWith("validation-"))
  .sort()
  .reverse();
const validation = JSON.parse(
  await readFile(resolve(artifacts, validationDirs[0], "summary.json"), "utf8"),
);
assert.equal(validation.version, APP_VERSION);
assert.equal(validation.quick, false, "Release requires the full Windows gate");
assert.equal(
  validation.results.length,
  30,
  "Release requires all 30 automated checks",
);
assert(
  validation.results.every((check) => check.passed),
  "Release gate has failures",
);
const staging = resolve(artifacts, "release-staging");
const nativeFiles = [
  "DragGroup.Native.exe",
  "DragGroup.Native.dll",
  "DragGroup.Native.deps.json",
  "DragGroup.Native.runtimeconfig.json",
  "DragGroup.Core.dll",
];
for (const edition of ["standalone", "helper"]) {
  await mkdir(resolve(staging, edition, "native"), { recursive: true });
  for (const file of nativeFiles)
    await cp(
      resolve(artifacts, "release-native/native", file),
      resolve(staging, edition, "native", file),
    );
}
const env = {
  ...process.env,
  DRAG_GROUP_BUNDLE_DIR: resolve(staging, "standalone"),
  DRAG_GROUP_HELPER_DIR: resolve(staging, "helper"),
};
for (const script of [
  "audit-source",
  "package",
  "audit-package",
  ...(!tabSpaceOnly ? ["package-drag-group", "audit-drag-group"] : []),
  "package-integrated-helper",
]) {
  const result = spawnSync(process.execPath, [`scripts/${script}.mjs`], {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) throw Error(`${script} failed`);
}
const output = resolve(artifacts, `release-${APP_VERSION}`);
await mkdir(output, { recursive: true });
const names = [
  `TabSpace-${APP_VERSION}-core.zip`,
  `TabSpace-${APP_VERSION}-newtab.zip`,
  ...(!tabSpaceOnly ? [`DragGroup-Windows-${helperVersion}.zip`] : []),
];
for (const name of names)
  await cp(resolve(artifacts, name), resolve(output, name));
const helperName = `DragGroup-Helper-Windows-${helperVersion}.zip`;
await cp(
  resolve(artifacts, `TabSpace-DragGroup-Helper-Windows-${APP_VERSION}.zip`),
  resolve(output, helperName),
);
names.push(helperName);
for (const [source, name] of [
  ["docs/USER_GUIDE_EL.md", "INSTALL-EL.md"],
  ["docs/USER_GUIDE_EN.md", "INSTALL-EN.md"],
  ["LICENSE", "LICENSE.txt"],
  ["artifacts/THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_NOTICES.txt"],
]) {
  await cp(resolve(root, source), resolve(output, name));
  names.push(name);
}
// Verify the helper ZIP exactly, including bytes from the freshly built native host.
const helper = unzipSync(
  new Uint8Array(await readFile(resolve(output, helperName))),
);
assert.deepEqual(
  Object.keys(helper).sort(),
  [
    "identity.json",
    "Install.ps1",
    "Uninstall.ps1",
    "README.md",
    "LICENSE.txt",
    ...nativeFiles.map((name) => `native/${name}`),
  ].sort(),
);
for (const file of Object.keys(helper))
  assert.deepEqual(
    Buffer.from(helper[file]),
    await readFile(resolve(staging, "helper", file)),
  );
const ids = JSON.parse(
  new TextDecoder().decode(helper["identity.json"]),
).extensionIds;
assert.equal(ids.length, 2);
assert.equal(new Set(ids).size, 2);
assert(ids.every((id) => /^[a-p]{32}$/.test(id)));
// Test the exact fresh host being distributed, without Windows registration.
const nativeDir = resolve(artifacts, "release-native/native");
await writeFile(
  resolve(nativeDir, "com.tabspace.draggroup.json"),
  JSON.stringify({
    name: "com.tabspace.draggroup",
    description: "Isolated release protocol fixture only",
    path: resolve(nativeDir, "DragGroup.Native.exe"),
    type: "stdio",
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  }),
);
const protocol = spawnSync(
  process.execPath,
  ["--test", "tests/drag-group-native.test.mjs"],
  {
    cwd: root,
    env: { ...env, DRAG_GROUP_NATIVE_DIR: nativeDir },
    stdio: "inherit",
    windowsHide: true,
  },
);
assert.equal(protocol.status, 0, "Fresh release native protocol checks failed");
const files = [];
for (const name of names) {
  const bytes = await readFile(resolve(output, name));
  files.push({
    name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const common = [
  helperName,
  "INSTALL-EL.md",
  "INSTALL-EN.md",
  "LICENSE.txt",
  "THIRD_PARTY_NOTICES.txt",
];
const releases = [
  {
    tag: `tabspace-v${APP_VERSION}`,
    files: [
      `TabSpace-${APP_VERSION}-core.zip`,
      `TabSpace-${APP_VERSION}-newtab.zip`,
      ...common,
    ],
    checksum: "TabSpace-SHA256SUMS.txt",
  },
  ...(!tabSpaceOnly
    ? [
        {
          tag: `drag-group-v${helperVersion}`,
          files: [`DragGroup-Windows-${helperVersion}.zip`, ...common],
          checksum: "DragGroup-SHA256SUMS.txt",
        },
      ]
    : []),
];
for (const release of releases)
  await writeFile(
    resolve(output, release.checksum),
    files
      .filter((file) => release.files.includes(file.name))
      .map((file) => `${file.sha256}  ${file.name}`)
      .join("\n") + "\n",
  );
const report = {
  date: new Date().toISOString(),
  tabSpaceVersion: APP_VERSION,
  dragGroupVersion: helperVersion,
  prerelease: !stable,
  validation: {
    checks: validation.results.length,
    passed: true,
    source: validationDirs[0],
  },
  helperInventoryAndBytesVerified: true,
  freshHelperProtocolPassed: true,
  files,
  releases,
  manualAcceptancePending: [
    "Clean Windows install/update/rollback",
    "Physical mouse/DPI/multi-monitor matrix",
  ],
};
await writeFile(
  resolve(output, "release-manifest.json"),
  JSON.stringify(report, null, 2),
);
console.log(`Release packages audited: ${output}`);
