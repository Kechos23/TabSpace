import "./development-maintenance.mjs";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { entity, plainDoc } from "../packages/domain/model.ts";
import { APP_VERSION } from "../packages/domain/version.ts";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright"),
  { expect } = await import("@playwright/test");
const extension = resolve(
  process.env.TABSPACE_EXTENSION_DIR || resolve(root, "dist/core"),
);
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/tasks-profile-${Date.now()}`),
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
const results = [],
  errors = [];
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const origin = `chrome-extension://${worker.url().split("/")[2]}`;
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/index.html`);
  const rpc = async (message) => {
    const response = await page.evaluate(
      (m) => chrome.runtime.sendMessage(m),
      message,
    );
    assert(response?.ok, response?.error);
    return response.value;
  };
  const load = () => rpc({ type: "load" });
  const read = async (name) =>
    (await load()).entities.find(
      (item) => item.name === name && !item.deletedAt,
    );
  const alpha = entity("space", "Alpha project", { view: "tasks" }),
    beta = entity("space", "Beta project", { view: "tabs" });
  const preparation = entity("section", "Preparation", {
    spaceId: alpha.id,
    sectionKind: "tasks",
  });
  const legacy = entity("task", "Existing task", {
    spaceId: alpha.id,
    sectionId: preparation.id,
    description: "Preserved legacy description",
    doc: plainDoc("Preserved legacy description"),
    priority: "high",
    starred: true,
  });
  const completed = entity("task", "Already done", {
    spaceId: alpha.id,
    completedAt: new Date().toISOString(),
  });
  const betaTask = entity("task", "Beta action", { spaceId: beta.id });
  const savedTab = entity("savedTab", "Saved Beta website", {
    spaceId: beta.id,
    url: "https://tasks.test/should-not-open",
  });
  for (const row of [
    alpha,
    beta,
    preparation,
    legacy,
    completed,
    betaTask,
    savedTab,
  ])
    await rpc({
      type: "command",
      command: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        type: "create",
        entity: row,
      },
    });
  await page.goto(`${origin}/index.html?space=${alpha.id}`);
  const workspace = page.locator(".tasks-workspace"),
    row = (name) =>
      workspace
        .locator(".checklist-task")
        .filter({
          has: page.getByRole("textbox", {
            name: `Task title: ${name}`,
            exact: true,
          }),
        });
  await expect(row("Existing task")).toBeVisible();
  assert.equal(await row("Existing task").getByRole("checkbox").count(), 1);
  assert.equal(
    await workspace.getByRole("checkbox", { name: /^Select / }).count(),
    0,
  );
  await expect(
    workspace.getByRole("button", { name: /^Completed/ }),
  ).toBeVisible();
  assert.equal(await row("Already done").count(), 0);
  results.push(
    "Space tasks are visible checklist sections with one completion checkbox per row; existing completed tasks start collapsed and legacy metadata remains stored",
  );
  const add = workspace.getByRole("textbox", {
    name: "Add task to Tasks",
    exact: true,
  });
  await add.fill("Inline one");
  await add.press("Enter");
  await expect(row("Inline one")).toBeVisible();
  await expect(add).toBeFocused();
  await add.fill("Inline two");
  await add.press("Enter");
  await expect(row("Inline two")).toBeVisible();
  const title = row("Inline one").getByRole("textbox");
  await title.fill("Renamed inline");
  await title.press("Enter");
  await expect(row("Renamed inline")).toBeVisible();
  const renamed = row("Renamed inline").getByRole("textbox");
  await renamed.fill("Cancelled rename");
  await renamed.press("Escape");
  await expect(renamed).toHaveValue("Renamed inline");
  assert(!(await read("Cancelled rename")));
  results.push(
    "Enter adds consecutive tasks and retains input focus; inline rename saves without a dialog and Escape cancels edits",
  );
  await row("Existing task")
    .getByRole("button", { name: "Details for Existing task", exact: true })
    .click();
  const editor = page.getByRole("textbox", {
    name: "Existing task content",
    exact: true,
  });
  await expect(editor).toContainText("Preserved legacy description");
  await workspace
    .getByLabel("Due date for Existing task", { exact: true })
    .fill("2031-05-20");
  await expect
    .poll(async () => (await read("Existing task"))?.dueDate)
    .toBe("2031-05-20");
  await workspace
    .getByLabel("Attach file to task Existing task", { exact: true })
    .setInputFiles({
      name: "task-evidence.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Task evidence"),
    });
  await expect(
    workspace.getByRole("button", {
      name: "Download task-evidence.txt",
      exact: true,
    }),
  ).toBeVisible();
  await editor.fill("Updated task details — σημειώσεις");
  await expect
    .poll(async () => (await read("Existing task"))?.description)
    .toBe("Updated task details — σημειώσεις");
  const preserved = await read("Existing task");
  assert.equal(preserved.id, legacy.id);
  assert.equal(preserved.priority, "high");
  assert.equal(preserved.starred, true);
  assert.equal(preserved.attachmentIds.length, 1);
  await workspace
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await row("Existing task")
    .getByRole("checkbox", { name: "Complete Existing task", exact: true })
    .check();
  await expect(row("Existing task")).toHaveCount(0);
  await workspace.getByRole("button", { name: /^Completed/ }).click();
  await row("Existing task")
    .getByRole("checkbox", { name: "Complete Existing task", exact: true })
    .uncheck();
  await expect(
    workspace
      .locator(`[data-task-section="${preparation.id}"]`)
      .getByRole("textbox", { name: "Task title: Existing task", exact: true }),
  ).toBeVisible();
  results.push(
    "Details preserve the same task ID, rich description, stars/priority and attachments; due date and description autosave; completion moves to Completed and undo restores the original section",
  );
  await workspace
    .getByRole("button", { name: "Tasks options", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Add section", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Build");
  await page
    .getByRole("button", { name: "Create section", exact: true })
    .click();
  const build = workspace.getByRole("region", { name: "Build", exact: true });
  await build
    .getByRole("textbox", { name: "Add task to Build", exact: true })
    .fill("Build one");
  await build
    .getByRole("textbox", { name: "Add task to Build", exact: true })
    .press("Enter");
  await expect(row("Build one")).toBeVisible();
  await row("Renamed inline").dragTo(
    build.getByRole("heading", { name: "Build", exact: true }),
    { sourcePosition: { x: 3, y: 3 } },
  );
  const buildEntity = await read("Build");
  await expect
    .poll(async () => (await read("Renamed inline"))?.sectionId)
    .toBe(buildEntity.id);
  await row("Inline two").dragTo(row("Build one"), {
    sourcePosition: { x: 3, y: 3 },
    targetPosition: { x: 3, y: 3 },
  });
  await expect
    .poll(async () => (await read("Inline two"))?.sectionId)
    .toBe(buildEntity.id);
  assert((await read("Inline two")).order < (await read("Build one")).order);
  results.push(
    "Sections can be created inline; native drag moves tasks into another section and inserts before a chosen task while retaining IDs",
  );
  const overview = async () => {
    await page.getByRole("button", { name: /My Tasks/ }).click();
    await expect(
      page.getByRole("heading", { name: "My Tasks", exact: true }),
    ).toBeVisible();
  };
  await overview();
  await expect(
    workspace.locator(`[data-task-space="${alpha.id}"]`),
  ).toBeVisible();
  await expect(
    workspace.locator(`[data-task-space="${beta.id}"]`),
  ).toBeVisible();
  for (const taskRow of await workspace.locator(".checklist-task").all())
    assert.equal(await taskRow.getByRole("checkbox").count(), 1);
  assert.equal(
    await workspace
      .getByRole("combobox", { name: "Task filter", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await workspace
      .getByLabel("Space for new task", { exact: true })
      .inputValue(),
    (await load()).inboxId,
  );
  await workspace
    .getByLabel("Space for new task", { exact: true })
    .selectOption(beta.id);
  const globalAdd = workspace.getByRole("textbox", {
    name: "Add task from My Tasks",
    exact: true,
  });
  await globalAdd.fill("From overview");
  await globalAdd.press("Enter");
  await expect
    .poll(async () => (await read("From overview"))?.spaceId)
    .toBe(beta.id);
  await workspace
    .getByLabel("Filter tasks by Space", { exact: true })
    .selectOption(beta.id);
  await expect(
    workspace.locator(`[data-task-space="${alpha.id}"]`),
  ).toHaveCount(0);
  const beforeTabs = await worker.evaluate(async () =>
    (await chrome.tabs.query({})).map((tab) => tab.id).sort(),
  );
  await workspace
    .locator(".tasks-space-header")
    .getByRole("button", { name: "Beta project", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Main tasks pane", exact: true }),
  ).toBeVisible();
  assert.deepEqual(
    await worker.evaluate(async () =>
      (await chrome.tabs.query({})).map((tab) => tab.id).sort(),
    ),
    beforeTabs,
  );
  assert.equal((await read("Beta project")).view, "tasks");
  results.push(
    "My Tasks groups the same canonical tasks by Space, adds to the selected Space with Inbox default, filters by Space and opens a Space's Tasks view without activating its Chrome tabs",
  );
  await overview();
  await row("From overview").getByRole("checkbox").check();
  await expect(row("From overview")).toHaveCount(0);
  await workspace
    .getByRole("button", { name: "Completed", exact: true })
    .click();
  await expect(row("From overview")).toBeVisible();
  await row("From overview").getByRole("checkbox").uncheck();
  await expect(row("From overview")).toHaveCount(0);
  await workspace.getByRole("button", { name: "To do", exact: true }).click();
  await expect(row("From overview")).toBeVisible();
  await workspace
    .getByRole("button", { name: "Tasks options", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Select tasks", exact: true })
    .click();
  assert.equal(await row("From overview").getByRole("checkbox").count(), 1);
  assert.equal(
    await workspace.getByRole("checkbox", { name: /^Complete / }).count(),
    0,
  );
  await row("From overview")
    .getByRole("checkbox", { name: "Select From overview", exact: true })
    .check();
  await workspace.getByRole("button", { name: "Move", exact: true }).click();
  const move = page.getByRole("dialog", { name: "Move tasks", exact: true });
  await move
    .getByLabel("Destination Space", { exact: true })
    .selectOption(alpha.id);
  await move
    .getByLabel("Destination task section", { exact: true })
    .selectOption(buildEntity.id);
  await move.getByRole("button", { name: "Move", exact: true }).click();
  await expect
    .poll(async () => (await read("From overview"))?.sectionId)
    .toBe(buildEntity.id);
  await workspace
    .getByRole("button", { name: "Done selecting", exact: true })
    .click();
  await row("Beta action")
    .getByRole("button", { name: "Actions for task Beta action", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await expect(row("Beta action copy")).toBeVisible();
  await row("Beta action copy")
    .getByRole("button", {
      name: "Actions for task Beta action copy",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Move to Trash", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(row("Beta action copy")).toHaveCount(0);
  const trashed = (await load()).entities.find(
    (item) => item.name === "Beta action copy",
  );
  assert(trashed.deletedAt);
  assert(!(await read("Beta action")).deletedAt);
  results.push(
    "My Tasks completion updates the original record; explicit selection mode replaces completion with one selection checkbox; bulk move, Duplicate and recoverable Trash work",
  );
  const state = await load();
  await rpc({ type: "settings", value: { ...state.settings, theme: "dark" } });
  await page.reload();
  await overview();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: resolve(root, "artifacts/tasks-overview-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.goto(`${origin}/index.html?space=${alpha.id}`);
  await expect(row("Existing task")).toBeVisible();
  await page.screenshot({
    path: resolve(root, "artifacts/tasks-space-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  const afterReload = await read("Existing task");
  assert.equal(afterReload.id, legacy.id);
  assert.equal(afterReload.attachmentIds.length, 1);
  assert.equal(afterReload.description, "Updated task details — σημειώσεις");
  await rpc({
    type: "settings",
    value: { ...(await load()).settings, theme: "light", colorTheme: "purple" },
  });
  await page.reload();
  await expect(row("Existing task")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({
    path: resolve(root, "artifacts/tasks-space-light.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 420, height: 900 });
  assert(
    await workspace.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  );
  await page.screenshot({
    path: resolve(root, "artifacts/tasks-narrow.png"),
    fullPage: true,
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(root, "docs/VALIDATION_TASKS_WORKSPACE.json"),
    JSON.stringify(
      { version: APP_VERSION, extension, results, pageErrors: errors },
      null,
      2,
    ),
  );
  console.log(results.join("\n"));
} catch (error) {
  console.error("Page errors:", errors);
  throw error;
} finally {
  await context.close();
}
