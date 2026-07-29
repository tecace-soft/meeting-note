export interface TranscriptSegment {
  speaker: string;
  text: string;
  start?: number;
  end?: number;
  translations?: Record<string, string>;
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

/// Extracts the outermost brace-balanced object from text that surrounds JSON
/// with prose or a partial code fence. Ignores braces inside strings so a `{`
/// in the summary body does not throw off the balance. Returns null when no
/// complete object is present.
function extractJsonObjectText(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const stripped = stripJsonCodeFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped) as unknown;
  } catch (error) {
    // Recovery: the model occasionally wraps the JSON in prose or an unbalanced
    // code fence. Retry on the outermost brace-balanced object before failing,
    // so a summary is not discarded over a formatting slip.
    const recovered = extractJsonObjectText(stripped);
    if (recovered === null) throw error;
    parsed = JSON.parse(recovered) as unknown;
  }
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
      const start = typeof segment.start === 'number' && Number.isFinite(segment.start) ? segment.start : undefined;
      const end = typeof segment.end === 'number' && Number.isFinite(segment.end) ? segment.end : undefined;
      return {
        speaker,
        text,
        ...(start !== undefined ? { start } : {}),
        ...(end !== undefined ? { end } : {}),
      };
    })
    .filter((segment) => segment.text);
}

export function formatTranscriptText(segments: TranscriptSegment[], language: 'original' | 'en' | 'ko' = 'original'): string {
  return segments
    .map((segment) => {
      const text = language === 'original'
        ? segment.text
        : segment.translations?.[language]?.trim() || segment.text;
      return `${segment.speaker}: ${text}`;
    })
    .join('\n');
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

function getDateParts(date: Date, timeZone?: string): { year: string; month: string; day: string } {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: '2-digit',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date);
      const year = parts.find((part) => part.type === 'year')?.value;
      const month = parts.find((part) => part.type === 'month')?.value;
      const day = parts.find((part) => part.type === 'day')?.value;
      if (year && month && day) return { year, month, day };
    } catch {
      // Fall back to the runtime timezone if the client sent an invalid timezone.
    }
  }

  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return { year, month, day };
}

function toDatePrefix(date: Date, timeZone?: string): string {
  const { year, month, day } = getDateParts(date, timeZone);
  return `${year}${month}${day}`;
}

function capitalizeDescriptor(value: string): string {
  const lower = value.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function buildNoteName(input: {
  title?: string | null;
  tags?: string[];
  summary?: string | null;
  createdAt?: Date;
  timeZone?: string | null;
}): string {
  const source = typeof input.title === 'string' && input.title.trim()
    ? input.title
    : [
        ...(input.tags ?? []),
        input.summary,
      ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).join(' ');
  const words = source.match(/[A-Za-z0-9]+/g)?.slice(0, 5) ?? [];
  const descriptor = words.length > 0
    ? words.map(capitalizeDescriptor).join('_')
    : 'Untitled_Meeting';
  return `${toDatePrefix(input.createdAt ?? new Date(), input.timeZone ?? undefined)}_${descriptor}`;
}

export function formatMeetingDateForPrompt(date: Date, timeZone?: string | null): string {
  const timeZoneName = timeZone?.trim() || undefined;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timeZoneName,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: timeZoneName ? 'short' : undefined,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}
