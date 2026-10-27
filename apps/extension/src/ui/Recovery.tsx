import { useEffect, useState } from "react";
import type { Entity } from "../../../../packages/domain/model";
import {
  RECOVERY_PAGE_SIZE,
  type RecoveryPage,
} from "../../../../packages/persistence/recovery";
import { repository } from "../../../../packages/persistence/repository";
import * as client from "../client";
import { Button, download } from "./components";

export function Recovery({
  entities,
  inboxId,
  quarantineCount,
  onPreview,
  onRefresh,
  onBack,
}: {
  entities: Entity[];
  inboxId: string;
  quarantineCount: number;
  onPreview: (id: string) => void;
  onRefresh: () => Promise<void>;
  onBack: () => void;
}) {
  const [page, setPage] = useState<RecoveryPage>();
  const [offset, setOffset] = useState(0),
    [draftOffset, setDraftOffset] = useState(0);
  const [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(true);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setPage(undefined);
    void client
      .loadRecovery(offset, draftOffset)
      .then((result) => {
        if (active) {
          if (offset > 0 && offset >= result.snapshotCount) {
            setOffset(
              Math.max(
                0,
                Math.floor((result.snapshotCount - 1) / RECOVERY_PAGE_SIZE) *
                  RECOVERY_PAGE_SIZE,
              ),
            );
            return;
          }
          if (draftOffset > 0 && draftOffset >= result.draftCount) {
            setDraftOffset(
              Math.max(
                0,
                Math.floor((result.draftCount - 1) / RECOVERY_PAGE_SIZE) *
                  RECOVERY_PAGE_SIZE,
              ),
            );
            return;
          }
          setPage(result);
          setError("");
        }
      })
      .catch((error) => {
        if (active)
          setError(
            error instanceof Error
              ? error.message
              : "Could not load recovery data.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [offset, draftOffset, revision]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = (message: { type?: string }) => {
      if (
        !["tabspace:changed", "tabspace:recoveryChanged"].includes(
          message.type ?? "",
        )
      )
        return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setRevision((n) => n + 1), 200);
    };
    if (client.isExtension) chrome.runtime.onMessage.addListener(changed);
    return () => {
      if (timer) clearTimeout(timer);
      if (client.isExtension) chrome.runtime.onMessage.removeListener(changed);
    };
  }, []);
  const perform = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      setRevision((n) => n + 1);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not complete recovery action.",
      );
    } finally {
      setBusy(false);
    }
  };
  const pagination = (
    label: string,
    offset: number,
    total: number,
    update: (n: number) => void,
  ) => (
    <div
      className="recovery-pagination"
      role="navigation"
      aria-label={`${label} pages`}
    >
      <Button
        disabled={loading || offset === 0}
        onClick={() => update(Math.max(0, offset - RECOVERY_PAGE_SIZE))}
      >
        Previous {label.toLowerCase()}
      </Button>
      <span>
        {total
          ? `${offset + 1}–${Math.min(offset + RECOVERY_PAGE_SIZE, total)} of ${total}`
          : "0"}
      </span>
      <Button
        disabled={loading || offset + RECOVERY_PAGE_SIZE >= total}
        onClick={() => update(offset + RECOVERY_PAGE_SIZE)}
      >
        Next {label.toLowerCase()}
      </Button>
    </div>
  );
  return (
    <div className="page recovery">
      <div className="recovery-back">
        <Button onClick={onBack}>← Back to Settings</Button>
      </div>
      <span className="eyebrow">A WAY BACK</span>
      <h1>Recovery</h1>
      <p className="muted">
        Reopen tabs from an earlier checkpoint or recover an editor draft.
        Checkpoints preserve URLs and group layouts, not form inputs or page
        state.
      </p>
      <div className="recovery-actions">
        <Button
          className="primary"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await client.browser("checkpoint");
              setOffset(0);
              await onRefresh();
            })
          }
        >
          Create protected checkpoint
        </Button>
        <Button disabled={loading} onClick={() => setRevision((n) => n + 1)}>
          Refresh recovery
        </Button>
      </div>
      {quarantineCount > 0 && (
        <Button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const records = await repository.db.meta
                .where("id")
                .startsWith("quarantine:")
                .toArray();
              download(
                new Blob(
                  [
                    JSON.stringify(
                      { app: "TabSpace quarantine", records },
                      null,
                      2,
                    ),
                  ],
                  { type: "application/json" },
                ),
                "TabSpace-quarantine-sensitive.json",
              );
            })
          }
        >
          Export preserved invalid records (sensitive)
        </Button>
      )}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button onClick={() => setRevision((n) => n + 1)}>
            Retry recovery
          </Button>
        </div>
      )}
      {loading && <p role="status">Loading recovery summaries…</p>}
      {!loading && page && (
        <>
          <h2>
            Checkpoints <span className="muted">({page.snapshotCount})</span>
          </h2>
          {pagination("Checkpoints", offset, page.snapshotCount, setOffset)}
          {!page.snapshotCount && <p>No checkpoints yet.</p>}
          {page.snapshots.map((s) => (
            <article className="snapshot card" key={s.id}>
              <div>
                <h3>{s.reason}</h3>
                <p>
                  {new Date(s.capturedAt).toLocaleString()} · {s.tabCount} tabs
                  · {s.groupCount} groups · {s.windowCount} windows{" "}
                  {s.protected ? "· Protected" : ""}
                </p>
              </div>
              <Button onClick={() => onPreview(s.id)}>Preview / restore</Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void perform(() =>
                    client.protectCheckpoint(s.id, !s.protected),
                  )
                }
              >
                {s.protected ? "Unprotect" : "Protect"}
              </Button>
            </article>
          ))}
          {!!page.draftCount && (
            <>
              <h2>
                Recovered editor drafts{" "}
                <span className="muted">({page.draftCount})</span>
              </h2>
              {pagination(
                "Drafts",
                draftOffset,
                page.draftCount,
                setDraftOffset,
              )}
              {page.drafts.map((d) => (
                <article className="card recovered-draft" key={d.id}>
                  <strong>
                    {entities.find((e) => e.id === d.noteId)?.name ?? "Note"}
                  </strong>
                  <p>{d.preview}</p>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const draft = await client.recoveryDraft(d.id);
                        const source = entities.find(
                          (e) => e.id === draft.noteId,
                        );
                        await client.create(
                          source?.kind === "task" ? "task" : "note",
                          "Recovered draft",
                          {
                            spaceId:
                              entities.find(
                                (e) =>
                                  e.id === source?.spaceId &&
                                  e.kind === "space" &&
                                  !e.deletedAt &&
                                  !e.archivedAt,
                              )?.id ?? inboxId,
                            doc: draft.doc,
                            description: draft.text,
                          },
                        );
                        await onRefresh();
                      })
                    }
                  >
                    Recover as separate item
                  </Button>
                </article>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
