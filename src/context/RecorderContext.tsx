import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

interface RecordingFormat {
  mimeType: string;
  extension: string;
}

type WakeLockState = 'active' | 'unavailable' | 'denied' | 'released';

interface RecoverableRecordingSession {
  id: string;
  fileName: string;
  mimeType: string;
  startedAt: number;
  chunkCount: number;
}

interface RecorderContextValue {
  isRecording: boolean;
  recordingTime: number;
  recordedAudioUrl: string | null;
  recordedBlob: Blob | null;
  recordedFileName: string;
  recordedMimeType: string;
  isPlayingRecording: boolean;
  playbackProgress: number;
  playbackCurrentTime: number;
  wakeLockState: WakeLockState;
  wakeLockWarning: string | null;
  recoverableSession: RecoverableRecordingSession | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  discardRecording: () => void;
  clearRecording: () => void;
  recoverRecording: () => Promise<void>;
  togglePlayback: () => void;
  seekPlaybackRatio: (ratio: number) => void;
  startScreenWakeLockKeepAlive: () => void;
  ensureScreenWakeLockFromGesture: () => Promise<void>;
  releaseScreenWakeLock: () => Promise<void>;
}

const RECORDING_FORMATS: RecordingFormat[] = [
  { mimeType: 'audio/mp4;codecs=mp4a.40.2', extension: 'm4a' },
  { mimeType: 'audio/mp4', extension: 'm4a' },
  { mimeType: 'audio/aac', extension: 'm4a' },
  { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
  { mimeType: 'audio/webm', extension: 'webm' },
];

const DB_NAME = 'meeting-note-recorder';
const DB_VERSION = 1;
const SESSION_STORE = 'session';
const CHUNK_STORE = 'chunks';
const ACTIVE_SESSION_ID = 'active';
const RECORDING_TIMESLICE_MS = 10000;

const RecorderContext = createContext<RecorderContextValue | null>(null);

function formatRecordingFileName(extension: string): string {
  const now = new Date();
  const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  return `Recording_${timestamp}.${extension}`;
}

function getPreferredRecordingFormat(): RecordingFormat {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return { mimeType: 'audio/webm', extension: 'webm' };
  }
  return (
    RECORDING_FORMATS.find((format) => MediaRecorder.isTypeSupported(format.mimeType)) ??
    { mimeType: 'audio/webm', extension: 'webm' }
  );
}

function openRecorderDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        db.createObjectStore(CHUNK_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open recorder database.'));
  });
}

async function withStore<T>(storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openRecorderDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = fn(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Recorder database request failed.'));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('Recorder database transaction failed.'));
    };
  });
}

function saveSession(session: RecoverableRecordingSession): Promise<IDBValidKey> {
  return withStore<IDBValidKey>(SESSION_STORE, 'readwrite', (store) => store.put(session));
}

function getSession(): Promise<RecoverableRecordingSession | undefined> {
  return withStore<RecoverableRecordingSession | undefined>(SESSION_STORE, 'readonly', (store) => store.get(ACTIVE_SESSION_ID));
}

function saveChunk(sessionId: string, index: number, blob: Blob): Promise<IDBValidKey> {
  return withStore<IDBValidKey>(CHUNK_STORE, 'readwrite', (store) =>
    store.put({ id: `${sessionId}:${index}`, sessionId, index, blob })
  );
}

async function getChunks(sessionId: string): Promise<Blob[]> {
  const db = await openRecorderDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const store = tx.objectStore(CHUNK_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      const rows = (request.result as Array<{ sessionId: string; index: number; blob: Blob }>)
        .filter((row) => row.sessionId === sessionId)
        .sort((a, b) => a.index - b.index);
      resolve(rows.map((row) => row.blob));
    };
    request.onerror = () => reject(request.error ?? new Error('Could not read recorder chunks.'));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('Could not read recorder chunks.'));
    };
  });
}

async function clearPersistedRecording(): Promise<void> {
  const db = await openRecorderDb().catch(() => null);
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([SESSION_STORE, CHUNK_STORE], 'readwrite');
    tx.objectStore(SESSION_STORE).clear();
    tx.objectStore(CHUNK_STORE).clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('Could not clear recorder database.'));
    };
  }).catch(() => undefined);
}

