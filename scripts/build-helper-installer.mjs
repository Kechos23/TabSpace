import { readFile, writeFile, mkdir, cp, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const metadata = JSON.parse(
  await readFile(
    resolve(root, "apps/drag-group/installer/version.json"),
    "utf8",
  ),
);
const nativeVersion = (
  await readFile(
    resolve(root, "apps/drag-group/native/DragGroup.Native.csproj"),
    "utf8",
  )
).match(/<Version>([^<]+)<\/Version>/)[1];
assert.equal(metadata.helperVersion, nativeVersion);
assert.equal(metadata.hostName, "com.tabspace.draggroup");
assert.match(metadata.version, /^\d+\.\d+\.\d+$/);
const testIndex = process.argv.indexOf("--test-id");
const testId = testIndex < 0 ? undefined : process.argv[testIndex + 1];
if (testIndex >= 0) assert.match(testId || "", /^[a-z0-9-]{1,60}$/);
const stage = resolve(
  root,
  "artifacts/helper-installer",
  testId || "production",
);
const output = resolve(
  root,
  "artifacts/helper-installer",
  testId ? "tests" : "release",
);
await mkdir(join(stage, "native"), { recursive: true });
await mkdir(output, { recursive: true });
const nativeFiles = [
  "DragGroup.Native.exe",
  "DragGroup.Native.dll",
  "DragGroup.Native.deps.json",
  "DragGroup.Native.runtimeconfig.json",
  "DragGroup.Core.dll",
];
const nativeDir = resolve(
  root,
  process.env.DRAG_GROUP_INSTALLER_NATIVE_DIR ||
    "artifacts/release-native/native",
);
for (const file of nativeFiles)
  await cp(join(nativeDir, file), join(stage, "native", file));
const dependencies = JSON.parse(
  await readFile(join(stage, "native/DragGroup.Native.deps.json"), "utf8"),
);
assert(
  dependencies.libraries[`DragGroup.Native/${metadata.helperVersion}`],
  "Staged helper version does not match installer metadata",
);
const hostBytes = await readFile(join(stage, "native/DragGroup.Native.exe"));
assert.equal(
  hostBytes.readUInt16LE(hostBytes.readUInt32LE(0x3c) + 4),
  0x8664,
  "Helper must be a Windows x64 executable",
);
const extensionIds = [];
for (const keyPath of [
  "apps/extension/manifest/public-key.json",
  "apps/drag-group/public-key.json",
]) {
  const { key } = JSON.parse(await readFile(resolve(root, keyPath), "utf8"));
  const id = [
    ...createHash("sha256")
      .update(Buffer.from(key, "base64"))
      .digest()
      .subarray(0, 16),
  ]
    .flatMap((value) => [value >> 4, value & 15])
    .map((value) => String.fromCharCode(97 + value))
    .join("");
  assert.match(id, /^[a-p]{32}$/);
  extensionIds.push(id);
}
assert.equal(new Set(extensionIds).size, 2);
await writeFile(
  join(stage, "identity.json"),
  JSON.stringify({ extensionIds }, null, 2),
);
await cp(resolve(root, "LICENSE"), join(stage, "LICENSE.txt"));
await cp(
  resolve(root, "artifacts/THIRD_PARTY_NOTICES.txt"),
  join(stage, "THIRD_PARTY_NOTICES.txt"),
);
await cp(
  resolve(root, "apps/drag-group/installer/SetupGuide.html"),
  join(stage, "SetupGuide.html"),
);

// Reuse the product's existing PNG mark; ICO supports PNG entries directly.
const iconImages = [];
for (const size of [16, 32, 48])
  iconImages.push({
    size,
    bytes: await readFile(
      resolve(root, `dist/core/icons/green/icon${size}.png`),
    ),
  });
const header = Buffer.alloc(6 + iconImages.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(iconImages.length, 4);
let offset = header.length;
iconImages.forEach(({ size, bytes }, index) => {
  const entry = 6 + index * 16;
  header[entry] = header[entry + 1] = size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(bytes.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += bytes.length;
});
await writeFile(
  join(stage, "helper.ico"),
  Buffer.concat([header, ...iconImages.map((image) => image.bytes)]),
);
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    resolve(root, "scripts/helper-installer-art.ps1"),
    "-OutputDirectory",
    stage,
  ],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
const payloadFiles = [
  ...nativeFiles.map((file) => `native/${file}`),
  "identity.json",
  "LICENSE.txt",
  "THIRD_PARTY_NOTICES.txt",
  "SetupGuide.html",
  "helper.ico",
];
const payload = [];
for (const file of payloadFiles) {
  const bytes = await readFile(join(stage, file));
  payload.push({
    file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await writeFile(
  join(stage, "Payload.iss"),
  [
    `#define InstallerVersion "${metadata.version}"`,
    `#define HelperVersion "${metadata.helperVersion}"`,
    `#define AllowedOrigins '${JSON.stringify(extensionIds.map((id) => `chrome-extension://${id}/`))}'`,
  ].join("\n") + "\n",
);
await writeFile(
  join(stage, "VerifyPayload.iss"),
  [
    "procedure VerifyInstalledPayload;",
    "begin",
    ...payload.map(
      ({ file, sha256 }) =>
        `  if CompareText(GetSHA256OfFile(ExpandConstant('{app}\\${file.replaceAll("/", "\\")}')), '${sha256}') <> 0 then RaiseException('Installed file verification failed: ${file}');`,
    ),
    "end;",
  ].join("\n") + "\n",
);
await writeFile(
  join(stage, "RollbackPayload.iss"),
  [
    `var PriorPayload: array[0..${payload.length - 1}] of Boolean; PayloadSnapshotReady: Boolean;`,
    "procedure SnapshotInstalledPayload;",
    "begin",
    "  if not ForceDirectories(ExpandConstant('{tmp}\\payload-rollback')) then RaiseException('Could not create rollback directory.');",
    ...payload.flatMap(({ file }, index) => [
      `  PriorPayload[${index}] := FileExists(ExpandConstant('{app}\\${file.replaceAll("/", "\\")}'));`,
      `  if PriorPayload[${index}] and not FileCopy(ExpandConstant('{app}\\${file.replaceAll("/", "\\")}'), ExpandConstant('{tmp}\\payload-rollback\\${index}'), False) then RaiseException('Could not back up ${file}.');`,
    ]),
    "  PayloadSnapshotReady := True;",
    "end;",
    "procedure RestoreInstalledPayload;",
    "begin",
    "  if not PayloadSnapshotReady then exit;",
    ...payload.flatMap(({ file }, index) => [
      `  if PriorPayload[${index}] then begin`,
      `    if not ForceDirectories(ExtractFileDir(ExpandConstant('{app}\\${file.replaceAll("/", "\\")}'))) then RaiseException('Could not recreate rollback target.');`,
      `    if not FileCopy(ExpandConstant('{tmp}\\payload-rollback\\${index}'), ExpandConstant('{app}\\${file.replaceAll("/", "\\")}'), False) then RaiseException('Could not restore ${file}.');`,
      `  end else DeleteFile(ExpandConstant('{app}\\${file.replaceAll("/", "\\")}'));`,
    ]),
    "end;",
  ].join("\n") + "\n",
);
assert.deepEqual(
  (await readdir(join(stage, "native"))).sort(),
  nativeFiles.toSorted(),
  "Stale native staging files must be removed explicitly before packaging",
);
const compiler = resolve(
  root,
  process.env.INNO_SETUP_COMPILER || ".cache/inno-7.1.0/compiler/ISCC.exe",
);
execFileSync(
  compiler,
  [
    `/DPayloadDir=${stage}`,
    `/DOutputDir=${output}`,
    ...(testId ? [`/DInstallerTestId=${testId}`] : []),
    resolve(root, "apps/drag-group/installer/HelperSetup.iss"),
  ],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
const name = testId
  ? `DragGroup-Helper-Setup-TEST-${testId}.exe`
  : `DragGroup-Helper-Setup-${metadata.version}.exe`;
const bytes = await readFile(join(output, name));
const sha256 = createHash("sha256").update(bytes).digest("hex");
const report = {
  date: new Date().toISOString(),
  installerVersion: metadata.version,
  helperVersion: metadata.helperVersion,
  file: name,
  bytes: bytes.length,
  sha256,
  testOnly: !!testId,
  extensionIds,
  payload,
};
await writeFile(join(output, name + ".json"), JSON.stringify(report, null, 2));
await writeFile(join(output, name + ".sha256"), `${sha256}  ${name}\n`);
console.log(
  JSON.stringify(
    { file: join(output, name), sha256, testOnly: !!testId },
    null,
    2,
  ),
);
