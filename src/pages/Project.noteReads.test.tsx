import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createFakeSupabase, FakeResult, RecordedQuery } from '../test/fakeSupabase';

const stable = vi.hoisted(() => ({
  auth: { user: { id: 'project-owner' }, getAccessToken: async () => 'synthetic-token' },
  language: { appLanguage: 'en', t: (key: string) => key },
  deleteResult: { data: null as unknown, error: null as { message: string } | null },
  fake: null as unknown,
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => stable.auth }));
vi.mock('../context/LanguageContext', () => ({ useLanguage: () => stable.language }));
vi.mock('../lib/noteImages', () => ({ getNoteImageCounts: async () => ({}) }));
vi.mock('../components/NoteImageAttachments', () => ({ default: () => null }));
vi.mock('../components/TranscriptDiarizedEditor', () => ({ default: () => null, getTranscriptSpeakerFilters: () => [], TranscriptSpeakerFilterControls: () => null }));
vi.mock('../config/supabaseConfig', async () => {
  const { createFakeSupabase } = await import('../test/fakeSupabase');
  const fake = createFakeSupabase((q: RecordedQuery): FakeResult => {
    if (q.calls.some((c) => c[0] === 'delete')) return stable.deleteResult;
    if (q.table === 'project') return { data: { id: 'fixture-project', user_id: 'project-owner', name: 'Fixture project', notes: ['fixture-note'] } };
    if (q.table === 'note') return { data: [{ id: 'fixture-note', name: 'Original title', summary: 'S', user_id: 'project-owner', projects: ['fixture-project'] }] };
    return { data: [] };
  });
  stable.fake = fake;
  return { supabase: fake.client };
});
import Project from './Project';

const fake = () => stable.fake as ReturnType<typeof createFakeSupabase>;
const noteQueries = () => fake().queries.filter((q) => q.table === 'note');
beforeEach(() => { fake().queries.length = 0; stable.deleteResult = { data: null, error: null }; });
afterEach(cleanup);
const mount = (search = '?id=fixture-project') => render(<MemoryRouter initialEntries={[`/project${search}`]}><Project /></MemoryRouter>);

describe('Project note read and delete call contract', () => {
  it('loads project notes by the project filter newest first', async () => {
    mount();
    await waitFor(() => expect(noteQueries().length).toBeGreaterThan(0));
    expect(noteQueries()[0].calls).toEqual([['select', '*'], ['contains', 'projects', ['fixture-project']], ['order', 'created_at', { ascending: false }]]);
  });
  it('loads the add-notes picker from owned and directly shared notes', async () => {
    mount('?id=fixture-project&addNotes=1');
    await waitFor(() => expect(noteQueries().length).toBe(2));
    const picker = noteQueries().find((q) => q.calls.some((c) => c[0] === 'or'))!;
    expect(picker.calls).toEqual([['select', '*'], ['or', 'user_id.eq.project-owner,shared_users.cs.{project-owner}'], ['order', 'created_at', { ascending: false }]]);
  });
  it('deletes an owned note scoped to the owner without a row check', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'projectNotes' }));
    await screen.findByText('Original title');
    fireEvent.click(screen.getByRole('button', { name: 'Note actions for Original title' }));
    fireEvent.click(screen.getByRole('button', { name: 'deleteNote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'delete' }));
    await waitFor(() => expect(noteQueries().some((q) => q.calls.some((c) => c[0] === 'delete'))).toBe(true));
    const del = noteQueries().find((q) => q.calls.some((c) => c[0] === 'delete'))!;
    expect(del.calls).toEqual([['delete'], ['eq', 'id', 'fixture-note'], ['eq', 'user_id', 'project-owner']]);
    await waitFor(() => expect(screen.queryByText('Original title')).not.toBeInTheDocument());
  });
  it('keeps the note listed and shows an Error message when delete fails', async () => {
    stable.deleteResult = { data: null, error: { message: 'delete denied' } };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'projectNotes' }));
    await screen.findByText('Original title');
    fireEvent.click(screen.getByRole('button', { name: 'Note actions for Original title' }));
    fireEvent.click(screen.getByRole('button', { name: 
'deleteNote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'delete' }));
    expect(await screen.findByText('Failed to delete note')).toBeInTheDocument();
    expect(screen.getAllByText('Original title').length).toBeGreaterThan(0);
  });
});
