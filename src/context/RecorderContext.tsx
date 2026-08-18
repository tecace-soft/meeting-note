import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { RECORDING_DRAFT_BUCKET, supabase } from '../config/supabaseConfig';

interface RecordingFormat {
  mimeType: string;
  extension: string;
}

type WakeLockState = 'active' | 'unavailable' | 'denied' | 'released';
type RecordingRecoverabilityStatus = 'protected' | 'local-only' | 'unprotected';

interface RecoverableRecordingSession {
  id: string;
  draftId?: string | null;
  userId?: string | null;
  fileName: string;
  mimeType: string;
  startedAt: number;
  lastChunkAt?: number | null;
  chunkCount: number;
  totalBytes?: number;
  cloudChunkCount?: number;
  cloudBacked?: boolean;
  partial?: boolean;
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
  recoverabilityStatus: RecordingRecoverabilityStatus;
  recoveryWarning: string | null;
  /** True during the final minutes before the 2-hour cap (non-blocking warning). */
  recordingLimitWarning: boolean;
  /** True when the last recording was auto-stopped because it hit the 2-hour cap. */
  recordingAutoStopped: boolean;
  /** Dismiss the "recording stopped at the 2-hour limit" notice. */
  acknowledgeAutoStop: () => void;
  /** The hard recording cap in seconds (2 hours), for consumers to show a countdown. */
  maxRecordingSeconds: number;
  /** Error from a failed start (mic permission, or an unresolved recovery), shown inline by consumers. */
  recorderError: string | null;
  clearRecorderError: () => void;
  recoverableSession: RecoverableRecordingSession | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  discardRecording: () => void;
  clearRecording: (options?: { discardDraft?: boolean }) => void;
  recoverRecording: () => Promise<void>;
  togglePlayback: () => void;
  seekPlaybackRatio: (ratio: number) => void;
  startScreenWakeLockKeepAlive: () => void;
  ensureScreenWakeLockFromGesture: () => Promise<void>;
  releaseScreenWakeLock: () => Promise<void>;
}

// Order matters: prefer webm/opus first. Chromium browsers (Chrome, Edge, Arc,
// Atlas, Brave) on macOS report `isTypeSupported('audio/mp4') === true` because
// the OS has an AAC encoder, but their MediaRecorder mp4 path produces NO data
// (empty chunks) — so recording "works" then yields no file. webm/opus records
// reliably on every Chromium/Firefox. Safari does not support webm, so it falls
// through to mp4/aac (which Safari records correctly). This keeps Safari working
// while fixing macOS Chromium (Windows Chrome already fell back to webm because
// it has no mp4 muxer).
const RECORDING_FORMATS: RecordingFormat[] = [
  { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
  { mimeType: 'audio/webm', extension: 'webm' },
  { mimeType: 'audio/mp4;codecs=mp4a.40.2', extension: 'm4a' },
  { mimeType: 'audio/mp4', extension: 'm4a' },
  { mimeType: 'audio/aac', extension: 'm4a' },
];

const DB_NAME = 'meeting-note-recorder';
const DB_VERSION = 1;
const SESSION_STORE = 'session';
const CHUNK_STORE = 'chunks';
const ACTIVE_SESSION_ID = 'active';
const RECORDING_TIMESLICE_MS = 2000;

// Cross-tab/window recording guard (Web Locks API). The recorder persists to a single
// shared IndexedDB session key, so two tabs recording at once would clobber each other,
// and a second tab used to misread the first tab's LIVE session as an "interrupted
// recording" to recover/discard (discarding it would wipe the other tab's in-progress
// recording). The recording tab HOLDS this lock for the whole recording; the browser
// auto-releases it if that tab crashes or closes, so a held lock reliably means "a
// recording is live in another tab" while a free lock + a leftover session means
// "genuinely interrupted". No timestamp heuristics needed.
const RECORDING_LOCK_NAME = 'meeting-note-active-recording';

function supportsWebLocks(): boolean {
  return typeof navigator !== 'undefined' && 'locks' in navigator && Boolean(navigator.locks);
}

// Acquire the recording lock. Returns a release() fn when acquired (or a no-op when Web
// Locks are unsupported — the tab then simply loses the cross-tab guard, nothing breaks),
// or null when ANOTHER tab already holds it (a recording is in progress elsewhere).
async function acquireRecordingLock(): Promise<(() => void) | null> {
  if (!supportsWebLocks()) return () => {};
  return new Promise<(() => void) | null>((resolveRelease) => {
    let release = () => {};
    const held = new Promise<void>((resolveHeld) => {
      release = resolveHeld;
    });
    void navigator.locks
      .request(RECORDING_LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolveRelease(null); // held elsewhere → caller must not start
          return undefined; // never held it; nothing to keep
        }
        resolveRelease(release);
        return held; // keep the lock until release() is called
      })
      .catch(() => resolveRelease(() => {})); // degrade to no guard on any lock error
  });
}

