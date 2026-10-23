import type { IncomingMessage, ServerResponse } from 'node:http';
import { env } from '../config/env.js';
import { supabase } from '../db/supabaseClient.js';
import { getBearerToken, readBody, sendJson } from '../http/shared.js';
import { getMicrosoftUserId } from '../http/identity.js';
import { normalizeTranscriptSegment, formatTranscriptText, parseSummary, type TranscriptSegment } from '../parsers.js';
import { resolveRegenerateSummaryRules } from '../pipeline/promptLoaders.js';
import { getPersonalMemoryContext } from '../pipeline/memoryContext.js';
import { recordGeminiUsage } from '../pipeline/usage.js';
import { callGeminiWithFallback } from '../ai/geminiFallback.js';
import { STANDARD_FALLBACK_CHAIN } from '../gemini-models.js';
import { buildRegenerateSummaryPrompt } from '../prompts.js';
import { foldNoteIntoMemory } from '../memory.js';

interface RegenerateSummaryRequest {
  noteId?: unknown;
  diarization?: unknown;
  previousSummary?: unknown;
  speakerProfiles?: unknown;
  instructions?: unknown;
  promptId?: unknown;
}

export function parseRegenerateSummaryInput(body: RegenerateSummaryRequest): {
  noteId: string;
  segments: TranscriptSegment[];
  previousSummary: string;
  speakerProfiles: unknown;
  instructions: string;
  promptId?: string;
} {
  const noteId = typeof body.noteId === 'string' && body.noteId.trim() ? body.noteId.trim() : '';
  if (!noteId) throw new Error('noteId is required.');

  const rawSegments = Array.isArray(body.diarization) ? body.diarization : [];
  const segments = rawSegments
    .filter((segment): segment is Record<string, unknown> => Boolean(segment) && typeof segment === 'object' && !Array.isArray(segment))
    .map(normalizeTranscriptSegment)
    .filter((segment): segment is TranscriptSegment => Boolean(segment));
  if (segments.length === 0) throw new Error('diarization must include at least one transcript segment.');

  const promptIdRaw =
    typeof body.promptId === 'string'
      ? body.promptId.trim()
      : typeof body.promptId === 'number'
        ? String(body.promptId)
        : '';

  return {
    noteId,
    segments,
    previousSummary: typeof body.previousSummary === 'string' ? body.previousSummary.trim() : '',
    speakerProfiles: body.speakerProfiles ?? [],
    instructions: typeof body.instructions === 'string' ? body.instructions : '',
    promptId: promptIdRaw || undefined,
  };
}

async function regenerateSummary(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  const input = parseRegenerateSummaryInput((await readBody(req, 12_000_000)) as RegenerateSummaryRequest);

  const { data: noteRow, error: noteError } = await supabase
    .from('note')
    .select('id, user_id, shared_users')
    .eq('id', input.noteId)
    .maybeSingle();
  if (noteError) throw noteError;
  if (!noteRow) {
    sendJson(res, 404, { error: 'Note not found.' });
    return;
  }
  const note = noteRow as { user_id?: unknown; shared_users?: unknown };
  const sharedUsers = Array.isArray(note.shared_users)
    ? note.shared_users.map((value) => String(value))
    : [];
  if (note.user_id !== tokenUserId && !sharedUsers.includes(tokenUserId)) {
    sendJson(res, 403, { error: 'You do not have access to regenerate this note.' });
    return;
  }

  if (!env.geminiApiKey) throw new Error('Gemini API key is missing.');

  // Regenerate with the requester's selected summary prompt (custom prompts now
  // apply here too, not just on fresh summaries).
  const summaryRules = await resolveRegenerateSummaryRules(input.promptId, tokenUserId);

  // F1' -> regenerate: inject the NOTE OWNER's personal memory (not the requester's) so a
  // regenerated summary keeps the same cross-meeting context a fresh one gets, and a shared
  // user regenerating never leaks their own memory into someone else's note. Best-effort.
  const personalMemoryContext = await getPersonalMemoryContext(
    typeof note.user_id === 'string' ? note.user_id : undefined,
  );

  const result = await callGeminiWithFallback({
    stage: 'Summary regeneration',
    model: env.regenerateSummaryModel,
    fallbackModels: [...STANDARD_FALLBACK_CHAIN],
    responseMimeType: 'application/json',
    maxOutputTokens: 16384,
    parts: [{
      text: buildRegenerateSummaryPrompt({
        now: new Date().toISOString(),
        instructions: input.instructions,
        summaryRules,
        diarizedTranscript: formatTranscriptText(input.segments, 'original'),
        previousSummary: input.previousSummary,
        speakerProfiles: input.speakerProfiles,
        personalMemoryContext,
      }),
    }],
  });
  const parsedSummary = parseSummary(result.text);

  await recordGeminiUsage({
    noteId: input.noteId,
    userId: tokenUserId,
    stage: 'summary-regeneration',
    model: result.model,
    inputType: 'text',
    usageMetadata: result.usageMetadata,
    latencyMs: result.latencyMs,
  });

  const { error: updateError } = await supabase
    .from('note')
    .update({ summary_edit: parsedSummary.summary })
    .eq('id', input.noteId);
  if (updateError) throw updateError;

  sendJson(res, 200, parsedSummary);

  // After responding (so the user is not blocked), fold this note into the owner's
  // memory + refresh its note_insight, best-effort. foldNoteIntoMemory is idempotent:
  // an already-folded note is skipped, so this mainly backfills notes that predate
  // server-side folding (e.g. earlier mobile notes) when they are regenerated.
  try {
    await foldNoteIntoMemory({
      supabase,
      apiKey: env.geminiApiKey,
      // Attribute the fold + note_insight write to the NOTE OWNER, never the
      // requester. A share recipient may regenerate (access check above allows
      // shared_users), but the memory/index must stay the owner's: writing under
      // the requester would fold the owner's content into the recipient's memory
      // and flip note_insight.user_id, costing the owner their own index under RLS.
      userId: typeof note.user_id === 'string' ? note.user_id : '',
      noteId: input.noteId,
      transcript: formatTranscriptText(input.segments, 'original'),
      selfName: null,
      // Speaker ontology profiles double as the owner-attribution hint on regenerate.
      speakerContext: typeof input.speakerProfiles === 'string'
        ? input.speakerProfiles
        : (Array.isArray(input.speakerProfiles) && input.speakerProfiles.length > 0
            ? JSON.stringify(input.speakerProfiles)
            : null),
    });
  } catch (memoryError) {
    console.warn(`Memory fold (regenerate) failed for note ${input.noteId}:`, memoryError);
  }
}

export async function handleRegenerateSummaryRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'POST' || req.url !== '/regenerate-summary') return false;
  await regenerateSummary(req, res); return true;
}
