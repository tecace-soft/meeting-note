import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fetchReferencingNotes,
  findReferencingNotes,
  formatNoteTitles,
  NOTE_REF_MAX_PAGES,
  noteReferencesFile,
  parseStorageObjectUrl,
  type NoteAudioRef,
} from './audioFileReferences';

const BASE = 'https://x.supabase.co/storage/v1/object';
const file = { id: 'f1', bucket: 'meeting-recordings', storage_path: 'user-1/1700-my meeting.m4a' };
const note = (over: Partial<NoteAudioRef>): NoteAudioRef => ({
  id: 'n1', name: 'T', audio_file: null, audio_file_id: null, ...over,
});

describe('parseStorageObjectUrl', () => {
  it('parses sign URL and ignores ?token', () => {
    expect(parseStorageObjectUrl(`${BASE}/sign/meeting-recordings/user-1/a.m4a?token=abc.def`))
      .toEqual({ bucket: 'meeting-recordings', path: 'user-1/a.m4a' });
  });
  it('parses public and authenticated URLs', () => {
    expect(parseStorageObjectUrl(`${BASE}/public/meeting-recordings/u/a.m4a`)?.path).toBe('u/a.m4a');
    expect(parseStorageObjectUrl(`${BASE}/authenticated/meeting-recordings/u/a.m4a`)?.path).toBe('u/a.m4a');
  });
  it('decodes percent-encoded paths', () => {
    expect(parseStorageObjectUrl(`${BASE}/sign/meeting-recordings/u/my%20meeting%20%281%29.m4a?token=t`)?.path)
      .toBe('u/my meeting (1).m4a');
  });
  it('returns null for junk, empty, null, non-storage URLs', () => {
    expect(parseStorageObjectUrl('')).toBeNull();
    expect(parseStorageObjectUrl(null)).toBeNull();
    expect(parseStorageObjectUrl('https://example.com/a.m4a')).toBeNull();
    expect(parseStorageObjectUrl(`${BASE}/sign/meeting-recordings/?token=t`)).toBeNull();
  });
  it('does not throw on malformed percent encoding', () => {
    expect(parseStorageObjectUrl(`${BASE}/sign/meeting-recordings/u/100%.m4a`)?.path).toBe('u/100%.m4a');
  });
});

describe('noteReferencesFile', () => {
  it('matches by audio_file_id', () => {
    expect(noteReferencesFile(note({ audio_file_id: 'f1' }), file)).toBe(true);
  });
  it('matches by URL when audio_file_id is NULL (orphan-prone case)', () => {
    const url = `${BASE}/sign/meeting-recordings/user-1/1700-my%20meeting.m4a?token=zzz`;
    expect(noteReferencesFile(note({ audio_file: url }), file)).toBe(true);
  });
  it('matches public URL form', () => {
    const url = `${BASE}/public/meeting-recordings/user-1/1700-my%20meeting.m4a`;
    expect(noteReferencesFile(note({ audio_file: url }), file)).toBe(true);
  });
  it('does not match a different bucket with same path', () => {
    const url = `${BASE}/sign/other-bucket/user-1/1700-my%20meeting.m4a?token=t`;
    expect(noteReferencesFile(note({ audio_file: url }), file)).toBe(false);
  });
  it('does not match a path that merely shares a prefix or suffix', () => {
    expect(noteReferencesFile(note({ audio_file: `${BASE}/sign/meeting-recordings/user-1/1700-my%20meeting.m4a.bak?token=t` }), file)).toBe(false);
    expect(noteReferencesFile(note({ audio_file: `${BASE}/sign/meeting-recordings/x/user-1/1700-my%20meeting.m4a?token=t` }), file)).toBe(false);
  });
  it('does not match other file id / empty refs', () => {
    expect(noteReferencesFile(note({ audio_file_id: 'f2' }), file)).toBe(false);
    expect(noteReferencesFile(note({}), file)).toBe(false);
  });
  it('rejects invalid file identity', () => {
    expect(noteReferencesFile(note({ audio_file_id: 'f1' }), { ...file, id: '' })).toBe(false);
    expect(noteReferencesFile(note({ audio_file_id: '' }), { ...file, storage_path: '' })).toBe(false);
  });
  it('tolerates leading slash in storage_path', () => {
    const url = `${BASE}/sign/meeting-recordings/user-1/a.m4a?token=t`;
    expect(noteReferencesFile(note({ audio_file: url }), { ...file, storage_path: '/user-1/a.m4a' })).toBe(true);
  });
});