// True when ANOTHER tab currently holds the recording lock (used at mount so a live
// recording elsewhere is never surfaced as a recoverable/interrupted session here).
async function isRecordingLockHeldElsewhere(): Promise<boolean> {
  if (!supportsWebLocks()) return false;
  try {
    return await navigator.locks.request(
      RECORDING_LOCK_NAME,
      { ifAvailable: true },
      async (lock) => lock === null,
    );
  } catch {
    return false;
  }
}

// Hard cap on a single recording: 2 hours. At the cap the recording auto-stops
// and is saved, and the user must start a new recording to continue. A
// non-blocking warning is surfaced RECORDING_LIMIT_WARNING_SECONDS before it.
export const MAX_RECORDING_SECONDS = 2 * 60 * 60;
export const RECORDING_LIMIT_WARNING_SECONDS = 5 * 60;

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

async function getChunkRows(sessionId: string): Promise<Array<{ sessionId: string; index: number; blob: Blob }>> {
  const db = await openRecorderDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const store = tx.objectStore(CHUNK_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      const rows = (request.result as Array<{ sessionId: string; index: number; blob: Blob }>)
        .filter((row) => row.sessionId === sessionId)
        .sort((a, b) => a.index - b.index);
      resolve(rows);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not read recorder chunks.'));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('Could not read recorder chunks.'));
    };
  });
}

async function getChunks(sessionId: string): Promise<Blob[]> {
  const rows = await getChunkRows(sessionId);
  return rows.map((row) => row.blob);
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

function getDraftChunkPath(userId: string, draftId: string, index: number, extension: string): string {
  return `${userId}/${draftId}/chunks/${String(index).padStart(6, '0')}.${extension}`;
}

function getRecoveredDurationFallback(session: RecoverableRecordingSession): number {
  if (session.lastChunkAt && session.lastChunkAt > session.startedAt) {
    return Math.max(0, Math.round((session.lastChunkAt - session.startedAt) / 1000));
  }
  return Math.max(0, Math.round((session.chunkCount * RECORDING_TIMESLICE_MS) / 1000));
}

function getAudioBlobDurationSeconds(blob: Blob): Promise<number | null> {
  if (typeof Audio === 'undefined' || typeof URL === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
    };
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) && audio.duration > 0
        ? Math.round(audio.duration)
        : null;
      cleanup();
      resolve(duration);
    };
    audio.onerror = () => {
      cleanup();
      resolve(null);
    };
    audio.src = url;
  });
}

function getExtensionFromMimeType(mimeType: string): string {
  if (mimeType.includes('mp4') || mimeType.includes('aac')) return 'm4a';
  if (mimeType.includes('webm')) return 'webm';
  return 'bin';
}

