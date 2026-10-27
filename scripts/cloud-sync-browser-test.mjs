import { resolve } from "node:path";
import { createServer } from "node:http";
import { cp, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { entity } from "../packages/domain/model.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const { expect } = await import("@playwright/test");
const files = new Map();
let revision = 0,
  requests = 0;
let failNextManifestGet = false;
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization,If-Match,If-None-Match,Content-Type",
  );
  res.setHeader("Access-Control-Expose-Headers", "ETag");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,PUT,MKCOL,PROPFIND,OPTIONS",
  );
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  requests++;
  if (
    req.headers.authorization !==
    `Basic ${Buffer.from("fixture:fixture-app-password").toString("base64")}`
  ) {
    res.writeHead(401).end();
    return;
  }
  if (!req.url.startsWith("/TabSpace/")) {
    res.writeHead(404).end();
    return;
  }
  if (req.method === "MKCOL") {
    res.writeHead(405).end();
    return;
  }
  const prior = files.get(req.url);
  if (req.method === "PROPFIND") {
    req.resume();
    if (!prior) {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(207, { "Content-Type": "application/xml" })
      .end(
        `<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:getetag>${prior.etag}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
      );
    return;
  }
  if (req.method === "GET") {
    if (failNextManifestGet && req.url.endsWith("manifest.json")) {
      failNextManifestGet = false;
      res.writeHead(503).end();
      return;
    }
    if (req.headers["if-match"] && req.headers["if-match"] !== prior?.etag) {
      res.writeHead(412).end();
      return;
    }
    if (!prior) res.writeHead(404).end();
    else
      res
        .writeHead(200, {
          ETag: req.url.endsWith("manifest.json")
            ? `"proxy-${prior.etag.slice(1, -1)}"`
            : prior.etag,
        })
        .end(prior.bytes);
  } else if (req.method === "PUT") {
    if (
      req.headers["if-match"]
        ? prior?.etag !== req.headers["if-match"]
        : !!prior
    ) {
      res.writeHead(412).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    files.set(req.url, {
      bytes: Buffer.concat(chunks),
      etag: `"${++revision}"`,
    });
    res.writeHead(201).end();
  } else res.writeHead(405).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/TabSpace/`;
// The production manifest is untouched. This disposable build grants only the
// synthetic loopback server, so real Chrome permission checks run without mocks.
const ext = resolve(root, `.cache/cloud-sync-extension-${Date.now()}`);
await cp(resolve(root, "dist/core"), ext, { recursive: true });
const manifest = JSON.parse(
  await readFile(resolve(ext, "manifest.json"), "utf8"),
);
manifest.host_permissions = ["http://127.0.0.1/*"];
await writeFile(resolve(ext, "manifest.json"), JSON.stringify(manifest));
const profiles = ["a", "b"].map((name) =>
  resolve(root, `artifacts/cloud-sync-${Date.now()}-${name}`),
);
const contexts = [];
const errors = [];
async function open(profile) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  contexts.push(context);
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(worker.url().replace("worker.js", "index.html"));
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const rpc = (m) =>
    page.evaluate(async (m) => {
      const r = await chrome.runtime.sendMessage(m);
      if (!r.ok) throw Error(r.error);
      return r.value;
    }, m);
  return { context, worker, page, rpc };
}
try {
  const a = await open(profiles[0]),
    b = await open(profiles[1]);
  const granted = await a.worker.evaluate(() => chrome.permissions.getAll());
  assert(
    !granted.origins?.includes("https://*/*"),
    "Optional HTTPS eligibility must not grant all servers",
  );
  await a.page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    a.page.getByLabel("Nextcloud address", { exact: true }),
  ).toBeVisible();
  await expect(a.page.getByLabel("Sync folder", { exact: true })).toHaveValue(
    "TabSpace",
  );
  await a.page
    .getByLabel("Nextcloud address", { exact: true })
    .fill("https://cloud.example.test");
  await a.page.getByLabel("Username", { exact: true }).fill("fixture");
  await expect(a.page.locator(".cloud-sync-location")).toContainText(
    "https://cloud.example.test/remote.php/dav/files/fixture/TabSpace/",
  );
  await expect(a.page.locator("#settings-sync")).not.toContainText("Preview");
  await expect(
    a.page.getByRole("heading", { name: "1. Server connection" }),
  ).toBeVisible();
  await expect(
    a.page.getByRole("heading", { name: "2. Sync encryption" }),
  ).toBeVisible();
  await a.page.setViewportSize({ width: 1280, height: 1700 });
  await a.page
    .locator("#settings-sync")
    .screenshot({ path: resolve(root, "artifacts/cloud-sync-setup.png") });
  await a.page.setViewportSize({ width: 1280, height: 900 });
  const passphrase = "fixture sync passphrase only";
  const configure = (client) =>
    client.rpc({
      type: "cloudSyncConfigure",
      url,
      username: "fixture",
      appPassword: "fixture-app-password",
      passphrase,
      automatic: false,
    });
  await configure(a);
  await configure(b);
  const space = entity("space", "Browser sync project");
  await a.rpc({
    type: "command",
    command: {
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "create",
      entity: space,
    },
  });
  await a.rpc({ type: "cloudSyncRun" });
  await b.rpc({ type: "cloudSyncRun" });
  const view = (client) =>
    client.rpc({ type: "view", force: false, recovery: false });
  assert((await view(b)).entities.some((e) => e.id === space.id));
  assert(
    !files
      .get("/TabSpace/manifest.json")
      .bytes.toString()
      .includes("Browser sync project"),
  );
  for (const [client, name] of [
    [a, "Changed on A"],
    [b, "Changed on B"],
  ]) {
    const current = (await view(client)).entities.find(
      (e) => e.id === space.id,
    );
    await client.rpc({
      type: "command",
      command: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "update",
        id: space.id,
        expectedRevision: current.revision,
        patch: { name },
      },
    });
  }
  await a.rpc({ type: "cloudSyncRun" });
  await b.page.getByRole("button", { name: "Settings", exact: true }).click();
  await b.page.getByRole("button", { name: "Sync now", exact: true }).click();
  await b.page
    .getByRole("heading", { name: "Review conflicting versions" })
    .waitFor();
  await b.page.getByLabel("Version to keep").selectOption("both");
  await b.page
    .getByRole("button", { name: "Sync with these choices", exact: true })
    .click();
  await expect(
    b.page.getByRole("heading", { name: "Review conflicting versions" }),
  ).toHaveCount(0);
  await a.rpc({ type: "cloudSyncRun" });
  assert(
    (await view(a)).entities.some(
      (e) => e.name === "Changed on B (Conflict copy)",
    ),
  );
  const status = await b.rpc({ type: "cloudSyncStatus" });
  assert(!JSON.stringify(status).includes(passphrase));
  assert(!JSON.stringify(status).includes("fixture-app-password"));
  failNextManifestGet = true;
  await b.page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(b.page.getByRole("alert")).toContainText("503");
  // Success from another view/background operation must clear an older UI error.
  await b.rpc({ type: "cloudSyncRun" });
  await expect(b.page.getByRole("alert")).toHaveCount(0);
  await b.page
    .locator("#settings-sync")
    .screenshot({ path: resolve(root, "artifacts/cloud-sync-settings.png") });
  await b.context.close();
  const restarted = await open(profiles[1]);
  assert.equal(
    (await restarted.rpc({ type: "cloudSyncStatus" })).unlocked,
    false,
  );
  const before = requests;
  await assert.rejects(
    restarted.rpc({ type: "cloudSyncRun" }),
    /Unlock cloud sync/,
  );
  assert.equal(requests, before);
  await restarted.rpc({ type: "cloudSyncUnlock", passphrase });
  await restarted.rpc({ type: "cloudSyncRun" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS two isolated Chromium profiles: encrypted WebDAV round trip, stable IDs, conflict UI/keep-both, secret-free status, locked restart and manual unlock",
  );
} finally {
  for (const context of contexts) await context.close().catch(() => undefined);
  await new Promise((r) => server.close(r));
}
