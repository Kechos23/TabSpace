import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
await build({
  entryPoints: [resolve(root, "scripts/performance.ts")],
  outfile: resolve(root, "artifacts/performance.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
});
const result = spawnSync(
  process.execPath,
  [resolve(root, "artifacts/performance.cjs")],
  { cwd: root, encoding: "utf8", windowsHide: true },
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
