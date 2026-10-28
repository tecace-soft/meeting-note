import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptSegment } from '../../lib/transcriptSegments';
import type { RegenerateSummaryResult } from '../../lib/regenerateSummary';
import {
  MAX_AUTO_NAME_REFRESHES_PER_NOTE,
  NAME_REFRESH_DEBOUNCE_MS,
  useSummaryNameRefresh,
  type SummaryNameRefreshInput,
} from './useSummaryNameRefresh';

// A: 60s, B: 35s, C: 5s (C is a minor speaker).
const transcript = (a = 'Speaker A', b = 'Speaker B', c = 'Speaker C'): TranscriptSegment[] => [
  { speaker: a, speakerKey: 'Speaker A', text: 'a1', start: 0, end: 30 },
  { speaker: b, speakerKey: 'Speaker B', text: 'b1', start: 30, end: 65 },
  { speaker: c, speakerKey: 'Speaker C', text: 'c1', start: 65, end: 70 },
  { speaker: a, speakerKey: 'Speaker A', text: 'a2', start: 70, end: 100 },
];

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Props = Partial<SummaryNameRefreshInput>;

function setup(initial: Props = {}) {
  const regenerate = vi.fn(
    async (_segments: TranscriptSegment[], _signal: AbortSignal): Promise<RegenerateSummaryResult> => ({
      summary: 'Named summary',
      persisted: false,
    })
  );
  const readSavedEdit = vi.fn(async (): Promise<string | null> => null);
  const saveSummary = vi.fn(async () => undefined);
  const onApply = vi.fn();
  const base: SummaryNameRefreshInput = {
    noteId: 'n1',
    segments: transcript(),
    generatedTexts: ['Generic summary'],
    currentSummary: 'Generic summary',
    isEditing: false,
    regenerate,
    readSavedEdit,
    saveSummary,
    onApply,
  };
  const view = renderHook((props: Props) => useSummaryNameRefresh({ ...base, ...props }), { initialProps: initial });
  // Later props merge into the earlier ones, like a parent that changes one value at a time.
  let current: Props = initial;
  const rerender = (next: Props) => {
    current = { ...current, ...next };
    view.rerender(current);
  };
  return { ...view, rerender, regenerate, readSavedEdit, saveSummary, onApply, base };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function passDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(NAME_REFRESH_DEBOUNCE_MS);
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useSummaryNameRefresh trigger', () => {
  it('does nothing while a main speaker is still unnamed, even if minor ones are named', async () => {
    const { rerender, regenerate, result } = setup();
    rerender({ segments: transcript('Andrew', 'Speaker B', 'Jin') });
    await passDebounce();
    expect(regenerate).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
  });

  it('regenerates once, after the debounce, when every main speaker is named', async () => {
    const { rerender, regenerate, saveSummary, onApply, result } = setup();
    const named = transcript('Andrew', 'Hansoo');
    rerender({ segments: named });
    expect(result.current.phase).toBe('scheduled');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NAME_REFRESH_DEBOUNCE_MS - 1);
    });
    expect(regenerate).not.toHaveBeenCalled();
    await passDebounce();
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(regenerate.mock.calls[0][0]).toEqual(named);
    expect(saveSummary).toHaveBeenCalledWith('Named summary');
    expect(onApply).toHaveBeenCalledWith('Named summary');
    expect(result.current.phase).toBe('idle');
    await passDebounce();
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it('restarts the debounce on each naming change and uses the latest names', async () => {
    const { rerender, regenerate } = setup();
    rerender({ segments: transcript('Andrew', 'Hansoo') });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NAME_REFRESH_DEBOUNCE_MS - 500);
    });
    rerender({ segments: transcript('Andrew', 'Mina') });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NAME_REFRESH_DEBOUNCE_MS - 500);
    });
    expect(regenerate).not.toHaveBeenCalled();
    await passDebounce();
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(regenerate.mock.calls[0][0]).toEqual(transcript('Andrew', 'Mina'));
  });

  it('refreshes again after a later rename, but not for the same names', async () => {
    const { rerender, regenerate } = setup();
    rerender({ segments: transcript('Andrew', 'Hansoo') });
    await passDebounce();
    rerender({ segments: transcript('Andrew', 'Hansoo') });
    await passDebounce();
    expect(regenerate).toHaveBeenCalledTimes(1);
    rerender({ segments: transcript('Andrew', 'Mina') });
    await passDebounce();
    expect(regenerate).toHaveBeenCalledTimes(2);
  });

  it('never overlaps requests; a rename during a request refreshes after it ends', async () => {
    const first = deferred<RegenerateSummaryResult>();
    const { rerender, regenerate, result } = setup();
    regenerate.mockImplementationOnce(() => first.promise);
    rerender({ segments: transcript('Andrew', 'Hansoo') });
    await passDebounce();
    expect(result.current.phase).toBe('running');
    rerender({ segments: transcript('Andrew', 'Mina') });
    await passDebounce();
    expect(regenerate).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve({ summary: 'First', persisted: false });
    });
    await flush();
    await passDebounce();
    expect(regenerate).toHaveBeenCalledTimes(2);
    expect(regenerate.mock.calls[1][0]).toEqual(transcript('Andrew', 'Mina'));
  });

  it(`stops automatic refreshes after ${MAX_AUTO_NAME_REFRESHES_PER_NOTE} per note and keeps the manual button`, async () => {
    const { rerender, regenerate, result } = setup();
    const names = ['Hansoo', 'Mina', 'Jin', 'Sora'];
    for (const name of names) {
      rerender({ segments: transcript('Andrew', name) });
      await passDebounce();
    }
    expect(regenerate).toHaveBeenCalledTimes(MAX_AUTO_NAME_REFRESHES_PER_NOTE);
    expect(result.current.autoPaused).toBe(true);
    await act(async () => {
      result.current.runManual();
    });
    await flush();
    expect(regenerate).toHaveBeenCalledTimes(MAX_AUTO_NAME_REFRESHES_PER_NOTE + 1);
  });

  it('aborts the request and clears the timer on unmount', async () => {
    const pending = deferred<RegenerateSummaryResult>();
    const { rerender, regenerate, unmount, onApply } = setup();
    regenerate.mockImplementationOnce(() => pending.promise);
    rerender({ segments: transcript('Andrew', 'Hansoo') });
    await passDebounce();
    const signal = regenerate.mock.calls[0][1];
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      pending.resolve({ summary: 'Late', persisted: false });
    });
    expect(onApply).not.toHaveBeenCalled();
  });

  it('resets when the note changes and does not fire for the old note', async () => {
    const { rerender, regenerate } = setup();
    rerender({ segments: transcript('Andrew', 'Hansoo') });
    rerender({ noteId: null, segments: [] });
    await passDebounce();
    expect(regenerate).not.toHaveBeenCalled();
  });
});

