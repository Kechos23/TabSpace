export function sameMembers(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((t) =>
      b.some(
        (n) =>
          n.id === t.id && n.pinned === t.pinned && n.groupId === t.groupId,
      ),
    )
  );
}
export function sameOrder(a, b) {
  return (
    sameMembers(a, b) &&
    a.every((t, i) => t.id === b[i].id && t.index === b[i].index)
  );
}
export function validateIntent(
  intent,
  captured,
  current,
  focused,
  now = Date.now(),
) {
  if (
    !focused ||
    intent.mapId !== captured.mapId ||
    intent.windowId !== current.windowId ||
    captured.windowId !== current.windowId ||
    // Covers a 30s hold, the initial map handshake and bounded release retries.
    now < captured.capturedAt ||
    now - captured.capturedAt > 40000
  )
    throw new Error("Window or identity map changed.");
  if (!sameMembers(captured.tabs, current.tabs))
    throw new Error("Tab membership, pin or group state changed.");
  const source = current.tabs.find((t) => t.id === intent.sourceId),
    target = current.tabs.find((t) => t.id === intent.targetId);
  if (
    !source ||
    !target ||
    source.id === target.id ||
    source.pinned ||
    target.pinned ||
    source.groupId !== -1 ||
    target.groupId !== -1 ||
    source.id === current.beaconId ||
    target.id === current.beaconId
  )
    throw new Error(
      "Only two distinct unpinned, ungrouped tabs are supported.",
    );
  if (
    current.tabs.filter((t) => t.highlighted).length !== 1 ||
    !source.highlighted
  )
    throw new Error("Multiple-tab dragging is not supported.");
  const withoutSource = (tabs) =>
    tabs
      .filter((t) => t.id !== source.id)
      .map((t) => t.id)
      .join(",");
  if (withoutSource(captured.tabs) !== withoutSource(current.tabs))
    throw new Error("Another tab moved during the gesture.");
  return true;
}
