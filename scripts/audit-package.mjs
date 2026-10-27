import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { APP_VERSION } from "../packages/domain/version.ts";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, ".."),
  out = resolve(root, "artifacts"),
  digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sums = await readFile(resolve(out, "SHA256SUMS.txt"), "utf8");
for (const line of sums.trim().split("\n")) {
  const [hash, name] = line.trim().split(/\s{2}/);
  assert.equal(digest(await readFile(resolve(out, name))), hash);
}
let coreExtract;
for (const variant of ["core", "newtab"]) {
  const dir = resolve(root, "dist", variant),
    zip = unzipSync(
      new Uint8Array(
        await readFile(resolve(out, `TabSpace-${APP_VERSION}-${variant}.zip`)),
      ),
    );
  const inventory = JSON.parse(
    await readFile(resolve(dir, "build-files.json"), "utf8"),
  );
  assert.deepEqual(
    Object.keys(zip).sort(),
    [...inventory, "THIRD_PARTY_NOTICES.txt", "LICENSE.txt"].sort(),
  );
  for (const name of inventory) {
    assert(
      !name.includes("..") && !name.includes("\\") && !name.startsWith("/"),
    );
    assert.equal(digest(zip[name]), digest(await readFile(resolve(dir, name))));
  }
  const manifest = JSON.parse(new TextDecoder().decode(zip["manifest.json"]));
  assert.equal(Boolean(manifest.chrome_url_overrides), variant === "newtab");
  if (variant === "core") {
    coreExtract = resolve(out, `packaged-core-${Date.now()}`);
    await mkdir(coreExtract, { recursive: true });
    for (const [name, bytes] of Object.entries(zip)) {
      const path = resolve(coreExtract, name);
      assert(!relative(coreExtract, path).startsWith(".."));
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, bytes);
    }
  }
}
const diagnosticPath = resolve(out, "TabSpace-0.1.0-native-diagnostic-win-x64.zip");
const hasDiagnostic = await access(diagnosticPath).then(() => true, () => false);
if (hasDiagnostic) {
const native = unzipSync(
  new Uint8Array(
    await readFile(
      resolve(out, "TabSpace-0.1.0-native-diagnostic-win-x64.zip"),
    ),
  ),
);
assert.deepEqual(
  Object.keys(native).sort(),
  [
    "TabSpace.Native.exe",
    "TabSpace.Native.dll",
    "TabSpace.Native.deps.json",
    "TabSpace.Native.runtimeconfig.json",
    "TabSpace.Native.Protocol.dll",
    "install-native-host.ps1",
    "uninstall-native-host.ps1",
    "NATIVE_HELPER.md",
  ].sort(),
);
assert(
  !Object.keys(native).some((name) =>
    /registration|native\.json|profile|key|\.pdb/.test(name),
  ),
);
}
const result = {
  date: new Date().toISOString(),
  checksums: "All archive/executable checksums verified",
  extensionFiles:
    "Exactly current build output plus license notices; no stale assets/test profiles/native registrations/private keys",
  nativeFiles:
    hasDiagnostic ? "Explicit diagnostic dependency/script/doc allowlist" : "Legacy diagnostic package not included; shared helper audited separately",
  coreExtract,
};
await writeFile(
  resolve(root, "docs/VALIDATION_PACKAGE.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
