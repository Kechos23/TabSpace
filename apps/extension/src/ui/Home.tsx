import { useState } from "react";
import type { Entity } from "../../../../packages/domain/model";
import { hasPersonalContent } from "../../../../packages/domain/browsing";
import type { State } from "../client";
import {
  Button,
  NavigationIcon,
  TreeChevron,
  SpaceIcon,
  CurrentSpaceBadge,
} from "./components";

export function Home({
  spaces,
  state,
  onOpen,
  onView,
  collections,
  onCreate,
}: {
  spaces: Entity[];
  state: State;
  onOpen: (id: string) => void;
  onView: (id: string) => void;
  collections: Entity[];
  onCreate: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [collapsedCollections, setCollapsedCollections] = useState<Set<string>>(
    new Set(),
  );
  const collectionById = new Map(collections.map((item) => [item.id, item]));
  const spacesByCollection = new Map<string, Entity[]>();
  for (const space of spaces) {
    if (space.temporary) continue;
    if (!space.sidebarId || !collectionById.has(space.sidebarId)) continue;
    const members = spacesByCollection.get(space.sidebarId) ?? [];
    members.push(space);
    spacesByCollection.set(space.sidebarId, members);
  }
  const query = filter.trim().toLocaleLowerCase();
  const current = spaces.find((space) =>
    state.sessions.some(
      (session) =>
        session.spaceId === space.id &&
        session.windowId === state.currentWindowId &&
        !session.parked,
    ),
  );
  const visible = spaces.filter((space) =>
    `${space.name} ${space.description ?? ""} ${collectionById.get(space.sidebarId ?? "")?.name ?? ""}`
      .toLocaleLowerCase()
      .includes(query),
  );
  const visibleIds = new Set(visible.map((space) => space.id));
  const visibleCollections = collections.filter(
    (collection) =>
      collection.name.toLocaleLowerCase().includes(query) ||
      spacesByCollection
        .get(collection.id)
        ?.some((space) => visibleIds.has(space.id)),
  );
  const cards = (entries: Entity[]) => (
    <div className="home-grid">
      {entries.map((space) => {
        const session = state.sessions.find(
          (item) => item.spaceId === space.id,
        );
        const here =
          session &&
          !session.parked &&
          session.windowId === state.currentWindowId;
        const status = here
          ? "Active in this window"
          : session?.parked
            ? "Preserved in a minimized window"
            : session
              ? "Open in another window"
              : space.temporary
                ? "Recently closed"
                : "Saved · not open";
        const count = state.spaceTabs[space.id]?.length ?? 0;
        const collection = collectionById.get(space.sidebarId ?? "");
        return (
          <article
            className={`home-card${here ? " is-current" : ""}`}
            key={space.id}
            data-space-id={space.id}
          >
            <button
              type="button"
              className="home-card-view"
              aria-label={`View Space ${space.name}`}
              title={`View ${space.name} without switching browser tabs`}
              onClick={() => onView(space.id)}
            />
            <div className="home-card-heading">
              <span className={`hero-icon ${space.color}`} aria-hidden="true">
                <SpaceIcon temporary={space.temporary} />
              </span>
              <div>
                <h3>{space.name}</h3>
                <span className="home-space-status">{status}</span>
                {space.temporary &&
                  hasPersonalContent(space, state.entities) && (
                    <small className="unsaved-content-badge">
                      Contains saved content
                    </small>
                  )}
              </div>
            </div>
            {collection && (
              <span
                className="home-collection-badge"
                title={`Collection: ${collection.name}`}
              >
                <NavigationIcon name="collection" />
                <span>{collection.name}</span>
              </span>
            )}
            <p className="home-description muted">
              {space.description ||
                (space.temporary
                  ? "Unsaved browsing — save this Space to keep it."
                  : "Your tabs, links, notes and tasks in one place.")}
            </p>
            <div className="home-card-footer">
              <span className="muted">
                {count} {count === 1 ? "tab" : "tabs"}
                {space.temporary ? " · Unsaved" : ""}
              </span>
              <Button
                className="home-open-space"
                title={`Open Space ${space.name}`}
                onClick={() => onOpen(space.id)}
              >
                {here
                  ? "Continue"
                  : session && !session.parked
                    ? "Go to window"
                    : "Open Space"}{" "}
                →
              </Button>
            </div>
          </article>
        );
      })}
    </div>
  );
  return (
    <section className="home" aria-label="Home overview">
      {!!state.browsingUnresolved?.length && (
        <p className="error" role="status">
          Some previous browsing could not be restored automatically. Its Spaces
          are kept in Recently closed browsing so you can reopen them without
          automatic duplication.
        </p>
      )}
      <header className="home-header">
        <div>
          <span className="eyebrow">YOUR LOCAL WORKSPACE</span>
          <h1>Home</h1>
          <p className="muted">
            Click a Space card to view its tabs, resources, notes and tasks. Use
            Open Space when you want to switch your browser tabs.
          </p>
        </div>
        <Button className="primary" onClick={onCreate}>
          + New Space
        </Button>
      </header>
      <div className="home-current">
        <div>
          <span className="eyebrow">THIS WINDOW</span>
          <h2>{current ? current.name : "No Space active yet"}</h2>
          <p className="muted">
            {current
              ? "New browser tabs in this window belong to this Space."
              : "Open a Space to start managing the tabs in this window."}
          </p>
        </div>
        {current && (
          <Button onClick={() => onView(current.id)}>View Space →</Button>
        )}
      </div>
      <div className="home-list-header">
        <h2>
          Your Spaces <span className="count">{spaces.length}</span>
        </h2>
        <label>
          <span className="sr-only">Filter Spaces</span>
          <input
            type="search"
            placeholder="Find a Space…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
      </div>
      <p className="home-switch-hint muted">
        Open Space switches this window, or takes you to its existing window.
        {state.settings.preserveLiveTabs
          ? " Previous tabs stay open in a minimized window."
          : " Previous tabs are saved and closed; they reload when you return."}
      </p>
      {!!visible.filter((space) => !space.temporary).length && (
        <>
          <h2 className="home-space-heading">Saved</h2>
          {cards(visible.filter((space) => !space.temporary))}
        </>
      )}
      {!!visible.filter((space) => space.temporary && !space.browsingClosedAt)
        .length && (
        <>
          <h2 className="home-space-heading">Unsaved</h2>
          {cards(
            visible.filter(
              (space) => space.temporary && !space.browsingClosedAt,
            ),
          )}
        </>
      )}
      <details className="home-recent-unsaved">
        <summary>
          Recently closed browsing{" "}
          <span>
            {
              visible.filter(
                (space) => space.temporary && !!space.browsingClosedAt,
              ).length
            }
          </span>
        </summary>
        {cards(
          visible.filter(
            (space) => space.temporary && !!space.browsingClosedAt,
          ),
        )}
      </details>{" "}
      {!visible.length && (
        <div className="home-empty">
          <h3>
            {spaces.length
              ? "No matching Spaces"
              : "Make room for your next project"}
          </h3>
          <p className="muted">
            {spaces.length
              ? "Try another name or clear your search."
              : "Create your first Space to get started."}
          </p>
          {spaces.length ? (
            <Button onClick={() => setFilter("")}>Clear search</Button>
          ) : (
            <Button className="primary" onClick={onCreate}>
              Create a Space
            </Button>
          )}
        </div>
      )}
      <section className="home-collections" aria-label="Collections overview">
        <h2>
          Collections <span className="count">{collections.length}</span>
        </h2>
        <p className="muted">
          Your Spaces, grouped by Collection. Select a name to view it without
          switching tabs.
        </p>
        <div className="home-collections-grid">
          {visibleCollections.map((collection) => {
            const members = (
              spacesByCollection.get(collection.id) ?? []
            ).filter((space) => visibleIds.has(space.id));
            const expanded = !collapsedCollections.has(collection.id);
            return (
              <section
                className="home-collection"
                key={collection.id}
                data-home-collection-id={collection.id}
              >
                <button
                  className="home-collection-toggle"
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={`home-collection-${collection.id}`}
                  aria-label={`${expanded ? "Collapse" : "Expand"} Home collection ${collection.name}`}
                  onClick={() =>
                    setCollapsedCollections((previous) => {
                      const next = new Set(previous);
                      if (next.has(collection.id)) next.delete(collection.id);
                      else next.add(collection.id);
                      return next;
                    })
                  }
                >
                  <TreeChevron expanded={expanded} />
                  <NavigationIcon name="collection" />
                  <span className="home-collection-name">
                    {collection.name}
                  </span>
                  <span className="count">{members.length}</span>
                </button>
                {expanded && (
                  <ul id={`home-collection-${collection.id}`}>
                    {members.map((space) => (
                      <li key={space.id}>
                        <button
                          type="button"
                          className="home-collection-view"
                          aria-label={`View Space ${space.name} in collection ${collection.name}`}
                          onClick={() => onView(space.id)}
                        >
                          <span
                            className={`space-icon ${space.color}`}
                            aria-hidden="true"
                          >
                            <SpaceIcon temporary={space.temporary} />
                          </span>
                          <span className="home-collection-space-name">
                            {space.name}
                          </span>
                          {current?.id === space.id && <CurrentSpaceBadge />}
                        </button>
                        <Button
                          className="home-open-space"
                          title={`Open Space ${space.name} from collection ${collection.name}`}
                          onClick={() => onOpen(space.id)}
                        >
                          Open Space →
                        </Button>
                      </li>
                    ))}
                    {!members.length && (
                      <li className="home-collection-empty muted">
                        No Spaces in this Collection yet.
                      </li>
                    )}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
        {!visibleCollections.length && (
          <p className="muted">
            {collections.length
              ? "No matching Collections."
              : "Create a Collection using + in the sidebar, then move related Spaces into it."}
          </p>
        )}
      </section>
    </section>
  );
}