export const RecorderProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedFileName, setRecordedFileName] = useState('Recording.m4a');
  const [recordedMimeType, setRecordedMimeType] = useState('audio/mp4');
  const [isPlayingRecording, setIsPlayingRecording] = useState(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [playbackCurrentTime, setPlaybackCurrentTime] = useState(0);
  const [wakeLockState, setWakeLockState] = useState<WakeLockState>('released');
  const [wakeLockWarning, setWakeLockWarning] = useState<string | null>(null);
  const [recoverableSession, setRecoverableSession] = useState<RecoverableRecordingSession | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const screenWakeLockRef = useRef<WakeLockSentinel | null>(null);
  const keepScreenAwakeRef = useRef(false);
  const wakeLockKeepAliveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingSessionRef = useRef<RecoverableRecordingSession | null>(null);
  const chunkIndexRef = useRef(0);
  const stopResolveRef = useRef<(() => void) | null>(null);

  const clearPlayback = useCallback(() => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current = null;
    }
    setIsPlayingRecording(false);
    setPlaybackProgress(0);
    setPlaybackCurrentTime(0);
  }, []);

  const ensureScreenWakeLockFromGesture = useCallback(async () => {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
      setWakeLockState('unavailable');
      setWakeLockWarning('Screen wake lock is not supported in this browser. Keep the screen on while recording.');
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (screenWakeLockRef.current) return;
    try {
      const wakeLock = await navigator.wakeLock.request('screen');
      screenWakeLockRef.current = wakeLock;
      setWakeLockState('active');
      setWakeLockWarning(null);
      wakeLock.addEventListener('release', () => {
        if (screenWakeLockRef.current === wakeLock) {
          screenWakeLockRef.current = null;
          setWakeLockState('released');
          if (keepScreenAwakeRef.current) {
            window.setTimeout(() => void ensureScreenWakeLockFromGesture(), 500);
          }
        }
      });
    } catch {
      setWakeLockState('denied');
      setWakeLockWarning('Could not keep the screen awake. Keep the browser visible and the screen on while recording.');
    }
  }, []);

  const startScreenWakeLockKeepAlive = useCallback(() => {
    keepScreenAwakeRef.current = true;
    void ensureScreenWakeLockFromGesture();
    if (wakeLockKeepAliveIntervalRef.current) return;
    wakeLockKeepAliveIntervalRef.current = setInterval(() => {
      if (!keepScreenAwakeRef.current) return;
      void ensureScreenWakeLockFromGesture();
    }, 15000);
  }, [ensureScreenWakeLockFromGesture]);

  const releaseScreenWakeLock = useCallback(async () => {
    keepScreenAwakeRef.current = false;
    if (wakeLockKeepAliveIntervalRef.current) {
      clearInterval(wakeLockKeepAliveIntervalRef.current);
      wakeLockKeepAliveIntervalRef.current = null;
    }
    try {
      await screenWakeLockRef.current?.release();
    } catch {
      /* unsupported, denied, or already released */
    } finally {
      screenWakeLockRef.current = null;
      setWakeLockState('released');
    }
  }, []);

  const finalizeRecording = useCallback(async (fallbackMimeType?: string) => {
    const session = recordingSessionRef.current;
    const persistedChunks = session ? await getChunks(session.id).catch(() => []) : [];
    const chunks = persistedChunks.length > 0 ? persistedChunks : audioChunksRef.current;
    const mimeType = fallbackMimeType || session?.mimeType || recordedMimeType;
    if (chunks.length > 0) {
      const audioBlob = new Blob(chunks, { type: mimeType });
      const audioUrl = URL.createObjectURL(audioBlob);
      setRecordedAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return audioUrl;
      });
      setRecordedBlob(audioBlob);
      setRecordedMimeType(mimeType);
      setRecordedFileName(session?.fileName ?? recordedFileName);
      setRecoverableSession(null);
      await clearPersistedRecording();
    }
    recordingSessionRef.current = null;
    audioChunksRef.current = [];
    chunkIndexRef.current = 0;
    setIsRecording(false);
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    await releaseScreenWakeLock();
    stopResolveRef.current?.();
    stopResolveRef.current = null;
  }, [recordedFileName, recordedMimeType, releaseScreenWakeLock]);

  const startRecording = useCallback(async () => {
    try {
      clearPlayback();
      startScreenWakeLockKeepAlive();
      await clearPersistedRecording();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recordingFormat = getPreferredRecordingFormat();
      const fileName = formatRecordingFileName(recordingFormat.extension);
      const session: RecoverableRecordingSession = {
        id: ACTIVE_SESSION_ID,
        fileName,
        mimeType: recordingFormat.mimeType,
        startedAt: Date.now(),
        chunkCount: 0,
      };
      recordingSessionRef.current = session;
      setRecoverableSession(null);
      await saveSession(session).catch(() => undefined);

      const mediaRecorder = new MediaRecorder(stream, { mimeType: recordingFormat.mimeType });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      chunkIndexRef.current = 0;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size <= 0) return;
        const index = chunkIndexRef.current++;
        audioChunksRef.current.push(event.data);
        const nextSession = { ...session, chunkCount: index + 1 };
        recordingSessionRef.current = nextSession;
        void saveSession(nextSession).catch(() => undefined);
        void saveChunk(session.id, index, event.data).catch(() => undefined);
      };
      mediaRecorder.onstop = () => {
        void finalizeRecording(mediaRecorder.mimeType || recordingFormat.mimeType);
      };
      mediaRecorder.onerror = () => {
        void finalizeRecording(mediaRecorder.mimeType || recordingFormat.mimeType);
      };
      stream.getTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
          } else {
            void finalizeRecording(mediaRecorder.mimeType || recordingFormat.mimeType);
          }
        });
      });

      mediaRecorder.start(RECORDING_TIMESLICE_MS);
      setIsRecording(true);
      setRecordingTime(0);
      setRecordedAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setRecordedBlob(null);
      setRecordedMimeType(recordingFormat.mimeType);
      setRecordedFileName(fileName);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } catch (error) {
      await releaseScreenWakeLock();
      console.error('Error starting recording:', error);
      alert('Could not access microphone. Please ensure you have granted microphone permissions.');
    }
  }, [clearPlayback, finalizeRecording, releaseScreenWakeLock, startScreenWakeLockKeepAlive]);

  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      await finalizeRecording();
      return;
    }
    const stopped = new Promise<void>((resolve) => {
      stopResolveRef.current = resolve;
    });
    recorder.requestData();
    recorder.stop();
    await stopped;
  }, [finalizeRecording]);

  const clearRecording = useCallback(() => {
    clearPlayback();
    setRecordedAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setRecordedBlob(null);
    setRecordedFileName('Recording.m4a');
    setRecordedMimeType('audio/mp4');
    setRecordingTime(0);
  }, [clearPlayback]);

  const discardRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setIsRecording(false);
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
    recordingSessionRef.current = null;
    audioChunksRef.current = [];
    chunkIndexRef.current = 0;
    void clearPersistedRecording();
    void releaseScreenWakeLock();
    setRecoverableSession(null);
    clearRecording();
  }, [clearRecording, releaseScreenWakeLock]);

  const recoverRecording = useCallback(async () => {
    const session = recoverableSession ?? await getSession().catch(() => undefined);
    if (!session) return;
    const chunks = await getChunks(session.id).catch(() => []);
    if (chunks.length === 0) return;
    const blob = new Blob(chunks, { type: session.mimeType });
    setRecordedAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(blob);
    });
    setRecordedBlob(blob);
    setRecordedFileName(session.fileName);
    setRecordedMimeType(session.mimeType);
    setRecordingTime(Math.max(0, Math.round((Date.now() - session.startedAt) / 1000)));
    setRecoverableSession(null);
    await clearPersistedRecording();
  }, [recoverableSession]);

  const togglePlayback = useCallback(() => {
    if (!recordedAudioUrl) return;
    if (!audioPlayerRef.current) {
      audioPlayerRef.current = new Audio(recordedAudioUrl);
      audioPlayerRef.current.onended = () => {
        setIsPlayingRecording(false);
        setPlaybackProgress(0);
        setPlaybackCurrentTime(0);
      };
      audioPlayerRef.current.ontimeupdate = () => {
        if (!audioPlayerRef.current) return;
        const current = audioPlayerRef.current.currentTime;
        const duration = audioPlayerRef.current.duration;
        setPlaybackCurrentTime(current);
        setPlaybackProgress(duration > 0 ? (current / duration) * 100 : 0);
      };
    }
    if (isPlayingRecording) {
      audioPlayerRef.current.pause();
      setIsPlayingRecording(false);
    } else {
      void audioPlayerRef.current.play();
      setIsPlayingRecording(true);
    }
  }, [isPlayingRecording, recordedAudioUrl]);

  const seekPlaybackRatio = useCallback((ratio: number) => {
    if (!audioPlayerRef.current) return;
    const clamped = Math.max(0, Math.min(1, ratio));
    const newTime = clamped * audioPlayerRef.current.duration;
    audioPlayerRef.current.currentTime = newTime;
    setPlaybackCurrentTime(newTime);
    setPlaybackProgress(clamped * 100);
  }, []);

  useEffect(() => {
    void getSession().then((session) => {
      if (session?.chunkCount) setRecoverableSession(session);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isRecording) {
        startScreenWakeLockKeepAlive();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isRecording, startScreenWakeLockKeepAlive]);

  useEffect(() => {
    return () => {
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
      if (wakeLockKeepAliveIntervalRef.current) clearInterval(wakeLockKeepAliveIntervalRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (recordedAudioUrl) URL.revokeObjectURL(recordedAudioUrl);
    };
  }, [recordedAudioUrl]);

  return (
    <RecorderContext.Provider
      value={{
        isRecording,
        recordingTime,
        recordedAudioUrl,
        recordedBlob,
        recordedFileName,
        recordedMimeType,
        isPlayingRecording,
        playbackProgress,
        playbackCurrentTime,
        wakeLockState,
        wakeLockWarning,
        recoverableSession,
        startRecording,
        stopRecording,
        discardRecording,
        clearRecording,
        recoverRecording,
        togglePlayback,
        seekPlaybackRatio,
        startScreenWakeLockKeepAlive,
        ensureScreenWakeLockFromGesture,
        releaseScreenWakeLock,
      }}
    >
      {children}
    </RecorderContext.Provider>
  );
};

export function useRecorder(): RecorderContextValue {
  const ctx = useContext(RecorderContext);
  if (!ctx) throw new Error('useRecorder must be used within RecorderProvider');
  return ctx;
}
