import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { APP_VERSION } from "../packages/domain/version.ts";
const root = resolve(import.meta.dirname, ".."),
  out = resolve(
    root,
    process.env.DRAG_GROUP_HELPER_DIR || "artifacts/tabspace-drag-helper",
  );
const id = (key) =>
  [
    ...createHash("sha256")
      .update(Buffer.from(key, "base64"))
      .digest()
      .subarray(0, 16),
  ]
    .flatMap((b) => [b >> 4, b & 15])
    .map((n) => String.fromCharCode(97 + n))
    .join("");
const extensionIds = [];
for (const p of [
  "apps/extension/manifest/public-key.json",
  "apps/drag-group/public-key.json",
])
  extensionIds.push(
    id(JSON.parse(await readFile(resolve(root, p), "utf8")).key),
  );
await mkdir(out, { recursive: true });
await writeFile(
  resolve(out, "identity.json"),
  JSON.stringify({ extensionIds }, null, 2),
);
for (const file of ["Install.ps1", "Uninstall.ps1"])
  await cp(resolve(root, "apps/drag-group/scripts", file), resolve(out, file));
await cp(
  resolve(root, "docs/drag-group-integration.md"),
  resolve(out, "README.md"),
);
await cp(resolve(root, "LICENSE"), resolve(out, "LICENSE.txt"));
const native = [
  "DragGroup.Native.exe",
  "DragGroup.Native.dll",
  "DragGroup.Native.deps.json",
  "DragGroup.Native.runtimeconfig.json",
  "DragGroup.Core.dll",
];
const files = {};
for (const file of [
  "identity.json",
  "Install.ps1",
  "Uninstall.ps1",
  "README.md",
  "LICENSE.txt",
  ...native.map((n) => "native/" + n),
])
  files[file] = new Uint8Array(await readFile(resolve(out, file)));
const archive = zipSync(files, { level: 9 }),
  name = `TabSpace-DragGroup-Helper-Windows-${APP_VERSION}.zip`;
await writeFile(resolve(root, "artifacts", name), archive);
await writeFile(
  resolve(root, "artifacts", "TabSpace-DragGroup-Helper-SHA256SUMS.txt"),
  createHash("sha256").update(archive).digest("hex") + "  " + name + "\n",
);
console.log(name, extensionIds);
