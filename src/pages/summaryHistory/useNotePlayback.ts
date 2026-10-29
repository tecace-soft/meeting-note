import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { requestNoteAudioUrl } from '../../lib/noteAudioUrl';
import { getNoteDiarizationRaw, normalizeTranscript, type TranscriptSegment } from '../../lib/transcriptSegments';
import type { Note } from './types';

export interface SegmentPlaybackState {
  noteId: string;
  segmentIndex: number;
  speaker: string;
  start: number;
  end: number | null;
  currentTime: number;
  isPlaying: boolean;
}

export const formatPlaybackTime = (seconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
};

export const isPlayableSegment = (segment: TranscriptSegment): boolean =>
  typeof segment.start === 'number' && Number.isFinite(segment.start) && segment.start >= 0;

export interface UseNotePlaybackOptions {
  /** The note whose detail pane is open; its audio URL is preloaded and playback of other notes stops. */
  selectedNote: Note | null;
  /** Microsoft token provider, used when no app token is available. */
  getAccessToken: () => Promise<string | null>;
}

/**
 * Transcript segment playback for the history page: the note audio signed-URL request and cache, the
 * play / stop state shown by the transcript editor, and the handlers of the page's hidden audio element.
 *
 * Cache the URL until a metadata load fails; invalidate only that note and sign once more.
 * A second load failure resets playback, and every metadata attempt has a fifteen-second bound.
 */
