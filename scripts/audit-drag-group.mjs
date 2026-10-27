import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, ".."),
  bundle = resolve(root, process.env.DRAG_GROUP_BUNDLE_DIR || "artifacts/drag-group");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const currentManifest = JSON.parse(
  await readFile(resolve(bundle, "extension/manifest.json"), "utf8"),
);
const archiveName = `DragGroup-Windows-${currentManifest.version}.zip`;
const archive = await readFile(resolve(root, "artifacts", archiveName));
const checksum = (
  await readFile(resolve(root, "artifacts/DragGroup-SHA256SUMS.txt"), "utf8")
).split("  ")[0];
assert.equal(digest(archive), checksum);
const files = unzipSync(archive);
const expected = [
  "identity.json",
  "Install.ps1",
  "Uninstall.ps1",
  "README.md",
  "LICENSE.txt",
  ...[
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
  ].map((n) => "extension/" + n),
  ...[
    "DragGroup.Native.exe",
    "DragGroup.Native.dll",
    "DragGroup.Native.deps.json",
    "DragGroup.Native.runtimeconfig.json",
    "DragGroup.Core.dll",
  ].map((n) => "native/" + n),
];
assert.deepEqual(Object.keys(files).sort(), expected.sort());
for (const name of expected)
  assert.equal(
    digest(files[name]),
    digest(await readFile(resolve(bundle, name))),
    name,
  );
const manifest = JSON.parse(
  new TextDecoder().decode(files["extension/manifest.json"]),
);
assert.equal(manifest.version, currentManifest.version);
assert.deepEqual(manifest.permissions, [
  "nativeMessaging",
  "tabGroups",
  "storage",
]);
assert.equal(manifest.incognito, "not_allowed");
assert.equal(manifest.host_permissions, undefined);
assert.equal(manifest.content_scripts, undefined);
assert.equal(manifest.externally_connectable, undefined);
assert(
  !manifest.content_security_policy.extension_pages.includes("unsafe-eval"),
);
const id = [
  ...createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest()
    .subarray(0, 16),
]
  .flatMap((b) => [b >> 4, b & 15])
  .map((n) => String.fromCharCode(97 + n))
  .join("");
assert.equal(
  id,
  JSON.parse(new TextDecoder().decode(files["identity.json"])).extensionId,
);
const config = JSON.parse(
  new TextDecoder().decode(files["native/DragGroup.Native.runtimeconfig.json"]),
);
assert(
  config.runtimeOptions.frameworks.some(
    (f) =>
      f.name === "Microsoft.WindowsDesktop.App" && f.version.startsWith("10."),
  ),
);
const report = {
  date: new Date().toISOString().slice(0,10),
  version: manifest.version,
  archive: "artifacts/" + archiveName,
  bytes: archive.length,
  sha256: checksum,
  extensionId: id,
  files: expected.length,
  exactInventoryAndBytes: true,
  noRegistrationBackupProfilesOrPrivateKeys: true,
  permissions: manifest.permissions,
  frameworkDependent: true,
};
await writeFile(
  resolve(root, "docs/DRAG_GROUP_PACKAGE.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
