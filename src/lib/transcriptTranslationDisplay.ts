import {
  normalizeTranscript,
  type TranscriptLanguage,
  type TranscriptSegment,
} from './transcriptSegments';

export type TranscriptTranslationMap = Partial<Record<'en' | 'ko', TranscriptSegment[]>>;
export type TranscriptTextTranslationMap = Partial<Record<'en' | 'ko', string>>;

export interface NoteTranscriptTranslationFields {
  diarization?: unknown;
  transcript?: unknown;
  transcription?: string | null;
  transcription_language?: string | null;
  transcription_translations?: TranscriptTextTranslationMap | null;
  diarization_translations?: TranscriptTranslationMap | null;
}

export function normalizeTranscriptLanguage(value: unknown): 'en' | 'ko' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace('_', '-');
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  if (normalized === 'ko' || normalized.startsWith('ko-')) return 'ko';
  return null;
}

export function getOppositeTranscriptLanguage(language: 'en' | 'ko' | null): 'en' | 'ko' | null {
  if (language === 'en') return 'ko';
  if (language === 'ko') return 'en';
  return null;
}

export function getTranscriptLanguageLabel(language: TranscriptLanguage): string {
  if (language === 'ko') return '한국어';
  if (language === 'en') return 'English';
  return 'Original';
}

export function getNoteTranslatedSegments(
  note: NoteTranscriptTranslationFields,
  language: TranscriptLanguage
): TranscriptSegment[] {
  if (language === 'original') return [];
  const raw = note.diarization_translations?.[language];
  return normalizeTranscript(raw);
}

export function getAvailableTranscriptLanguages(note: NoteTranscriptTranslationFields): TranscriptLanguage[] {
  const languages: TranscriptLanguage[] = ['original'];
  for (const language of ['en', 'ko'] as const) {
    if (getNoteTranslatedSegments(note, language).length > 0 || note.transcription_translations?.[language]?.trim()) {
      languages.push(language);
    }
  }
  return languages;
}

export function getDisplayTranscriptSegments(
  note: NoteTranscriptTranslationFields,
  language: TranscriptLanguage
): TranscriptSegment[] {
  if (language !== 'original') {
    const translated = getNoteTranslatedSegments(note, language);
    if (translated.length > 0) return translated;
  }
  return normalizeTranscript(note.diarization ?? note.transcript);
}

export function getDisplayTranscriptText(note: NoteTranscriptTranslationFields, language: TranscriptLanguage): string {
  if (language !== 'original') {
    const translatedPlain = note.transcription_translations?.[language]?.trim();
    if (translatedPlain) return translatedPlain;
    const translatedSegments = getNoteTranslatedSegments(note, language);
    if (translatedSegments.length > 0) {
      return translatedSegments.map((segment) => `${segment.speaker}: ${segment.text}`).join('\n\n');
    }
  }
  const plain = note.transcription?.trim();
  if (plain) return plain;
  return normalizeTranscript(note.diarization ?? note.transcript)
    .map((segment) => `${segment.speaker}: ${segment.text}`)
    .join('\n\n');
}

export function updateTranslationMap(
  current: TranscriptTranslationMap | null | undefined,
  language: TranscriptLanguage,
  segments: TranscriptSegment[]
): TranscriptTranslationMap | null {
  if (language === 'original') return current ?? null;
  return {
    ...(current ?? {}),
    [language]: segments,
  };
}
