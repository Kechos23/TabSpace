import "./development-maintenance.mjs";
import { build as viteBuild } from "vite";
import { build as bundle } from "esbuild";
import { mkdir, readFile, writeFile, cp, access } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { generateKeyPairSync, createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { APP_VERSION } from "../packages/domain/version.ts";
import {
  savedSpaceIconPath,
  spaceIconColors,
} from "../packages/domain/manager-icons.ts";
import { spaceIconPixels } from "./space-icon-pixels.mjs";
import {
  themeIconColors,
  themeIconPath,
} from "../packages/domain/theme-icons.ts";
const root = resolve(import.meta.dirname, "..");
const own = (path) => {
  const full = resolve(root, path);
  if (relative(root, full).startsWith(".."))
    throw Error("Output must stay in repository.");
  return full;
};
await mkdir(own("apps/extension/manifest"), { recursive: true });
const keyPath = own("apps/extension/manifest/public-key.json");
let key;
try {
  key = JSON.parse(await readFile(keyPath, "utf8")).key;
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  key = pair.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  await writeFile(keyPath, JSON.stringify({ key }, null, 2));
}
const standaloneKey = JSON.parse(
  await readFile(own("apps/drag-group/public-key.json"), "utf8"),
).key;
const standaloneId = [
  ...createHash("sha256")
    .update(Buffer.from(standaloneKey, "base64"))
    .digest()
    .subarray(0, 16),
]
  .flatMap((b) => [b >> 4, b & 15])
  .map((n) => String.fromCharCode(97 + n))
  .join("");
const manifest = {
  manifest_version: 3,
  name: "TabSpace",
  version: APP_VERSION,
  minimum_chrome_version: "116",
  description: "Local-first Spaces for your tabs, links, notes and tasks.",
  key,
  incognito: "not_allowed",
  permissions: [
    "tabs",
    "favicon",
    "tabGroups",
    "storage",
    "unlimitedStorage",
    "alarms",
    "contextMenus",
    "sidePanel",
  ],
  optional_permissions: ["nativeMessaging"],
  // Explicitly approved on 2026-10-25. Declares eligibility only; the UI requests
  // one chosen server at runtime. No host access is granted at installation.
  optional_host_permissions: ["https://*/*"],
  background: { service_worker: "worker.js", type: "module" },
  action: { default_popup: "popup.html", default_title: "TabSpace" },
  side_panel: { default_path: "sidepanel.html" },
  icons: {
    16: "icons/icon16.png",
    32: "icons/icon32.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png",
  },
  commands: {
    "open-manager": {
      suggested_key: { default: "Ctrl+Shift+Y" },
      description: "Open TabSpace manager",
    },
    "save-tab": { description: "Save current tab to Inbox" },
  },
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'",
  },
};
const built = await viteBuild({ configFile: own("vite.config.ts") });
const buildFiles = (Array.isArray(built) ? built : [built]).flatMap((result) =>
  result.output.map((file) => file.fileName),
);
await bundle({
  entryPoints: [own("apps/extension/src/background/worker.ts")],
  outfile: own("dist/core/worker.js"),
  bundle: true,
  format: "esm",
  target: "chrome116",
  minify: true,
  define: { __DRAG_GROUP_STANDALONE_ID__: JSON.stringify(standaloneId) },
});
const dragFiles = [
  "manager.js",
  "controller.html",
  "controller.js",
  "runtime.js",
  "policy.js",
  "grouping.js",
  "style.css",
  "fixture.html",
  "fixture.js",
];
await bundle({
  entryPoints: [own("apps/extension/src/manager-icon.ts")],
  outfile: own("dist/core/manager-icon.js"),
  bundle: true,
  format: "esm",
  target: "chrome116",
  minify: true,
});
buildFiles.push("manager-icon.js");
await mkdir(own("dist/core/drag-group"), { recursive: true });
for (const name of dragFiles)
  await cp(
    own(
      name === "manager.js"
        ? "apps/extension/manager-drag.js"
        : "apps/drag-group/extension/" + name,
    ),
    own("dist/core/drag-group/" + name),
  );
