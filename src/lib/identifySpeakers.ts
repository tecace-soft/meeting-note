import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config/supabaseConfig';
import { getSegmentText, type TranscriptSegment } from './transcriptSegments';
import { buildSpeakerContextForSummary } from './speakerOntology';

/** One model suggestion for an anonymous diarization label. */
export interface SpeakerSuggestion {
  label: string;
  speakerId: string | null;
  name: string | null;
  confidence: number;
  isSelf: boolean;
  rationale: string;
}

export interface IdentifyAuth {
  appToken: string | null;
  msToken: string | null;
}

interface SavedSpeakerLike {
  id: string;
  name: string;
  profile?: string | null;
}

/**
 * A diarization label is "anonymous" when it is a generic placeholder the diarizer
 * assigned ("Speaker", "Speaker A", "Speaker 1", "Transcript", "Unknown") rather than
 * a real person's name the user has already set. Only these need identifying.
 */
export function isAnonymousSpeakerLabel(label: string): boolean {
  const t = label.trim();
  if (!t) return false;
  return /^(speaker|transcript|unknown)\b/i.test(t) || /^speaker\s*#?\s*\d+$/i.test(t);
}

/**
 * A name that is NOT a real person and must never be saved as a speaker row: an anonymous
 * diarization label ("Speaker A") OR the product name ("meeting note"). Past bad renames/Sync
 * Profiles created such rows, which then polluted the roster and re-surfaced as suggestions.
 * Keep the product-name tokens in sync with the identify-speakers edge fn.
 */
export function isNonPersonSpeakerName(name: string): boolean {
  const t = name.trim();
  if (!t) return true;
  if (isAnonymousSpeakerLabel(t)) return true;
  const lc = t.toLowerCase().replace(/[^a-z0-9]/g, '');
  return lc === 'meetingnote' || lc === 'meetingnotes';
}

/** Distinct anonymous labels present in the transcript, in first-seen order. */
export function anonymousLabelsInTranscript(segments: TranscriptSegment[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const seg of segments) {
    const label = seg.speaker?.trim();
    if (!label || !isAnonymousSpeakerLabel(label) || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

interface IdentifyResponse {
  suggestions?: SpeakerSuggestion[];
  error?: string;
}

/**
 * Ask the `identify-speakers` edge function to suggest, for each anonymous label,
 * who the speaker most likely is (text/context matching, suggestion-only).
 * Returns [] when there are no anonymous labels to resolve.
 */
export async function requestSpeakerSuggestions(
  segments: TranscriptSegment[],
  savedSpeakers: SavedSpeakerLike[],
  selfName: string | null,
  auth: IdentifyAuth,
  noteId?: string | null,
): Promise<SpeakerSuggestion[]> {
  const labels = anonymousLabelsInTranscript(segments);
  if (labels.length === 0) return [];

  const roster = savedSpeakers
    .filter((s) => s.name?.trim())
    .map((s) => ({
      // speaker.id is an integer PK — at runtime it is a NUMBER (PostgREST JSON), despite the
      // `string` type. Stringify so the edge function's roster parsing keeps it (a number was
      // being dropped, leaving an empty roster → the model could only answer "unknown").
      speakerId: String(s.id),
      name: s.name,
      summary: buildSpeakerContextForSummary(s.name, s.profile ?? null),
    }));

  // Send the ORIGINAL-language transcript: name mentions, vocatives, and honorifics
  // (the strongest identity signals) are weakened or lost by translation to English.
  const transcriptText = segments
    .map((s) => `${s.speaker}: ${getSegmentText(s, 'original')}`)
    .join('\n\n');

  const response = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/identify-speakers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${auth.appToken ?? SUPABASE_ANON_KEY}`,
      ...(auth.msToken ? { 'x-ms-access-token': auth.msToken } : {}),
    },
    body: JSON.stringify({ transcriptText, labels, roster, selfName, noteId: noteId ?? null }),
  });

  const raw = await response.text();
  let parsed: IdentifyResponse;
  try {
    parsed = raw ? (JSON.parse(raw) as IdentifyResponse) : {};
  } catch {
    parsed = { error: raw || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    throw new Error(parsed.error || raw || `HTTP ${response.status}`);
  }
  return Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
}
