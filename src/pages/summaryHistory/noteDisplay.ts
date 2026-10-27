import type { Note } from './types';

export function getLocalizedSummary(note: Note, language: 'en' | 'ko'): string {
  const translated = note.summary_translations?.[language]?.trim();
  return note.summary_edit?.trim() || translated || note.summary?.trim() || '';
}

export function getNoteDisplayTitle(note: Note): string {
  const n = note.name?.trim();
  if (n) return n;
  return 'Untitled note';
}
