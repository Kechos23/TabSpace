import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { resolve } from "node:path";
import { generateKeyPairSync, createHash } from "node:crypto";
import { zipSync } from "fflate";
const root = resolve(import.meta.dirname, ".."),
  source = resolve(root, "apps/drag-group"),
  out = resolve(root, process.env.DRAG_GROUP_BUNDLE_DIR || "artifacts/drag-group");
await mkdir(out, { recursive: true });
let key;
try {
  key = JSON.parse(
    await readFile(resolve(source, "public-key.json"), "utf8"),
  ).key;
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64");
  await writeFile(
    resolve(source, "public-key.json"),
    JSON.stringify({ key }, null, 2),
  );
}
const extensionId = [
  ...createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest()
    .subarray(0, 16),
]
  .flatMap((b) => [b >> 4, b & 15])
  .map((n) => String.fromCharCode(97 + n))
  .join("");
await cp(resolve(source, "extension"), resolve(out, "extension"), {
  recursive: true,
});
const manifest = JSON.parse(
  await readFile(resolve(source, "extension/manifest.json"), "utf8"),
);
manifest.key = key;
await writeFile(
  resolve(out, "extension/manifest.json"),
  JSON.stringify(manifest, null, 2),
);
await writeFile(
  resolve(out, "identity.json"),
  JSON.stringify({ extensionId }, null, 2),
);
for (const file of ["Install.ps1", "Uninstall.ps1"])
  await cp(resolve(source, "scripts", file), resolve(out, file));
await cp(resolve(source, "README.md"), resolve(out, "README.md"));
await cp(resolve(root, "LICENSE"), resolve(out, "LICENSE.txt"));
const names = [
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
const files = {};
for (const name of names)
  files[name] = new Uint8Array(await readFile(resolve(out, name)));
const bytes = zipSync(files, { level: 6 });
const archiveName = `DragGroup-Windows-${manifest.version}.zip`;
const archive = resolve(root, "artifacts", archiveName);
await writeFile(archive, bytes);
await writeFile(
  resolve(root, "artifacts/DragGroup-SHA256SUMS.txt"),
  `${createHash("sha256").update(bytes).digest("hex")}  ${archiveName}\n`,
);
console.log(
  JSON.stringify(
    { extensionId, bundle: out, archive, bytes: bytes.length },
    null,
    2,
  ),
);
