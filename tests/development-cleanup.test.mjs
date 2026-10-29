import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  utimes,
  access,
  rm,
  symlink,
  readFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { cleanupDevelopment } from "../scripts/development-cleanup.mjs";

const now = Date.now(),
  hour = 3600000;
const parent = resolve(import.meta.dirname, "../artifacts");
await mkdir(parent, { recursive: true });
async function fixture(fn) {
  const root = await mkdtemp(join(parent, "cleanup-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}
async function folder(root, name, hours = 96, content = "data") {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  const file = join(path, "fixture.txt");
  await writeFile(file, content);
  const date = new Date(now - hours * hour);
  await utimes(file, date, date);
  await utimes(path, date, date);
  return path;
}
const run = (root, options = {}) =>
  cleanupDevelopment({
    root,
    now,
    commands: "",
    protectedPaths: [],
    force: true,
    ...options,
  });

test("preview is non-destructive; apply keeps two latest per family and enforces 48 hours", async () =>
  fixture(async (root) => {
    const old = await folder(root, "artifacts/test-profile-1000000000000", 100);
    const keep1 = await folder(
      root,
      "artifacts/test-profile-1000000000001",
      90,
    );
    const keep2 = await folder(
      root,
      "artifacts/test-profile-1000000000002",
      80,
    );
    const recent = await folder(
      root,
      "artifacts/session-profile-1000000000000",
      12,
    );
    const preview = await run(root);
    assert.deepEqual(preview.candidates, [old]);
    assert(await exists(old));
    const result = await run(root, { apply: true });
    assert.deepEqual(result.removed, [old]);
    for (const path of [keep1, keep2, recent]) assert(await exists(path));
  }));
test("protects active profiles, installed extension paths and recently changed nested files", async () =>
  fixture(async (root) => {
    const active = await folder(root, "artifacts/test-profile-1000000000000");
    const installed = await folder(
      root,
      "artifacts/test-profile-1000000000001",
    );
    const fresh = await folder(root, "artifacts/test-profile-1000000000002");
    await utimes(join(fresh, "fixture.txt"), new Date(now), new Date(now));
    const result = await run(root, {
      apply: true,
      keep: 0,
      commands: `chrome --user-data-dir="${active}"`.toLowerCase(),
      protectedPaths: [join(installed, "extension")],
    });
    assert.equal(result.removed.length, 0);
    assert.equal(result.skipped.length, 3);
  }));
test("allowlist excludes source, releases, toolchains and repositories, including nested Git", async () =>
  fixture(async (root) => {
    const paths = [];
    for (const name of [
      "artifacts/public-repository/TabSpace",
      "dist/core",
      ".cache/dotnet",
      ".cache/browsers",
      "node_modules",
      "artifacts/public-release",
      "artifacts/validation-2026-10-29",
      "artifacts/unknown-1000000000000",
    ])
      paths.push(await folder(root, name));
    const repo = await folder(root, "artifacts/test-profile-1000000000000");
    await mkdir(join(repo, ".git"));
    const date = new Date(now - 96 * hour);
    await utimes(repo, date, date);
    await utimes(join(repo, ".git"), date, date);
    const result = await run(root, { apply: true, keep: 0 });
    assert.equal(result.removed.length, 0);
    for (const path of [...paths, repo]) assert(await exists(path));
  }));
test("never follows junctions or deletes trees containing links", async () =>
  fixture(async (root) => {
    const outside = await folder(root, "protected");
    const candidate = await folder(
      root,
      "artifacts/test-profile-1000000000000",
    );
    await symlink(
      outside,
      join(candidate, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const date = new Date(now - 96 * hour);
    await utimes(candidate, date, date);
    await symlink(
      outside,
      join(root, "artifacts/test-profile-1000000000001"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await run(root, { apply: true, keep: 0 });
    assert.equal(result.removed.length, 0);
    assert(await exists(join(outside, "fixture.txt")));
  }));
test("rejects a redirected artifacts directory before writing cleanup metadata", async () =>
  fixture(async (root) => {
    const outside = await folder(root, "protected");
    await symlink(
      outside,
      join(root, "artifacts"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(run(root, { apply: true }), /must not be a link/);
    assert.equal(await exists(join(outside, ".development-cleanup")), false);
  }));
test("cache cleanup is limited to aged cloud-sync copies; automatic execution is throttled", async () =>
  fixture(async (root) => {
    const old = await folder(root, ".cache/cloud-sync-extension-1000000000000");
    const unknown = await folder(root, ".cache/other-1000000000000");
    const result = await run(root, { apply: true, keep: 0 });
    assert.deepEqual(result.removed, [old]);
    assert(await exists(unknown));
    const next = await run(root, { apply: true, force: false });
    assert.equal(next.throttled, true);
  }));
test("a live cleaner lock prevents overlapping deletion", async () =>
  fixture(async (root) => {
    const path = await folder(root, "artifacts/test-profile-1000000000000");
    await mkdir(join(root, "artifacts/.development-cleanup"), {
      recursive: true,
    });
    await writeFile(
      join(root, "artifacts/.development-cleanup/lock.json"),
      JSON.stringify({ pid: process.pid }),
    );
    const report = await run(root, { apply: true, keep: 0 });
    assert.equal(report.busy, true);
    assert(await exists(path));
  }));
