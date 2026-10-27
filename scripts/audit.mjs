import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { APP_VERSION } from "../packages/domain/version.ts";
const root = resolve(import.meta.dirname, "..");
for (const variant of ["core", "newtab"]) {
  const dir = resolve(root, "dist", variant),
    m = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8"));
  assert.equal(m.manifest_version, 3);
  assert.equal(m.version, APP_VERSION);
  assert.equal(m.incognito, "not_allowed");
  assert(!m.host_permissions?.length);
  assert.deepEqual(
    m.optional_host_permissions,
    ["https://*/*"],
    "HTTPS sync access remains optional and requested per selected server",
  );
  assert(!m.content_scripts?.length);
  assert(!m.externally_connectable);
  assert(m.optional_permissions.includes("nativeMessaging"));
  assert(!m.permissions.includes("history"));
  assert(!m.permissions.includes("scripting"));
  assert(!m.permissions.includes("downloads"));
  assert(m.permissions.includes("favicon"));
  assert(!m.content_security_policy.extension_pages.includes("unsafe-eval"));
  assert.equal(Boolean(m.chrome_url_overrides), variant === "newtab");
  const walk = async (p) => {
    for (const e of await readdir(p, { withFileTypes: true })) {
      const f = resolve(p, e.name);
      if (e.isDirectory()) await walk(f);
      else if (/\.(js|html|css)$/.test(f)) {
        const text = await readFile(f, "utf8");
        assert(!/<script[^>]+src=["']https?:/i.test(text));
        assert(!/@import\s+["']https?:/i.test(text));
        assert(!/\beval\s*\(/.test(text));
        assert(!/sourceMappingURL/.test(text));
      }
    }
  };
  await walk(dir);
  for (const icon of Object.values(m.icons))
    assert(
      (await readFile(resolve(dir, icon)))
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    );
}
console.log("Manifest, CSP, local code and PNG icon audit passed.");