await writeFile(
  own("dist/core/drag-group/config.js"),
  "export const dragConfig = " +
    JSON.stringify({
      integrated: true,
      expectedHelperBuild: "0.1.21",
      preferenceKey: "dragGroupEnabled",
      messagePrefix: "dragGroup:",
    }) +
    ";",
);
await writeFile(
  own("dist/core/index.html"),
  (await readFile(own("dist/core/index.html"), "utf8"))
    .replace(
      "</body>",
      '<script type="module" async src="./drag-group/manager.js"></script></body>',
    )
    .replace(
      "</head>",
      '<script type="module" async src="./manager-icon.js"></script></head>',
    ),
);
function crc32(b) {
  let crc = -1;
  for (const c of b) {
    crc ^= c;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type),
    len = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function icon(size, color = "#28796c", pixels) {
  const rgb = color.match(/[a-f0-9]{2}/gi).map((hex) => parseInt(hex, 16));
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = y * (size * 4 + 1) + 1 + x * 4;
      const nx = (x / size) * 40,
        ny = (y / size) * 40;
      const rect = (a, b, w, h) =>
        nx >= a && nx < a + w && ny >= b && ny < b + h;
      const inside = rect(2, 2, 36, 36);
      const glyph =
        rect(12, 12, 16, 5) || rect(12, 21, 7, 7) || rect(24, 21, 4, 7);
      raw[k] = glyph ? 255 : rgb[0];
      raw[k + 1] = glyph ? 255 : rgb[1];
      raw[k + 2] = glyph ? 255 : rgb[2];
      raw[k + 3] = inside ? 255 : 0;
      if (pixels)
        raw.set(pixels.subarray((y * size + x) * 4, (y * size + x + 1) * 4), k);
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size);
  head.writeUInt32BE(size, 4);
  head[8] = 8;
  head[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
await mkdir(own("dist/core/icons"), { recursive: true });
for (const s of [16, 32, 48, 128])
  await writeFile(own(`dist/core/icons/icon${s}.png`), icon(s));
const themedIcons = [];
for (const [theme, color] of Object.entries(themeIconColors)) {
  await mkdir(own(`dist/core/icons/${theme}`), { recursive: true });
  for (const size of [16, 24, 32, 48]) {
    const path = themeIconPath(theme, size);
    await writeFile(own(`dist/core/${path}`), icon(size, color));
    themedIcons.push(path);
  }
}
for (const [color, fill] of Object.entries(spaceIconColors)) {
  for (const appearance of ["light", "dark"]) {
    await mkdir(own(`dist/core/icons/spaces/${color}/${appearance}`), {
      recursive: true,
    });
    for (const size of [16, 32]) {
      const path = savedSpaceIconPath(color, appearance, size);
      await writeFile(
        own(`dist/core/${path}`),
        icon(size, fill, spaceIconPixels(size, fill, appearance)),
      );
      themedIcons.push(path);
    }
  }
}
await writeFile(
  own("dist/core/manifest.json"),
  JSON.stringify(manifest, null, 2),
);
await writeFile(
  own("dist/core/build-files.json"),
  JSON.stringify(
    [
      ...new Set([
        ...buildFiles,
        "worker.js",
        "manifest.json",
        ...Object.values(manifest.icons),
        ...themedIcons,
        ...[...dragFiles, "config.js"].map((n) => "drag-group/" + n),
      ]),
    ],
    null,
    2,
  ),
);
await cp(own("dist/core"), own("dist/newtab"), { recursive: true });
await writeFile(
  own("dist/newtab/manifest.json"),
  JSON.stringify(
    { ...manifest, chrome_url_overrides: { newtab: "newtab.html" } },
    null,
    2,
  ),
);
const id = [
  ...createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest()
    .subarray(0, 16),
]
  .map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15)))
  .join("");
await writeFile(
  own("dist/identity.json"),
  JSON.stringify(
    {
      extensionId: id,
      version: manifest.version,
      variants: ["core", "newtab"],
    },
    null,
    2,
  ),
);
console.log(`Built core and New Tab variants. Local identity: ${id}`);
