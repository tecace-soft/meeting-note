import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SUBMIT_RECORD_STORAGE_KEY,
  SUBMIT_RECORD_TTL_MS,
  clearSubmitRecord,
  noteIdForSubmission,
  resetSubmitRecordMemoryForTests,
} from './summarySubmitRecord';

let counter = 0;
const generate = () => `note-${++counter}`;

beforeEach(() => {
  window.localStorage.clear();
  resetSubmitRecordMemoryForTests();
  counter = 0;
});

// S11 minimal piece (DEC-0024): the note id for a source is stored BEFORE the first POST, so a
// reload or a lost response followed by a resubmit of the same source reuses the same note id and
// the server's (user_id, note_id) job dedupe returns the existing job instead of a second run.
describe('noteIdForSubmission', () => {
  it('persists a new record before returning the id', () => {
    const id = noteIdForSubmission({ userId: 'u1', fileKey: 'file-1', now: 1000, generate });
    expect(id).toBe('note-1');
    expect(JSON.parse(window.localStorage.getItem(SUBMIT_RECORD_STORAGE_KEY) ?? 'null')).toEqual({
      userId: 'u1',
      fileKey: 'file-1',
      noteId: 'note-1',
      createdAt: 1000,
    });
  });

  it('reuses the id for the same user and source, also after a reload (memory lost)', () => {
    const first = noteIdForSubmission({ userId: 'u1', fileKey: 'file-1', now: 1000, generate });
    resetSubmitRecordMemoryForTests();
    expect(noteIdForSubmission({ userId: 'u1', fileKey: 'file-1', now: 2000, generate })).toBe(first);
  });

  it('starts a new id for another source, another user, or an expired record', () => {
    noteIdForSubmission({ userId: 'u1', fileKey: 'file-1', now: 0, generate });
    expect(noteIdForSubmission({ userId: 'u1', fileKey: 'file-2', now: 1, generate })).toBe('note-2');
    expect(noteIdForSubmission({ userId: 'u2', fileKey: 'file-2', now: 2, generate })).toBe('note-3');
    expect(noteIdForSubmission({ userId: 'u2', fileKey: 'file-2', now: 3 + SUBMIT_RECORD_TTL_MS, generate })).toBe('note-4');
  });

  it('ignores a corrupt stored record', () => {
    window.localStorage.setItem(SUBMIT_RECORD_STORAGE_KEY, '{not json');
    expect(noteIdForSubmission({ userId: 'u1', fileKey: 'file-1', now: 0, generate })).toBe('note-1');
  });

  it('keeps working in memory when storage is unavailable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const first = noteIdForSubmission({ userId: 'u1', fileKey: 'file-1', now: 0, generate });
    expect(noteIdForSubmission({ userId: 'u1', fileKey: 'file-1', now: 1, generate })).toBe(first);
    setItem.mockRestore();
    warn.mockRestore();
  });
});

describe('clearSubmitRecord', () => {
  it('clears only the record of the finished note', () => {
    noteIdForSubmission({ userId: 'u1', fileKey: 'file-1', now: 0, generate });
    clearSubmitRecord('other-note');
    expect(noteIdForSubmission({ userId: 'u1', fileKey: 'file-1', now: 1, generate })).toBe('note-1');
    clearSubmitRecord('note-1');
    expect(window.localStorage.getItem(SUBMIT_RECORD_STORAGE_KEY)).toBeNull();
    expect(noteIdForSubmission({ userId: 'u1', fileKey: 'file-1', now: 2, generate })).toBe('note-2');
  });
});