async function upsertCloudDraft(session: RecoverableRecordingSession): Promise<void> {
  if (!session.userId || !session.draftId) return;
  const { error } = await supabase.from('recording_draft').upsert({
    id: session.draftId,
    user_id: session.userId,
    file_name: session.fileName,
    mime_type: session.mimeType,
    started_at: new Date(session.startedAt).toISOString(),
    last_chunk_at: session.lastChunkAt ? new Date(session.lastChunkAt).toISOString() : null,
    chunk_count: session.chunkCount,
    total_bytes: session.totalBytes ?? 0,
    status: 'active',
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function uploadCloudDraftChunk(params: {
  userId: string;
  draftId: string;
  mimeType: string;
  index: number;
  blob: Blob;
}): Promise<void> {
  const storagePath = getDraftChunkPath(
    params.userId,
    params.draftId,
    params.index,
    getExtensionFromMimeType(params.mimeType)
  );
  const { error: uploadError } = await supabase.storage
    .from(RECORDING_DRAFT_BUCKET)
    .upload(storagePath, params.blob, {
      cacheControl: '86400',
      contentType: params.mimeType,
      upsert: true,
    });
  if (uploadError) throw uploadError;

  const { error: chunkError } = await supabase.from('recording_draft_chunk').upsert({
    draft_id: params.draftId,
    user_id: params.userId,
    chunk_index: params.index,
    bucket: RECORDING_DRAFT_BUCKET,
    storage_path: storagePath,
    mime_type: params.mimeType,
    size_bytes: params.blob.size,
  }, { onConflict: 'draft_id,chunk_index' });
  if (chunkError) throw chunkError;
}

async function getLatestCloudDraft(userId: string): Promise<RecoverableRecordingSession | null> {
  const { data, error } = await supabase
    .from('recording_draft')
    .select('id, user_id, file_name, mime_type, started_at, last_chunk_at, chunk_count, total_bytes')
    .eq('user_id', userId)
    .eq('status', 'active')
    .gt('chunk_count', 0)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as {
    id: string;
    user_id: string;
    file_name: string;
    mime_type: string;
    started_at: string;
    last_chunk_at?: string | null;
    chunk_count?: number | null;
    total_bytes?: number | null;
  };
  return {
    id: ACTIVE_SESSION_ID,
    draftId: row.id,
    userId: row.user_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    startedAt: new Date(row.started_at).getTime(),
    lastChunkAt: row.last_chunk_at ? new Date(row.last_chunk_at).getTime() : null,
    chunkCount: row.chunk_count ?? 0,
    totalBytes: row.total_bytes ?? 0,
    cloudChunkCount: row.chunk_count ?? 0,
    cloudBacked: true,
    partial: true,
  };
}

async function getCloudDraftChunks(session: RecoverableRecordingSession): Promise<Blob[]> {
  if (!session.userId || !session.draftId) return [];
  const { data, error } = await supabase
    .from('recording_draft_chunk')
    .select('bucket, storage_path')
    .eq('draft_id', session.draftId)
    .eq('user_id', session.userId)
    .order('chunk_index', { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as Array<{ bucket: string; storage_path: string }>;
  const blobs: Blob[] = [];
  for (const row of rows) {
    const { data: signed, error: signedError } = await supabase.storage
      .from(row.bucket || RECORDING_DRAFT_BUCKET)
      .createSignedUrl(row.storage_path, 60 * 10);
    if (signedError || !signed?.signedUrl) throw signedError ?? new Error('Could not create draft chunk URL.');
    const response = await fetch(signed.signedUrl);
    if (!response.ok) throw new Error(`Could not download draft chunk: ${response.status}`);
    blobs.push(await response.blob());
  }
  return blobs;
}

async function deleteCloudDraft(session: RecoverableRecordingSession | null): Promise<void> {
  if (!session?.userId || !session.draftId) return;
  const { data } = await supabase
    .from('recording_draft_chunk')
    .select('bucket, storage_path')
    .eq('draft_id', session.draftId)
    .eq('user_id', session.userId);
  const rows = (data ?? []) as Array<{ bucket: string; storage_path: string }>;
  const pathsByBucket = rows.reduce<Record<string, string[]>>((acc, row) => {
    const bucket = row.bucket || RECORDING_DRAFT_BUCKET;
    acc[bucket] = [...(acc[bucket] ?? []), row.storage_path];
    return acc;
  }, {});
  await Promise.all(
    Object.entries(pathsByBucket).map(([bucket, paths]) => supabase.storage.from(bucket).remove(paths))
  );
  await supabase.from('recording_draft').delete().eq('id', session.draftId).eq('user_id', session.userId);
}

export const RecorderProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
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
  const [recoverabilityStatus, setRecoverabilityStatus] = useState<RecordingRecoverabilityStatus>('local-only');
  const [recoveryWarning, setRecoveryWarning] = useState<string | null>(null);
  const [recordingLimitWarning, setRecordingLimitWarning] = useState(false);
  const [recordingAutoStopped, setRecordingAutoStopped] = useState(false);
  const acknowledgeAutoStop = useCallback(() => setRecordingAutoStopped(false), []);
  const [recorderError, setRecorderError] = useState<string | null>(null);
  const clearRecorderError = useCallback(() => setRecorderError(null), []);
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
  const recordedSessionRef = useRef<RecoverableRecordingSession | null>(null);
  const chunkIndexRef = useRef(0);
  // Guards the 2-hour auto-stop so it fires exactly once per recording.
  const autoStopFiredRef = useRef(false);
  const stopResolveRef = useRef<(() => void) | null>(null);
  const cloudDraftFailuresRef = useRef(0);
  // Holds the release() for the cross-tab recording lock while this tab is recording.
  const recordingLockReleaseRef = useRef<(() => void) | null>(null);
  // Tracks the latest recordedAudioUrl so the unmount-only teardown can revoke
  // it without listing recordedAudioUrl as an effect dependency (see below).
  const recordedAudioUrlRef = useRef<string | null>(null);

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

  const updateRecoveryStatus = useCallback((next: {
    indexedDbOk?: boolean;
    cloudOk?: boolean;
    message?: string | null;
  }) => {
    if (next.cloudOk) {
      setRecoverabilityStatus('protected');
      setRecoveryWarning(null);
      return;
    }
    if (next.indexedDbOk) {
      setRecoverabilityStatus('local-only');
      setRecoveryWarning(next.message ?? 'Recording is saved on this device. Cloud backup is not available right now.');
      return;
    }
    setRecoverabilityStatus('unprotected');
    setRecoveryWarning(next.message ?? 'Recording recovery is degraded. Keep this page open until recording is complete.');
  }, []);

  const flushRecorderData = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    try {
      recorder.requestData();
    } catch {
      /* Some browsers throw if requestData races with stop. */
    }
  }, []);

  const clearDraftBackups = useCallback((session: RecoverableRecordingSession | null) => {
    void clearPersistedRecording();
    void deleteCloudDraft(session);
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
      recordedSessionRef.current = session;
      void getAudioBlobDurationSeconds(audioBlob).then((duration) => {
        if (duration != null) setRecordingTime(duration);
      });
      setRecoverableSession(null);
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
    // Recording ended in this tab — release the cross-tab lock so other tabs can record.
    recordingLockReleaseRef.current?.();
    recordingLockReleaseRef.current = null;
    await releaseScreenWakeLock();
    stopResolveRef.current?.();
    stopResolveRef.current = null;
  }, [recordedFileName, recordedMimeType, releaseScreenWakeLock]);

  const startRecording = useCallback(async () => {
    try {
      setRecorderError(null);
      if (recoverableSession) {
        setRecorderError('Recover or discard the interrupted recording before starting a new one.');
        return;
      }
      // Cross-tab guard: acquire the recording lock BEFORE clearPersistedRecording wipes
      // IndexedDB. If another tab holds it, a recording is already live there (single
      // shared session) — refuse rather than clobber it or misreport it as "interrupted".
      const lockRelease = await acquireRecordingLock();
      if (lockRelease === null) {
        setRecorderError('A recording is already in progress in another tab or window. Stop that recording before starting a new one.');
        return;
      }
      recordingLockReleaseRef.current = lockRelease;
      clearPlayback();
      startScreenWakeLockKeepAlive();
      await clearPersistedRecording();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recordingFormat = getPreferredRecordingFormat();
      const fileName = formatRecordingFileName(recordingFormat.extension);
      const draftId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : null;
      const session: RecoverableRecordingSession = {
        id: ACTIVE_SESSION_ID,
        draftId,
        userId: user?.id ?? null,
        fileName,
        mimeType: recordingFormat.mimeType,
        startedAt: Date.now(),
        lastChunkAt: null,
        chunkCount: 0,
        totalBytes: 0,
        cloudChunkCount: 0,
        cloudBacked: false,
      };
      recordingSessionRef.current = session;
      recordedSessionRef.current = null;
      setRecoverableSession(null);
      cloudDraftFailuresRef.current = 0;
      const indexedDbOk = await saveSession(session).then(() => true).catch(() => false);
      if (!indexedDbOk) {
        updateRecoveryStatus({
          indexedDbOk: false,
          cloudOk: false,
          message: 'This browser could not save recording chunks locally. Keep this page open until recording is complete.',
        });
      } else if (user?.id && draftId) {
        await upsertCloudDraft(session)
          .then(() => updateRecoveryStatus({ indexedDbOk: true, cloudOk: true }))
          .catch(() => updateRecoveryStatus({
            indexedDbOk: true,
            cloudOk: false,
            message: 'Recording is saved on this device, but cloud backup is not available right now.',
          }));
      } else {
        updateRecoveryStatus({
          indexedDbOk: true,
          cloudOk: false,
          message: 'Recording is saved on this device only. Sign in is required for cloud backup.',
        });
      }

      // Cap the audio bitrate to a speech-optimal 64 kbps. Without this the
      // browser default (~128 kbps, e.g. Safari AAC) makes a 2-hour meeting
      // ~115 MB. 64 kbps keeps 2 hours near ~58 MB while giving AssemblyAI a
      // safer fidelity floor than 32 kbps (helps AAC/Safari and noisy rooms);
      // it fits well under the raised 200 MB storage cap (~7 hours). Applies
      // whether the codec is Opus (Chrome/Firefox) or AAC (Safari).
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: recordingFormat.mimeType,
        audioBitsPerSecond: 64000,
      });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      chunkIndexRef.current = 0;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size <= 0) return;
        const index = chunkIndexRef.current++;
        audioChunksRef.current.push(event.data);
        const previousTotalBytes = recordingSessionRef.current?.totalBytes ?? 0;
        const nextSession = {
          ...(recordingSessionRef.current ?? session),
          lastChunkAt: Date.now(),
          chunkCount: index + 1,
          totalBytes: previousTotalBytes + event.data.size,
        };
        recordingSessionRef.current = nextSession;
        void saveSession(nextSession).catch(() => {
          updateRecoveryStatus({
            indexedDbOk: false,
            cloudOk: Boolean(nextSession.cloudBacked),
            message: 'This browser stopped saving local recording chunks. Keep this page open until recording is complete.',
          });
        });
        void saveChunk(session.id, index, event.data).catch(() => {
          updateRecoveryStatus({
            indexedDbOk: false,
            cloudOk: Boolean(nextSession.cloudBacked),
            message: 'This browser stopped saving local recording chunks. Keep this page open until recording is complete.',
          });
        });
        if (nextSession.userId && nextSession.draftId) {
          void uploadCloudDraftChunk({
            userId: nextSession.userId,
            draftId: nextSession.draftId,
            mimeType: nextSession.mimeType,
            index,
            blob: event.data,
          })
            .then(async () => {
              const cloudBackedSession = {
                ...(recordingSessionRef.current ?? nextSession),
                cloudBacked: true,
                cloudChunkCount: Math.max(recordingSessionRef.current?.cloudChunkCount ?? 0, index + 1),
              };
              recordingSessionRef.current = cloudBackedSession;
              await upsertCloudDraft(cloudBackedSession);
              updateRecoveryStatus({ indexedDbOk: true, cloudOk: true });
            })
            .catch(() => {
              cloudDraftFailuresRef.current += 1;
              if (cloudDraftFailuresRef.current <= 2) {
                updateRecoveryStatus({
                  indexedDbOk: true,
                  cloudOk: false,
                  message: 'Recording is saved on this device, but cloud backup is currently failing.',
                });
              }
            });
        }
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
      autoStopFiredRef.current = false;
      setRecordingLimitWarning(false);
      setRecordingAutoStopped(false);
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
      // Starting failed after we took the lock — release it so other tabs aren't blocked.
      recordingLockReleaseRef.current?.();
      recordingLockReleaseRef.current = null;
      await releaseScreenWakeLock();
      console.error('Error starting recording:', error);
      setRecorderError('Could not access microphone. Please ensure you have granted microphone permissions.');
    }
  }, [clearPlayback, finalizeRecording, recoverableSession, releaseScreenWakeLock, startScreenWakeLockKeepAlive, updateRecoveryStatus, user?.id]);

  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      await finalizeRecording();
      return;
    }
    const stopped = new Promise<void>((resolve) => {
      stopResolveRef.current = resolve;
    });
    try {
      recorder.requestData();
    } catch {
      /* requestData can race with browser/device-driven stop. */
    }
    recorder.stop();
    await stopped;
  }, [finalizeRecording]);

  // Enforce the 2-hour recording cap. Warn during the final minutes, then
  // auto-stop and save at the cap (the user starts a new recording to
  // continue). The ref guard makes the stop fire exactly once even though this
  // effect re-runs on every 1-second recordingTime tick.
  useEffect(() => {
    if (!isRecording) return;
    const remaining = MAX_RECORDING_SECONDS - recordingTime;
    setRecordingLimitWarning(remaining <= RECORDING_LIMIT_WARNING_SECONDS && remaining > 0);
    if (recordingTime >= MAX_RECORDING_SECONDS && !autoStopFiredRef.current) {
      autoStopFiredRef.current = true;
      setRecordingLimitWarning(false);
      setRecordingAutoStopped(true);
      void stopRecording();
    }
  }, [isRecording, recordingTime, stopRecording]);

  const clearRecording = useCallback((options?: { discardDraft?: boolean }) => {
    clearPlayback();
    const sessionToDelete = recordedSessionRef.current ?? recoverableSession ?? recordingSessionRef.current;
    setRecordedAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setRecordedBlob(null);
    setRecordedFileName('Recording.m4a');
    setRecordedMimeType('audio/mp4');
    setRecordingTime(0);
    setRecordingLimitWarning(false);
    setRecordingAutoStopped(false);
    recordedSessionRef.current = null;
    if (options?.discardDraft) {
      clearDraftBackups(sessionToDelete);
      setRecoverableSession(null);
    }
  }, [clearDraftBackups, clearPlayback, recoverableSession]);

  const discardRecording = useCallback(() => {
    const sessionToDelete = recordingSessionRef.current ?? recordedSessionRef.current ?? recoverableSession;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setIsRecording(false);
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
    recordingSessionRef.current = null;
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    chunkIndexRef.current = 0;
    clearDraftBackups(sessionToDelete);
    // If this tab was the one recording, drop the cross-tab lock too.
    recordingLockReleaseRef.current?.();
    recordingLockReleaseRef.current = null;
    void releaseScreenWakeLock();
    setRecoverableSession(null);
    clearRecording();
  }, [clearDraftBackups, clearRecording, recoverableSession, releaseScreenWakeLock]);

  const recoverRecording = useCallback(async () => {
    const session = recoverableSession ?? await getSession().catch(() => undefined);
    if (!session) return;
    const localChunks = await getChunks(session.id).catch(() => []);
    const chunks = localChunks.length > 0 ? localChunks : await getCloudDraftChunks(session).catch(() => []);
    if (chunks.length === 0) return;
    const blob = new Blob(chunks, { type: session.mimeType });
    setRecordedAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(blob);
    });
    setRecordedBlob(blob);
    setRecordedFileName(session.fileName);
    setRecordedMimeType(session.mimeType);
    setRecordingTime(getRecoveredDurationFallback(session));
    void getAudioBlobDurationSeconds(blob).then((duration) => {
      if (duration != null) setRecordingTime(duration);
    });
    recordedSessionRef.current = { ...session, partial: true };
    setRecoverableSession(null);
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
    let cancelled = false;
    void (async () => {
      // If another tab holds the recording lock, a recording is LIVE there — its persisted
      // session is not "interrupted", so never surface it as recoverable here (and never
      // let this tab discard it, which would wipe the other tab's in-progress recording).
      if (await isRecordingLockHeldElsewhere()) return;
      if (cancelled) return;
      const localSession = await getSession().catch(() => undefined);
      if (cancelled) return;
      if (localSession?.chunkCount) {
        setRecoverableSession(localSession);
        return;
      }
      if (!user?.id) return;
      const cloudSession = await getLatestCloudDraft(user.id).catch(() => null);
      if (!cancelled && cloudSession?.chunkCount) setRecoverableSession(cloudSession);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleVisibilityChange = () => {
      if (isRecording) flushRecorderData();
      if (document.visibilityState === 'visible' && isRecording) {
        startScreenWakeLockKeepAlive();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [flushRecorderData, isRecording, startScreenWakeLockKeepAlive]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handlePageHide = () => {
      if (isRecording) flushRecorderData();
    };
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isRecording) return;
      flushRecorderData();
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [flushRecorderData, isRecording]);

  // Keep the ref in sync with the latest recorded URL. This effect only reads
  // state into a ref; it performs no teardown, so re-running it is harmless.
  useEffect(() => {
    recordedAudioUrlRef.current = recordedAudioUrl;
  }, [recordedAudioUrl]);

  // Unmount-only teardown. Empty deps are intentional: this must run ONLY when
  // the provider unmounts, never when recordedAudioUrl changes. Starting a
  // second recording sets recordedAudioUrl back to null, and if this cleanup
  // re-ran then, it would stop the newly created stream and clear the new
  // recording timer (they share the same refs), killing the fresh recording.
  // Object URLs are already revoked at every replacement site (finalize/start/
  // clear/recover), so only the currently-held URL needs revoking on unmount.
  useEffect(() => {
    return () => {
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
      if (wakeLockKeepAliveIntervalRef.current) clearInterval(wakeLockKeepAliveIntervalRef.current);
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.requestData();
        } catch {
          /* requestData can race with a browser/device-driven stop. */
        }
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      // Release the cross-tab recording lock if this tab held it (also auto-released by
      // the browser on tab close, but drop it explicitly on provider unmount too).
      recordingLockReleaseRef.current?.();
      recordingLockReleaseRef.current = null;
      if (recordedAudioUrlRef.current) URL.revokeObjectURL(recordedAudioUrlRef.current);
    };
  }, []);

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
        recoverabilityStatus,
        recoveryWarning,
        recordingLimitWarning,
        recordingAutoStopped,
        acknowledgeAutoStop,
        maxRecordingSeconds: MAX_RECORDING_SECONDS,
        recorderError,
        clearRecorderError,
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
