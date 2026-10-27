import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { entity } from "../packages/domain/model.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const extension = resolve(root, "dist/core");
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/showcase-${Date.now()}`),
  {
    channel: "chromium",
    headless: true,
    colorScheme: "dark",
    viewport: { width: 1440, height: 1000 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  },
);
try {
  const demoTitles = [
    "Project documentation",
    "Release checklist",
    "API reference",
  ];
  await context.route("https://showcase.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<title>${demoTitles[Number(new URL(route.request().url()).pathname.split("/").at(-1))] || "Project reference"}</title><h1>Sample project</h1>`,
    }),
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const base = worker.url().replace("worker.js", "");
  const manager = await context.newPage();
  await manager.goto(base + "index.html");
  await manager.getByRole("heading", { name: "Home", exact: true }).waitFor();
  const rpc = (message) =>
    manager.evaluate(async (message) => {
      const result = await chrome.runtime.sendMessage(message);
      if (!result.ok) throw Error(result.error);
      return result.value;
    }, message);
  const initial = await rpc({ type: "load" });
  await rpc({
    type: "settings",
    value: {
      ...initial.settings,
      theme: "dark",
      colorTheme: "blue",
      preserveLiveTabs: false,
    },
  });
  const projects = entity("sidebar", "Projects", { order: 0 });
  const development = entity("space", "Development", {
    description: "Documentation, ideas and the next small step.",
    color: "blue",
    sidebarId: projects.id,
    order: 1,
  });
  const design = entity("space", "Design system", {
    description: "Components, visual references and interface notes.",
    color: "purple",
    sidebarId: projects.id,
    order: 2,
  });
  const reading = entity("space", "Reading list", {
    description: "Useful pages to return to when there is time.",
    color: "green",
    order: 3,
  });
  const records = [projects, design, reading];
  for (const [space, titles] of [
    [design, ["Typography guide", "Component library"]],
    [reading, ["A better browsing workflow", "Local-first software"]],
  ]) {
    titles.forEach((name, index) =>
      records.push(
        entity("savedTab", name, {
          spaceId: space.id,
          url: `https://showcase.test/${space.id}/${index}`,
          order: index,
        }),
      ),
    );
  }
  records.push(
    entity("task", "Collect interface feedback", {
      spaceId: design.id,
      order: 1,
    }),
  );
  for (const record of records)
    await rpc({
      type: "command",
      command: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: record,
      },
    });
  for (let index = 0; index < demoTitles.length; index++) {
    const demo = await context.newPage();
    await demo.goto(`https://showcase.test/demo/${index}`);
  }
  const windowId = await manager.evaluate(
    async () => (await chrome.tabs.getCurrent()).windowId,
  );
  await rpc({
    type: "browser",
    commandId: crypto.randomUUID(),
    action: "saveWindowSpace",
    payload: {
      spaceId: development.id,
      name: development.name,
      color: "blue",
      collectionId: projects.id,
      windowId,
      locked: false,
    },
  });
  await rpc({
    type: "command",
    command: {
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type: "create",
      entity: entity("task", "Review the next release", {
        spaceId: development.id,
        order: 0,
      }),
    },
  });
  await manager.bringToFront();
  await manager.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await manager
    .getByRole("button", { name: "View Space Development", exact: true })
    .first()
    .waitFor();
  await mkdir(resolve(root, "docs/images"), { recursive: true });
  await manager.screenshot({ path: resolve(root, "docs/images/overview.png") });
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 380, height: 900 });
  await panel.goto(base + "sidepanel.html");
  await panel.locator(".app.panel-tree").waitFor();
  const tree = panel.locator(`[data-space-id="${development.id}"]`).first();
  if (
    (await tree
      .getByRole("button", { name: "Tabs in Development", exact: true })
      .getAttribute("aria-expanded")) === "false"
  )
    await tree
      .getByRole("button", { name: "Tabs in Development", exact: true })
      .click();
  await tree
    .getByRole("button", { name: /Project documentation/ })
    .first()
    .waitFor();
  await panel.screenshot({ path: resolve(root, "docs/images/sidepanel.png") });
  const popup = await context.newPage();
  await popup.goto(base + "popup.html");
  await popup.getByRole("status").filter({ hasText: "Ready" }).waitFor();
  await popup
    .locator(".popup-shell")
    .screenshot({ path: resolve(root, "docs/images/popup.png") });
  console.log(
    "Captured current manager, panel and popup using isolated synthetic project data only.",
  );
} finally {
  await context.close();
}
