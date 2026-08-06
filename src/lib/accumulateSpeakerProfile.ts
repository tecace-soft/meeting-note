import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from '../config/supabaseConfig';
import { getSegmentText, type TranscriptSegment } from './transcriptSegments';
import { canonicalOntologyProfileString } from './speakerOntology';
import { isAnonymousSpeakerLabel, type IdentifyAuth } from './identifySpeakers';

interface GenerateProfileResponse {
  profile?: string;
  error?: string;
}

async function invokeGenerateProfile(
  body: { speakerName: string; speakerId: string; transcriptText: string; existingProfile: string | null },
  auth: IdentifyAuth
): Promise<GenerateProfileResponse> {
  const response = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/generate-profile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${auth.appToken ?? SUPABASE_ANON_KEY}`,
      ...(auth.msToken ? { 'x-ms-access-token': auth.msToken } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed: GenerateProfileResponse;
  try {
    parsed = raw ? (JSON.parse(raw) as GenerateProfileResponse) : {};
  } catch {
    parsed = { error: raw || `HTTP ${response.status}` };
  }
  if (!response.ok) throw new Error(parsed.error || raw || `HTTP ${response.status}`);
  return parsed;
}

/**
 * F1a — auto-accumulate a NAMED speaker's ontology profile from a note's transcript,
 * merging into their existing profile (via generate-profile). Best-effort: the caller
 * runs this in the background and logs failures; it never touches anonymous labels and
 * only writes when the speaker actually has lines in this transcript.
 *
 * Returns the saved profile string, or null when nothing was accumulated (skipped).
 */
export async function accumulateSpeakerProfile(params: {
  speakerName: string;
  speakerId: string | null;
  userId: string;
  segments: TranscriptSegment[];
  auth: IdentifyAuth;
}): Promise<string | null> {
  const { userId, segments, auth } = params;
  const name = params.speakerName.trim();
  if (!name || isAnonymousSpeakerLabel(name)) return null;

  // Only accumulate if this speaker actually has lines in the transcript.
  if (!segments.some((s) => s.speaker.trim() === name)) return null;

  // Resolve the speaker row id (needed to save the merged profile back).
  let speakerId = params.speakerId;
  if (!speakerId) {
    const { data } = await supabase
      .from('speaker')
      .select('id')
      .eq('user_id', userId)
      .eq('name', name)
      .limit(1)
      .maybeSingle();
    speakerId = (data as { id: string } | null)?.id ?? null;
  }
  if (!speakerId) return null;

  const { data: existingRow } = await supabase
    .from('speaker')
    .select('profile')
    .eq('id', speakerId)
    .eq('user_id', userId)
    .maybeSingle();
  const existingProfile = ((existingRow as { profile: string | null } | null)?.profile ?? '').trim() || null;

  const transcriptText = segments.map((s) => `${s.speaker}: ${getSegmentText(s, 'en')}`).join('\n\n');

  const result = await invokeGenerateProfile(
    { speakerName: name, speakerId, transcriptText, existingProfile },
    auth
  );
  if (result.error) throw new Error(result.error);

  const merged = canonicalOntologyProfileString(result.profile ?? '');
  if (!merged.trim()) return null;

  const { error } = await supabase
    .from('speaker')
    .update({ profile: merged })
    .eq('id', speakerId)
    .eq('user_id', userId);
  if (error) throw error;

  return merged;
}