describe('useSummaryNameRefresh hand edits', () => {
  it('shows a replace notice instead of overwriting a summary edited on this page', async () => {
    const { rerender, saveSummary, onApply, result } = setup({ currentSummary: 'My own words' });
    rerender({ segments: transcript('Andrew', 'Hansoo') });
    await passDebounce();
    expect(onApply).not.toHaveBeenCalled();
    expect(saveSummary).not.toHaveBeenCalled();
    expect(result.current.pendingReplacement).toBe('Named summary');
    await act(async () => {
      await result.current.acceptReplacement();
    });
    expect(saveSummary).toHaveBeenCalledWith('Named summary');
    expect(onApply).toHaveBeenCalledWith('Named summary');
    expect(result.current.pendingReplacement).toBeNull();
  });

  it('treats an open editor as a hand edit', async () => {
    const { rerender, onApply, result } = setup({ isEditing: true });
    rerender({ segments: transcript('Andrew', 'Hansoo') });
    await passDebounce();
    expect(onApply).not.toHaveBeenCalled();
    expect(result.current.pendingReplacement).toBe('Named summary');
  });

  it('treats a saved edit from another tab as a hand edit, and an unreadable note too', async () => {
    const other = setup();
    other.readSavedEdit.mockResolvedValue('Edited elsewhere');
    other.rerender({ segments: transcript('Andrew', 'Hansoo') });
    await passDebounce();
    expect(other.onApply).not.toHaveBeenCalled();
    expect(other.result.current.pendingReplacement).toBe('Named summary');
    other.unmount();

    const unreadable = setup();
    unreadable.readSavedEdit.mockRejectedValue(new Error('down'));
    unreadable.rerender({ segments: transcript('Andrew', 'Hansoo') });
    await passDebounce();
    expect(unreadable.onApply).not.toHaveBeenCalled();
    expect(unreadable.result.current.pendingReplacement).toBe('Named summary');
  });

  it('does not treat a previous auto refresh as a hand edit', async () => {
    const { rerender, readSavedEdit, onApply } = setup();
    rerender({ segments: transcript('Andrew', 'Hansoo') });
    await passDebounce();
    readSavedEdit.mockResolvedValue('Named summary');
    rerender({ segments: transcript('Andrew', 'Mina'), currentSummary: 'Named summary' });
    await passDebounce();
    expect(onApply).toHaveBeenCalledTimes(2);
  });

  it('dismissing keeps the edit and does not ask again for the same names', async () => {
    const { rerender, regenerate, result, onApply } = setup({ currentSummary: 'My own words' });
    rerender({ segments: transcript('Andrew', 'Hansoo') });
    await passDebounce();
    act(() => result.current.dismissReplacement());
    expect(result.current.pendingReplacement).toBeNull();
    await passDebounce();
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('the manual button replaces even an edited summary', async () => {
    const { result, onApply, readSavedEdit } = setup({ currentSummary: 'My own words' });
    await act(async () => {
      result.current.runManual();
    });
    await flush();
    expect(readSavedEdit).not.toHaveBeenCalled();
    expect(onApply).toHaveBeenCalledWith('Named summary');
  });
});

describe('useSummaryNameRefresh failures', () => {
  it('keeps the old summary, shows the error and retries only when asked', async () => {
    const { rerender, regenerate, onApply, result } = setup();
    regenerate.mockRejectedValueOnce(new Error('Gemini is busy'));
    rerender({ segments: transcript('Andrew', 'Hansoo') });
    await passDebounce();
    expect(onApply).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Gemini is busy');
    await passDebounce();
    expect(regenerate).toHaveBeenCalledTimes(1);
    await act(async () => {
      result.current.retry();
    });
    await flush();
    expect(regenerate).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenCalledWith('Named summary');
    expect(result.current.error).toBeNull();
  });

  it('a failed save keeps the old summary and reports the error', async () => {
    const { rerender, saveSummary, onApply, result } = setup();
    saveSummary.mockRejectedValueOnce(new Error('Could not save'));
    rerender({ segments: transcript('Andrew', 'Hansoo') });
    await passDebounce();
    expect(onApply).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Could not save');
  });

  it('does not save again when the server already saved', async () => {
    const { rerender, regenerate, saveSummary, onApply } = setup();
    regenerate.mockResolvedValueOnce({ summary: 'Saved by server', persisted: true });
    rerender({ segments: transcript('Andrew', 'Hansoo') });
    await passDebounce();
    expect(saveSummary).not.toHaveBeenCalled();
    expect(onApply).toHaveBeenCalledWith('Saved by server');
  });
});
