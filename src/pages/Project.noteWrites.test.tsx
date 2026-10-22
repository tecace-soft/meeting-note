import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  user: { id: 'project-owner' } as { id: string } | null,
  noteOwner: 'note-owner',
  updateData: null as { id: string } | null,
  updateError: null as { message: string } | null,
  updates: [] as Array<{ patch: Record<string, string>; filters: Array<[string, unknown]>; selected: string | null }>,
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: fixture.user, getAccessToken: async () => 'synthetic-token' }) }));
vi.mock('../context/LanguageContext', () => ({ useLanguage: () => ({ appLanguage: 'en', t: (key: string) => key }) }));
vi.mock('../lib/noteImages', () => ({ getNoteImageCounts: async () => ({}) }));
vi.mock('../components/NoteImageAttachments', () => ({ default: () => null }));
vi.mock('../components/TranscriptDiarizedEditor', () => ({ default: () => null, getTranscriptSpeakerFilters: () => [], TranscriptSpeakerFilterControls: () => null }));
vi.mock('../config/supabaseConfig', () => ({
  supabase: {
    from(table: string) {
      let mutation: (typeof fixture.updates)[number] | null = null;
      const result = () => mutation
        ? { data: fixture.updateData, error: fixture.updateError }
        : table === 'project'
          ? { data: { id: 'fixture-project', user_id: 'project-owner', name: 'Fixture project', notes: ['fixture-note'] }, error: null }
          : { data: table === 'note' ? [{ id: 'fixture-note', name: 'Original title', summary: 'Original summary', user_id: fixture.noteOwner, projects: ['fixture-project'] }] : [], error: null };
      const query: any = {
        select(columns: string) { if (mutation) mutation.selected = columns; return query; },
        update(patch: Record<string, string>) { mutation = { patch, filters: [], selected: null }; fixture.updates.push(mutation); return query; },
        eq(key: string, value: unknown) { mutation?.filters.push([key, value]); return query; },
        contains() { return query; }, order() { return query; },
        single: async () => result(), maybeSingle: async () => result(),
        then(resolve: any, reject: any) { return Promise.resolve(result()).then(resolve, reject); },
      };
      return query;
    },
  },
}));
import Project from './Project';

beforeEach(() => { fixture.user = { id: 'project-owner' }; fixture.noteOwner = 'note-owner'; fixture.updateData = null; fixture.updateError = null; fixture.updates.length = 0; });
afterEach(cleanup);
async function openProject() {
  render(<MemoryRouter initialEntries={['/project?id=fixture-project']}><Project /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'projectNotes' }));
  await screen.findByText('Original title');
}
async function editSummary() {
  await openProject();
  fireEvent.click(screen.getByText('Original title'));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByDisplayValue('Original summary'), { target: { value: 'Changed summary' } });
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
}
async function renameNote() {
  await openProject();
  fireEvent.click(screen.getByRole('button', { name: 'Note actions for Original title' }));
  fireEvent.click(screen.getByRole('button', { name: 'Rename Note' }));
  const input = screen.getByDisplayValue('Original title');
  fireEvent.change(input, { target: { value: 'Changed title' } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('T2-1 Project note write regression', () => {
  it('does not close summary editor or claim success when UPDATE returns zero rows', async () => {
    await editSummary();
    await waitFor(() => expect(fixture.updates).toHaveLength(1));
    expect(await screen.findByText(/권한이 없을 수/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Changed summary')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
  it('keeps the rename input and reports failure when UPDATE returns zero rows', async () => {
    await renameNote();
    expect(await screen.findByText(/권한이 없을 수/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Changed title')).toBeInTheDocument();
    expect(screen.queryByTitle('Changed title')).not.toBeInTheDocument();
  });
  it('only updates the displayed summary after a returned row confirms success', async () => {
    fixture.noteOwner = 'project-owner';
    fixture.updateData = { id: 'fixture-note' };
    await editSummary();
    await waitFor(() => expect(screen.queryByDisplayValue('Changed summary')).not.toBeInTheDocument());
    expect(screen.getByText('Changed summary')).toBeInTheDocument();
    expect(fixture.updates[0]).toEqual({ patch: { summary_edit: 'Changed summary' }, filters: [['id', 'fixture-note'], ['user_id', 'project-owner']], selected: 'id' });
  });
  it('only updates the displayed title after a returned row confirms success', async () => {
    fixture.noteOwner = 'project-owner';
    fixture.updateData = { id: 'fixture-note' };
    await renameNote();
    expect(await screen.findByTitle('Changed title')).toBeInTheDocument();
    expect(fixture.updates[0]).toEqual({ patch: { name: 'Changed title' }, filters: [['id', 'fixture-note'], ['user_id', 'project-owner']], selected: 'id' });
  });
  it('missing identity prevents the summary mutation and retains the edit', async () => {
    fixture.user = null;
    await editSummary();
    expect(await screen.findByText(/인증/)).toBeInTheDocument();
    expect(fixture.updates).toHaveLength(0);
    expect(screen.getByDisplayValue('Changed summary')).toBeInTheDocument();
  });
  it('shows database errors and retains the summary draft', async () => {
    fixture.updateError = { message: 'Fixture write failure' };
    await editSummary();
    expect(await screen.findByText('Fixture write failure')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Changed summary')).toBeInTheDocument();
  });
});
