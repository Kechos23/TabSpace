/** Read-only popup projection. No server details, document contents or credentials. */
export type CloudSyncSummary = {
  configured: boolean;
  hasAccess: boolean;
  automatic: boolean;
  unlocked: boolean;
  running: boolean;
  lastSynced?: string;
  needsAttention: boolean;
  hasConflicts: boolean;
};
