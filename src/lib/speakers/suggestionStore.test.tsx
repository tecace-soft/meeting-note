import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeakerSuggestion } from '../identifySpeakers';
import type { TranscriptSegment } from '../transcriptSegments';
import {
  SUGGESTION_TIMEOUT_MS,
  resetSuggestionStoreForTests,
  transcriptRevision,
  useSpeakerSuggestions,
  type SuggestionFetcher,
} from './suggestionStore';

const segs = (a = 'Speaker A', b = 'Speaker B'): TranscriptSegment[] => [
  { speaker: a, speakerKey: 'Speaker A', text: 'Hello Hansoo.', start: 0, end: 5 },
  { speaker: b, speakerKey: 'Speaker B', text: 'Hi Andrew.', start: 5, end: 9 },
];
const suggestion = (label: string, name: string | null): SpeakerSuggestion => ({
  label,
  name,
  speakerId: name ? `id-${name}` : null,
  confidence: 0.9,
  isSelf: false,
  rationale: '',
});
const BOTH = [suggestion('Speaker A', 'Andrew'), suggestion('Speaker B', 'Hansoo')];

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type Props = { noteId: string | null; segments: TranscriptSegment[]; autoSuggest: boolean; fetcher: SuggestionFetcher };
function setup(initial: Partial<Props> = {}) {
  const fetcher = (initial.fetcher as ReturnType<typeof vi.fn<SuggestionFetcher>> | undefined) ?? vi.fn<SuggestionFetcher>(async () => BOTH);
  let current: Props = { noteId: 'n1', segments: segs(), autoSuggest: false, ...initial, fetcher };
  const view = renderHook((p: Props) => useSpeakerSuggestions(p), { initialProps: current });
  const rerender = (next: Partial<Props>) => {
    current = { ...current, ...next };
    view.rerender(current);
  };
  return { ...view, rerender, fetcher };
}

beforeEach(() => {
  resetSuggestionStoreForTests();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('transcriptRevision', () => {
  it('ignores display-name renames but changes when text or speaker keys change', () => {
    const base = transcriptRevision(segs());
    expect(transcriptRevision(segs('Andrew', 'Hansoo'))).toBe(base);
    expect(transcriptRevision([{ ...segs()[0], text: 'Hello there.' }, segs()[1]])).not.toBe(base);
    expect(transcriptRevision([{ ...segs()[0], speakerKey: 'Speaker C' }, segs()[1]])).not.toBe(base);
  });
});

describe('useSpeakerSuggestions', () => {
  it('starts empty and loads on request', async () => {
    const { result, fetcher } = setup();
    expect(result.current.suggestions).toBeNull();
    await act(async () => {
      await result.current.requestSuggestions();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.suggestions).toEqual(BOTH);
  });

  it('auto-suggests once per note, without a click', async () => {
    const { result, fetcher, unmount } = setup({ autoSuggest: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.suggestions).toEqual(BOTH);
    unmount();
    // A remount (tab switch, second panel) reads the cache instead of calling the model again.
    const again = setup({ autoSuggest: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(again.fetcher).not.toHaveBeenCalled();
    expect(again.result.current.suggestions).toEqual(BOTH);
  });

  it('does not auto-suggest when every label already has a name, or without a note', async () => {
    const named = setup({ autoSuggest: true, segments: segs('Andrew', 'Hansoo') });
    const noNote = setup({ autoSuggest: true, noteId: null });
    await act(async () => {
      await Promise.resolve();
    });
    expect(named.fetcher).not.toHaveBeenCalled();
    expect(noNote.fetcher).not.toHaveBeenCalled();
  });

  it('shares one in-flight request between two panels of the same note', async () => {
    const pending = deferred<SpeakerSuggestion[]>();
    const fetcher = vi.fn<SuggestionFetcher>(() => pending.promise);
    const first = setup({ autoSuggest: true, fetcher });
    const second = setup({ autoSuggest: true, fetcher });
    await act(async () => {
      await Promise.resolve();
    });
    expect(first.result.current.suggesting).toBe(true);
    expect(second.result.current.suggesting).toBe(true);
    await act(async () => {
      await second.result.current.requestSuggestions();
    });
    expect(first.fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(BOTH);
    });
    expect(first.result.current.suggestions).toEqual(BOTH);
    expect(second.result.current.suggestions).toEqual(BOTH);
  });

  it('hides a suggestion once its label has a name, so a late suggestion never covers an edit', async () => {
    const { result, rerender } = setup();
    await act(async () => {
      await result.current.requestSuggestions();
    });
    rerender({ segments: segs('Mina') });
    expect(result.current.suggestions).toEqual([BOTH[1]]);
    expect(result.current.allSuggestions).toEqual(BOTH);
  });

  it('drops suggestions when the transcript text changes and does not auto-run again', async () => {
    const { result, rerender, fetcher } = setup({ autoSuggest: true });
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ segments: [{ ...segs()[0], text: 'Edited text.' }, segs()[1]] });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.suggestions).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('re-suggest forces a new request', async () => {
    const { result, fetcher } = setup();
    await act(async () => {
      await result.current.requestSuggestions();
    });
    fetcher.mockResolvedValueOnce([suggestion('Speaker A', 'Mina')]);
    await act(async () => {
      await result.current.requestSuggestions({ force: true });
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.suggestions).toEqual([suggestion('Speaker A', 'Mina')]);
  });

  it('reports errors and allows a manual retry', async () => {
    const { result, fetcher } = setup();
    fetcher.mockRejectedValueOnce(new Error('identify failed'));
    await act(async () => {
      await result.current.requestSuggestions();
    });
    expect(result.current.error).toBe('identify failed');
    expect(result.current.suggestions).toBeNull();
    await act(async () => {
      await result.current.requestSuggestions();
    });
    expect(result.current.suggestions).toEqual(BOTH);
    expect(result.current.error).toBeNull();
  });

  it('times out even when a step ignores the abort signal (token, roster)', async () => {
    vi.useFakeTimers();
    const { result, fetcher } = setup();
    fetcher.mockImplementation(() => new Promise<never>(() => undefined));
    let done!: Promise<void>;
    act(() => {
      done = result.current.requestSuggestions();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGESTION_TIMEOUT_MS + 1);
      await done;
    });
    expect(result.current.error).toMatch(/timed out/);
    expect(result.current.suggesting).toBe(false);
    expect((fetcher.mock.calls[0][0] as AbortSignal).aborted).toBe(true);
  });

  it('times out a request that never answers', async () => {
    vi.useFakeTimers();
    const { result, fetcher } = setup();
    fetcher.mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    let done!: Promise<void>;
    act(() => {
      done = result.current.requestSuggestions();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGESTION_TIMEOUT_MS + 1);
      await done;
    });
    expect(result.current.error).toMatch(/timed out/);
    expect(result.current.suggesting).toBe(false);
  });
});
