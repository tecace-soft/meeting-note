// S11 minimal piece for U1 (DEC-0024, REFACTOR_PLAN 4.2 S11 (1) and (2)).
// The note id of a summary submission is bound to the user and the source file and written to
// localStorage BEFORE the first POST. Resubmitting the same source (auto start, retry, reload,
// lost response) reuses the id, and the server's (user_id, note_id) job dedupe returns the
// existing job instead of a second transcription. A successful run clears the record, so
// deliberately summarizing the same file again still makes a new note (unchanged behavior).

export const SUBMIT_RECORD_STORAGE_KEY = 'meeting-note:summary-submit';
export const SUBMIT_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

export interface SummarySubmitRecord {
  userId: string;
  fileKey: string;
  noteId: string;
  createdAt: number;
}

// Fallback when storage is unavailable (private mode, quota): same-tab reuse still works.
let memoryRecord: SummarySubmitRecord | null = null;

/** Test-only: forget the in-memory copy, as a page reload would. */
export function resetSubmitRecordMemoryForTests(): void {
  memoryRecord = null;
}

function isRecord(value: unknown): value is SummarySubmitRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.userId === 'string' &&
    typeof v.fileKey === 'string' &&
    typeof v.noteId === 'string' &&
    typeof v.createdAt === 'number'
  );
}

function readStored(): SummarySubmitRecord | null {
  try {
    const raw = window.localStorage.getItem(SUBMIT_RECORD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    console.warn('Ignoring an unreadable summary submit record:', error);
    return null;
  }
}

function writeStored(record: SummarySubmitRecord): void {
  memoryRecord = record;
  try {
    window.localStorage.setItem(SUBMIT_RECORD_STORAGE_KEY, JSON.stringify(record));
  } catch (error) {
    console.warn('Could not persist the summary submit record; keeping it in memory only:', error);
  }
}

/**
 * Note id for submitting `fileKey`: the stored id while the same user resubmits the same source
 * within the TTL, otherwise a new id that is persisted before it is returned.
 */
export function noteIdForSubmission(input: {
  userId: string;
  fileKey: string;
  now: number;
  generate: () => string;
}): string {
  const existing = readStored() ?? memoryRecord;
  if (
    existing &&
    existing.userId === input.userId &&
    existing.fileKey === input.fileKey &&
    input.now - existing.createdAt < SUBMIT_RECORD_TTL_MS
  ) {
    return existing.noteId;
  }
  const record: SummarySubmitRecord = {
    userId: input.userId,
    fileKey: input.fileKey,
    noteId: input.generate(),
    createdAt: input.now,
  };
  writeStored(record);
  return record.noteId;
}

/** Forget the record after its note was created, but only if it is still that note's record. */
export function clearSubmitRecord(noteId: string): void {
  if (memoryRecord?.noteId === noteId) memoryRecord = null;
  const stored = readStored();
  if (stored?.noteId !== noteId) return;
  try {
    window.localStorage.removeItem(SUBMIT_RECORD_STORAGE_KEY);
  } catch (error) {
    console.warn('Could not clear the summary submit record:', error);
  }
}
