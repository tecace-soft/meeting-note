import { getNoteDiarizationRaw, normalizeTranscript } from '../../lib/transcriptSegments';
import type { Note } from './types';

export function normalizeTagList(raw: unknown): string[] {
  if (raw == null) return [];
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        return normalizeTagList(JSON.parse(s) as unknown);
      } catch {
        return s.split(',').map((t) => t.trim()).filter(Boolean);
      }
    }
    return s.split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (item == null) continue;
    if (typeof item === 'string') {
      const t = item.trim();
      if (t) out.push(t);
    } else if (typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const label = o.label ?? o.name ?? o.value;
      if (typeof label === 'string' && label.trim()) out.push(label.trim());
    } else {
      const t = String(item).trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function textMatchesNeedle(value: string, needle: string): boolean {
  const text = value.trim().toLocaleLowerCase();
  return Boolean(text) && (text.includes(needle) || needle.includes(text));
}

export function noteMatchesSearch(note: Note, query: string, currentUserSearchValues: string[]): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const queryLooksLikeCurrentUser = currentUserSearchValues.some((value) => textMatchesNeedle(value, needle));

  const searchableText = [
    note.name,
    note.summary,
    note.summary_edit,
    ...Object.values(note.summary_translations ?? {}),
    ...normalizeTagList(note.tag),
    ...normalizeTagList(note.tags),
  ]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .join(' ')
    .toLocaleLowerCase();
  if (searchableText.includes(needle)) return true;

  if (!queryLooksLikeCurrentUser && note.user_name?.trim().toLocaleLowerCase().includes(needle)) return true;

  const speakers = normalizeTranscript(getNoteDiarizationRaw(note))
    .map((segment) => segment.speaker.trim().toLocaleLowerCase())
    .filter(Boolean);
  if (speakers.some((speaker) => speaker.includes(needle))) return true;

  const transcription = note.transcription || '';
  return transcription
    .split(/\r?\n/)
    .some((line) => {
      const [speakerPrefix] = line.split(':', 1);
      return speakerPrefix?.trim().toLocaleLowerCase().includes(needle);
    });
}

