import type { Draft, Snapshot } from "../domain/model";
import type { TabSpaceDB } from "./repository";

export const RECOVERY_PAGE_SIZE = 20;
export type RecoveryPage = {
  snapshots: (Pick<Snapshot, "id" | "capturedAt" | "reason" | "protected"> & {
    tabCount: number;
    groupCount: number;
    windowCount: number;
  })[];
  drafts: (Pick<Draft, "id" | "noteId" | "updatedAt"> & { preview: string })[];
  snapshotCount: number;
  draftCount: number;
};

// Read only one bounded page. Full tab arrays and rich documents never cross the
// manager message boundary until an individual item is explicitly requested.
export async function recoveryPage(
  db: TabSpaceDB,
  offset = 0,
  draftOffset = 0,
): Promise<RecoveryPage> {
  if (![offset, draftOffset].every((n) => Number.isSafeInteger(n) && n >= 0))
    throw new Error("Invalid recovery page.");
  return db.transaction("r", [db.snapshots, db.drafts], async () => {
    const snapshots = await db.snapshots
      .orderBy("capturedAt")
      .reverse()
      .offset(offset)
      .limit(RECOVERY_PAGE_SIZE)
      .toArray();
    const drafts = await db.drafts
      .offset(draftOffset)
      .limit(RECOVERY_PAGE_SIZE)
      .toArray();
    return {
      snapshots: snapshots.map((s) => ({
        id: s.id,
        capturedAt: s.capturedAt,
        reason: s.reason,
        protected: s.protected,
        tabCount: s.tabs.length,
        groupCount: s.groups.length,
        windowCount: new Set(s.tabs.map((t) => t.windowKey ?? "unknown")).size,
      })),
      drafts: drafts.map((d) => ({
        id: d.id,
        noteId: d.noteId,
        updatedAt: d.updatedAt,
        preview: d.text.slice(0, 200),
      })),
      snapshotCount: await db.snapshots.count(),
      draftCount: await db.drafts.count(),
    };
  });
}
