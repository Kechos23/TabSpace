import MiniSearch from "minisearch";
import type { Entity, LiveTab, Snapshot } from "../domain/model";
export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("el")
    .replace(/ς/g, "σ");
export type Hit = {
  id: string;
  name: string;
  text: string;
  kind: string;
  spaceId?: string;
  url?: string;
  entity?: Entity;
  tabId?: number;
  archived?: boolean;
};
export class SearchIndex {
  private docs = new Map<string, Hit>();
  private index = new MiniSearch<Hit>({
    fields: ["name", "text", "url"],
    storeFields: ["name", "text", "kind", "spaceId", "url", "tabId"],
    processTerm: fold,
    tokenize: (s) => s.split(/[^\p{L}\p{N}_]+/u).filter(Boolean),
  });
  update(
    entities: Entity[],
    tabs: LiveTab[],
    snapshots: Snapshot[] = [],
    includeHistory = false,
  ) {
    const archivedParents = new Set(
      entities
        .filter((e) => e.kind === "space" && e.archivedAt)
        .map((e) => e.id),
    );
    const docs: Hit[] = [
      ...entities
        .filter((e) => !e.deletedAt)
        .map((e) => ({
          id: e.id,
          name: e.name,
          text: `${e.description} ${e.text} ${e.tags.join(" ")}`,
          kind: e.kind,
          spaceId: e.spaceId ?? (e.kind === "space" ? e.id : undefined),
          url: e.url,
          entity: e,
          archived: Boolean(
            e.archivedAt || (e.spaceId && archivedParents.has(e.spaceId)),
          ),
        })),
      ...tabs.map((t) => ({
        id: `tab:${t.id}`,
        name: t.title,
        text: "",
        kind: "liveTab",
        spaceId: t.spaceId,
        url: t.url,
        tabId: t.id,
      })),
      ...(includeHistory
        ? snapshots.flatMap((s) =>
            s.tabs.map((t, i) => ({
              id: `session:${s.id}:${i}`,
              name: t.title,
              text: s.reason,
              kind: "session",
              spaceId: t.spaceId,
              url: t.url,
            })),
          )
        : []),
    ];
    const next = new Map(docs.map((d) => [d.id, d]));
    for (const [id, old] of this.docs) {
      const n = next.get(id);
      if (
        !n ||
        old.name !== n.name ||
        old.text !== n.text ||
        old.url !== n.url
      ) {
        this.index.remove(old);
        this.docs.delete(id);
      }
    }
    for (const d of docs) {
      if (!this.docs.has(d.id)) {
        this.index.add(d);
      }
      // Filters and result entities stay current without rebuilding searchable text.
      this.docs.set(d.id, d);
    }
  }
  search(
    query: string,
    filters: {
      kind?: string;
      spaceId?: string;
      domain?: string;
      archived?: boolean;
      sectionId?: string;
      taskState?: string;
      dueFrom?: string;
      dueTo?: string;
    } = {},
  ): Hit[] {
    const results = query.trim()
      ? this.index
          .search(query, { prefix: true, fuzzy: 0.15, combineWith: "AND" })
          .map((r) => this.docs.get(r.id)!)
          .filter(Boolean)
      : Array.from(this.docs.values());
    return results.filter(
      (d) =>
        (!filters.kind || d.kind === filters.kind) &&
        (!filters.spaceId || d.spaceId === filters.spaceId) &&
        (!filters.domain ||
          (() => {
            try {
              return new URL(d.url ?? "").hostname
                .toLowerCase()
                .includes(filters.domain!.toLowerCase());
            } catch {
              return false;
            }
          })()) &&
        (!filters.sectionId || d.entity?.sectionId === filters.sectionId) &&
        (!filters.taskState ||
          (d.kind === "task" &&
            (filters.taskState === "completed"
              ? Boolean(d.entity?.completedAt)
              : filters.taskState === "starred"
                ? d.entity?.starred
                : !d.entity?.completedAt))) &&
        (!filters.dueFrom ||
          Boolean(d.entity?.dueDate && d.entity.dueDate >= filters.dueFrom)) &&
        (!filters.dueTo ||
          Boolean(d.entity?.dueDate && d.entity.dueDate <= filters.dueTo)) &&
        (filters.archived || !d.archived),
    );
  }
}
