import { useEffect, useState } from "react";
import { request } from "../client";
import type { CloudSyncSummary } from "../../../../packages/sync/status";

export function CloudSyncIndicator() {
  const [status, setStatus] = useState<CloudSyncSummary>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let closed = false,
      pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await request<CloudSyncSummary>({
          type: "cloudSyncSummary",
        });
        if (!closed) {
          setStatus(next);
          setUnavailable(false);
        }
      } catch {
        if (!closed) setUnavailable(true);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, []);
  const attention =
    unavailable ||
    !!(
      status?.configured &&
      (!status.hasAccess || status.needsAttention || status.hasConflicts)
    );
  const label = unavailable
    ? "Sync status unavailable"
    : !status
      ? "Checking sync…"
      : !status.configured
        ? "Cloud sync off"
        : status.running
          ? "Syncing…"
          : !status.hasAccess
            ? "Sync needs access"
            : status.hasConflicts
              ? "Sync needs review"
              : status.needsAttention
                ? "Sync needs attention"
                : !status.unlocked
                  ? "Sync locked"
                  : "Cloud sync ready";
  const detail = unavailable
    ? "Could not read cloud sync status. Check Settings → Cloud sync."
    : !status
      ? "Reading local sync status; no sync is started."
      : !status.configured
        ? "Optional cloud sync is off. Set it up in Settings → Cloud sync."
        : [
            label,
            status.lastSynced
              ? `Last successful sync: ${new Date(status.lastSynced).toLocaleString()}.`
              : "No successful sync yet.",
            status.automatic
              ? "Automatic sync every 5 minutes while unlocked."
              : "Manual sync.",
            "Manage in Settings → Cloud sync.",
          ].join(" ");
  return (
    <span
      className="popup-cloud-sync"
      role="status"
      title={detail}
      aria-label={`${label}. ${detail}`}
      data-attention={attention}
      data-running={!unavailable && !!status?.configured && !!status.running}
    >
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M7 18H6a4 4 0 0 1-.7-7.9 6.5 6.5 0 0 1 12.5-1.8A5 5 0 0 1 19 18h-2" />
        {status?.configured && !unavailable ? (
          status.running ? (
            <path d="m9 16 3-3 3 3m-3-3v8" />
          ) : attention ? (
            <path d="M12 13v4m0 3h.01" />
          ) : !status.unlocked ? (
            <>
              <rect x="9" y="16" width="6" height="5" rx="1" />
              <path d="M10 16v-1a2 2 0 0 1 4 0v1" />
            </>
          ) : (
            <path d="m9 17 2 2 4-4" />
          )
        ) : (
          <path d="M9 17h6" />
        )}
      </svg>
      <span>{label}</span>
    </span>
  );
}
