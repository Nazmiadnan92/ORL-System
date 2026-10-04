// Local C1 Edge policy candidate. Deployment must provide a shared/distributed
// rateLimit implementation; an isolate-local counter is not sufficient.
export const C1_BODY_TIMEOUT_MS = 2000;
export const C1_RPC_TIMEOUT_MS = 25000;
export const C1_SMALL_BODY_BYTES = 32768;
export const C1_BACKUP_BODY_BYTES = 8 * 1024 * 1024;
export const C1_BACKUP_MAX_IDENTITIES = 2000;
export const C1_RATE_WINDOW_SECONDS = 60;
export const C1_RATE_MAX_REQUESTS = 30;

export function backupWithinRuntimePolicy(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) return false;
  for (const key of ['requests', 'identities', 'creation_receipts']) {
    if (backup[key] !== undefined && (!Array.isArray(backup[key]) || backup[key].length > C1_BACKUP_MAX_IDENTITIES)) return false;
  }
  return JSON.stringify(backup).length <= C1_BACKUP_BODY_BYTES;
}
