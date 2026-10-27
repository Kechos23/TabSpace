const intents = new Map<number, { spaceId: string; token: symbol }>();
const notify = () => {
  void chrome.runtime
    .sendMessage({ type: "tabspace:iconChanged" })
    .catch(() => undefined);
};
export function beginIconIntent(
  windowId: number,
  spaceId: string,
  token: symbol,
) {
  intents.set(windowId, { spaceId, token });
  notify();
}
export function iconIntentFor(windowId: number) {
  return intents.get(windowId)?.spaceId;
}
export function endIconIntent(token: symbol) {
  let changed = false;
  for (const [windowId, intent] of intents)
    if (intent.token === token) {
      intents.delete(windowId);
      changed = true;
    }
  if (changed) notify();
}
