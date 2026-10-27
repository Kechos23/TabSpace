import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { APP_VERSION } from "../packages/domain/version.ts";
const root = resolve(import.meta.dirname, ".."),
  out = resolve(root, "artifacts");
await mkdir(out, { recursive: true });
const licenses = [],
  notices = [];
for (const name of await readdir(resolve(root, "node_modules"))) {
  if (name.startsWith(".")) continue;
  const dirs = name.startsWith("@")
    ? (await readdir(resolve(root, "node_modules", name))).map(
        (n) => `${name}/${n}`,
      )
    : [name];
  for (const dir of dirs) {
    const path = resolve(root, "node_modules", dir);
    try {
      const p = JSON.parse(
        await readFile(resolve(path, "package.json"), "utf8"),
      );
      licenses.push({
        name: p.name,
        version: p.version,
        license: p.license ?? "See package license",
      });
      for (const entry of await readdir(path, { withFileTypes: true }))
        if (
          entry.isFile() &&
          /^(license|licence|copying|notice)(\.|$)/i.test(entry.name)
        )
          notices.push(
            `${p.name} ${p.version} — ${entry.name}\n${await readFile(resolve(path, entry.name), "utf8")}`,
          );
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
}
const noticeBytes = new TextEncoder().encode(
  "TabSpace dependency notices (including development dependencies)\n\n" +
    notices.join("\n\n────────────────────────\n\n"),
);
await writeFile(resolve(out, "THIRD_PARTY_NOTICES.txt"), noticeBytes);
await writeFile(
  resolve(out, "dependency-inventory.json"),
  JSON.stringify(licenses, null, 2),
);
const checks = [];
for (const variant of ["core", "newtab"]) {
  const dir = resolve(root, "dist", variant),
    files = {};
  const inventory = JSON.parse(
    await readFile(resolve(dir, "build-files.json"), "utf8"),
  );
  for (const name of inventory) {
    if (
      typeof name !== "string" ||
      name.includes("\\") ||
      name.startsWith("/") ||
      name.split("/").some((x) => x === ".." || x === ".")
    )
      throw Error("Invalid build inventory path");
    const path = resolve(dir, name);
    if (relative(dir, path).startsWith(".."))
      throw Error("Build file escapes output directory");
    files[name] = new Uint8Array(await readFile(path));
  }
  files["THIRD_PARTY_NOTICES.txt"] = noticeBytes;
  files["LICENSE.txt"] = new Uint8Array(await readFile(resolve(root, "LICENSE")));
  const bytes = zipSync(files, { level: 6 }),
    name = `TabSpace-${APP_VERSION}-${variant}.zip`;
  await writeFile(resolve(out, name), bytes);
  checks.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
}
const nativeDir = resolve(out, "native-win-x64");
try {
  const files = {};
  const nativeFiles = [
    "TabSpace.Native.exe",
    "TabSpace.Native.dll",
    "TabSpace.Native.deps.json",
    "TabSpace.Native.runtimeconfig.json",
    "TabSpace.Native.Protocol.dll",
  ];
  for (const name of nativeFiles)
    files[name] = new Uint8Array(await readFile(resolve(nativeDir, name)));
  const config = JSON.parse(
    new TextDecoder().decode(files["TabSpace.Native.runtimeconfig.json"]),
  );
  if (!config.runtimeOptions?.frameworks && !config.runtimeOptions?.framework)
    throw Error(
      "This packager currently supports the validated framework-dependent native build only.",
    );
  checks.push(
    `${createHash("sha256").update(files["TabSpace.Native.exe"]).digest("hex")}  native-win-x64/TabSpace.Native.exe`,
  );
  if (!Object.keys(files).some((name) => name.endsWith(".exe")))
    throw Error("Native helper executable missing");
  for (const name of ["install-native-host.ps1", "uninstall-native-host.ps1"])
    files[name] = new Uint8Array(
      await readFile(resolve(root, "scripts", name)),
    );
  files["NATIVE_HELPER.md"] = new Uint8Array(
    await readFile(resolve(root, "docs/NATIVE_HELPER.md")),
  );
  const bytes = zipSync(files, { level: 6 }),
    name = "TabSpace-0.1.0-native-diagnostic-win-x64.zip";
  await writeFile(resolve(out, name), bytes);
  checks.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.warn("Native package skipped: publish the diagnostic helper first.");
}
await writeFile(resolve(out, "SHA256SUMS.txt"), checks.join("\n") + "\n");
console.log(checks.join("\n"));
