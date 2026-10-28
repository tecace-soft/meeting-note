import { useCallback, useEffect, useRef, useState } from 'react';

/** Seconds the user can cancel before an automatic summary is submitted (U1, DEC-0024). */
export const AUTO_SUBMIT_GRACE_SECONDS = 5;
/** Recordings shorter than this never start a summary automatically (accidental taps). */
export const MIN_AUTO_SUMMARY_SECONDS = 5;

export type AutoSubmitSource = 'recording' | 'upload' | 'recent';

export interface AutoSubmitGrace {
  /** Seconds left before submission, or null when no countdown runs. */
  secondsLeft: number | null;
  source: AutoSubmitSource | null;
  start: (source: AutoSubmitSource) => void;
  /** Cancel before submission: nothing is sent to the server. */
  cancel: () => void;
}

/**
 * Countdown before an automatic summary submit. One countdown at a time; a new start restarts it.
 * The interval is cleared on cancel, on elapse and on unmount.
 */
export function useAutoSubmitGrace(onElapsed: (source: AutoSubmitSource) => void): AutoSubmitGrace {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [source, setSource] = useState<AutoSubmitSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onElapsedRef = useRef(onElapsed);
  onElapsedRef.current = onElapsed;

  const stop = useCallback(() => {
    if (timerRef.current !== null) clearInterval(timerRef.current);
    timerRef.current = null;
    setSecondsLeft(null);
    setSource(null);
  }, []);

  const start = useCallback(
    (next: AutoSubmitSource) => {
      stop();
      let remaining = AUTO_SUBMIT_GRACE_SECONDS;
      setSource(next);
      setSecondsLeft(remaining);
      timerRef.current = setInterval(() => {
        remaining -= 1;
        if (remaining > 0) {
          setSecondsLeft(remaining);
          return;
        }
        stop();
        onElapsedRef.current(next);
      }, 1000);
    },
    [stop]
  );

  useEffect(() => () => {
    if (timerRef.current !== null) clearInterval(timerRef.current);
  }, []);

  return { secondsLeft, source, start, cancel: stop };
}
