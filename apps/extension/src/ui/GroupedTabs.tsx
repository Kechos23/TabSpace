import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { TreeChevron } from "./components";

type GroupedTab = { groupKey?: string; group?: string; groupColor?: string };
// Group by identity, never title: unnamed or identically named groups remain separate.
export function GroupedTabs<T extends GroupedTab>({
  items,
  render,
  sidebar = false,
  actions,
}: {
  items: T[];
  render: (item: T, index: number) => ReactNode;
  sidebar?: boolean;
  actions?: (item: T) => ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const blocks: {
    key: string;
    group?: T;
    rows: { item: T; index: number }[];
  }[] = [];
  const groups = new Map<string, (typeof blocks)[number]>();
  items.forEach((item, index) => {
    if (item.groupKey === undefined) {
      blocks.push({ key: `tab:${index}`, rows: [{ item, index }] });
      return;
    }
    let block = groups.get(item.groupKey);
    if (!block) {
      block = { key: `group:${item.groupKey}`, group: item, rows: [] };
      groups.set(item.groupKey, block);
      blocks.push(block);
    }
    block.rows.push({ item, index });
  });
  return blocks.map((block) => {
    if (!block.group)
      return (
        <Fragment key={block.key}>
          {block.rows.map(({ item, index }) => render(item, index))}
        </Fragment>
      );
    const hidden = !!collapsed[block.key];
    const label = block.group.group?.trim() || "Unnamed group";
    const header = (
      <button
        type="button"
        className="tab-group-heading"
        aria-expanded={!hidden}
        onClick={() =>
          setCollapsed((old) => ({ ...old, [block.key]: !hidden }))
        }
      >
        <TreeChevron expanded={!hidden} />
        <span className="tab-group-dot" />
        <span className="tab-group-name">{label}</span>
        <span className="tab-group-count">{block.rows.length}</span>
      </button>
    );
    const style = {
      "--group-color": `var(--tab-group-${block.group.groupColor || "grey"}, var(--muted))`,
    } as CSSProperties;
    return sidebar ? (
      <li key={block.key} className="tab-group sidebar-tab-group" style={style}>
        {header}
        <ul hidden={hidden} className="tab-group-children">
          {block.rows.map(({ item, index }) => render(item, index))}
        </ul>
      </li>
    ) : (
      <div
        key={block.key}
        className="tab-group manager-tab-group"
        style={style}
      >
        <div className="tab-group-header">
          {header}
          {actions?.(block.group)}
        </div>
        <div hidden={hidden} className="tab-group-children">
          {block.rows.map(({ item, index }) => render(item, index))}
        </div>
      </div>
    );
  });
}
