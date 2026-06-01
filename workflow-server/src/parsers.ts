export interface TranscriptSegment {
  speaker: string;
  text: string;
}

export interface ParsedSummary {
  title: string;
  summary: string;
  tags: string[];
}

export function stripJsonCodeFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const stripped = stripJsonCodeFences(raw);
  const parsed = JSON.parse(stripped) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Model output must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

export function parseDiarizedSegments(raw: string): TranscriptSegment[] {
  const parsed = parseJsonObject(raw);
  if (!Array.isArray(parsed.segments)) {
    throw new Error('Transcription JSON must include a segments array.');
  }

  return parsed.segments
    .filter((segment): segment is Record<string, unknown> => Boolean(segment) && typeof segment === 'object' && !Array.isArray(segment))
    .map((segment) => {
      const speaker = typeof segment.speaker === 'string' && segment.speaker.trim()
        ? segment.speaker.trim()
        : 'Unknown Speaker';
      const text = typeof segment.text === 'string' ? segment.text.trim() : '';
      return { speaker, text };
    })
    .filter((segment) => segment.text);
}

export function formatTranscriptText(segments: TranscriptSegment[]): string {
  return segments.map((segment) => `${segment.speaker}: ${segment.text}`).join('\n');
}

export function parseSummary(raw: string): ParsedSummary {
  const parsed = parseJsonObject(raw);
  const title = typeof parsed.title === 'string' && parsed.title.trim()
    ? parsed.title.trim().split(/\s+/).slice(0, 6).join(' ')
    : 'Untitled Meeting';
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (!summary) throw new Error('Summary JSON must include a non-empty summary string.');

  const tags = Array.isArray(parsed.tags)
    ? parsed.tags
        .map((tag) => (typeof tag === 'string' ? tag.trim() : String(tag ?? '').trim()))
        .filter(Boolean)
        .map((tag) => tag.replace(/\s+/g, '-'))
    : [];

  return { title, summary, tags };
}