describe('findReferencingNotes / formatNoteTitles', () => {
  it('returns only referencing notes', () => {
    const notes = [note({ id: 'a', audio_file_id: 'f1' }), note({ id: 'b' })];
    expect(findReferencingNotes(notes, file).map((n) => n.id)).toEqual(['a']);
  });
  it('formats titles with fallback and truncation', () => {
    const ns = ['A', '', 'C', 'D', 'E'].map((name, i) => note({ id: String(i), name }));
    expect(formatNoteTitles(ns, 'Untitled')).toEqual(['A', 'Untitled', 'C', '+2']);
  });
});

interface MockOpts {
  all: NoteAudioRef[];
  cap?: number; // server max_rows: silently truncates every response
  count?: number | null | ((call: number) => number | null);
  error?: unknown;
  hang?: boolean;
}

function mockClient(o: MockOpts): SupabaseClient & { calls: number } {
  let call = 0;
  let range: [number, number] = [0, 0];
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = chain; builder.eq = chain; builder.or = chain; builder.order = chain;
  builder.range = (a: number, b: number) => { range = [a, b]; return builder; };
  builder.abortSignal = (signal: AbortSignal) => {
    if (o.hang) return new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
    call += 1;
    if (o.error) return Promise.resolve({ data: null, error: o.error, count: null });
    const want = range[1] - range[0] + 1;
    const rows = o.all.slice(range[0], range[0] + Math.min(want, o.cap ?? want));
    const c = typeof o.count === 'function' ? o.count(call) : o.count === undefined ? o.all.length : o.count;
    return Promise.resolve({ data: rows, error: null, count: c });
  };
  const client = { from: () => builder } as unknown as SupabaseClient & { calls: number };
  Object.defineProperty(client, 'calls', { get: () => call });
  return client;
}

const mk = (n: number, hit?: number): NoteAudioRef[] =>
  Array.from({ length: n }, (_, i) => note({ id: String(i), audio_file_id: i === hit ? 'f1' : 'other' }));

describe('fetchReferencingNotes (fail-closed)', () => {
  it('returns referencing notes', async () => {
    expect(await fetchReferencingNotes(mockClient({ all: mk(3, 1) }), 'u', file)).toHaveLength(1);
  });
  it('finds a reference beyond a server max_rows cap (no silent truncation)', async () => {
    const c = mockClient({ all: mk(2500, 2400), cap: 1000 });
    expect(await fetchReferencingNotes(c, 'u', file)).toHaveLength(1);
    expect(c.calls).toBe(3);
  });
  it('copes with a server cap far below the page size', async () => {
    const c = mockClient({ all: mk(350, 349), cap: 100 });
    expect(await fetchReferencingNotes(c, 'u', file)).toHaveLength(1);
  });
  it('throws when count is missing', async () => {
    await expect(fetchReferencingNotes(mockClient({ all: mk(3), count: null }), 'u', file)).rejects.toThrow(/exact count/);
  });
  it('throws when count says more rows exist but server returns none', async () => {
    await expect(fetchReferencingNotes(mockClient({ all: mk(3), count: 10 }), 'u', file)).rejects.toThrow(/empty/);
  });
  it('throws when count changes between pages', async () => {
    const c = mockClient({ all: mk(2500), cap: 1000, count: (n) => (n === 1 ? 2500 : 2600) });
    await expect(fetchReferencingNotes(c, 'u', file)).rejects.toThrow(/changed/);
  });
  it('throws when the page cap is reached before reading everything', async () => {
    const c = mockClient({ all: mk(3000), cap: 1, count: 3000 });
    await expect(fetchReferencingNotes(c, 'u', file)).rejects.toThrow(/Too many/);
    expect(c.calls).toBe(NOTE_REF_MAX_PAGES);
  });
  it('throws on query error', async () => {
    await expect(fetchReferencingNotes(mockClient({ all: [], error: new Error('rls') }), 'u', file)).rejects.toThrow('rls');
  });
  it('throws on timeout', async () => {
    await expect(fetchReferencingNotes(mockClient({ all: [], hang: true }), 'u', file, 10)).rejects.toThrow('aborted');
  });
  it('validates inputs', async () => {
    await expect(fetchReferencingNotes(mockClient({ all: [] }), '', file)).rejects.toThrow();
  });
});
