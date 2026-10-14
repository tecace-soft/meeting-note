/**
 * Idempotent, bounded-retry write of a public.file row after a storage upload.
 *
 * Pure orchestration: all I/O is injected so the retry / reuse / timeout /
 * outcome classification is unit-testable. A failure never throws; it is
 * returned as `{ status: 'failed' }` so the caller must decide how to surface it
 * (it can no longer be swallowed by accident).
 */

export const FILE_RECORD_MAX_ATTEMPTS = 3;
export const FILE_RECORD_ATTEMPT_TIMEOUT_MS = 10_000;
const BACKOFF_MS = [500, 1500];

export type FileRecordOutcome =
  | { status: 'saved'; id: string | null; attempts: number }
  | { status: 'reused'; id: string; attempts: number }
  | { status: 'failed'; error: unknown; attempts: number };

export interface FileRecordDeps {
  /** Returns the id of an existing row for this storage object, or null. */
  findExisting: () => Promise<string | null>;
  /** Inserts the row and returns its id (null if the server returned none). */
  insert: () => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  attemptTimeoutMs?: number;
  maxAttempts?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function withTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`File record request timed out after ${ms}ms`)), ms);
  });
  return Promise.race([op, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Each attempt first looks for an existing row (a previous attempt may have
 * succeeded with a lost response), then inserts. Never creates duplicates for
 * the same storage object within this flow.
 */
export async function saveFileRecordWithRetry(deps: FileRecordDeps): Promise<FileRecordOutcome> {
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = deps.attemptTimeoutMs ?? FILE_RECORD_ATTEMPT_TIMEOUT_MS;
  const maxAttempts = deps.maxAttempts ?? FILE_RECORD_MAX_ATTEMPTS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const existing = await withTimeout(deps.findExisting(), timeoutMs);
      if (existing) return { status: 'reused', id: existing, attempts: attempt };
      const id = await withTimeout(deps.insert(), timeoutMs);
      return { status: 'saved', id, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]);
    }
  }
  return { status: 'failed', error: lastError, attempts: maxAttempts };
}
