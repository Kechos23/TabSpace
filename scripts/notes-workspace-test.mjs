import { resolve } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/browsers");
const { chromium } = await import("playwright");
const extension = resolve(
  process.env.TABSPACE_EXTENSION_DIR || resolve(root, "dist/core"),
);
const context = await chromium.launchPersistentContext(
  resolve(root, `artifacts/notes-profile-${Date.now()}`),
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
const results = [];
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const api = async (m) => {
    const r = await page.evaluate((m) => chrome.runtime.sendMessage(m), m);
    assert(r?.ok, r?.error);
    return r.value;
  };
  const load = () => api({ type: "load" });
  const settle = async (check) => {
    for (let i = 0; i < 80; i++) {
      const s = await load();
      if (check(s)) return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("Notes did not save");
  };
  await page.goto(
    `chrome-extension://${worker.url().split("/")[2]}/index.html`,
  );
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await page.locator(".view-nav button").filter({ hasText: "Notes" }).click();
  const editor = page.locator(".notes-workspace .tiptap").first();
  await editor.waitFor();
  const state = await load(),
    inbox = state.inboxId;
  assert.equal(
    state.entities.filter(
      (e) => e.kind === "note" && e.spaceId === inbox && !e.deletedAt,
    ).length,
    1,
  );
  const [a, b] = await Promise.all([
    api({ type: "ensureSpaceNote", spaceId: inbox }),
    api({ type: "ensureSpaceNote", spaceId: inbox }),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(await page.getByText("+ Section", { exact: true }).count(), 0);
  assert.equal(
    await page.getByText("↑ Attach file", { exact: true }).count(),
    0,
  );
  await page
    .getByRole("textbox", { name: "Note title", exact: true })
    .fill("Research notes");
  await editor.click();
  await page.keyboard.type("# Plan");
  await page.keyboard.press("Enter");
  await page.keyboard.type("**Important** ");
  assert.equal(await editor.locator("h1").textContent(), "Plan");
  assert.equal(await editor.locator("strong").textContent(), "Important");
  await page.getByRole("button", { name: "Bullet list", exact: true }).click();
  await page.keyboard.type("First item");
  assert.equal(await editor.locator("ul li").count(), 1);
  let saved = await settle((s) =>
    s.entities.some(
      (e) =>
        e.id === a.id &&
        e.name === "Research notes" &&
        e.text.includes("First item"),
    ),
  );
  results.push(
    "Notes opens directly into one editable note; title, Markdown shortcuts and toolbar formatting autosave locally without Section/Attach file controls",
  );
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .md", exact: true }).click();
  const download = await downloadEvent;
  const output = resolve(root, "artifacts/notes-export.md");
  await download.saveAs(output);
  const markdown = await readFile(output, "utf8");
  assert(markdown.includes("# Plan"));
  assert(markdown.includes("**Important**"));
  await page.getByRole("button", { name: "Focus editor", exact: true }).click();
  assert.equal(await page.locator(".editor-focus-mode").count(), 1);
  await page
    .getByRole("button", { name: "Leave focus mode", exact: true })
    .click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Note revisions", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Close dialog" }).click();
  results.push(
    "Export produces Markdown; focus mode and revision history are usable",
  );
  await page.getByRole("button", { name: "+ Add note", exact: true }).click();
  await page.locator(".note-card").nth(1).waitFor();
  const second = page.locator(".note-card").nth(1);
  await second.getByRole("textbox", { name: "Note title" }).fill("Second note");
  await second.locator(".tiptap").click();
  await page.keyboard.type("Second body");
  await settle((s) =>
    s.entities.some(
      (e) =>
        e.kind === "note" &&
        e.name === "Second note" &&
        e.text.includes("Second body"),
    ),
  );
  await page.reload();
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await page.locator(".notes-workspace").waitFor();
  await editor.waitFor();
  assert.equal(await page.locator(".note-card").count(), 2);
  assert.equal(await editor.locator("h1").textContent(), "Plan");
  await page
    .getByRole("button", { name: "Expand note Second note", exact: true })
    .click();
  await page.locator(".note-card").nth(1).locator(".tiptap").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Final edit");
  await page
    .locator(".note-card")
    .nth(1)
    .getByRole("button", { name: "Delete note", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await settle((s) =>
    s.entities.some(
      (e) =>
        e.kind === "note" &&
        e.name === "Second note" &&
        e.deletedAt &&
        e.text.includes("Final edit"),
    ),
  );
  results.push(
    "Multiple notes reopen with saved formatting; individual deletion goes to recoverable Trash",
  );
  await page.getByRole("button", { name: "Toggle light/dark theme" }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await page.screenshot({
    path: resolve(root, "artifacts/notes-workspace-dark.png"),
  });
  await page.setViewportSize({ width: 400, height: 900 });
  assert(
    await page
      .locator(".notes-workspace")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(root, "docs/VALIDATION_NOTES_WORKSPACE.json"),
    JSON.stringify({ extension, results }, null, 2),
  );
  console.log(results.map((r) => `PASS ${r}`).join("\n"));
} finally {
  await context.close();
}
