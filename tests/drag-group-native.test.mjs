import { dragConfig } from "../apps/drag-group/extension/config.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, ".."),
  dir = resolve(
    root,
    process.env.DRAG_GROUP_NATIVE_DIR || "artifacts/drag-group/native",
  );
const { extensionId } = JSON.parse(
  await readFile(
    resolve(
      root,
      process.env.DRAG_GROUP_BUNDLE_DIR || "artifacts/drag-group",
      "identity.json",
    ),
    "utf8",
  ),
);
const origin = `chrome-extension://${extensionId}/`,
  session = "00000000-0000-4000-8000-000000000001";
const encode = (value) => {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
};
async function run(args, frames, reply) {
  const child = spawn(resolve(dir, "DragGroup.Native.exe"), args, {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let bytes = Buffer.alloc(0),
    messages = [];
  child.stdout.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE() + 4) {
      const length = bytes.readUInt32LE();
      const value = JSON.parse(bytes.subarray(4, 4 + length));
      messages.push(value);
      bytes = bytes.subarray(4 + length);
      if (reply) reply(child, value);
    }
  });
  child.stdin.on("error", () => {});
  child.stderr.resume();
  const exit = new Promise((resolve, reject) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", reject);
  });
  const timeout = setTimeout(() => child.kill(), 8000);
  try {
    for (const frame of frames) child.stdin.write(frame);
    if (!reply) child.stdin.end();
    return { code: await exit, messages };
  } finally {
    clearTimeout(timeout);
  }
}
if (process.env.DRAG_GROUP_NATIVE_DIR) {
  const registration = JSON.parse(
    await readFile(resolve(dir, "com.tabspace.draggroup.json"), "utf8"),
  );
  for (const allowed of registration.allowed_origins)
    test("shared helper accepts explicit origin " + allowed, async () => {
      const result = await run(
        [allowed],
        [encode({ protocolVersion: 1, type: "hello", session })],
        (child, message) => {
          if (message.type === "challenge")
            child.stdin.write(
              encode({ protocolVersion: 1, type: "shutdown", session }),
            );
        },
      );
      assert.equal(result.code, 0);
      assert.equal(result.messages[0].type, "challenge");
      assert.equal(result.messages[0].build, dragConfig.expectedHelperBuild);
    });
}
test("actual host challenges the exact origin and shuts down on request", async () => {
  const result = await run(
    [origin],
    [encode({ protocolVersion: 1, type: "hello", session })],
    (child, message) => {
      if (message.type === "challenge")
        child.stdin.write(
          encode({ protocolVersion: 1, type: "shutdown", session }),
        );
    },
  );
  assert.equal(result.code, 0);
  assert.equal(result.messages[0].type, "challenge");
  assert.match(result.messages[0].nonce, /^[a-f0-9]{32}$/);
});
test("actual host rejects an unauthorized extension origin", async () => {
  const result = await run(
    ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"],
    [],
  );
  assert.equal(result.code, 3);
  assert.equal(result.messages.length, 0);
});
test("actual host rejects unknown fields", async () => {
  const result = await run(
    [origin],
    [encode({ protocolVersion: 1, type: "hello", session, extra: true })],
  );
  assert.equal(result.code, 4);
  assert.equal(result.messages.length, 0);
});
test("actual host rejects an oversized frame without returning data", async () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(65537);
  const result = await run([origin], [header]);
  assert.equal(result.messages.length, 0);
  assert.notEqual(result.code, null);
});
