import type { IncomingMessage, ServerResponse } from 'node:http';
import { env } from '../config/env.js';
import { supabase } from '../db/supabaseClient.js';
import { getBearerToken, readBody, sendJson } from '../http/shared.js';
import { getMicrosoftUserId } from '../http/identity.js';
import { extractAndStoreInsight } from '../memory.js';
import { normalizeTranscriptSegment, formatTranscriptText, type TranscriptSegment } from '../parsers.js';
import { buildSpeakerContextFromSegments } from '../pipeline/speakerContext.js';

// F5.0: re-extract note_insight for a note from its NAMED diarization, so action owners
// and participant names resolve to real people after a speaker rename. Insight-only — it
// does NOT re-fold personal memory (that path is idempotent per note and needs a
// supersede design; deferred). Auth mirrors regenerate-summary (Microsoft Graph token,
// owner-or-shared access).
async function refreshNoteInsight(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  const body = (await readBody(req, 1_000_000)) as { noteId?: unknown } | null;
  const noteId = typeof body?.noteId === 'string' ? body.noteId.trim() : '';
  if (!noteId) {
    sendJson(res, 400, { error: 'noteId is required.' });
    return;
  }

  const { data: noteRow, error: noteError } = await supabase
    .from('note')
    .select('id, user_id, shared_users, diarization, transcription')
    .eq('id', noteId)
    .maybeSingle();
  if (noteError) throw noteError;
  if (!noteRow) {
    sendJson(res, 404, { error: 'Note not found.' });
    return;
  }
  const note = noteRow as { user_id?: unknown; shared_users?: unknown; diarization?: unknown; transcription?: unknown };
  const ownerId = typeof note.user_id === 'string' ? note.user_id : '';
  const sharedUsers = Array.isArray(note.shared_users) ? note.shared_users.map((value) => String(value)) : [];
  if (ownerId !== tokenUserId && !sharedUsers.includes(tokenUserId)) {
    sendJson(res, 403, { error: 'You do not have access to this note.' });
    return;
  }
  if (!env.geminiApiKey) throw new Error('Gemini API key is missing.');

  // Prefer the named diarization (real speaker names) over the frozen "Speaker A/B"
  // transcription column — that asymmetry is why owners were unattributed before.
  const segments = Array.isArray(note.diarization)
    ? (note.diarization as unknown[])
        .filter((segment): segment is Record<string, unknown> => Boolean(segment) && typeof segment === 'object' && !Array.isArray(segment))
        .map(normalizeTranscriptSegment)
        .filter((segment): segment is TranscriptSegment => Boolean(segment))
    : [];
  const transcript = segments.length
    ? formatTranscriptText(segments, 'original')
    : (typeof note.transcription === 'string' ? note.transcription : '');
  if (!transcript.trim()) {
    sendJson(res, 422, { error: 'Note has no transcript to index.' });
    return;
  }

  const result = await extractAndStoreInsight({
    supabase,
    apiKey: env.geminiApiKey,
    userId: ownerId,
    noteId,
    transcript,
    speakerContext: buildSpeakerContextFromSegments(segments),
  });
  if (!result.ok) {
    sendJson(res, 502, { error: `Insight extraction failed: ${result.reason ?? 'unknown'}` });
    return;
  }
  sendJson(res, 200, { ok: true, noteId });
}

// F4 backfill: populate note_insight for existing notes (insight only, no memory
// fold). Admin-gated and batched — call repeatedly until `processed` is 0. Each
// call pulls a batch of notes still lacking a note_insight row (server-side filter
// via notes_needing_insight) and extracts one row each.
// Admins allowed to run maintenance backfills (validated via the Microsoft Graph
// token, same as the other workflow-server endpoints).
const INSIGHT_BACKFILL_ADMIN_IDS = new Set<string>([
  '31d79bfe-2488-47c2-aa45-949375e93bde', // Andrew (andrewyoo@tecace.com)
]);

async function backfillInsight(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  if (!tokenUserId || !INSIGHT_BACKFILL_ADMIN_IDS.has(tokenUserId)) {
    sendJson(res, 403, { error: 'Insight backfill is not available for this user.' });
    return;
  }
  if (!env.geminiApiKey) throw new Error('Gemini API key is missing.');

  const body = (await readBody(req, 1_000_000)) as { limit?: unknown } | null;
  const limit = Math.max(1, Math.min(Math.floor(Number(body?.limit) || 25), 50));

  const { data, error } = await supabase.rpc('notes_needing_insight', { p_limit: limit });
  if (error) throw error;
  const notes = (data as Array<{ id: string; user_id: string; transcription: string }>) ?? [];

  let written = 0;
  let failed = 0;
  const sampleFailures: string[] = [];
  for (const note of notes) {
    try {
      const result = await extractAndStoreInsight({
        supabase,
        apiKey: env.geminiApiKey,
        userId: note.user_id,
        noteId: note.id,
        transcript: note.transcription ?? '',
      });
      if (result.ok) {
        written += 1;
      } else {
        failed += 1;
        if (sampleFailures.length < 5 && result.reason) sampleFailures.push(`${note.id.slice(0, 8)}: ${result.reason}`);
      }
    } catch (backfillError) {
      failed += 1;
      if (sampleFailures.length < 5) sampleFailures.push(`${note.id.slice(0, 8)}: threw ${(backfillError as Error).message.slice(0, 160)}`);
      console.warn(`Backfill insight failed for note ${note.id}:`, backfillError);
    }
  }

  sendJson(res, 200, { processed: notes.length, written, failed, sampleFailures });
}

export async function handleBackfillInsightRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'POST' || req.url !== '/admin/backfill-insight') return false;
  await backfillInsight(req, res); return true;
}
export async function handleRefreshNoteInsightRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'POST' || req.url !== '/refresh-note-insight') return false;
  await refreshNoteInsight(req, res); return true;
}
