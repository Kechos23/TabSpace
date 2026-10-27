// Diagnostic build only: production sources, dist and the personal Chrome profile are untouched.
import { build as bundle } from "esbuild";
import { build as viteBuild } from "vite";
import { parseAst } from "rolldown/parseAst";
import { resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { APP_VERSION } from "../packages/domain/version.ts";

const root = resolve(import.meta.dirname, "..");
const controls = process.argv.includes("--controls");
const stamp = Date.now(),
  output = resolve(root, `artifacts/ui-audit-${stamp}`);
await mkdir(output, { recursive: true });
const extension = resolve(output, "extension");
await cp(resolve(root, "dist/core"), extension, { recursive: true });
const selected = {
  "browser.ts": ["live", "reconcile", "saveBindings"],
  "sessions.ts": ["syncSessions", "capture", "activateSession"],
  "repository.ts": ["list", "execute", "snapshot", "pruneSnapshots"],
  "index.ts": ["update", "search"],
  "App.tsx": ["App"],
};
function instrument(source, id) {
  const file = basename(id.split("?")[0]),
    names = selected[file];
  if (
    !names ||
    (!id.replaceAll("\\", "/").includes("/src/") &&
      !id.replaceAll("\\", "/").includes("/packages/"))
  )
    return source;
  const ast = parseAst(
    source,
    { lang: file.endsWith("tsx") ? "tsx" : "ts" },
    id,
  );
  const patches = [];
  function visit(node) {
    const name =
      node.type === "MethodDefinition" ? node.key?.name : node.id?.name;
    const fn = node.type === "MethodDefinition" ? node.value : node;
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "MethodDefinition") &&
      fn.body &&
      names.includes(name)
    ) {
      const asynchronous = fn.async;
      const label = JSON.stringify(
        `${file}:${name === "reconcile" ? "reconcile-dispatch" : name}`,
      );
      const start = fn.body.start + 1,
        end = fn.body.end - 1;
      const body = source.slice(start, end);
      patches.push({
        start,
        end,
        replacement: `const __auditStart = performance.now(); try { ${asynchronous ? `return await (async () => {${body}})();` : body} } finally { const events = globalThis.__tabspacePerf ??= []; if(events.length < 30000) events.push({name:${label}, ms:performance.now()-__auditStart, at:performance.timeOrigin+__auditStart}); }`,
      });
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        value.forEach((child) => {
          if (child?.type) visit(child);
        });
      else if (value?.type) visit(value);
    }
  }
  visit(ast);
  for (const patch of patches.sort((a, b) => b.start - a.start))
    source =
      source.slice(0, patch.start) +
      patch.replacement +
      source.slice(patch.end);
  return source;
}
await viteBuild({
  configFile: resolve(root, "vite.config.ts"),
  logLevel: "error",
  build: { outDir: extension },
  plugins: [
    {
      name: "local-ui-audit",
      enforce: "pre",
      transform(source, id) {
        return instrument(source, id);
      },
    },
  ],
});
await bundle({
  entryPoints: [resolve(root, "apps/extension/src/background/worker.ts")],
  outfile: resolve(extension, "worker.js"),
  bundle: true,
  format: "esm",
  target: "chrome116",
  minify: true,
  plugins: [
    {
      name: "local-worker-audit",
      setup(build) {
        build.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
          if (!path.startsWith(root) || path.includes("node_modules")) return;
          let contents = instrument(await readFile(path, "utf8"), path);
          if (path.endsWith("worker.ts")) {
            contents = contents.replace(
              "const result = effects.then(job, job);",
              `const queuedAt=performance.now(); const measured=()=>{ const events=globalThis.__tabspacePerf ??= []; if(events.length<30000) events.push({name:"worker:queueWait",ms:performance.now()-queuedAt,at:performance.timeOrigin+queuedAt}); return job(); }; const result = effects.then(measured, measured);`,
            );
            contents = contents.replace(
              'const browser = await reconcile("view refresh");',
              'const auditLoadStarted=performance.now(); const browser = await reconcile("view refresh"); (globalThis.__tabspacePerf ??= []).push({name:"worker:load-reconcile",ms:performance.now()-auditLoadStarted,at:performance.timeOrigin+auditLoadStarted});',
            );
          }
          return { contents, loader: "ts" };
        });
      },
    },
  ],
});
await bundle({
  stdin: {
    contents:
      "export {entity,defaults,blankDoc} from './packages/domain/model.ts';",
    resolveDir: root,
  },
  outfile: resolve(output, "model.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
});
const { entity, defaults, blankDoc } = await import(
  pathToFileURL(resolve(output, "model.mjs"))
);
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const context = await chromium.launchPersistentContext(
  resolve(output, "profile"),
  {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  },
);
const result = {
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  sourceDirty: !!execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  date: new Date().toISOString(),
  kind: controls ? "controlled-comparisons" : "after-performance-improvements",
  version: JSON.parse(
    await readFile(resolve(extension, "manifest.json"), "utf8"),
  ).version,
  hardware: {
    cpu: cpus()[0].model,
    cores: cpus().length,
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
  },
  browser: context.browser()?.version(),
  method:
    "Instrumented copy of the current production extension; async method wall times overlap/nest and must not be added together. No personal profile or production files changed.",
  timingDefinitions: {
    operations:
      "view:* measures click to selected view plus two animation frames, before waiting for persistence; settledMs additionally includes the ACK wait and trace collection overhead. Other UI operations wait for Saved locally. Small samples, including automation overhead, are descriptive rather than latency guarantees.",
    fullLoad:
      "full-load operation.ms also includes transporting the returned state to the Node runner. Use trace.ui.rpc load times for Chrome-message latency, not full-load operation.ms.",
    reconcileDispatch:
      "browser.ts:reconcile-dispatch measures synchronous dispatch only, not asynchronous reconciliation. worker:load-reconcile measures the awaited load reconciliation in control runs.",
    controls:
      "Without-history clears synthetic snapshots only; empty-current relocates synthetic resources/notes/tasks to another Space; two-views explicitly overlaps a second manager load. The first empty-current sample also includes reindexing after the mass fixture relocation.",
  },
  cases: [],
};
const stats = (values) => {
  const a = [...values].sort((a, b) => a - b);
  return {
    n: a.length,
    medianMs: +a[Math.floor(a.length / 2)].toFixed(2),
    p95Ms: +a[Math.min(a.length - 1, Math.floor(a.length * 0.95))].toFixed(2),
    maxMs: +a.at(-1).toFixed(2),
  };
};
try {
  await context.route("https://audit.test/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Audit page</title><p>Offline performance fixture</p>",
    }),
  );
  await context.addInitScript(() => {
    globalThis.__rpc = [];
    globalThis.__longTasks = [];
    new PerformanceObserver((list) =>
      globalThis.__longTasks.push(
        ...list.getEntries().map((e) => ({
          ms: e.duration,
          at: performance.timeOrigin + e.startTime,
        })),
      ),
    ).observe({ entryTypes: ["longtask"] });
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...rest) => {
      const at = performance.now();
      const promise = original(message, ...rest);
      if (!promise?.then) return promise;
      return promise.then((response) => {
        globalThis.__rpc.push({
          type: message.type,
          action: message.action,
          command: message.command?.type,
          ms: performance.now() - at,
          at: performance.timeOrigin + at,
        });
        return response;
      });
    };
  });
  let worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const base = `chrome-extension://${worker.url().split("/")[2]}`;
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/index.html`);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const rpc = async (message) => {
    const r = await page.evaluate(
      (m) => chrome.runtime.sendMessage(m),
      message,
    );
    assert(r.ok, r.error);
    return r.value;
  };
  const spaces = Array.from({ length: 100 }, (_, i) =>
    entity("space", `Audit project ${i}`, { view: "tabs" }),
  );
  const reset = async () => {
    await page.evaluate(() => {
      globalThis.__tabspacePerf = [];
      globalThis.__rpc = [];
      globalThis.__longTasks = [];
    });
    await worker.evaluate(() => (globalThis.__tabspacePerf = []));
  };
  const capture = async () => ({
    ui: await page.evaluate(() => ({
      methods: globalThis.__tabspacePerf ?? [],
      rpc: globalThis.__rpc,
      longTasks: globalThis.__longTasks,
    })),
    worker: await worker.evaluate(() => globalThis.__tabspacePerf ?? []),
  });
  const measure = async (name, work) => {
    await reset();
    const started = performance.now();
    await work();
    const ms = performance.now() - started;
    const trace = await capture();
    return { name, ms: +ms.toFixed(2), trace };
  };
  const settle = () =>
    page.locator(".save-status").filter({ hasText: "Saved locally" }).waitFor();
  const switchView = async (target) => {
    const label = target[0].toUpperCase() + target.slice(1);
    await page
      .locator(".view-nav")
      .getByRole("button", { name: new RegExp(`${label}$`) })
      .click();
    await page.waitForFunction(
      (t) =>
        document
          .querySelector(".view-nav button.active")
          ?.textContent.trim()
          .endsWith(t),
      label,
    );
    await settle();
  };
  let opened = 0;
  for (const fixture of [
    {
      name: "small",
      spaces: 3,
      resources: 100,
      notes: 20,
      tasks: 30,
      tabs: 8,
      snapshots: 0,
    },
    {
      name: "medium",
      spaces: 20,
      resources: 2000,
      notes: 200,
      tasks: 500,
      tabs: 60,
      snapshots: 50,
    },
    {
      name: "large",
      spaces: 100,
      resources: 10000,
      notes: 1000,
      tasks: 5000,
      tabs: 180,
      snapshots: 200,
    },
  ]) {
    if (controls && fixture.name !== "large") continue;
    console.log(
      `Preparing ${fixture.name}: ${fixture.tabs} live tabs, ${fixture.resources + fixture.notes + fixture.tasks} content records`,
    );
    const rows = spaces.slice(0, fixture.spaces);
    for (const [kind, count] of [
      ["resource", fixture.resources],
      ["note", fixture.notes],
      ["task", fixture.tasks],
    ])
      for (let i = 0; i < count; i++)
        rows.push(
          entity(kind, `${kind} ${i} audit`, {
            spaceId: spaces[0].id,
            url:
              kind === "resource" ? `https://audit.test/item/${i}` : undefined,
            doc: kind === "note" ? blankDoc() : undefined,
            description: `Local audit record ${i}`,
          }),
        );
    const snapshots = Array.from({ length: fixture.snapshots }, (_, i) => ({
      id: crypto.randomUUID(),
      capturedAt: new Date(Date.now() - i * 1000).toISOString(),
      reason: "Synthetic audit history",
      protected: true,
      tabs: Array.from({ length: fixture.tabs }, (_, n) => ({
        url: `https://audit.test/old/${n}`,
        title: `Historical tab ${n}`,
        pinned: false,
        active: n === 0,
        muted: false,
      })),
      groups: [],
    }));
    await page.evaluate(
      async (data) => {
        const request = indexedDB.open("TabSpace-v1");
        const db = await new Promise((res, rej) => {
          request.onsuccess = () => res(request.result);
          request.onerror = () => rej(request.error);
        });
        await new Promise((res, rej) => {
          const tx = db.transaction(
            ["entities", "snapshots", "meta"],
            "readwrite",
          );
          for (const name of ["entities", "snapshots"])
            tx.objectStore(name).clear();
          for (const row of data.rows) tx.objectStore("entities").put(row);
          for (const row of data.snapshots)
            tx.objectStore("snapshots").put(row);
          tx.objectStore("meta").put({ id: "inbox", value: data.inbox });
          tx.objectStore("meta").put({ id: "settings", value: data.settings });
          tx.objectStore("meta").put({
            id: "collectionGeneration",
            value: crypto.randomUUID(),
          });
          tx.objectStore("meta").put({
            id: "indexRevision",
            value: crypto.randomUUID(),
          });
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        });
        db.close();
      },
      {
        rows,
        snapshots,
        inbox: spaces[0].id,
        settings: { ...defaults, pinManager: false },
      },
    );
    await page.goto(`${base}/index.html?space=${spaces[0].id}`);
    await page
      .getByRole("heading", { name: spaces[0].name, exact: true, level: 1 })
      .waitFor();
    if (opened === 0)
      await rpc({
        type: "browser",
        commandId: crypto.randomUUID(),
        action: "activateSession",
        payload: { spaceId: spaces[0].id },
      });
    await worker.evaluate(
      async ({ from, to }) => {
        for (let i = from; i < to; i++)
          await chrome.tabs.create({
            url: `https://audit.test/tab/${i}`,
            active: false,
          });
      },
      { from: opened, to: fixture.tabs },
    );
    opened = fixture.tabs;
    await rpc({ type: "load" });
    await settle();
    const operations = [];
    for (let sample = 0; sample < 3; sample++)
      operations.push(await measure("full-load", () => rpc({ type: "load" })));
    const state = await rpc({ type: "load" });
    const payloadBytes = Buffer.byteLength(JSON.stringify(state));
    const lightweight = await rpc({
      type: "view",
      recovery: false,
      force: false,
    });
    const lightweightBytes = Buffer.byteLength(JSON.stringify(lightweight));
    operations.push(
      await measure("view:unchanged-read", () =>
        rpc({
          type: "view",
          recovery: false,
          force: false,
          knownVersion: lightweight.viewVersion,
        }),
      ),
    );
    for (const target of [
      "resources",
      "tasks",
      "tabs",
      "notes",
      "resources",
      "tabs",
    ]) {
      const clickStarted = performance.now();
      operations.push(
        await measure(`view:${target}`, async () => {
          await page
            .locator(".view-nav")
            .getByRole("button", {
              name: new RegExp(`${target[0].toUpperCase() + target.slice(1)}$`),
            })
            .click();
          await page.waitForFunction(
            (t) =>
              document
                .querySelector(".view-nav button.active")
                ?.textContent.trim()
                .endsWith(t),
            target[0].toUpperCase() + target.slice(1),
          );
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
        }),
      );
      console.log(
        `${fixture.name} ${operations.at(-1).name}: ${operations.at(-1).ms}ms`,
      );
      await settle();
      operations.at(-1).settledMs = +(performance.now() - clickStarted).toFixed(
        2,
      );
    }
    if (controls) {
      await page.evaluate(async () => {
        const r = indexedDB.open("TabSpace-v1");
        const db = await new Promise(
          (res) => (r.onsuccess = () => res(r.result)),
        );
        await new Promise((res, rej) => {
          const tx = db.transaction("snapshots", "readwrite");
          tx.objectStore("snapshots").clear();
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        });
        db.close();
      });
      await rpc({ type: "load" });
      await settle();
      for (const target of ["resources", "tasks", "tabs"]) {
        const measurement = await measure(`without-history:${target}`, () =>
          switchView(target),
        );
        operations.push(measurement);
        console.log(`${measurement.name}: ${measurement.ms}ms`);
      }
      await page.evaluate(async (destination) => {
        const r = indexedDB.open("TabSpace-v1");
        const db = await new Promise(
          (res) => (r.onsuccess = () => res(r.result)),
        );
        await new Promise((res, rej) => {
          const tx = db.transaction("entities", "readwrite");
          const store = tx.objectStore("entities");
          const all = store.getAll();
          all.onsuccess = () => {
            for (const row of all.result)
              if (["resource", "note", "task"].includes(row.kind))
                store.put({ ...row, spaceId: destination });
          };
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        });
        db.close();
      }, spaces[1].id);
      await rpc({ type: "load" });
      await page.getByRole("button", { name: "Refresh browser state" }).click();
      await settle();
      for (const target of ["resources", "notes", "tasks"]) {
        const measurement = await measure(`empty-current:${target}`, () =>
          switchView(target),
        );
        operations.push(measurement);
        console.log(`${measurement.name}: ${measurement.ms}ms`);
      }
      const other = await context.newPage();
      await other.goto(`${base}/index.html`);
      await other
        .getByRole("heading", { name: "Home", exact: true })
        .waitFor({ timeout: 120000 });
      for (const target of ["resources", "tasks", "tabs"]) {
        const parallel = other.evaluate(async () => {
          const response = await chrome.runtime.sendMessage({ type: "load" });
          return response.ok;
        });
        const measurement = await measure(`two-views:${target}`, () =>
          switchView(target),
        );
        operations.push(measurement);
        await parallel;
        console.log(`${measurement.name}: ${measurement.ms}ms`);
      }
      await other.close();
    }
    operations.push(
      await measure("home", async () => {
        await page
          .getByRole("button", { name: "Back to Home", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Home", exact: true })
          .waitFor();
      }),
    );
    operations.push(
      await measure("space:already-active", async () => {
        await page
          .getByRole("button", {
            name: `Open Space ${spaces[0].name}`,
            exact: true,
          })
          .click();
        await page
          .getByRole("heading", { name: spaces[0].name, exact: true, level: 1 })
          .waitFor();
        await settle();
      }),
    );
    operations.push(
      await measure("theme", async () => {
        await page
          .getByRole("button", { name: "Toggle light/dark theme" })
          .click();
        await settle();
      }),
    );
    operations.push(
      await measure("search:open", async () => {
        await page.keyboard.press("Control+k");
        await page.getByRole("dialog").waitFor();
        await page.locator("dialog .search-result").first().waitFor();
      }),
    );
    for (let sample = 0; sample < 3; sample++)
      operations.push(
        await measure("search", async () => {
          await page
            .getByRole("textbox", { name: "Search local collection" })
            .fill(`resource ${fixture.resources - 1 - sample}`);
          await page.locator("dialog .search-result").first().waitFor();
        }),
      );
    await page.keyboard.press("Escape");
    for (let sample = 0; sample < 3; sample++)
      operations.push(
        await measure("durable-command", async () => {
          const current = await page.evaluate(async (id) => {
            const r = indexedDB.open("TabSpace-v1");
            const db = await new Promise(
              (res) => (r.onsuccess = () => res(r.result)),
            );
            const row = await new Promise((res) => {
              const q = db
                .transaction("entities")
                .objectStore("entities")
                .get(id);
              q.onsuccess = () => res(q.result);
            });
            db.close();
            return row;
          }, spaces[0].id);
          await rpc({
            type: "command",
            command: {
              schemaVersion: 1,
              commandId: crypto.randomUUID(),
              type: "update",
              id: current.id,
              expectedRevision: current.revision,
              patch: { description: `Measured save ${sample}` },
            },
          });
        }),
      );
    const summaries = {};
    for (const name of new Set(operations.map((o) => o.name)))
      summaries[name] = stats(
        operations.filter((o) => o.name === name).map((o) => o.ms),
      );
    const methods = operations.flatMap((o) => [
      ...o.trace.ui.methods,
      ...o.trace.worker,
    ]);
    const methodsSummary = {};
    for (const name of new Set(methods.map((e) => e.name)))
      methodsSummary[name] = stats(
        methods.filter((e) => e.name === name).map((e) => e.ms),
      );
    result.cases.push({
      fixture,
      nativeLoadMessageSummary: stats(
        operations
          .filter((o) => o.name === "full-load")
          .flatMap((o) =>
            o.trace.ui.rpc
              .filter((message) => message.type === "load")
              .map((message) => message.ms),
          ),
      ),
      actual: {
        entities: state.entities.length,
        snapshots: state.snapshots.length,
        payloadMiB: +(payloadBytes / 1024 ** 2).toFixed(2),
        lightweightPayloadMiB: +(lightweightBytes / 1024 ** 2).toFixed(2),
        lightweightSnapshots: lightweight.snapshots.length,
        lightweightSnapshotCount: lightweight.snapshotCount,
      },
      summaries,
      methodsSummary,
      operations,
    });
    await writeFile(
      resolve(output, "progress.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(
      JSON.stringify({ case: fixture.name, summaries, methodsSummary }),
    );
  }
  assert.deepEqual(errors, []);
  result.pageErrors = errors;
  await writeFile(
    resolve(
      root,
      controls
        ? `docs/VALIDATION_UI_PERFORMANCE_CONTROLS_${APP_VERSION}.json`
        : `docs/VALIDATION_UI_PERFORMANCE_${APP_VERSION}.json`,
    ),
    JSON.stringify(result, null, 2),
  );
  console.log(`Audit complete; raw data and isolated build: ${output}`);
} finally {
  await context.close();
}
