import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptSegment } from '../lib/transcriptSegments';

// U9 (DEC-0024): the transcript editor's suggestion card can request suggestions without a click,
// render alone above the summary ('only') or stay hidden ('hidden'). Applying a suggestion stays a
// user action and never shares the note (U9-0 guard re-checked here).

const h = vi.hoisted(() => ({
  request: null as unknown as ReturnType<typeof vi.fn>,
  setNoteSharedUsers: null as unknown as ReturnType<typeof vi.fn>,
  listSpeakers: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', displayName: 'Andrew' }, getAccessToken: async () => 'ms-token' }),
}));
vi.mock('../context/LanguageContext', () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
vi.mock('../config/supabaseConfig', () => ({
  getSupabaseAccessTokenForRequest: async () => 'app-token',
  SUPABASE_URL: 'https://example.test',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('../lib/notes/repository', () => {
  h.setNoteSharedUsers = vi.fn();
  return {
    getNoteSharing: vi.fn(),
    setNoteSharedUsers: (...a: unknown[]) => h.setNoteSharedUsers(...a),
    patchNoteReturningId: vi.fn(async () => ({ id: 'n1' })),
  };
});
vi.mock('../lib/speakers/repository', () => {
  h.listSpeakers = vi.fn(async () => [{ id: '1', name: 'Andrew' }]);
  return {
    deleteSpeaker: vi.fn(),
    findSpeakersByEmail: vi.fn(),
    findSpeakersByMicrosoftId: vi.fn(),
    insertContactSpeakerReturning: vi.fn(),
    insertSpeakerNameReturning: vi.fn(),
    listSpeakers: (...a: unknown[]) => h.listSpeakers(...a),
    updateSpeakerProfile: vi.fn(),
  };
});
vi.mock('../lib/identifySpeakers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/identifySpeakers')>();
  h.request = vi.fn();
  return { ...actual, requestSpeakerSuggestions: (...a: unknown[]) => h.request(...a) };
});
vi.mock('../lib/speakerFeedback', () => ({ logSpeakerFeedback: vi.fn(async () => undefined) }));
vi.mock('../lib/accumulateSpeakerProfile', () => ({ accumulateSpeakerProfile: vi.fn(async () => null) }));
vi.mock('../lib/refreshNoteInsight', () => ({ scheduleNoteInsightRefresh: vi.fn() }));
vi.mock('../services/microsoftContacts', () => ({ fetchTecAceContacts: vi.fn(async () => []) }));

import TranscriptDiarizedEditor from './TranscriptDiarizedEditor';
import { resetSuggestionStoreForTests } from '../lib/speakers/suggestionStore';

const SEGMENTS: TranscriptSegment[] = [
  { speaker: 'Speaker A', speakerKey: 'Speaker A', text: 'Hello Hansoo, thanks for joining.', start: 0, end: 5 },
  { speaker: 'Speaker B', speakerKey: 'Speaker B', text: 'Thanks Andrew.', start: 5, end: 8 },
];
const SUGGESTIONS = [
  { label: 'Speaker A', name: 'Andrew', speakerId: '1', confidence: 0.92, isSelf: true, rationale: 'self' },
  { label: 'Speaker B', name: 'Hansoo', speakerId: null, confidence: 0.9, isSelf: false, rationale: 'named' },
];

function renderEditor(props: Partial<React.ComponentProps<typeof TranscriptDiarizedEditor>> = {}) {
  const onSegmentsChange = vi.fn();
  const onPersistSegments = vi.fn(async () => undefined);
  const view = render(
    <TranscriptDiarizedEditor
      segments={SEGMENTS}
      noteId="n1"
      onSegmentsChange={onSegmentsChange}
      onPersistSegments={onPersistSegments}
      {...props}
    />
  );
  return { ...view, onSegmentsChange, onPersistSegments };
}

beforeEach(() => {
  resetSuggestionStoreForTests();
  h.request.mockReset();
  h.request.mockResolvedValue(SUGGESTIONS);
  h.setNoteSharedUsers.mockReset();
});
afterEach(() => cleanup());

describe('TranscriptDiarizedEditor suggestion card', () => {
  it('keeps the click-to-suggest default (no request until Suggest is pressed)', async () => {
    renderEditor();
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.request).not.toHaveBeenCalled();
    expect(screen.getByText('Hello Hansoo, thanks for joining.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'suggestSpeakers' }));
    await screen.findByText('Hansoo');
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('suggestionsNotInSummaryHint')).not.toBeInTheDocument();
  });

  it("'only' with autoSuggest shows suggestions without a click and without the transcript", async () => {
    const onReviewSpeakers = vi.fn();
    renderEditor({ autoSuggest: true, suggestionPanel: 'only', onReviewSpeakers });
    await screen.findByText('Hansoo');
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls[0][4]).toBe('n1');
    expect(h.request.mock.calls[0][5]).toBeInstanceOf(AbortSignal);
    expect(screen.queryByText('Hello Hansoo, thanks for joining.')).not.toBeInTheDocument();
    expect(screen.getByText('suggestionsNotInSummaryHint')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'editSpeakerNamesInTranscript' }));
    expect(onReviewSpeakers).toHaveBeenCalledTimes(1);
  });

  it('applying a suggestion saves the names, updates the parent and never shares the note', async () => {
    const { onPersistSegments, onSegmentsChange } = renderEditor({ autoSuggest: true, suggestionPanel: 'only' });
    await screen.findByText('Hansoo');
    const applyButtons = screen.getAllByRole('button', { name: 'applySuggestion' });
    fireEvent.click(applyButtons[1]);
    await waitFor(() => expect(onSegmentsChange).toHaveBeenCalled());
    const saved = (onPersistSegments.mock.calls[0] as unknown as [TranscriptSegment[]])[0];
    expect(saved.map((s) => s.speaker)).toEqual(['Speaker A', 'Hansoo']);
    expect(saved.map((s) => s.speakerKey)).toEqual(['Speaker A', 'Speaker B']);
    expect(h.setNoteSharedUsers).not.toHaveBeenCalled();
  });

  it("'hidden' shows the transcript without the card, and a second editor reuses the cached result", async () => {
    renderEditor({ autoSuggest: true, suggestionPanel: 'only' });
    await screen.findByText('Hansoo');
    cleanup();
    renderEditor({ autoSuggest: true, suggestionPanel: 'hidden' });
    expect(screen.getByText('Hello Hansoo, thanks for joining.')).toBeInTheDocument();
    expect(screen.queryByText('suggestSpeakersTitle')).not.toBeInTheDocument();
    renderEditor({ autoSuggest: true });
    expect(await screen.findByText('Hansoo')).toBeInTheDocument();
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('hides the card once every label has a name', async () => {
    renderEditor({
      autoSuggest: true,
      segments: SEGMENTS.map((s, i) => ({ ...s, speaker: i === 0 ? 'Andrew' : 'Hansoo' })),
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText('suggestSpeakersTitle')).not.toBeInTheDocument();
    expect(h.request).not.toHaveBeenCalled();
  });
});
