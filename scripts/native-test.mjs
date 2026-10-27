import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, ".."),
  dir = resolve(root, "artifacts/native-win-x64");
const { extensionId } = JSON.parse(
  await readFile(resolve(root, "dist/identity.json"), "utf8"),
);
const origin = `chrome-extension://${extensionId}/`,
  exe = resolve(dir, "TabSpace.Native.exe");
await writeFile(
  resolve(dir, "com.tabspace.native.json"),
  JSON.stringify(
    {
      name: "com.tabspace.native",
      description: "TabSpace optional diagnostic host",
      path: exe,
      type: "stdio",
      allowed_origins: [origin],
    },
    null,
    2,
  ),
);
const hello = Buffer.from(
    JSON.stringify({
      protocolVersion: 1,
      type: "hello",
      requestId: crypto.randomUUID(),
    }),
  ),
  head = Buffer.alloc(4);
head.writeUInt32LE(hello.length);
const bytes = Buffer.concat([head, hello]);
async function request(args, input, fragment = false) {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    proc.stdout.on("data", (b) => chunks.push(b));
    proc.on("error", reject);
    proc.stdin.on("error", () => {});
    proc.on("close", (code) => resolve({ code, bytes: Buffer.concat(chunks) }));
    if (fragment) {
      for (const b of input) proc.stdin.write(Buffer.from([b]));
      proc.stdin.end();
    } else proc.stdin.end(input);
  });
}
const accepted = await request([origin], bytes, true);
assert.equal(accepted.code, 0);
const length = accepted.bytes.readUInt32LE(0);
assert.equal(accepted.bytes.length, length + 4);
const result = JSON.parse(accepted.bytes.subarray(4).toString("utf8"));
assert.equal(result.gestureEnabled, false);
assert.equal(result.protocolVersion, 1);
const rejected = await request(
  ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"],
  bytes,
);
assert.equal(rejected.code, 3);
assert.equal(rejected.bytes.length, 0);
const oversized = Buffer.alloc(4);
oversized.writeUInt32LE(65537);
const invalid = await request([origin], oversized);
assert.equal(invalid.code, 2);
assert.equal(invalid.bytes.length, 0);
console.log(
  "Built native executable: fragmented handshake, exact origin rejection, bounded frame rejection passed. No registry registration or input hooks were created.",
);
