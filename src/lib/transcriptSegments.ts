import { supabase } from '../config/supabaseConfig';

export type TranscriptLanguage = 'original' | 'en' | 'ko';

export type TranscriptSegment = {
  speaker: string;
  text: string;
  start?: number;
  end?: number;
  translations?: Record<string, string>;
};

export type ReplacementScope = 'single' | 'from_here' | 'all';

const SPEAKER_NUMBER_RE = /^Speaker\s*#?\s*(\d+)\s*$/i;

export function getNoteDiarizationRaw(note: { diarization?: unknown }): unknown {
  return note.diarization;
}

/**
 * Unwrap jsonb that may be a JSON string, or `{ segments: [...] }`, etc.
 * Does not treat plain prose strings as segment arrays (returns [] for non-JSON strings).
 */
export function coerceDiarizationArray(raw: unknown): unknown[] | null {
  if (raw == null) return null;

  let v: unknown = raw;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    try {
      v = JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  }

  if (Array.isArray(v)) return v;

  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    for (const key of ['segments', 'transcript', 'diarization', 'items', 'utterances'] as const) {
      const inner = o[key];
      if (Array.isArray(inner)) return inner;
    }
  }

  return null;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function segmentSpeakerText(o: Record<string, unknown>): TranscriptSegment {
  const sp =
    o.speaker ??
    o.Speaker ??
    o.speaker_name ??
    o.speakerName ??
    o.name;
  const tx =
    o.text ??
    o.Text ??
    o.content ??
    o.transcript ??
    o.message ??
    o.body;
  const speaker = typeof sp === 'string' ? sp : String(sp ?? '');
  const text = typeof tx === 'string' ? tx : String(tx ?? '');
  const start = finiteNumber(o.start ?? o.start_time ?? o.startTime);
  const end = finiteNumber(o.end ?? o.end_time ?? o.endTime);
  const rawTranslations = o.translations ?? o.translated_texts ?? o.translatedTexts;
  const translations = rawTranslations && typeof rawTranslations === 'object' && !Array.isArray(rawTranslations)
    ? Object.fromEntries(
        Object.entries(rawTranslations as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim()))
          .map(([language, translatedText]) => [language, translatedText.trim()])
      )
    : undefined;
  return {
    speaker,
    text,
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(translations && Object.keys(translations).length > 0 ? { translations } : {}),
  };
}

export function getSegmentText(segment: TranscriptSegment, language: TranscriptLanguage = 'original'): string {
  if (language === 'original') return segment.text;
  return segment.translations?.[language]?.trim() || segment.text;
}

export function normalizeTranscript(raw: unknown): TranscriptSegment[] {
  if (raw == null) return [];

  const coerced = coerceDiarizationArray(raw);
  if (coerced != null) {
    const out: TranscriptSegment[] = [];
    for (const item of coerced) {
      if (item == null || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const segment = segmentSpeakerText(o);
      if (!segment.text.trim() && !segment.speaker.trim()) continue;
      out.push(segment);
    }
    return out;
  }

  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const segment = segmentSpeakerText(o);
    if (segment.text.trim() || segment.speaker.trim()) return [segment];
  }

  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return [];
    return [{ speaker: 'Transcript', text: t }];
  }

  return [];
}

/** True when we should show the diarized segment UI (not plain transcription). */
export function hasUsableDiarization(raw: unknown): boolean {
  return normalizeTranscript(raw).length > 0;
}

export function getTranscriptAvatarLabel(speaker: string): string {
  const trimmed = speaker.trim();
  const numMatch = trimmed.match(SPEAKER_NUMBER_RE);
  if (numMatch?.[1]) return numMatch[1];

  if (!trimmed) return '?';

  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const a = parts[0][0];
    const b = parts[1][0];
    if (a && b) {
      const pair = (a + b).toUpperCase();
      return pair.length <= 2 ? pair : pair.slice(0, 2);
    }
  }

  const chars = [...trimmed];
  return (chars[0] ?? '') + (chars[1] ?? '');
}

export function applySpeakerReplacements(
  segments: TranscriptSegment[],
  segmentIndex: number,
  originalSpeaker: string,
  newSpeaker: string,
  scope: ReplacementScope
): TranscriptSegment[] {
  return segments.map((seg, i) => {
    if (scope === 'single') {
      return i === segmentIndex ? { ...seg, speaker: newSpeaker } : seg;
    }
    if (scope === 'from_here') {
      if (i === segmentIndex) return { ...seg, speaker: newSpeaker };
      if (i > segmentIndex && seg.speaker === originalSpeaker) return { ...seg, speaker: newSpeaker };
      return seg;
    }
    if (seg.speaker !== originalSpeaker) return seg;
    return { ...seg, speaker: newSpeaker };
  });
}


export async function persistNoteDiarization(noteId: string, segments: TranscriptSegment[]): Promise<void> {
  if (!noteId) return;
  const { error } = await supabase.from('note').update({ diarization: segments }).eq('id', noteId);
  if (error) throw error;
}
