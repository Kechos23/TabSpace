import { expect, it } from "vitest";
import { normalizeState, type State } from "../apps/extension/src/client";

it("accepts legacy worker responses without losing collection data or throwing on sessions.find", () => {
  const entities = [
    { id: "kept-record", kind: "space", name: "Existing collection" },
  ];
  const legacy = {
    entities,
    settings: { theme: "dark" },
    browser: { tabs: [], groups: [] },
  } as unknown as State;
  const state = normalizeState(legacy);
  expect(state.entities).toBe(entities);
  expect(state.sessions.find((s) => s.windowId === 1)).toBeUndefined();
  expect(state.windows).toEqual([]);
  expect(state.sessionInterrupted).toBe(false);
  expect("sessions" in legacy).toBe(false);
});
it("keeps current session metadata from a current worker", () => {
  const sessions = [{ spaceId: "space", windowId: 1, parked: false }];
  const windows = [{ id: 1, title: "Window", tabs: 3 }];
  const value = {
    sessions,
    windows,
    sessionInterrupted: true,
  } as unknown as State;
  const state = normalizeState(value);
  expect(state.sessions).toBe(sessions);
  expect(state.windows).toBe(windows);
  expect(state.sessionInterrupted).toBe(true);
});
