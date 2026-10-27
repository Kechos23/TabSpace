import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Repository, TabSpaceDB } from "../packages/persistence/repository";
import {
  recoveryPage,
  RECOVERY_PAGE_SIZE,
} from "../packages/persistence/recovery";
import { blankDoc, type Snapshot } from "../packages/domain/model";

let repo: Repository;
beforeEach(async () => {
  repo = new Repository(new TabSpaceDB(`recovery-${crypto.randomUUID()}`));
  await repo.initialize();
});
afterEach(async () => {
  await repo.db.delete();
});

const seed = async () => {
  const snapshots: Snapshot[] = Array.from({ length: 45 }, (_, i) => ({
    id: crypto.randomUUID(),
    capturedAt: new Date(Date.now() - i * 1000).toISOString(),
    reason: `Checkpoint ${i}`,
    protected: i === 0,
    tabs: Array.from({ length: 300 }, (_, n) => ({
      title: `Private page ${n}`,
      url: `https://private.test/${n}`,
      pinned: false,
      muted: false,
      windowKey: String(n % 3),
    })),
    groups: [],
  }));
  await repo.db.snapshots.bulkPut(snapshots);
  await repo.db.drafts.bulkPut(
    Array.from({ length: 45 }, (_, i) => ({
      id: `draft-${String(i).padStart(3, "0")}`,
      noteId: crypto.randomUUID(),
      baseRevision: 1,
      doc: blankDoc(),
      text: "Private draft ".repeat(1000),
      updatedAt: new Date().toISOString(),
    })),
  );
  return snapshots;
};

it("returns bounded recovery summaries without sending tab URLs or rich drafts", async () => {
  const snapshots = await seed();
  const page = await recoveryPage(repo.db);
  expect(page.snapshotCount).toBe(45);
  expect(page.draftCount).toBe(45);
  expect(page.snapshots).toHaveLength(RECOVERY_PAGE_SIZE);
  expect(page.drafts).toHaveLength(RECOVERY_PAGE_SIZE);
  expect(page.snapshots[0]).toMatchObject({
    id: snapshots[0].id,
    protected: true,
    tabCount: 300,
    groupCount: 0,
    windowCount: 3,
  });
  expect(page.snapshots[0]).not.toHaveProperty("tabs");
  expect(page.drafts[0]).not.toHaveProperty("doc");
  expect(page.drafts[0].preview).toHaveLength(200);
  expect(JSON.stringify(page)).not.toContain("https://private.test");
  expect(JSON.stringify(page).length).toBeLessThan(20000);
  expect((await repo.db.snapshots.get(snapshots[0].id))?.tabs).toHaveLength(
    300,
  );
  expect((await repo.db.drafts.get("draft-000"))?.text.length).toBeGreaterThan(
    10000,
  );
});
it("pages independently through all checkpoints and drafts without duplicates", async () => {
  await seed();
  const pages = await Promise.all([
    recoveryPage(repo.db, 0, 0),
    recoveryPage(repo.db, 20, 20),
    recoveryPage(repo.db, 40, 40),
  ]);
  expect(pages[2].snapshots).toHaveLength(5);
  expect(pages[2].drafts).toHaveLength(5);
  expect(new Set(pages.flatMap((p) => p.snapshots.map((s) => s.id))).size).toBe(
    45,
  );
  expect(new Set(pages.flatMap((p) => p.drafts.map((d) => d.id))).size).toBe(
    45,
  );
});
it("handles empty and out-of-range pages without inventing or deleting records", async () => {
  expect(await recoveryPage(repo.db)).toEqual({
    snapshots: [],
    drafts: [],
    snapshotCount: 0,
    draftCount: 0,
  });
  await seed();
  expect(await recoveryPage(repo.db, 500, 500)).toEqual({
    snapshots: [],
    drafts: [],
    snapshotCount: 45,
    draftCount: 45,
  });
});
it("rejects invalid paging offsets", async () => {
  for (const offset of [-1, 0.5, NaN, Infinity])
    await expect(recoveryPage(repo.db, offset)).rejects.toThrow(
      "Invalid recovery page",
    );
});
