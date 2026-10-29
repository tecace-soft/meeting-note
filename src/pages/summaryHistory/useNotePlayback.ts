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
 * The signed URL is cached per note for the lifetime of the hook and is never refreshed; a URL that has
 * expired (R10) fails at loadAudioMetadata and playback resets. A re-sign-on-failure fix belongs in
 * getNoteAudioUrl (drop the cache entry and request a new URL) plus a single retry in playTranscriptSegment
 * when loadAudioMetadata rejects.
 */
export function useNotePlayback({ selectedNote, getAccessToken }: UseNotePlaybackOptions) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlCacheRef = useRef<Map<string, string>>(new Map());
  const playbackStopAtRef = useRef<number | null>(null);
  const [segmentPlayback, setSegmentPlayback] = useState<SegmentPlaybackState | null>(null);
  const [playbackLoadingSegment, setPlaybackLoadingSegment] = useState<{ noteId: string; segmentIndex: number } | null>(null);

  const getNoteAudioUrl = async (note: Note): Promise<string> => {
    const cached = audioUrlCacheRef.current.get(note.id);
    if (cached) return cached;
    const url = await requestNoteAudioUrl(note.id, getAccessToken);
    audioUrlCacheRef.current.set(note.id, url);
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

  const stopSegmentPlayback = () => {
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

  const loadAudioMetadata = (audio: HTMLAudioElement, url: string): Promise<void> => {
    if (audio.src === url && audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timeout);
        audio.removeEventListener('loadedmetadata', onLoaded);
        audio.removeEventListener('canplay', onLoaded);
        audio.removeEventListener('error', onError);
      };
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(getAudioErrorMessage(audio)));
      };
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Audio metadata did not load. The audio URL may be expired, blocked, or not playable in this browser.'));
      }, 15000);

      audio.addEventListener('loadedmetadata', onLoaded, { once: true });
      audio.addEventListener('canplay', onLoaded, { once: true });
      audio.addEventListener('error', onError, { once: true });

      if (audio.src !== url) {
        audio.src = url;
      }
      audio.load();
    });
  };

  useEffect(() => {
    if (!selectedNote || segmentPlayback?.noteId === selectedNote.id) return;
    stopSegmentPlayback();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the selected note id or playback note changes
  }, [selectedNote?.id, segmentPlayback?.noteId]);

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

    try {
      setPlaybackLoadingSegment({ noteId: note.id, segmentIndex });
      const url = audioUrlCacheRef.current.get(note.id) ?? await getNoteAudioUrl(note);
      audio.muted = false;
      audio.volume = 1;
      playbackStopAtRef.current = end;
      setSegmentPlayback({
        noteId: note.id,
        segmentIndex,
        speaker: segment.speaker.trim() || 'Speaker',
        start,
        end,
        currentTime: start,
        isPlaying: true,
      });
      await loadAudioMetadata(audio, url);
      if (Number.isFinite(audio.duration) && start > audio.duration) {
        throw new Error(`Segment timestamp ${formatPlaybackTime(start)} is outside this audio file (${formatPlaybackTime(audio.duration)}).`);
      }
      audio.currentTime = start;
      await audio.play();
    } catch (error) {
      console.error('Failed to play transcript segment:', error);
      playbackStopAtRef.current = null;
      setSegmentPlayback(null);
    } finally {
      setPlaybackLoadingSegment(null);
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
