import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createFakeSupabase, RecordedQuery } from '../test/fakeSupabase';

// Real pages, transcript editor, sharing modal and repositories; only I/O boundaries are fake.
// Every async test has a five-second deadline; findBy/waitFor also have their one-second bound.
const h = vi.hoisted(() => {
  vi.stubEnv('VITE_WORKFLOW_API_URL', 'https://workflow.example.test');
  return {
    auth: { user: { id: 'owner', displayName: 'Owner' }, isAuthenticated: true, isLoading: false, getAccessToken: async () => 'synthetic-ms' },
    fake: null as unknown,
    owner: 'owner',
    shared: ['legacy-recipient'] as string[],
    zeroRows: false,
    beforeShareWrite: null as (() => void) | null,
    rejectRename: false,
    unknownIdentity: false,
    microsoftId: 'colleague-oid',
    contacts: [] as Array<{ id: string; displayName: string; email: string; userPrincipalName: string }>,
  };
});
vi.mock('../context/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('../context/LanguageContext', () => ({ useLanguage: () => ({ appLanguage: 'en', transcriptLanguage: 'original', t: (key: string) => key }) }));
vi.mock('../context/RecorderContext', () => ({ useRecorder: () => ({
  isRecording: false, recordingTime: 0, recordedAudioUrl: null, recordedBlob: null,
  recoverabilityStatus: 'protected', maxRecordingSeconds: 7200, releaseScreenWakeLock: async () => undefined,
}) }));
vi.mock('../components/ConfirmDialog', () => ({ useConfirm: () => async () => true }));
vi.mock('../config/msalConfig', () => ({ graphScopes: { calendar: [] } }));
vi.mock('../config/supabaseConfig', async () => {
  const { createFakeSupabase } = await import('../test/fakeSupabase');
  const fake = createFakeSupabase((q) => {
    if (q.table === 'note') {
      const update = q.calls.find(([m]) => m === 'update')?.[1] as Record<string, unknown> | undefined;
      if (update) {
        if ('shared_users' in update) {
          const concurrentChange = h.beforeShareWrite;
          h.beforeShareWrite = null;
          concurrentChange?.();
          const expected = q.calls.find(([m, column]) => m === 'eq' && column === 'shared_users');
          if (expected && expected[2] !== `{${h.shared.map((id) => JSON.stringify(id)).join(',')}}`) return { data: null };
          if (h.zeroRows || h.owner !== 'owner') return { data: null };
          h.shared = update.shared_users as string[];
        } else if (h.rejectRename) return { data: null };
        return { data: { id: 'note-1' } };
      }
      if (q.calls.some(([m, c]) => m === 'select' && c === 'user_id, shared_users')) {
        return { data: { user_id: h.owner, shared_users: h.shared } };
      }
      if (q.calls.some(([m]) => m === 'single' || m === 'maybeSingle')) return { data: { summary_edit: null } };
      return { data: [{ id: 'note-1', name: 'Sharing fixture', user_id: h.owner, shared_users: h.shared,
        created_at: '2026-10-28T10:00:00Z', meeting_at: '2026-10-28T10:00:00Z',
        summary: 'Fixture summary', diarization: [
          { speaker: 'Speaker A', speakerKey: 'Speaker A', text: 'The first update.', start: 0, end: 50 },
          { speaker: 'Speaker B', speakerKey: 'Speaker B', text: 'The second update.', start: 50, end: 100 },
        ] }], count: 1 };
    }
    if (q.table === 'speaker') {
      const inserted = q.calls.find(([m]) => m === 'insert')?.[1] as Record<string, unknown> | undefined;
      if (inserted) return { data: { id: 2, ...inserted } };
      return { data: [{ id: 1, name: 'Colleague', microsoft_id: h.unknownIdentity ? null : h.microsoftId }] };
    }
    if (q.table === 'summary_prompt') return { data: [{ id: 1, name: 'Default', prompt: 'Summarize.' }] };
    return { data: [] };
  });
  h.fake = fake;
  return { supabase: fake.client, getSupabaseAccessTokenForRequest: async () => 'synthetic-app', AUDIO_BUCKET: 'meeting-recordings', SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'synthetic-anon' };
});
vi.mock('../services/microsoftContacts', () => ({ fetchTecAceContacts: async () => h.contacts }));
vi.mock('../lib/identifySpeakers', async (original) => ({
  ...await original<typeof import('../lib/identifySpeakers')>(),
  requestSpeakerSuggestions: async () => [{ label: 'Speaker A', name: 'Colleague', speakerId: '1', confidence: 0.9, isSelf: false, rationale: 'fixture' }],
}));
vi.mock('../lib/accumulateSpeakerProfile', () => ({ accumulateSpeakerProfile: async () => null }));
vi.mock('../lib/speakerFeedback', () => ({ logSpeakerFeedback: async () => undefined }));
vi.mock('../lib/refreshNoteInsight', () => ({ scheduleNoteInsightRefresh: vi.fn() }));
vi.mock('../lib/recentAudioFilesQuery', () => ({ fetchRecentAudioFiles: async () => ({ data: [], error: null }) }));
vi.mock('../services/supabaseResumableUpload', () => ({ isSupabaseResumableConfigured: () => false, shouldUseResumableUpload: () => false }));
vi.mock('../lib/noteImages', () => ({ getNoteImageCounts: async () => ({}), uploadNoteImage: vi.fn() }));
vi.mock('../services/graphService', () => ({ getOutlookCalendarEvents: async () => [] }));
vi.mock('../services/meetingKnowledge', () => ({ meetingKnowledgeUiEnabled: false }));
vi.mock('../components/MeetingBriefing', () => ({ MeetingBriefing: () => null }));
vi.mock('../components/NoteImageAttachments', () => ({ default: () => null }));
vi.mock('../components/MeetingKnowledgeModal', () => ({ default: () => null }));
vi.mock('../components/AxkhIntegrationButton', () => ({ default: () => null, shouldShowAxkhEntry: () => false }));

import TranscriptionSummary from './TranscriptionSummary';
import SummaryHistory from './SummaryHistory';
import { resetSuggestionStoreForTests } from '../lib/speakers/suggestionStore';

const fake = () => h.fake as ReturnType<typeof createFakeSupabase>;
const shareWrites = () => fake().queries.filter((q) => q.table === 'note' && q.calls.some(([m, v]) => m === 'update' && 'shared_users' in (v as object)));
const diarizationWrites = () => fake().queries.filter((q) => q.table === 'note' && q.calls.some(([m, v]) => m === 'update' && 'diarization' in (v as object)));
const sharesIn = (q: RecordedQuery) => (q.calls.find(([m]) => m === 'update')?.[1] as { shared_users: string[] }).shared_users;

beforeEach(() => {
  window.localStorage.clear();
  resetSuggestionStoreForTests();
  h.owner = 'owner'; h.shared = ['legacy-recipient']; h.zeroRows = false; h.beforeShareWrite = null; h.rejectRename = false; h.unknownIdentity = false; h.microsoftId = 'colleague-oid'; h.contacts = [];
  fake().queries.length = 0;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.endsWith('/note-audio-url')) return Response.json({ url: 'https://audio.example.test/fixture' });
    if (input.includes('/summarize-audio/jobs/job-1')) return Response.json({ jobId: 'job-1', noteId: 'note-1', status: 'completed', result: {
      title: 'Sharing fixture', summary: 'Fixture summary', transcript: [
        { speaker: 'Speaker A', speakerKey: 'Speaker A', text: 'The first update.', start: 0, end: 50 },
        { speaker: 'Speaker B', speakerKey: 'Speaker B', text: 'The second update.', start: 50, end: 100 },
      ],
    } });
    throw new Error(`Unexpected offline request: ${input}`);
  }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mountPage(page: 'new' | 'history', transcript = true) {
  if (page === 'new') window.localStorage.setItem('meeting-note:active-summary-job', JSON.stringify({ jobId: 'job-1', noteId: 'note-1' }));
  render(<MemoryRouter>{page === 'new' ? <TranscriptionSummary /> : <SummaryHistory />}</MemoryRouter>);
  if (page === 'history') fireEvent.click((await screen.findAllByText('Sharing fixture'))[0]);
  await screen.findAllByText('Fixture summary');
  if (transcript) fireEvent.click((await screen.findAllByRole('tab', { name: 'transcription' }))[0]);
}
async function nameSpeaker(name = 'Colleague', pickSaved = true, label = 'Speaker A') {
  fireEvent.click(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-transcript-speaker-trigger]')).find((b) => b.textContent === label)!);
  const menu = await screen.findByRole('dialog', { name: 'Change Speaker' });
  await within(menu).findByText('Colleague');
  if (name === 'Colleague' && pickSaved) fireEvent.click(within(menu).getByText('Colleague', { exact: true }).closest('button')!);
  else fireEvent.change(within(menu).getByPlaceholderText('searchOrTypeSpeaker'), { target: { value: name } });
  fireEvent.click(within(menu).getByRole('button', { name: 'Change' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Change Speaker' })).not.toBeInTheDocument());
}

for (const page of ['new', 'history'] as const) describe(`${page}: U9-0 explicit note sharing`, () => {
  it('manual naming preserves shares and shows a separate one-click share action', async () => {
    await mountPage(page);
    await nameSpeaker();
    expect(diarizationWrites()).toHaveLength(1);
    expect(shareWrites()).toHaveLength(0);
    expect(h.shared).toEqual(['legacy-recipient']);
    const button = await screen.findByRole('button', { name: 'shareNoteWithThisPerson' });
    // Re-read on click so a recipient added since naming is preserved as well.
    h.shared.push('added-in-other-tab');
    fireEvent.click(button);
    await screen.findByText('noteAlreadyShared');
    expect(shareWrites()).toHaveLength(1);
    expect(sharesIn(shareWrites()[0])).toEqual(['legacy-recipient', 'added-in-other-tab', 'colleague-oid']);
    expect(shareWrites()[0].calls).toContainEqual(['eq', 'user_id', 'owner']);
    expect(shareWrites()[0].calls).toContainEqual(['select', 'id']);
  }, 5000);

  it('does not restore a recipient revoked by another tab between read and write', async () => {
    h.shared = ['legacy-recipient', 'still-shared'];
    await mountPage(page); await nameSpeaker();
    const button = await screen.findByRole('button', { name: 'shareNoteWithThisPerson' });
    h.beforeShareWrite = () => { h.shared = ['still-shared']; };
    fireEvent.click(button);
    await screen.findByText('noteAlreadyShared');
    expect(h.shared).toEqual(['still-shared', 'colleague-oid']);
    expect(shareWrites()).toHaveLength(2);
  }, 5000);

  it('preserves a recipient added by another tab between read and write', async () => {
    await mountPage(page); await nameSpeaker();
    const button = await screen.findByRole('button', { name: 'shareNoteWithThisPerson' });
    h.beforeShareWrite = () => { h.shared = [...h.shared, 'other-tab-recipient']; };
    fireEvent.click(button);
    await screen.findByText('noteAlreadyShared');
    expect(h.shared).toEqual(['legacy-recipient', 'other-tab-recipient', 'colleague-oid']);
    expect(shareWrites()).toHaveLength(2);
  }, 5000);

  it('does not offer sharing with the note owner themselves', async () => {
    h.microsoftId = 'owner';
    await mountPage(page); await nameSpeaker();
    expect(screen.queryByRole('button', { name: 'shareNoteWithThisPerson' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'selectNoteSharingTarget' })).not.toBeInTheDocument();
    expect(shareWrites()).toHaveLength(0);
  }, 5000);

  it('a name without an account opens the existing sharing dialog without writing shares', async () => {
    await mountPage(page);
    await nameSpeaker('Guest');
    fireEvent.click(await screen.findByRole('button', { name: 'selectNoteSharingTarget' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share note' });
    expect(within(dialog).getByText(/Select TecAce contacts/)).toBeInTheDocument();
    expect(shareWrites()).toHaveLength(0);
    expect(h.shared).toEqual(['legacy-recipient']);
  }, 5000);

  it('a zero-row share write shows an error, retains the name and allows retry', async () => {
    await mountPage(page); await nameSpeaker();
    h.zeroRows = true;
    fireEvent.click(await screen.findByRole('button', { name: 'shareNoteWithThisPerson' }));
    expect(await screen.findByText(/Could not share/)).toBeInTheDocument();
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-transcript-speaker-trigger]')).find((b) => b.textContent === 'Colleague')!).toBeInTheDocument();
    expect(h.shared).toEqual(['legacy-recipient']);
    expect(screen.queryByText('noteAlreadyShared')).not.toBeInTheDocument();
    h.zeroRows = false;
    fireEvent.click(screen.getByRole('button', { name: 'shareNoteWithThisPerson' }));
    await screen.findByText('noteAlreadyShared');
  }, 5000);

  it('accepting a suggestion also requires an explicit share click', async () => {
    await mountPage(page, page === 'history');
    if (page === 'history') fireEvent.click((await screen.findAllByRole('button', { name: 'suggestSpeakers' }))[0]);
    fireEvent.click((await screen.findAllByRole('button', { name: 'applySuggestion' }))[0]);
    await screen.findByRole('button', { name: 'shareNoteWithThisPerson' });
    expect(shareWrites()).toHaveLength(0);
    expect(diarizationWrites()).toHaveLength(1);
  }, 5000);

  it('typing a saved name does not infer its account identity', async () => {
    await mountPage(page); await nameSpeaker('Colleague', false);
    await screen.findByRole('button', { name: 'selectNoteSharingTarget' });
    expect(shareWrites()).toHaveLength(0);
  }, 5000);

  it('refuses sharing if ownership changed after the button was shown', async () => {
    await mountPage(page); await nameSpeaker();
    const button = await screen.findByRole('button', { name: 'shareNoteWithThisPerson' });
    h.owner = 'another-owner';
    fireEvent.click(button);
    await screen.findByText('Only the note owner can share this note.');
    expect(shareWrites()).toHaveLength(0);
  }, 5000);

  it('a failed name save never offers or attempts sharing', async () => {
    h.rejectRename = true;
    await mountPage(page);
    fireEvent.click(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-transcript-speaker-trigger]')).find((b) => b.textContent === 'Speaker A')!);
    const menu = await screen.findByRole('dialog', { name: 'Change Speaker' });
    fireEvent.click((await within(menu).findByText('Colleague', { exact: true })).closest('button')!);
    fireEvent.click(within(menu).getByRole('button', { name: 'Change' }));
    await waitFor(() => expect(diarizationWrites()).toHaveLength(1));
    expect(screen.getByRole('dialog', { name: 'Change Speaker' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'shareNoteWithThisPerson' })).not.toBeInTheDocument();
    expect(shareWrites()).toHaveLength(0);
  }, 5000);

  it('reset clears sharing offers without revoking existing shares', async () => {
    await mountPage(page); await nameSpeaker();
    await screen.findByRole('button', { name: 'shareNoteWithThisPerson' });
    fireEvent.click(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-transcript-speaker-trigger]')).find((b) => b.textContent === 'Colleague')!);
    fireEvent.click(await screen.findByRole('button', { name: 'resetSpeakers' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'shareNoteWithThisPerson' })).not.toBeInTheDocument());
    expect(shareWrites()).toHaveLength(0);
    expect(h.shared).toEqual(['legacy-recipient']);
  }, 5000);

  it('deduplicates the same recipient and keeps the action after all labels are named', async () => {
    await mountPage(page); await nameSpeaker();
    await nameSpeaker('Colleague', true, 'Speaker B');
    await screen.findByRole('button', { name: 'shareNoteWithThisPerson' });
    expect(screen.getAllByRole('button', { name: 'shareNoteWithThisPerson' })).toHaveLength(1);
    expect(screen.queryByText('suggestSpeakersTitle')).not.toBeInTheDocument();
    expect(shareWrites()).toHaveLength(0);
  }, 5000);

  it('a Microsoft contact assignment does not share and uses the selected object id', async () => {
    h.contacts = [{ id: 'contact-oid', displayName: 'Directory Person', email: 'person@example.test', userPrincipalName: 'person@example.test' }];
    await mountPage(page);
    fireEvent.click(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-transcript-speaker-trigger]')).find((b) => b.textContent === 'Speaker A')!);
    fireEvent.click(await screen.findByRole('button', { name: /Directory Person/ }));
    const button = await screen.findByRole('button', { name: 'shareNoteWithThisPerson' });
    expect(shareWrites()).toHaveLength(0);
    fireEvent.click(button);
    await screen.findByText('noteAlreadyShared');
    expect(sharesIn(shareWrites()[0])).toEqual(['legacy-recipient', 'contact-oid']);
  }, 5000);
});