export function useNotePlayback({ selectedNote, getAccessToken }: UseNotePlaybackOptions) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlCacheRef = useRef<Map<string, string>>(new Map());
  const playbackLoadRef = useRef<AbortController | null>(null);
  const audioUrlGenerationRef = useRef<Map<string, number>>(new Map());
  const playbackStopAtRef = useRef<number | null>(null);
  const [segmentPlayback, setSegmentPlayback] = useState<SegmentPlaybackState | null>(null);
  const [playbackLoadingSegment, setPlaybackLoadingSegment] = useState<{ noteId: string; segmentIndex: number } | null>(null);

  const getNoteAudioUrl = async (note: Note, signal?: AbortSignal): Promise<string> => {
    const cached = audioUrlCacheRef.current.get(note.id);
    if (cached) return cached;
    const generation = (audioUrlGenerationRef.current.get(note.id) ?? 0) + 1;
    audioUrlGenerationRef.current.set(note.id, generation);
    const url = await requestNoteAudioUrl(note.id, getAccessToken, signal);
    // An old preload must not restore a URL discarded by a later retry.
    if (!signal?.aborted && audioUrlGenerationRef.current.get(note.id) === generation) {
      audioUrlCacheRef.current.set(note.id, url);
    }
    return url;
  };

  useEffect(() => {
    if (!selectedNote) return;
    const segments = normalizeTranscript(getNoteDiarizationRaw(selectedNote));
    if (!segments.some(isPlayableSegment)) return;
    void getNoteAudioUrl(selectedNote).catch((error) => {
      console.warn('Could not preload note audio URL:', error);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- preload only when the selected note id changes
  }, [selectedNote?.id]);

  useEffect(() => {
    const loadRef = playbackLoadRef;
    return () => { loadRef.current?.abort(); };
  }, []);

  const stopSegmentPlayback = () => {
    playbackLoadRef.current?.abort();
    playbackLoadRef.current = null;
    setPlaybackLoadingSegment(null);
    const audio = audioRef.current;
    if (audio) audio.pause();
    playbackStopAtRef.current = null;
    setSegmentPlayback(null);
  };

  const getAudioErrorMessage = (audio: HTMLAudioElement): string => {
    const code = audio.error?.code;
    const detail =
      code === MediaError.MEDIA_ERR_ABORTED ? 'loading was aborted' :
      code === MediaError.MEDIA_ERR_NETWORK ? 'a network error occurred' :
      code === MediaError.MEDIA_ERR_DECODE ? 'the browser could not decode this audio file' :
      code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? 'the audio URL or format is not supported by this browser' :
      'the browser did not provide a media error code';
    return `Audio file could not be loaded: ${detail}.`;
  };

  const loadAudioMetadata = (audio: HTMLAudioElement, url: string, signal: AbortSignal, force: boolean): Promise<void> => {
    if (signal.aborted) return Promise.reject(new DOMException('Playback cancelled.', 'AbortError'));
    if (!force && !audio.error && audio.src === url && audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timeout);
        audio.removeEventListener('loadedmetadata', onLoaded);
        audio.removeEventListener('canplay', onLoaded);
        audio.removeEventListener('error', onError);
        signal.removeEventListener('abort', onAbort);
      };
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(getAudioErrorMessage(audio)));
      };
      const onAbort = () => { cleanup(); reject(new DOMException('Playback cancelled.', 'AbortError')); };
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Audio metadata did not load. The audio URL may be expired, blocked, or not playable in this browser.'));
      }, 15000);

      audio.addEventListener('loadedmetadata', onLoaded, { once: true });
      audio.addEventListener('canplay', onLoaded, { once: true });
      audio.addEventListener('error', onError, { once: true });
      signal.addEventListener('abort', onAbort, { once: true });

      if (audio.src !== url) {
        audio.src = url;
      }
      audio.load();
    });
  };

  useEffect(() => {
    if (!selectedNote || segmentPlayback?.noteId === selectedNote.id) return;
    stopSegmentPlayback();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a media error clears playback state during retry; only a selection change cancels it
  }, [selectedNote?.id]);

  const playTranscriptSegment = async (note: Note, segment: TranscriptSegment, segmentIndex: number) => {
    if (!isPlayableSegment(segment)) return;
    const start = segment.start ?? 0;
    const end = typeof segment.end === 'number' && Number.isFinite(segment.end) && segment.end > start
      ? segment.end
      : null;

    const audio = audioRef.current;
    if (!audio) return;

    if (segmentPlayback?.noteId === note.id && segmentPlayback.segmentIndex === segmentIndex && segmentPlayback.isPlaying) {
      stopSegmentPlayback();
      return;
    }

    playbackLoadRef.current?.abort();
    const controller = new AbortController();
    playbackLoadRef.current = controller;
    const isCurrent = () => !controller.signal.aborted && playbackLoadRef.current === controller;
    const playing = { noteId: note.id, segmentIndex, speaker: segment.speaker.trim() || 'Speaker',
      start, end, currentTime: start, isPlaying: true };
    try {
      setPlaybackLoadingSegment({ noteId: note.id, segmentIndex });
      let url = await getNoteAudioUrl(note, controller.signal);
      if (!isCurrent()) return;
      audio.muted = false;
      audio.volume = 1;
      playbackStopAtRef.current = end;
      setSegmentPlayback(playing);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await loadAudioMetadata(audio, url, controller.signal, attempt > 0);
          break;
        } catch (loadError) {
          if (!isCurrent()) return;
          audioUrlCacheRef.current.delete(note.id);
          audioUrlGenerationRef.current.set(note.id, (audioUrlGenerationRef.current.get(note.id) ?? 0) + 1);
          if (attempt > 0) throw loadError;
          url = await getNoteAudioUrl(note, controller.signal);
          if (!isCurrent()) return;
        }
      }
      if (!isCurrent()) return;
      if (Number.isFinite(audio.duration) && start > audio.duration) {
        throw new Error(`Segment timestamp ${formatPlaybackTime(start)} is outside this audio file (${formatPlaybackTime(audio.duration)}).`);
      }
      // React's media error handler cleared these during the first failed attempt.
      playbackStopAtRef.current = end;
      setSegmentPlayback(playing);
      audio.currentTime = start;
      await audio.play();
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Failed to play transcript segment:', error);
      playbackStopAtRef.current = null;
      setSegmentPlayback(null);
    } finally {
      if (isCurrent()) {
        playbackLoadRef.current = null;
        setPlaybackLoadingSegment(null);
      }
    }
  };

  /** Spread onto the page's hidden `<audio ref={audioRef}>`. */
  const audioElementProps = {
    onTimeUpdate: (event: SyntheticEvent<HTMLAudioElement>) => {
      const audio = event.currentTarget;
      const stopAt = playbackStopAtRef.current;
      const currentTime = audio.currentTime;
      setSegmentPlayback((prev) => prev ? { ...prev, currentTime } : prev);
      if (stopAt != null && currentTime >= stopAt) {
        audio.pause();
        playbackStopAtRef.current = null;
        setSegmentPlayback((prev) => prev ? { ...prev, currentTime: stopAt, isPlaying: false } : prev);
      }
    },
    onPlay: (event: SyntheticEvent<HTMLAudioElement>) => {
      const currentTime = event.currentTarget.currentTime;
      setSegmentPlayback((prev) => prev ? { ...prev, currentTime, isPlaying: true } : prev);
    },
    onPause: (event: SyntheticEvent<HTMLAudioElement>) => {
      const currentTime = event.currentTarget.currentTime;
      setSegmentPlayback((prev) => prev ? { ...prev, currentTime, isPlaying: false } : prev);
    },
    onEnded: () => {
      playbackStopAtRef.current = null;
      setSegmentPlayback((prev) => prev ? { ...prev, isPlaying: false } : prev);
    },
    onError: () => {
      playbackStopAtRef.current = null;
      setSegmentPlayback(null);
    },
  };

  return {
    audioRef,
    segmentPlayback,
    playbackLoadingSegment,
    playTranscriptSegment,
    audioElementProps,
  };
}
