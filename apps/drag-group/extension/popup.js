const $ = (id) => document.getElementById(id);
let windowId,
  busy = false;
async function refresh() {
  if (busy) return;
  try {
    const state = await chrome.runtime.sendMessage({ type: "getState" });
    if (state.error) throw new Error(state.error);
    $("version").textContent = state.version;
    $("enabled").checked = state.enabled;
    const ready = state.windows.filter(
      (w) =>
        w.status.startsWith("Ready") || w.status.startsWith("Group created"),
    ).length;
    $("summary").textContent = state.enabled
      ? `Ενεργό · ${ready}/${state.windows.length} παράθυρα έτοιμα`
      : "Σε παύση σε όλα τα παράθυρα";
    const current = state.windows.find((w) => w.windowId === windowId);
    const status = current?.status ?? "";
    $("current").textContent = !state.enabled
      ? "Η επιλογή αποθηκεύεται και μετά την επανεκκίνηση."
      : status.startsWith("Ready") || status.startsWith("Group created")
        ? "Έτοιμο για σύρσιμο και δημιουργία group."
        : status.includes("Helper unavailable") ||
            status.includes("versions differ")
          ? "Ο helper χρειάζεται έλεγχο. Άνοιξε τις λεπτομέρειες."
          : status.includes("tab count")
            ? "Άνοιξε τουλάχιστον δύο καρτέλες για grouping."
            : "Προετοιμασία παραθύρου. Κράτησε τις καρτέλες ορατές.";
    $("details").disabled = !current?.tabId;
  } catch (error) {
    $("summary").textContent = error.message;
  }
}
windowId = (await chrome.windows.getCurrent()).id;
$("enabled").addEventListener("change", async () => {
  busy = true;
  $("enabled").disabled = true;
  try {
    await chrome.runtime.sendMessage({
      type: "setEnabled",
      enabled: $("enabled").checked,
    });
  } finally {
    busy = false;
    $("enabled").disabled = false;
    await refresh();
  }
});
$("details").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "openController", windowId });
  window.close();
});
await refresh();
const timer = setInterval(refresh, 1000);
addEventListener("pagehide", () => clearInterval(timer));
