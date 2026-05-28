export interface TranscriptSegment {
  speaker: string;
  text: string;
}

export function coerceDiarizationArray(raw: unknown): unknown[] | null {
  if (raw == null) return null;

  let value: unknown = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }

  if (Array.isArray(value)) return value;

  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const key of ['segments', 'transcript', 'diarization', 'items', 'utterances']) {
      const inner = obj[key];
      if (Array.isArray(inner)) return inner;
    }
  }

  return null;
}

function segmentSpeakerText(item: Record<string, unknown>): TranscriptSegment {
  const speaker =
    item.speaker ??
    item.Speaker ??
    item.speaker_name ??
    item.speakerName ??
    item.name;
  const text =
    item.text ??
    item.Text ??
    item.content ??
    item.transcript ??
    item.message ??
    item.body;

  return {
    speaker: typeof speaker === 'string' ? speaker : String(speaker ?? ''),
    text: typeof text === 'string' ? text : String(text ?? ''),
  };
}

export function normalizeTranscript(raw: unknown): TranscriptSegment[] {
  if (raw == null) return [];

  const coerced = coerceDiarizationArray(raw);
  if (coerced) {
    return coerced
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map(segmentSpeakerText)
      .filter((segment) => segment.speaker.trim() || segment.text.trim());
  }

  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const segment = segmentSpeakerText(raw as Record<string, unknown>);
    return segment.speaker.trim() || segment.text.trim() ? [segment] : [];
  }

  if (typeof raw === 'string' && raw.trim()) {
    return [{ speaker: 'Transcript', text: raw.trim() }];
  }

  return [];
}

export function formatTranscript(segments: TranscriptSegment[]): string {
  return segments.map((segment) => `${segment.speaker}: ${segment.text}`).join('\n\n');
}

export function uniqueSpeakersFromSegments(segments: TranscriptSegment[]): string[] {
  const seen = new Set<string>();
  const speakers: string[] = [];
  for (const segment of segments) {
    const speaker = segment.speaker.trim();
    if (!speaker || seen.has(speaker)) continue;
    seen.add(speaker);
    speakers.push(speaker);
  }
  return speakers;
}
