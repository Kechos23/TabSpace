import { useEffect, useState } from "react";
import * as client from "../client";
import { repository } from "../../../../packages/persistence/repository";
import {
  storageInfo,
  cleanUnusedFiles,
  type StorageInfo,
} from "../../../../packages/persistence/maintenance";
import { Button, Modal } from "./components";

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function StorageMaintenance() {
  const [info, setInfo] = useState<StorageInfo>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      setInfo(
        client.isExtension
          ? await client.request<StorageInfo>({ type: "storageInfo" })
          : await storageInfo(repository),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const clean = async () => {
    setBusy(true);
    setError("");
    try {
      if (!info) return;
      setInfo(
        client.isExtension
          ? await client.request<StorageInfo>({
              type: "cleanUnusedFiles",
              ids: info.unusedIds,
            })
          : await cleanUnusedFiles(repository, info.unusedIds),
      );
      setConfirm(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <span className="setting-label">Stored files</span>
        <p>
          {info
            ? `${info.fileCount} files · ${size(info.fileBytes)} · ${info.unusedCount} unused (${size(info.unusedBytes)})`
            : "Checking stored files…"}
        </p>
        <p>
          Files in content, Trash, backgrounds and retained history are
          protected. Files are never deleted automatically.
        </p>
        {info?.cleanupBlocked && (
          <p role="status">
            Cleanup is unavailable while preserved invalid records need review.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {confirm && info && (
          <Modal
            title="Clean unused files"
            onClose={() => {
              if (!busy) setConfirm(false);
            }}
          >
            <p>
              Permanently delete up to {info.unusedCount} unused files (
              {size(info.unusedBytes)})? Files that became used since this
              preview will be kept.
            </p>
            <div className="actions">
              <Button disabled={busy} onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={() => void clean()}>
                Delete unused files
              </Button>
            </div>
          </Modal>
        )}
      </div>
      <div className="setting-control">
        <Button
          disabled={busy || !info || info.cleanupBlocked || !info.unusedCount}
          onClick={() => setConfirm(true)}
        >
          Clean unused files
        </Button>
      </div>
    </div>
  );
}
