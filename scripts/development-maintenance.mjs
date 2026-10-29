import { cleanupDevelopment } from "./development-cleanup.mjs";

// Best-effort, local development only. Never bundled into the extension.
try {
  const report = await cleanupDevelopment({ apply: true });
  if (report.removed?.length)
    console.log(
      `Development cleanup: removed ${report.removed.length} old temporary folders.`,
    );
  if (report.errors?.length || report.staleLock)
    console.warn(
      "Development cleanup skipped some items; see artifacts/.development-cleanup.",
    );
} catch (error) {
  console.warn(`Development cleanup skipped: ${error.message}`);
}
