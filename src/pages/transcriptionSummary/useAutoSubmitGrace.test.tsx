import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_SUBMIT_GRACE_SECONDS, useAutoSubmitGrace } from './useAutoSubmitGrace';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useAutoSubmitGrace', () => {
  it('counts down and calls onElapsed once with the source', async () => {
    const onElapsed = vi.fn();
    const { result } = renderHook(() => useAutoSubmitGrace(onElapsed));
    expect(result.current.secondsLeft).toBeNull();
    act(() => result.current.start('recording'));
    expect(result.current.secondsLeft).toBe(AUTO_SUBMIT_GRACE_SECONDS);
    expect(result.current.source).toBe('recording');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.secondsLeft).toBe(AUTO_SUBMIT_GRACE_SECONDS - 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_SUBMIT_GRACE_SECONDS * 1000);
    });
    expect(onElapsed).toHaveBeenCalledTimes(1);
    expect(onElapsed).toHaveBeenCalledWith('recording');
    expect(result.current.secondsLeft).toBeNull();
  });

  it('cancel means nothing is submitted', async () => {
    const onElapsed = vi.fn();
    const { result } = renderHook(() => useAutoSubmitGrace(onElapsed));
    act(() => result.current.start('upload'));
    act(() => result.current.cancel());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_SUBMIT_GRACE_SECONDS * 2000);
    });
    expect(onElapsed).not.toHaveBeenCalled();
    expect(result.current.secondsLeft).toBeNull();
  });

  it('a second start restarts the countdown instead of running two', async () => {
    const onElapsed = vi.fn();
    const { result } = renderHook(() => useAutoSubmitGrace(onElapsed));
    act(() => result.current.start('upload'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    act(() => result.current.start('recent'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_SUBMIT_GRACE_SECONDS * 1000);
    });
    expect(onElapsed).toHaveBeenCalledTimes(1);
    expect(onElapsed).toHaveBeenCalledWith('recent');
  });

  it('stops on unmount', async () => {
    const onElapsed = vi.fn();
    const { result, unmount } = renderHook(() => useAutoSubmitGrace(onElapsed));
    act(() => result.current.start('recording'));
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_SUBMIT_GRACE_SECONDS * 2000);
    });
    expect(onElapsed).not.toHaveBeenCalled();
  });
});
