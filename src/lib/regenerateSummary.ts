import { selectSpeakersByNames } from './speakers/repository';
import type { TranscriptSegment } from './transcriptSegments';

/** Upper bound for one regenerate call (lite model, up to 16k output tokens). */
export const REGENERATE_TIMEOUT_MS = 120_000;

export interface SpeakerProfileForSummary {
  speakerName: string;
  profile: unknown;
}

export interface RegenerateSummaryRequest {
  apiUrl: string;
  token: string;
  noteId: string;
  diarization: TranscriptSegment[];
  previousSummary: string;
  speakerProfiles: SpeakerProfileForSummary[];
  instructions: string;
  promptId?: string;
  /** false asks the server not to save summary_edit (the caller saves after its own checks). */
  persist: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RegenerateSummaryResult {
  summary: string;
  /** What the server reports; null from a server that predates the persist flag. */
  persisted: boolean | null;
}

function parseProfile(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw; // plain-text profiles are sent as-is
  }
}

/**
 * Saved profiles of the speakers named in `segments`, for the regenerate prompt. A lookup
 * failure is logged and yields [] so the summary still regenerates (profiles are context only).
 */
export async function loadSpeakerProfilesForSummary(
  userId: string,
  segments: readonly TranscriptSegment[]
): Promise<SpeakerProfileForSummary[]> {
  const names = [...new Set(segments.map((segment) => segment.speaker).filter(Boolean))];
  if (names.length === 0) return [];
  const { data, error } = await selectSpeakersByNames(userId, names, 'name, profile');
  if (error) {
    console.warn('Speaker profiles for the summary could not be loaded; continuing without them:', error);
    return [];
  }
  return ((data ?? []) as { name: string; profile: string | null }[])
    .filter((row) => Boolean(row.profile))
    .map((row) => ({ speakerName: row.name, profile: parseProfile(row.profile as string) }));
}

/** Abort `controller` when `signal` aborts or after `timeoutMs`; returns a cleanup function. */
function linkAbort(controller: AbortController, signal: AbortSignal | undefined, timeoutMs: number) {
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  return () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  };
}

/** POST /regenerate-summary with a bounded wait. Throws on HTTP errors, empty results and timeouts. */
export async function requestRegeneratedSummary(request: RegenerateSummaryRequest): Promise<RegenerateSummaryResult> {
  const apiUrl = request.apiUrl.replace(/\/$/, '');
  if (!apiUrl) throw new Error('Workflow API URL is not configured.');
  const controller = new AbortController();
  const release = linkAbort(controller, request.signal, request.timeoutMs ?? REGENERATE_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiUrl}/regenerate-summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${request.token}` },
      body: JSON.stringify({
        noteId: request.noteId,
        diarization: request.diarization,
        previousSummary: request.previousSummary,
        speakerProfiles: request.speakerProfiles,
        instructions: request.instructions,
        promptId: request.promptId,
        persist: request.persist,
      }),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as
      | { summary?: unknown; persisted?: unknown; error?: unknown }
      | null;
    if (!response.ok) {
      const message = typeof payload?.error === 'string' && payload.error ? payload.error : `Request failed: ${response.status}`;
      throw new Error(message);
    }
    const summary = typeof payload?.summary === 'string' ? payload.summary : '';
    if (!summary.trim()) throw new Error('No summary was returned.');
    const persisted = typeof payload?.persisted === 'boolean' ? payload.persisted : null;
    return { summary, persisted };
  } catch (error) {
    if (controller.signal.aborted && !request.signal?.aborted) {
      throw new Error('The summary update timed out. Please try again.');
    }
    throw error;
  } finally {
    release();
  }
}
