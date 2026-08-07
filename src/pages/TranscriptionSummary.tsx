import React, { useState, useEffect, useRef, useCallback, startTransition } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../components/ConfirmDialog';
import { getTeamsChats, TeamsChat, sendChatMessage } from '../services/graphService';
import {
  supabase,
  AUDIO_BUCKET,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  getSupabaseAccessTokenForRequest,
} from '../config/supabaseConfig';
import {
  isSupabaseResumableConfigured,
  shouldUseResumableUpload,
  uploadWithTus,
} from '../services/supabaseResumableUpload';
import { ensureStorageObjectReady } from '../lib/storagePublicReady';
import {
  ArrowsReload01,
  Chat,
  Check,
  CloseMd,
  Cloud,
  CloudUpload,
  Copy,
  EditPencilLine01,
  ListOrdered,
  Loading,
  MoreVertical,
  Pause,
  Play,
  Save,
  ShareAndroid,
  Stop,
  UserCircle,
  UserVoice,
  Users,
  VolumeMax,
  Download,
} from 'react-coolicons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { marked } from 'marked';
import NoteImageAttachments from '../components/NoteImageAttachments';
import TranscriptDiarizedEditor, {
  getTranscriptSpeakerFilters,
  TranscriptSpeakerFilterControls,
} from '../components/TranscriptDiarizedEditor';
import {
  getSegmentText,
  normalizeTranscript,
  persistNoteDiarization,
  type TranscriptLanguage,
  type TranscriptSegment,
} from '../lib/transcriptSegments';
import {
  getAvailableTranscriptLanguages,
  getDisplayTranscriptSegments,
  getDisplayTranscriptText,
  getTranscriptLanguageLabel,
  updateTranslationMap,
  type TranscriptTextTranslationMap,
  type TranscriptTranslationMap,
} from '../lib/transcriptTranslationDisplay';
import { canonicalOntologyProfileString } from '../lib/speakerOntology';
import { formatDurationMeta } from '../lib/noteDuration';
import { updateUserMemoryFromNote } from '../lib/userMemory';
import {
  uploadNoteImage,
  type NoteImage,
  type PendingNoteImage,
} from '../lib/noteImages';
import { DEFAULT_SUMMARY_PROMPT, DEFAULT_SUMMARY_PROMPT_NAME } from '../constants/defaultSummaryPrompt';
import ShareNoteModal from '../components/ShareNoteModal';
import { useRecorder } from '../context/RecorderContext';
import { useLanguage } from '../context/LanguageContext';

const SUMMARY_PROMPT_TABLE = 'summary_prompt';
const WORKFLOW_API_URL = ((import.meta.env.VITE_WORKFLOW_API_URL as string | undefined) ?? '').replace(/\/$/, '');

interface GeneratedProfile {
  speakerId: string | null;
  speakerName: string;
  draft: string;
  isNew: boolean;
  saving: boolean;
  saved: boolean;
  saveError: string | null;
}

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  status: 'pending' | 'uploading' | 'processing' | 'completed' | 'error';
  progress?: number;
  error?: string;
  publicUrl?: string;
  bucket?: string;
  storagePath?: string;
  audioFileId?: string;
  recordedAt?: string | null;
}

interface RecentAudioFile {
  id: string;
  name: string;
  bucket: string;
  storage_path: string;
  public_url: string;
  mime_type?: string | null;
  size_bytes?: number | null;
  source?: 'upload' | 'recording' | string | null;
  recorded_at?: string | null;
  created_at?: string | null;
}

interface SegmentPlaybackState {
  segmentIndex: number;
  start: number;
  end: number | null;
  currentTime: number;
  isPlaying: boolean;
}

const AUDIO_SIGNED_URL_SECONDS = 60 * 60 * 6;
const ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS = [
  '3ga',
  '8svx',
  'aac',
  'ac3',
  'aif',
  'aiff',
  'alac',
  'amr',
  'ape',
  'au',
  'dss',
  'flac',
  'flv',
  'm4a',
  'm4b',
  'm4p',
  'm4r',
  'mp3',
  'mp4',
  'mpeg',
  'mpg',
  'oga',
  'ogg',
  'opus',
  'qcp',
  'ra',
  'ram',
  'sln',
  'spx',
  'wav',
  'webm',
  'wma',
] as const;
const ASSEMBLYAI_AUDIO_ACCEPT = `audio/*,video/mp4,video/webm,${ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS
  .map((ext) => `.${ext}`)
  .join(',')}`;
const ASSEMBLYAI_AUDIO_EXTENSION_RE = new RegExp(
  `\\.(${ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS.join('|')})$`,
  'i'
);

interface WorkflowJobStatus {
  jobId: string;
  noteId?: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  stage?: string;
  progress?: number;
  result?: {
    transcript?: unknown;
    summary?: unknown;
    summaryTranslations?: Record<string, string>;
    transcriptionLanguage?: 'en' | 'ko' | null;
    transcriptionTranslations?: TranscriptTextTranslationMap;
    diarizationTranslations?: TranscriptTranslationMap;
    title?: unknown;
    tags?: unknown;
    audioDurationSeconds?: unknown;
  } | null;
  error?: string | null;
}

// A summarize job runs on the backend for minutes; persist its id so a page
// refresh (or navigating away and back) can resume polling instead of losing
// the in-flight summary entirely.
const ACTIVE_SUMMARY_JOB_STORAGE_KEY = 'meeting-note:active-summary-job';

interface PersistedSummaryJob {
  jobId: string;
  noteId: string;
}

function readActiveSummaryJob(): PersistedSummaryJob | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_SUMMARY_JOB_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedSummaryJob>;
    if (typeof parsed.jobId === 'string' && parsed.jobId && typeof parsed.noteId === 'string' && parsed.noteId) {
      return { jobId: parsed.jobId, noteId: parsed.noteId };
    }
  } catch {
    /* corrupt or unavailable storage: treat as no active job */
  }
  return null;
}

function persistActiveSummaryJob(job: PersistedSummaryJob): void {
  try {
    window.localStorage.setItem(ACTIVE_SUMMARY_JOB_STORAGE_KEY, JSON.stringify(job));
  } catch {
    /* storage unavailable (private mode/quota): resume-on-refresh just won't work */
  }
}

function clearActiveSummaryJob(): void {
  try {
    window.localStorage.removeItem(ACTIVE_SUMMARY_JOB_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

interface SummaryResultState {
  transcript: TranscriptSegment[];
  summary: string;
  summaryTranslations?: Record<string, string>;
  transcription_language?: string | null;
  transcription_translations?: TranscriptTextTranslationMap | null;
  diarization_translations?: TranscriptTranslationMap | null;
  title?: string | null;
  meetingAt?: string | null;
  audioDurationSeconds?: number | null;
}

async function invokeGenerateProfile(
  body: {
    speakerName: string;
    speakerId: string;
    transcriptText: string;
    existingProfile: string | null;
  },
  auth: { appToken: string | null; msToken: string | null }
): Promise<{ profile?: string; error?: string }> {
  const response = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/generate-profile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${auth.appToken ?? SUPABASE_ANON_KEY}`,
      ...(auth.msToken ? { 'x-ms-access-token': auth.msToken } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed: { profile?: string; error?: string };
  try {
    parsed = raw ? JSON.parse(raw) as { profile?: string; error?: string } : {};
  } catch {
    parsed = { error: raw || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    throw new Error(parsed.error || raw || `HTTP ${response.status}`);
  }
  return parsed;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.includes(',') ? result.split(',')[1] ?? '' : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Could not read attachment.'));
    reader.readAsDataURL(file);
  });
}

const TranscriptionSummary: React.FC = () => {
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading, getAccessToken } = useAuth();
  const { appLanguage, transcriptLanguage, t } = useLanguage();
  const {
    isRecording,
    recordingTime,
    recordedAudioUrl,
    recordedBlob,
    recordedFileName,
    recordedMimeType,
    isPlayingRecording,
    playbackProgress,
    playbackCurrentTime,
    wakeLockWarning,
    recoverabilityStatus,
    recoveryWarning,
    recordingLimitWarning,
    recordingAutoStopped,
    acknowledgeAutoStop,
    maxRecordingSeconds,
    recoverableSession,
    recorderError,
    clearRecorderError,
    startRecording,
    stopRecording,
    clearRecording,
    recoverRecording,
    discardRecording,
    togglePlayback: togglePlayRecording,
    seekPlaybackRatio,
    startScreenWakeLockKeepAlive,
    ensureScreenWakeLockFromGesture,
    releaseScreenWakeLock,
  } = useRecorder();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadProgressGateRef = useRef<Map<string, { pct: number; at: number }>>(new Map());
  const activeUploadsRef = useRef(0);

  const [chats, setChats] = useState<TeamsChat[]>([]);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [pendingNoteImages, setPendingNoteImages] = useState<PendingNoteImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [summaryPromptRows, setSummaryPromptRows] = useState<{ id: string; name: string; prompt: string }[]>([]);
  const [selectedSummaryPromptId, setSelectedSummaryPromptId] = useState<string | null>(null);
  const [summaryPromptsLoading, setSummaryPromptsLoading] = useState(true);
  /** Optional free-text instructions; separate from the saved summarization template (`promptId`). */
  const [optionalInstructions, setOptionalInstructions] = useState('');
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryProgress, setSummaryProgress] = useState<{ stage: string; progress: number } | null>(null);
  const [summaryResult, setSummaryResult] = useState<SummaryResultState | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  // Aborts the active summary-job poll loop on unmount so it stops calling
  // setState after the page is gone; the job keeps running on the backend and
  // is resumed from localStorage on the next mount.
  const summaryJobAbortRef = useRef<AbortController | null>(null);
  const resumedSummaryJobRef = useRef(false);
  // Always points at the latest runSummaryJob so the resume effect can call it
  // without listing an every-render-changing function in its dependency array.
  const runSummaryJobRef = useRef<((jobId: string, noteId: string, token: string) => Promise<void>) | null>(null);
  const resultAudioRef = useRef<HTMLAudioElement | null>(null);
  const resultPlaybackStopAtRef = useRef<number | null>(null);
  const [resultSegmentPlayback, setResultSegmentPlayback] = useState<SegmentPlaybackState | null>(null);
  const [resultPlaybackLoadingSegmentIndex, setResultPlaybackLoadingSegmentIndex] = useState<number | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [isForwarding, setIsForwarding] = useState(false);
  const [forwardSuccess, setForwardSuccess] = useState(false);
  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [editedSummary, setEditedSummary] = useState<string>('');
  const [currentNoteId, setCurrentNoteId] = useState<string | null>(null);
  const [summaryEditError, setSummaryEditError] = useState<string | null>(null);
  const generatedTitleInputRef = useRef<HTMLInputElement | null>(null);
  const [isEditingGeneratedTitle, setIsEditingGeneratedTitle] = useState(false);
  const [generatedTitleDraft, setGeneratedTitleDraft] = useState('');
  const [openMenuChatId, setOpenMenuChatId] = useState<string | null>(null);
  const [showDiscardModal, setShowDiscardModal] = useState(false);
  const [isForwardTeamsModalOpen, setIsForwardTeamsModalOpen] = useState(false);
  const [isShareNoteModalOpen, setIsShareNoteModalOpen] = useState(false);
  const [generatedSharedUserIds, setGeneratedSharedUserIds] = useState<string[]>([]);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [profileGenStep, setProfileGenStep] = useState<'idle' | 'finding-speakers' | 'generating' | 'ready' | 'error'>('idle');
  const [profileGenError, setProfileGenError] = useState<string | null>(null);
  const [generatedProfiles, setGeneratedProfiles] = useState<GeneratedProfile[]>([]);
  const [isSaveAllConfirmOpen, setIsSaveAllConfirmOpen] = useState(false);
  const [saveAllStatus, setSaveAllStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [saveAllErrorDetails, setSaveAllErrorDetails] = useState<string[]>([]);
  const [resultsTab, setResultsTab] = useState<'summary' | 'transcription' | 'images'>('summary');
  const [generatedNoteImageCount, setGeneratedNoteImageCount] = useState(0);
  const [transcriptSpeakerFilters, setTranscriptSpeakerFilters] = useState<string[]>([]);
  const [generatedTranscriptLanguage, setGeneratedTranscriptLanguage] = useState<TranscriptLanguage>('original');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Recording and recent audio states
  const [recentAudioFiles, setRecentAudioFiles] = useState<RecentAudioFile[]>([]);
  const [recentAudioLoading, setRecentAudioLoading] = useState(false);
  const [recentAudioError, setRecentAudioError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [forwardError, setForwardError] = useState<string | null>(null);
  /** Tailwind `md` is 768px — used to mirror “mobile” layout behavior. */
  const [isNarrowViewport, setIsNarrowViewport] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 767px)').matches : false
  );

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setOpenMenuChatId(null);
    if (openMenuChatId) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [openMenuChatId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 767px)');
    const sync = () => setIsNarrowViewport(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  /** Must match Supabase `note.id` type (uuid). The summarize webhook receives this value. */
  const generateNoteId = (): string => crypto.randomUUID();

  const formatRecordingTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const confirm = useConfirm();
  const confirmDiscardRecording = useCallback(
    (): Promise<boolean> =>
      confirm({
        title: 'Discard recording',
        message: 'This will permanently discard the saved recording backup. Continue?',
        confirmLabel: 'Discard',
        destructive: true,
      }),
    [confirm]
  );

  const useRecording = () => {
    if (!recordedBlob) return;

    startScreenWakeLockKeepAlive();

    const fileName = recordedFileName;
    const audioFile = new window.File([recordedBlob], fileName, { type: recordedMimeType });
    
    const newFile: UploadedFile = {
      id: crypto.randomUUID(),
      name: fileName,
      size: recordedBlob.size,
      type: recordedMimeType,
      status: 'pending',
    };
    
    setUploadedFiles([newFile]);
    void uploadToSupabase(newFile.id, audioFile, 'recording').then((ok) => {
      if (ok) clearRecording({ discardDraft: true });
    });
  };

  const seekPlayback = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    seekPlaybackRatio(x / rect.width);
  };

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, isLoading, navigate]);

  useEffect(() => {
    if (!user?.id || !isAuthenticated) {
      setSummaryPromptRows([]);
      setSelectedSummaryPromptId(null);
      setSummaryPromptsLoading(false);
      setOptionalInstructions('');
      return;
    }
    let cancelled = false;

    const loadSummaryPrompts = async () => {
      setSummaryPromptsLoading(true);
      try {
        const { data: rows, error } = await supabase
          .from(SUMMARY_PROMPT_TABLE)
          .select('id, name, prompt')
          .eq('user_id', user.id)
          .order('name', { ascending: true });

        if (cancelled) return;
        if (error) throw error;

        let list = (rows ?? []) as { id: string; name: string; prompt: string }[];

        if (list.length === 0) {
          const { error: insertError } = await supabase.from(SUMMARY_PROMPT_TABLE).insert({
            user_id: user.id,
            name: DEFAULT_SUMMARY_PROMPT_NAME,
            prompt: DEFAULT_SUMMARY_PROMPT,
          });
          if (cancelled) return;
          if (insertError) {
            const code = (insertError as { code?: string }).code;
            if (code !== '23505') {
              console.error('summary_prompt insert:', insertError);
            }
          }
          const { data: rowsAfter, error: refetchError } = await supabase
            .from(SUMMARY_PROMPT_TABLE)
            .select('id, name, prompt')
            .eq('user_id', user.id)
            .order('name', { ascending: true });
          if (cancelled) return;
          if (refetchError) throw refetchError;
          list = (rowsAfter ?? []) as typeof list;
        }

        setSummaryPromptRows(list);

        const storageKey = `mn.selectedSummaryPrompt.${user.id}`;
        const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) : null;
        let pick = stored && list.some((r) => r.id === stored) ? stored : null;
        if (!pick && list.length > 0) {
          const def = list.find((r) => r.name === DEFAULT_SUMMARY_PROMPT_NAME);
          pick = def?.id ?? list[0].id;
        }
        setSelectedSummaryPromptId(pick);
      } catch (e) {
        if (!cancelled) console.error('Failed to load summary prompts:', e);
      } finally {
        if (!cancelled) setSummaryPromptsLoading(false);
      }
    };

    void loadSummaryPrompts();
    return () => {
      cancelled = true;
    };
  }, [user?.id, isAuthenticated]);

  const handleSummaryPromptSelect = useCallback(
    (promptId: string) => {
      const nextPromptId = promptId || null;
      setSelectedSummaryPromptId(nextPromptId);
      if (user?.id && typeof localStorage !== 'undefined') {
        if (nextPromptId) {
          localStorage.setItem(`mn.selectedSummaryPrompt.${user.id}`, nextPromptId);
        } else {
          localStorage.removeItem(`mn.selectedSummaryPrompt.${user.id}`);
        }
      }
    },
    [user?.id]
  );

  useEffect(() => {
    const fetchChats = async () => {
      if (!isAuthenticated) return;

      try {
        setChatsLoading(true);
        setChatsError(null);
        const token = await getAccessToken();
        if (token) {
          const teamsChats = await getTeamsChats(token);
          setChats(teamsChats);
        }
      } catch (error: any) {
        console.error('Error fetching chats:', error);
        setChatsError(error.message || 'Failed to load Teams chats');
      } finally {
        setChatsLoading(false);
      }
    };

    fetchChats();
  }, [isAuthenticated, getAccessToken]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    startScreenWakeLockKeepAlive();
    handleFiles(files);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const input = e.target;
    const list = input.files;
    if (!list?.length) return;
    const files = Array.from(list);
    ensureScreenWakeLockFromGesture();
    window.setTimeout(() => {
      handleFiles(files);
      input.value = '';
    }, 0);
  };

  const loadRecentAudioFiles = useCallback(async () => {
    if (!user?.id) {
      setRecentAudioFiles([]);
      return;
    }

    setRecentAudioLoading(true);
    setRecentAudioError(null);
    try {
      const query = supabase
        .from('file')
        .select('id, name, bucket, storage_path, public_url, mime_type, size_bytes, source, recorded_at, created_at')
        .eq('user_id', user.id)
        .order('recorded_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(10);
      let { data, error }: { data: unknown[] | null; error: { message: string } | null } = await query;

      if (error && /recorded_at/i.test(error.message)) {
        const fallback = await supabase
          .from('file')
          .select('id, name, bucket, storage_path, public_url, mime_type, size_bytes, source, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(10);
        data = fallback.data;
        error = fallback.error;
      }

      if (error) throw error;
      setRecentAudioFiles((data ?? []) as RecentAudioFile[]);
    } catch (error) {
      console.error('Failed to load recent audio files:', error);
      setRecentAudioError(error instanceof Error ? error.message : 'Failed to load recent recordings');
    } finally {
      setRecentAudioLoading(false);
    }
  }, [user?.id]);

  const saveAudioFileRecord = useCallback(
    async (
      file: File,
      storagePath: string,
      source: 'upload' | 'recording'
    ): Promise<string | null> => {
      if (!user?.id) return null;
      const { data, error } = await supabase.from('file').insert({
        user_id: user.id,
        name: file.name,
        bucket: AUDIO_BUCKET,
        storage_path: storagePath,
        public_url: '',
        mime_type: file.type || 'application/octet-stream',
        size_bytes: file.size,
        source,
        recorded_at: file.lastModified > 0 ? new Date(file.lastModified).toISOString() : null,
      }).select('id').single();
      if (error) throw error;
      await loadRecentAudioFiles();
      return typeof data?.id === 'string' ? data.id : null;
    },
    [loadRecentAudioFiles, user?.id]
  );

  const createAudioSignedUrl = useCallback(async (storagePath: string, bucket = AUDIO_BUCKET): Promise<string> => {
    const { data, error } = await supabase.storage
      .from(bucket || AUDIO_BUCKET)
      .createSignedUrl(storagePath, AUDIO_SIGNED_URL_SECONDS);
    if (error || !data?.signedUrl) {
      throw error ?? new Error('Could not create a signed audio URL.');
    }
    return data.signedUrl;
  }, []);

  const selectRecentAudioFile = async (file: RecentAudioFile) => {
    ensureScreenWakeLockFromGesture();
    setRecentAudioError(null);
    try {
      const signedUrl = await createAudioSignedUrl(file.storage_path, file.bucket || AUDIO_BUCKET);
      clearRecording();
      setUploadedFiles([
        {
          id: file.id,
          name: file.name,
          size: Number(file.size_bytes ?? 0),
          type: file.mime_type || 'audio/*',
          status: 'completed',
          progress: 100,
          publicUrl: signedUrl,
          bucket: file.bucket || AUDIO_BUCKET,
          storagePath: file.storage_path,
          audioFileId: file.id,
          recordedAt: file.recorded_at ?? null,
        },
      ]);
      setSummaryError(null);
    } catch (error) {
      console.error('Failed to create signed URL for recent audio file:', error);
      setRecentAudioError(error instanceof Error ? error.message : 'Failed to load recent recording');
    }
  };

  const deleteRecentAudioFile = async (file: RecentAudioFile) => {
    if (!user?.id) return;

    setRecentAudioError(null);
    try {
      const { error: storageError } = await supabase.storage
        .from(file.bucket || AUDIO_BUCKET)
        .remove([file.storage_path]);

      if (storageError) throw storageError;

      const { data: deletedFile, error: deleteError } = await supabase
        .from('file')
        .delete()
        .eq('id', file.id)
        .eq('user_id', user.id)
        .select('id')
        .maybeSingle();

      if (deleteError) throw deleteError;
      // 0 rows deleted (RLS denied / already gone): don't imply success.
      if (!deletedFile) throw new Error('Could not delete this recording. Please refresh and try again.');

      setRecentAudioFiles((prev) => prev.filter((item) => item.id !== file.id));
    } catch (error) {
      console.error('Failed to delete recent audio file:', error);
      setRecentAudioError(error instanceof Error ? error.message : 'Failed to delete recent recording');
    }
  };

  useEffect(() => {
    if (!user?.id || !isAuthenticated) {
      setRecentAudioFiles([]);
      setRecentAudioLoading(false);
      setRecentAudioError(null);
      return;
    }
    void loadRecentAudioFiles();
  }, [isAuthenticated, loadRecentAudioFiles, user?.id]);

  useEffect(() => {
    const translatedSummary = summaryResult?.summaryTranslations?.[appLanguage]?.trim();
    if (!translatedSummary || isEditingSummary) return;
    setEditedSummary(translatedSummary);
    setSummaryResult((prev) => (prev ? { ...prev, summary: translatedSummary } : prev));
  }, [appLanguage, isEditingSummary, summaryResult?.summaryTranslations]);

  // Keep in sync with the meeting-recordings bucket file_size_limit
  // (supabase/migrations/20260805120000_raise_meeting_recordings_upload_limit.sql)
  // and the project-wide storage upload limit in the Supabase dashboard.
  const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB

  const oversizedFileMessage = (bytes: number): string =>
    `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB. Your file: ${(bytes / 1024 / 1024).toFixed(1)}MB`;

  const handleFiles = (files: File[]) => {
    setUploadError(null);
    const audioFiles = files.filter(file =>
      file.type.startsWith('audio/') ||
      ASSEMBLYAI_AUDIO_EXTENSION_RE.test(file.name)
    );

    if (audioFiles.length === 0) {
      setUploadError('Please upload an AssemblyAI-supported audio file.');
      return;
    }

    const oversizedFiles = audioFiles.filter(f => f.size > MAX_FILE_SIZE);
    if (oversizedFiles.length > 0) {
      setUploadError(oversizedFileMessage(oversizedFiles[0].size));
      return;
    }

    const newUploadedFiles: UploadedFile[] = audioFiles.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      type: file.type,
      status: 'pending' as const,
      recordedAt: file.lastModified > 0 ? new Date(file.lastModified).toISOString() : null,
    }));

    setUploadedFiles((prev) => [...prev, ...newUploadedFiles]);

    newUploadedFiles.forEach((meta, i) => {
      void uploadToSupabase(meta.id, audioFiles[i], 'upload');
    });
  };

  const uploadToSupabase = async (fileId: string, file: File, source: 'upload' | 'recording'): Promise<boolean> => {
    // Enforce the size cap here so BOTH paths (file picker and recording) get a
    // clear message before any network attempt, not an opaque Supabase 413.
    if (file.size > MAX_FILE_SIZE) {
      const message = oversizedFileMessage(file.size);
      setUploadedFiles((prev) =>
        prev.map((f) => (f.id === fileId ? { ...f, status: 'error', error: message } : f))
      );
      setUploadError(message);
      return false;
    }

    setUploadedFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, status: 'uploading', progress: 0 } : f))
    );

    activeUploadsRef.current += 1;
    startScreenWakeLockKeepAlive();
    try {
      const ext = file.name.split('.').pop() || 'audio';
      const sanitizedName =
        Array.from(file.name)
          .filter((char) => char.charCodeAt(0) <= 0x7f)
          .join('')
          .replace(/\s+/g, '_')
          .replace(/[^a-zA-Z0-9._-]/g, '') || `audio_${Date.now()}`;
      const filePath = `${fileId}-${sanitizedName.includes('.') ? sanitizedName : `${sanitizedName}.${ext}`}`;

      const useTus =
        isSupabaseResumableConfigured(SUPABASE_URL) && shouldUseResumableUpload(file.size);

      if (useTus) {
        const uploadAccessToken = await getSupabaseAccessTokenForRequest();
        if (!uploadAccessToken) throw new Error('Could not get Supabase auth token for upload.');
        await uploadWithTus(
          filePath,
          file,
          SUPABASE_URL,
          SUPABASE_ANON_KEY,
          uploadAccessToken,
          (uploaded, total) => {
            const pct = total > 0 ? Math.min(100, Math.round((uploaded / total) * 100)) : 0;
            const now = Date.now();
            const gate = uploadProgressGateRef.current;
            const prev = gate.get(fileId) ?? { pct: -1, at: 0 };
            const jump = pct - prev.pct;
            const elapsed = now - prev.at;
            if (pct >= 100 || prev.pct < 0 || jump >= 3 || elapsed >= 450) {
              gate.set(fileId, { pct, at: now });
              startTransition(() => {
                setUploadedFiles((prevFiles) =>
                  prevFiles.map((f) => (f.id === fileId ? { ...f, progress: pct } : f))
                );
              });
            }
          }
        );
      } else {
        const { error } = await supabase.storage
          .from(AUDIO_BUCKET)
          .upload(filePath, file, {
            cacheControl: '3600',
            upsert: false,
          });
        if (error) throw error;
      }

      await ensureStorageObjectReady(AUDIO_BUCKET, filePath);
      const signedUrl = await createAudioSignedUrl(filePath, AUDIO_BUCKET);

      let audioFileId: string | null = null;
      try {
        audioFileId = await saveAudioFileRecord(file, filePath, source);
      } catch (recordError) {
        console.error('Failed to save audio file metadata:', recordError);
        if (source === 'recording') throw recordError;
      }

      setUploadedFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? {
                ...f,
                status: 'completed',
                progress: 100,
                publicUrl: signedUrl,
                bucket: AUDIO_BUCKET,
                storagePath: filePath,
                audioFileId: audioFileId ?? undefined,
                recordedAt: file.lastModified > 0 ? new Date(file.lastModified).toISOString() : null,
              }
            : f
        )
      );
      return true;
    } catch (error: any) {
      console.error('Upload error:', error);
      // Backstop: if the storage layer rejects on size (e.g. the project-wide
      // upload limit is below MAX_FILE_SIZE), show the same clear cap message
      // instead of an opaque 413 / "exceeded the maximum allowed size".
      const raw = String(error?.message ?? error?.error ?? '');
      const isSizeError =
        error?.statusCode === '413' ||
        error?.status === 413 ||
        /too large|maximum allowed size|payload too large|exceeded the maximum/i.test(raw);
      const message = isSizeError ? oversizedFileMessage(file.size) : (error.message || 'Upload failed');
      if (isSizeError) setUploadError(message);
      setUploadedFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? {
                ...f,
                status: 'error',
                error: message,
              }
            : f
        )
      );
      return false;
    } finally {
      uploadProgressGateRef.current.delete(fileId);
      activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1);
      if (activeUploadsRef.current === 0 && !isRecording) {
        await releaseScreenWakeLock();
      }
    }
  };

  const removeFile = (fileId: string) => {
    setUploadedFiles(prev => prev.filter(f => f.id !== fileId));
    clearRecording({ discardDraft: true });
  };

  const handlePendingImagesAdd = useCallback((images: PendingNoteImage[]) => {
    setPendingNoteImages((prev) => [...prev, ...images]);
  }, []);

  const handlePendingImageRemove = useCallback((imageId: string) => {
    setPendingNoteImages((prev) => {
      const removed = prev.find((image) => image.id === imageId);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((image) => image.id !== imageId);
    });
  }, []);

  const uploadPendingNoteImages = async (noteId: string): Promise<NoteImage[]> => {
    if (!user?.id) return [];
    const validPendingImages = pendingNoteImages.filter((image) => image.status !== 'error');
    if (validPendingImages.length === 0) return [];

    const uploadedImages: NoteImage[] = [];
    for (const pendingImage of validPendingImages) {
      setPendingNoteImages((prev) =>
        prev.map((image) => (image.id === pendingImage.id ? { ...image, status: 'uploading', error: null } : image))
      );
      try {
        const uploaded = await uploadNoteImage({
          file: pendingImage.file,
          noteId,
          userId: user.id,
          name: pendingImage.name,
          width: pendingImage.width ?? null,
          height: pendingImage.height ?? null,
        });
        uploadedImages.push(uploaded);
        setPendingNoteImages((prev) =>
          prev.map((image) =>
            image.id === pendingImage.id
              ? { ...image, status: 'uploaded', storagePath: uploaded.storage_path, noteImage: uploaded }
              : image
          )
        );
      } catch (err) {
        setPendingNoteImages((prev) =>
          prev.map((image) =>
            image.id === pendingImage.id
              ? { ...image, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' }
              : image
          )
        );
        throw err;
      }
    }
    return uploadedImages;
  };

  const hasCompletedFiles = uploadedFiles.some(f => f.status === 'completed');
  const showPromptSection = isRecording || recordedAudioUrl || uploadedFiles.length > 0;
  const summaryFlowActive =
    isSummarizing || isRegenerating || summaryResult !== null || summaryError !== null;
  const promptSectionLayoutExpanded =
    showPromptSection &&
    (!isNarrowViewport || !summaryFlowActive);

  const waitForWorkflowJob = async (
    jobId: string,
    initialToken: string,
    getToken: () => Promise<string | null>,
    signal?: AbortSignal
  ): Promise<WorkflowJobStatus> => {
    const startedAt = Date.now();
    const POLL_INTERVAL_MS = 2500;
    const throwIfAborted = () => {
      if (signal?.aborted) throw new DOMException('Polling aborted.', 'AbortError');
    };
    // Transcription/summarization can run for many minutes; a single network
    // blip, a gateway 5xx, or an expired token must NOT fail a job that is still
    // running on the backend. Tolerate a few consecutive poll failures (with a
    // token refresh + backoff) before giving up. Terminal states reported by the
    // backend (completed/failed) are handled outside the catch and are final.
    const MAX_CONSECUTIVE_POLL_FAILURES = 5;
    let token = initialToken;
    let consecutiveFailures = 0;
    while (Date.now() - startedAt < 60 * 60 * 1000) {
      throwIfAborted();
      let status: WorkflowJobStatus;
      try {
        const response = await fetch(`${WORKFLOW_API_URL}/summarize-audio/jobs/${encodeURIComponent(jobId)}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal,
        });
        if (!response.ok) {
          const detail = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(detail?.error || `Workflow status request failed: ${response.status}`);
        }
        status = (await response.json()) as WorkflowJobStatus;
        consecutiveFailures = 0;
      } catch (error) {
        // Abort (unmount/new run) is not a poll failure — stop immediately.
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
          throw new DOMException('Polling aborted.', 'AbortError');
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          throw error instanceof Error ? error : new Error('Workflow polling failed.');
        }
        // Refresh the token in case the reused one expired mid-job, then back off.
        const refreshed = await getToken().catch(() => null);
        if (refreshed) token = refreshed;
        const backoff = Math.min(POLL_INTERVAL_MS * 2 ** (consecutiveFailures - 1), 20000);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }

      setSummaryProgress({
        stage: status.stage || status.status,
        progress: typeof status.progress === 'number' ? status.progress : 0,
      });

      if (status.status === 'completed') return status;
      if (status.status === 'failed') throw new Error(status.error || 'Workflow job failed.');
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error('Workflow job timed out.');
  };

  const downloadStorageAudioFile = async (
    storagePath: string | undefined,
    fileName: string,
    bucket = AUDIO_BUCKET,
    fallbackUrl?: string
  ) => {
    try {
      const url = storagePath ? await createAudioSignedUrl(storagePath, bucket) : fallbackUrl;
      if (!url) throw new Error('Could not create a signed download URL.');
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      anchor.rel = 'noopener noreferrer';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      console.error('Failed to download audio file:', error);
      setSummaryError(error instanceof Error ? error.message : 'Failed to download audio file');
    }
  };

  const isPlayableSegment = (segment: TranscriptSegment): boolean =>
    typeof segment.start === 'number' && Number.isFinite(segment.start) && segment.start >= 0;

  const getResultAudioUrl = async (): Promise<string> => {
    const completedFile = uploadedFiles.find((f) => f.status === 'completed' && (f.storagePath || f.publicUrl));
    if (!completedFile) throw new Error('No audio file is available for playback.');
    if (completedFile.storagePath) {
      return createAudioSignedUrl(completedFile.storagePath, completedFile.bucket || AUDIO_BUCKET);
    }
    if (completedFile.publicUrl) return completedFile.publicUrl;
    throw new Error('No audio file is available for playback.');
  };

  const stopResultSegmentPlayback = () => {
    const audio = resultAudioRef.current;
    if (audio) audio.pause();
    resultPlaybackStopAtRef.current = null;
    setResultSegmentPlayback(null);
  };

  const handlePlayResultTranscriptSegment = async (segment: TranscriptSegment, segmentIndex: number) => {
    if (!isPlayableSegment(segment)) return;
    const audio = resultAudioRef.current;
    if (!audio) return;

    if (resultSegmentPlayback?.segmentIndex === segmentIndex && resultSegmentPlayback.isPlaying) {
      stopResultSegmentPlayback();
      return;
    }

    const start = segment.start ?? 0;
    const end = typeof segment.end === 'number' && Number.isFinite(segment.end) && segment.end > start ? segment.end : null;

    try {
      setResultPlaybackLoadingSegmentIndex(segmentIndex);
      const url = await getResultAudioUrl();
      audio.muted = false;
      audio.volume = 1;
      resultPlaybackStopAtRef.current = end;
      setResultSegmentPlayback({
        segmentIndex,
        start,
        end,
        currentTime: start,
        isPlaying: true,
      });
      if (audio.src !== url) {
        audio.src = url;
        audio.load();
      }
      if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            audio.removeEventListener('loadedmetadata', onReady);
            audio.removeEventListener('canplay', onReady);
            audio.removeEventListener('error', onError);
          };
          const onReady = () => {
            cleanup();
            resolve();
          };
          const onError = () => {
            cleanup();
            reject(new Error('Could not load audio for playback.'));
          };
          audio.addEventListener('loadedmetadata', onReady, { once: true });
          audio.addEventListener('canplay', onReady, { once: true });
          audio.addEventListener('error', onError, { once: true });
        });
      }
      audio.currentTime = start;
      await audio.play();
    } catch (error) {
      console.error('Failed to play generated transcript segment:', error);
      resultPlaybackStopAtRef.current = null;
      setResultSegmentPlayback(null);
    } finally {
      setResultPlaybackLoadingSegmentIndex(null);
    }
  };

  // F1c: fold a note's transcript into the user's personal memory in the
  // background (best-effort, deduped per note). Called after a fresh summary AND
  // after a regenerate, so the note is folded once either way. Never blocks or
  // fails the caller.
  const foldNoteIntoUserMemory = (noteId: string, segments: TranscriptSegment[]): void => {
    if (!user?.id || segments.length === 0) return;
    const memoryUserId = user.id;
    const memorySelfName = user.displayName ?? null;
    void (async () => {
      try {
        const auth = {
          appToken: await getSupabaseAccessTokenForRequest().catch(() => null),
          msToken: await getAccessToken().catch(() => null),
        };
        await updateUserMemoryFromNote({
          userId: memoryUserId,
          noteId,
          segments,
          selfName: memorySelfName,
          auth,
        });
      } catch (memoryError) {
        console.error('Failed to update user memory:', memoryError);
      }
    })();
  };

  const applySummaryResult = async (completedJob: WorkflowJobStatus, noteId: string) => {
    const result = completedJob.result ?? {};
    const summaryTranslations = result.summaryTranslations && typeof result.summaryTranslations === 'object'
      ? result.summaryTranslations
      : undefined;
    const summaryText =
      summaryTranslations?.[appLanguage]?.trim() ||
      (typeof result.summary === 'string' ? result.summary : String(result.summary ?? ''));
    const noteTitle = typeof result.title === 'string' && result.title.trim()
      ? result.title.trim()
      : 'Untitled note';
    const meetingAt = new Date().toISOString();
    const transcript = normalizeTranscript(result.transcript);
    const transcriptionTranslations = result.transcriptionTranslations && typeof result.transcriptionTranslations === 'object'
      ? result.transcriptionTranslations
      : undefined;
    const diarizationTranslations = result.diarizationTranslations && typeof result.diarizationTranslations === 'object'
      ? result.diarizationTranslations
      : undefined;
    const audioDurationSeconds =
      typeof result.audioDurationSeconds === 'number' && Number.isFinite(result.audioDurationSeconds)
        ? result.audioDurationSeconds
        : null;
    try {
      // On a resumed job, pendingNoteImages was lost to the refresh, so this is
      // a no-op; on a fresh run it uploads the staged attachments.
      const uploadedImages = await uploadPendingNoteImages(noteId);
      setGeneratedNoteImageCount(uploadedImages.length);
      if (uploadedImages.length > 0) {
        pendingNoteImages.forEach((image) => URL.revokeObjectURL(image.previewUrl));
        setPendingNoteImages([]);
      }
    } catch (imageError) {
      console.error('Failed to save note attachments:', imageError);
    }
    setSummaryResult({
      summary: summaryText,
      summaryTranslations,
      transcription_language: result.transcriptionLanguage ?? null,
      transcription_translations: transcriptionTranslations,
      diarization_translations: diarizationTranslations,
      title: noteTitle,
      meetingAt,
      transcript,
      audioDurationSeconds,
    });
    setGeneratedSharedUserIds([]);
    setGeneratedTitleDraft(noteTitle);
    setEditedSummary(summaryText);
    setResultsTab('summary');

    // F1c: fold this meeting into the user's personal memory (durable per-user
    // context base). Best-effort, fully in the background — never blocks the UI.
    foldNoteIntoUserMemory(noteId, transcript);
  };

  // Poll a created job to completion and apply its result. Persists the job id
  // so a refresh/navigation can resume it, and aborts cleanly on unmount (the
  // job keeps running on the backend; a later mount resumes from localStorage).
  const runSummaryJob = async (jobId: string, noteId: string, token: string) => {
    const controller = new AbortController();
    summaryJobAbortRef.current?.abort();
    summaryJobAbortRef.current = controller;
    persistActiveSummaryJob({ jobId, noteId });
    try {
      const completedJob = await waitForWorkflowJob(jobId, token, getAccessToken, controller.signal);
      await applySummaryResult(completedJob, noteId);
      clearActiveSummaryJob();
    } catch (error: any) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        // Unmount/navigation: keep the persisted job so a later mount resumes it.
        return;
      }
      console.error('Error summarizing:', error);
      setSummaryError(error.message || 'Failed to generate summary');
      clearActiveSummaryJob();
    } finally {
      if (summaryJobAbortRef.current === controller) summaryJobAbortRef.current = null;
      if (!controller.signal.aborted) {
        setIsSummarizing(false);
        setSummaryProgress(null);
      }
    }
  };

  const handleSummarize = async () => {
    if (!hasCompletedFiles) return;
    const selectedPrompt = summaryPromptRows.find((row) => row.id === selectedSummaryPromptId) ?? summaryPromptRows[0] ?? null;
    if (!selectedPrompt?.id) {
      setSummaryError('Select a summarization prompt.');
      return;
    }

    const completedFiles = uploadedFiles.filter(f => f.status === 'completed' && (f.publicUrl || f.storagePath));
    if (completedFiles.length === 0) return;

    stopResultSegmentPlayback();
    setIsSummarizing(true);
    setSummaryProgress({ stage: 'starting', progress: 0 });
    setSummaryResult(null);
    setGeneratedSharedUserIds([]);
    setGeneratedTranscriptLanguage('original');
    setIsEditingGeneratedTitle(false);
    setGeneratedTitleDraft('');
    setGeneratedNoteImageCount(0);
    setSummaryError(null);

    let jobId: string;
    let noteId: string;
    let token: string;
    try {
      const file = completedFiles[0];
      noteId = generateNoteId();
      setCurrentNoteId(noteId);

      if (!WORKFLOW_API_URL) {
        throw new Error('Workflow API URL is not configured.');
      }
      const acquiredToken = await getAccessToken();
      if (!acquiredToken) throw new Error('Could not acquire Microsoft access token.');
      token = acquiredToken;
      const downloadUrl = file.storagePath
        ? await createAudioSignedUrl(file.storagePath, file.bucket || AUDIO_BUCKET)
        : file.publicUrl;
      if (!downloadUrl) throw new Error('Could not create a signed audio URL.');
      const validPendingAttachments = pendingNoteImages.filter((attachment) => attachment.status !== 'error');
      const summaryAttachments = await Promise.all(
        validPendingAttachments.map(async (attachment) => ({
          name: attachment.name,
          mimeType: attachment.mimeType || attachment.file.type || 'application/octet-stream',
          dataBase64: await fileToBase64(attachment.file),
        }))
      );

      const requestBody = {
        downloadUrl,
        fileName: file.name,
        fileId: file.audioFileId,
        meetingAt: file.recordedAt ?? null,
        userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        instructions: optionalInstructions,
        promptId: String(selectedPrompt.id),
        userId: user?.id || '',
        userName: user?.displayName || '',
        noteId,
        language: appLanguage,
        attachments: summaryAttachments,
      };

      const response = await fetch(`${WORKFLOW_API_URL}/summarize-audio/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(detail?.error || `Request failed: ${response.status}`);
      }

      const createdJob = (await response.json()) as { jobId?: string };
      if (!createdJob.jobId) throw new Error('Workflow did not return a job id.');
      jobId = createdJob.jobId;
    } catch (error: any) {
      console.error('Error summarizing:', error);
      setSummaryError(error.message || 'Failed to generate summary');
      setIsSummarizing(false);
      setSummaryProgress(null);
      return;
    }

    await runSummaryJob(jobId, noteId, token);
  };

  runSummaryJobRef.current = runSummaryJob;

  // Abort the active poll loop on unmount so it stops updating state; the backend
  // job keeps running and is resumed from localStorage on the next mount.
  useEffect(() => {
    return () => {
      summaryJobAbortRef.current?.abort();
    };
  }, []);

  // Resume an in-flight summary job after a page refresh or navigating back.
  // Runs once per mount, after auth is ready; the ref guard prevents re-entry on
  // subsequent renders.
  useEffect(() => {
    if (resumedSummaryJobRef.current) return;
    if (!isAuthenticated || !user?.id) return;
    const persisted = readActiveSummaryJob();
    if (!persisted) return;
    resumedSummaryJobRef.current = true;
    setIsSummarizing(true);
    setSummaryProgress({ stage: 'resuming', progress: 0 });
    setSummaryError(null);
    setCurrentNoteId(persisted.noteId);
    void (async () => {
      const token = await getAccessToken();
      if (!token) {
        setSummaryError('Could not resume the previous summary. Please try again.');
        setIsSummarizing(false);
        setSummaryProgress(null);
        clearActiveSummaryJob();
        return;
      }
      await runSummaryJobRef.current?.(persisted.jobId, persisted.noteId, token);
    })();
  }, [isAuthenticated, user?.id, getAccessToken]);

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (days === 1) {
      return 'Yesterday';
    } else if (days < 7) {
      return date.toLocaleDateString([], { weekday: 'short' });
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  };

  const formatExactDateTime = (dateString: string): string => {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return dateString;
    return date.toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getChatDisplayName = (chat: TeamsChat): string => {
    if (chat.topic) return chat.topic;
    if (chat.members && chat.members.length > 0) {
      const userEmail = user?.email?.toLowerCase() || '';
      const otherMembers = chat.members.filter(m => {
        const memberEmail = m.email?.toLowerCase() || '';
        if (!memberEmail) return true;
        return memberEmail !== userEmail;
      });
      
      if (otherMembers.length > 0) {
        return otherMembers.map(m => m.displayName).join(', ');
      }
    }
    return chat.chatType === 'oneOnOne' ? 'Direct Message' : 'Group Chat';
  };

  const persistSummaryEdit = async (summaryText: string): Promise<boolean> => {
    if (!currentNoteId) return false;

    try {
      setSummaryEditError(null);
      const { data, error } = await supabase
        .from('note')
        .update({ summary_edit: summaryText })
        .eq('id', currentNoteId)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      // 0 rows updated (RLS denied / note gone): don't report a save that
      // didn't happen — the edit would silently vanish on refresh.
      if (!data) throw new Error('Could not save your edit. Please refresh and try again.');
      return true;
    } catch (err: unknown) {
      console.error('Error saving summary edit:', err);
      setSummaryEditError(err instanceof Error ? err.message : 'Failed to save summary edit');
      return false;
    }
  };

  const getGeneratedTitle = (): string => summaryResult?.title?.trim() || 'Untitled note';

  const startGeneratedTitleEdit = (selectAll = false) => {
    setIsEditingGeneratedTitle(true);
    setGeneratedTitleDraft(getGeneratedTitle());
    window.requestAnimationFrame(() => {
      generatedTitleInputRef.current?.focus();
      if (selectAll) generatedTitleInputRef.current?.select();
    });
  };

  const saveGeneratedTitleEdit = async () => {
    if (!summaryResult || !currentNoteId) return;
    const name = generatedTitleDraft.trim();
    if (!name || name === getGeneratedTitle()) {
      setIsEditingGeneratedTitle(false);
      setGeneratedTitleDraft('');
      return;
    }

    try {
      setSummaryEditError(null);
      const { data, error } = await supabase
        .from('note')
        .update({ name })
        .eq('id', currentNoteId)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      // 0 rows updated (RLS denied / note gone): don't fake a successful rename.
      if (!data) throw new Error('Could not save the title. Please refresh and try again.');
      setSummaryResult((prev) => (prev ? { ...prev, title: name } : prev));
    } catch (err: unknown) {
      setSummaryEditError(err instanceof Error ? err.message : 'Failed to save note title');
    } finally {
      setIsEditingGeneratedTitle(false);
      setGeneratedTitleDraft('');
    }
  };

  const handleToggleEditSummary = async () => {
    if (!isEditingSummary) {
      setIsEditingSummary(true);
      return;
    }

    if (currentNoteId) {
      const saved = await persistSummaryEdit(editedSummary);
      if (!saved) return;
    }
    setIsEditingSummary(false);
  };

  const handleForwardSummary = async () => {
    if (!selectedChatId || !editedSummary || !currentNoteId) return;
    
    setIsForwarding(true);
    setForwardSuccess(false);
    setForwardError(null);

    try {
      const token = await getAccessToken();
      if (!token) throw new Error('No access token');

      // Convert markdown to HTML for Teams
      const summaryHtml = await marked(editedSummary);
      const message = `<strong>Meeting Note:</strong><br><br>${summaryHtml}`;
      await sendChatMessage(token, selectedChatId, message, 'html');
      
      // Update the note in Supabase with the chat_id
      const { error: updateError } = await supabase
        .from('note')
        .update({ chat_id: selectedChatId })
        .eq('id', currentNoteId);
      
      if (updateError) {
        console.error('Error updating note with chat_id:', updateError);
      }
      
      setForwardSuccess(true);
      setIsForwardTeamsModalOpen(false);
      setOpenMenuChatId(null);
      setTimeout(() => setForwardSuccess(false), 3000);
    } catch (error: any) {
      console.error('Error forwarding summary:', error);
      setForwardError('Failed to forward summary: ' + (error.message || 'Unknown error'));
    } finally {
      setIsForwarding(false);
    }
  };

  const formatTranscriptText = (segments: TranscriptSegment[], language: TranscriptLanguage = transcriptLanguage): string =>
    segments.map((s) => `${s.speaker}: ${getSegmentText(s, language)}`).join('\n\n');

  const getGeneratedTranscriptLanguage = (): TranscriptLanguage => {
    if (!summaryResult) return 'original';
    return getAvailableTranscriptLanguages(summaryResult).includes(generatedTranscriptLanguage)
      ? generatedTranscriptLanguage
      : 'original';
  };

  const getGeneratedTranscriptSegments = (): TranscriptSegment[] => {
    if (!summaryResult) return [];
    return getDisplayTranscriptSegments(summaryResult, getGeneratedTranscriptLanguage());
  };

  const persistGeneratedTranscript = async (language: TranscriptLanguage, next: TranscriptSegment[]) => {
    if (!currentNoteId) return;
    if (language === 'original') {
      await persistNoteDiarization(currentNoteId, next);
      return;
    }
    const nextTranslations = updateTranslationMap(summaryResult?.diarization_translations, language, next);
    const { data, error } = await supabase
      .from('note')
      .update({
        diarization_translations: nextTranslations,
        transcription_translations: {
          ...(summaryResult?.transcription_translations ?? {}),
          [language]: next.map((segment) => `${segment.speaker}: ${segment.text}`).join('\n\n'),
        },
      })
      .eq('id', currentNoteId)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Transcript translation save did not update the note.');
  };

  const updateGeneratedTranscript = (language: TranscriptLanguage, next: TranscriptSegment[]) => {
    setSummaryResult((prev) => {
      if (!prev) return prev;
      if (language === 'original') return { ...prev, transcript: next };
      return {
        ...prev,
        diarization_translations: updateTranslationMap(prev.diarization_translations, language, next),
        transcription_translations: {
          ...(prev.transcription_translations ?? {}),
          [language]: next.map((segment) => `${segment.speaker}: ${segment.text}`).join('\n\n'),
        },
      };
    });
  };

  const renderGeneratedTranscriptLanguageToggle = () => {
    if (!summaryResult) return null;
    const languages = getAvailableTranscriptLanguages(summaryResult);
    if (languages.length <= 1) return null;
    const selected = getGeneratedTranscriptLanguage();
    return (
      <div className="transcript-language-toggle" role="radiogroup" aria-label="Transcript language">
        {languages.map((language) => (
          <button
            key={language}
            type="button"
            role="radio"
            aria-checked={selected === language}
            className={`transcript-language-toggle-option ${selected === language ? 'transcript-language-toggle-option-active' : ''}`}
            onClick={() => setGeneratedTranscriptLanguage(language)}
          >
            {getTranscriptLanguageLabel(language)}
          </button>
        ))}
      </div>
    );
  };

  const handleGenerateProfile = async () => {
    if (!summaryResult || !user?.id) return;
    setIsProfileModalOpen(true);
    setProfileGenStep('finding-speakers');
    setProfileGenError(null);
    setGeneratedProfiles([]);

    try {
      const uniqueSpeakers = [...new Set(summaryResult.transcript.map((s) => s.speaker).filter(Boolean))];

      const { data: speakerRows, error: speakerErr } = await supabase
        .from('speaker')
        .select('id, name, profile')
        .eq('user_id', user.id)
        .in('name', uniqueSpeakers);

      if (speakerErr) throw speakerErr;

      const speakerMap = new Map<string, { id: string; profile: string | null }>();
      ((speakerRows ?? []) as { id: string; name: string; profile: string | null }[]).forEach((s) => {
        speakerMap.set(s.name.toLowerCase(), { id: s.id, profile: s.profile });
      });

      setProfileGenStep('generating');

      const transcriptText = formatTranscriptText(summaryResult.transcript);

      const appToken = await getSupabaseAccessTokenForRequest();
      const msToken = appToken ? null : await getAccessToken();
      if (!appToken && !msToken) throw new Error('Could not get access. Please sign in again.');
      const auth = { appToken, msToken };

      const results = await Promise.all(
        uniqueSpeakers.map(async (speakerName): Promise<GeneratedProfile> => {
          const record = speakerMap.get(speakerName.toLowerCase()) ?? null;
          const existingProfile = record?.profile?.trim() || null;

          const data = await invokeGenerateProfile({
            speakerName,
            speakerId: record?.id ?? '',
            transcriptText,
            existingProfile,
          }, auth).catch((error: unknown) => {
            console.error(`generate-profile failed for "${speakerName}"`, error);
            throw new Error(`Edge function error for "${speakerName}": ${error instanceof Error ? error.message : String(error)}`);
          });
          if (data?.error) throw new Error(`Profile error for "${speakerName}": ${data.error}`);

          const draft = canonicalOntologyProfileString(data?.profile ?? '');

          return {
            speakerId: record?.id ?? null,
            speakerName,
            draft,
            isNew: !existingProfile,
            saving: false,
            saved: false,
            saveError: null,
          };
        })
      );

      setGeneratedProfiles(results);
      setProfileGenStep('ready');
    } catch (err: unknown) {
      console.error('Profile generation failed:', err);
      setProfileGenError(err instanceof Error ? err.message : 'Profile generation failed');
      setProfileGenStep('error');
    }
  };

  const handleSaveProfile = async (speakerName: string): Promise<{ ok: boolean; error?: string }> => {
    if (!user?.id) return { ok: false, error: 'Missing authenticated user.' };
    const profile = generatedProfiles.find((p) => p.speakerName === speakerName);
    if (!profile) return { ok: false, error: `Profile "${speakerName}" not found.` };

    setGeneratedProfiles((prev) =>
      prev.map((p) => (p.speakerName === speakerName ? { ...p, saving: true, saveError: null } : p))
    );

    try {
      const toSave = canonicalOntologyProfileString(profile.draft);
      if (profile.speakerId) {
        const { data, error } = await supabase
          .from('speaker')
          .update({ profile: toSave })
          .eq('id', profile.speakerId)
          .eq('user_id', user.id)
          .select('id')
          .maybeSingle();
        if (error) throw error;
        // 0 rows updated (RLS denied / row gone): don't mark it saved.
        if (!data) throw new Error('Could not save the speaker profile. Please refresh and try again.');
      } else {
        const { error } = await supabase
          .from('speaker')
          .insert({ user_id: user.id, name: speakerName, profile: toSave });
        if (error) throw error;
      }
      setGeneratedProfiles((prev) =>
        prev.map((p) =>
          p.speakerName === speakerName ? { ...p, draft: toSave, saving: false, saved: true } : p
        )
      );
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Save failed';
      setGeneratedProfiles((prev) =>
        prev.map((p) =>
          p.speakerName === speakerName
            ? { ...p, saving: false, saveError: message }
            : p
        )
      );
      return { ok: false, error: message };
    }
  };

  const handleConfirmSaveAllProfiles = async () => {
    const unsaved = generatedProfiles.filter((p) => !p.saved);
    if (unsaved.length === 0) {
      setSaveAllStatus('success');
      setSaveAllErrorDetails([]);
      setIsProfileModalOpen(false);
      return;
    }
    setSaveAllStatus('saving');
    setSaveAllErrorDetails([]);
    const failures: string[] = [];
    for (const profile of unsaved) {
      const result = await handleSaveProfile(profile.speakerName);
      if (!result.ok) failures.push(`${profile.speakerName}: ${result.error || 'Save failed'}`);
    }
    if (failures.length === 0) {
      setSaveAllStatus('success');
      setIsProfileModalOpen(false);
      return;
    }
    setSaveAllErrorDetails(failures);
    setSaveAllStatus('error');
  };

  const handleRegenerateSummary = async () => {
    if (!summaryResult || !currentNoteId || !user?.id) return;
    setIsRegenerating(true);
    setRegenerateError(null);
    try {
      if (!WORKFLOW_API_URL) {
        throw new Error('Workflow API URL is not configured.');
      }
      const token = await getAccessToken();
      if (!token) throw new Error('Could not acquire Microsoft access token.');
      const uniqueSpeakers = [...new Set(summaryResult.transcript.map((s) => s.speaker).filter(Boolean))];
      const { data: speakerRows } = await supabase
        .from('speaker')
        .select('name, profile')
        .eq('user_id', user.id)
        .in('name', uniqueSpeakers);

      const speakerProfiles = ((speakerRows ?? []) as { name: string; profile: string | null }[])
        .filter((s) => s.profile)
        .map((s) => ({
          speakerName: s.name,
          profile: (() => { try { return JSON.parse(s.profile!); } catch { return s.profile; } })(),
        }));

      const response = await fetch(`${WORKFLOW_API_URL}/regenerate-summary`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          noteId: currentNoteId,
          diarization: summaryResult.transcript,
          previousSummary: editedSummary,
          speakerProfiles,
          instructions: optionalInstructions,
          promptId: selectedSummaryPromptId ? String(selectedSummaryPromptId) : undefined,
        }),
      });

      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(detail?.error || `Request failed: ${response.status}`);
      }

      const result = await response.json();
      const newSummary = typeof result.summary === 'string' ? result.summary : String(result.summary ?? '');
      if (!newSummary) throw new Error('No summary returned from webhook');

      setEditedSummary(newSummary);
      setSummaryResult((prev) => (prev ? { ...prev, summary: newSummary } : prev));
      setResultsTab('summary');

      // F1c: a regenerate also finalizes this note's transcript/summary, so fold
      // it into the user's memory too (deduped — a note already folded is skipped).
      foldNoteIntoUserMemory(currentNoteId, summaryResult.transcript);
    } catch (err: unknown) {
      console.error('Regenerate summary failed:', err);
      setRegenerateError(err instanceof Error ? err.message : 'Regeneration failed');
    } finally {
      setIsRegenerating(false);
    }
  };

  const resultActionBtnClass =
    'result-action-btn flex min-h-[2.75rem] w-full min-w-0 items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:w-auto sm:justify-start sm:px-4 sm:py-2';
  const resultActionBtnLabelClass = 'hidden truncate sm:inline';

  const handleCopyText = useCallback(async (text: string, key: string) => {
    const value = text.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1500);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  }, []);

  if (isLoading) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center" style={{ backgroundColor: 'var(--bg)' }}>
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 mx-auto mb-4" style={{ borderColor: 'var(--accent)' }}></div>
          <p style={{ color: 'var(--text-secondary)' }}>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="transcription-summary-page flex h-full min-h-0 flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg)' }}>
      <main className="min-h-0 flex-1 flex flex-col overflow-hidden p-4 md:p-6">
        <div className="w-full max-w-7xl mx-auto flex-1 min-h-0 flex flex-col">
          {/* File Upload Section */}
          <section className="flex-1 min-h-0 flex flex-col">
            <div className="shrink-0">
            <div className="app-page-header">
              <h1 className="app-page-title">
                    {t('uploadAudio')}
              </h1>
              <p className="app-page-subtitle">
                    {t('uploadAudioPageSubtitle')}
              </p>
            </div>
            {recorderError ? (
              <div
                className="mb-4 flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm"
                style={{
                  backgroundColor: 'var(--error-light)',
                  borderColor: 'var(--error)',
                  color: 'var(--error)',
                }}
                role="alert"
              >
                <span>{recorderError}</span>
                <button
                  type="button"
                  onClick={clearRecorderError}
                  className="shrink-0 underline"
                >
                  {appLanguage === 'ko' ? '닫기' : 'Dismiss'}
                </button>
              </div>
            ) : null}
            {wakeLockWarning && isRecording ? (
              <div
                className="mb-4 rounded-lg border px-4 py-3 text-sm"
                style={{
                  backgroundColor: 'var(--warning-light, var(--bg-secondary))',
                  borderColor: 'var(--border)',
                  color: 'var(--text-secondary)',
                }}
              >
                {wakeLockWarning}
              </div>
            ) : null}
            {(recoveryWarning || (isRecording && recoverabilityStatus === 'protected')) ? (
              <div
                className="mb-4 rounded-lg border px-4 py-3 text-sm"
                style={{
                  backgroundColor: 'var(--bg-secondary)',
                  borderColor: 'var(--border)',
                  color: 'var(--text-secondary)',
                }}
              >
                {recoveryWarning ??
                  'Recording recovery is protected with local chunks and cloud draft backup.'}
              </div>
            ) : null}
            {isRecording && recordingLimitWarning ? (
              <div
                className="mb-4 rounded-lg border px-4 py-3 text-sm font-medium"
                style={{
                  backgroundColor: 'var(--error-light, var(--bg-secondary))',
                  borderColor: 'var(--error)',
                  color: 'var(--error)',
                }}
                role="alert"
              >
                {appLanguage === 'ko'
                  ? `2시간 녹음 제한에 곧 도달합니다. 약 ${Math.ceil(Math.max(0, maxRecordingSeconds - recordingTime) / 60)}분 후 자동으로 종료되고 저장됩니다.`
                  : `Approaching the 2-hour recording limit. It will stop and save automatically in about ${Math.ceil(Math.max(0, maxRecordingSeconds - recordingTime) / 60)} min.`}
              </div>
            ) : null}
            {recordingAutoStopped ? (
              <div
                className="mb-4 flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm"
                style={{
                  backgroundColor: 'var(--bg-secondary)',
                  borderColor: 'var(--border)',
                  color: 'var(--text-secondary)',
                }}
                role="status"
              >
                <span>
                  {appLanguage === 'ko'
                    ? '2시간 제한에 도달해 녹음이 종료되고 저장되었습니다. 계속하려면 새로 녹음을 시작하세요.'
                    : 'Recording stopped at the 2-hour limit and was saved. Start a new recording to continue.'}
                </span>
                <button
                  type="button"
                  onClick={acknowledgeAutoStop}
                  className="shrink-0 underline"
                >
                  {appLanguage === 'ko' ? '닫기' : 'Dismiss'}
                </button>
              </div>
            ) : null}
            {recoverableSession && !isRecording && !recordedAudioUrl ? (
              <div className="card mb-4 rounded-lg p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                      {appLanguage === 'ko' ? '중단된 녹음 복구' : 'Recover interrupted recording'}
                    </p>
                    <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {appLanguage === 'ko' ? '복구할 수 있는 이전 녹음 백업이 있습니다.' : 'A previous recording backup is available for recovery.'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void recoverRecording()}
                      className="rounded-lg px-4 py-2 text-sm font-medium"
                      style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                    >
                      {appLanguage === 'ko' ? '녹음 복구' : 'Recover recording'}
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        if (await confirmDiscardRecording()) discardRecording();
                      }}
                      className="rounded-lg px-4 py-2 text-sm font-medium"
                      style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                    >
                      {t('discard')}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
            {/* Record/Upload Options - Hidden when files are uploaded or recording complete */}
            <div className={`collapse-container ${(uploadedFiles.length > 0 || recordedAudioUrl) ? 'collapsed' : 'expanded'}`}>
              <div className="collapse-content">
                <div className="audio-source-options flex flex-col md:flex-row items-stretch gap-4">
                  {/* Record Option */}
                  <button
                    type="button"
                    onClick={isRecording ? stopRecording : startRecording}
                    className={`audio-option-panel record-audio-panel flex-1 card rounded-lg p-4 md:p-6 text-center transition-all ${isRecording ? 'recording-active' : ''}`}
                  >
                    {!isRecording ? (
                      <>
                        <span
                          className="record-audio-icon w-16 h-16 rounded-full mx-auto mb-3 flex items-center justify-center"
                          style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                        >
                          <UserVoice className="h-7 w-7" />
                        </span>
                        <p className="text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>
                          {t('recordAudio')}
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {t('clickToStartRecording')}
                        </p>
                      </>
                    ) : (
                      <>
                        <div className="relative w-16 h-16 mx-auto mb-3">
                          <div 
                            className="absolute inset-0 rounded-full animate-ping opacity-25"
                            style={{ backgroundColor: 'var(--error)' }}
                          />
                          <span
                            className="record-audio-icon relative w-16 h-16 rounded-full flex items-center justify-center"
                            style={{ backgroundColor: 'var(--error)', color: '#fff' }}
                          >
                            <Stop className="h-6 w-6" fill="currentColor" />
                          </span>
                        </div>
                        <p className="text-lg font-mono font-medium mb-1" style={{ color: 'var(--error)' }}>
                          {formatRecordingTime(recordingTime)}
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {t('recordingClickToStop')}
                        </p>
                      </>
                    )}
                  </button>

                  {/* OR Divider */}
                  <div className="audio-source-divider flex md:flex-col items-center justify-center gap-2 py-2 md:py-0 md:px-2">
                    <div className="flex-1 h-px md:h-auto md:w-px md:flex-1" style={{ backgroundColor: 'var(--border)' }} />
                    <span className="text-xs font-medium px-2" style={{ color: 'var(--text-muted)' }}>{t('or')}</span>
                    <div className="flex-1 h-px md:h-auto md:w-px md:flex-1" style={{ backgroundColor: 'var(--border)' }} />
                  </div>

                  {/* Upload Option — label + native input avoids iOS issues with programmatic .click() */}
                  <label
                    htmlFor="meeting-audio-upload"
                    className={`audio-option-panel upload-audio-panel flex-1 drop-zone rounded-lg p-6 text-center cursor-pointer transition-all block min-h-[8rem] ${isDragging ? 'drag-over' : ''}`}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                  >
                    <input
                      id="meeting-audio-upload"
                      ref={fileInputRef}
                      type="file"
                      accept={ASSEMBLYAI_AUDIO_ACCEPT}
                      multiple
                      onChange={handleFileSelect}
                      className="sr-only"
                    />
                    <CloudUpload className="mx-auto mb-3 h-10 w-10" style={{ color: 'var(--text-muted)' }} />
                    <p className="text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>
                      {t('uploadAudioFile')}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {t('dropFilesBrowse')}
                    </p>
                    <p className="text-xs mt-2 max-w-xs mx-auto" style={{ color: 'var(--text-muted)' }}>
                      {t('largeFilesKeepOpen')}
                    </p>
                  </label>
                </div>
              </div>
            </div>

            {uploadError ? (
              <p className="mb-4 text-sm" style={{ color: 'var(--error)' }}>
                {uploadError}
              </p>
            ) : null}

            {/* Recording Playback - Shows when recording is complete but not uploaded */}
            <div className={`collapse-container ${(recordedAudioUrl && uploadedFiles.length === 0) ? 'expanded' : 'collapsed'}`}>
              <div className="collapse-content">
                <div className="card rounded-lg p-4 md:p-6">
                  <div className="flex items-center gap-4 mb-4">
                    <button
                      onClick={togglePlayRecording}
                      className="w-14 h-14 rounded-full flex items-center justify-center transition-all hover:scale-105 flex-shrink-0"
                      style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                    >
                      {isPlayingRecording ? (
                        <Pause className="w-6 h-6" fill="currentColor" />
                      ) : (
                        <Play className="w-6 h-6" fill="currentColor" style={{ marginLeft: '3px' }} />
                      )}
                    </button>
                    <div className="flex-grow">
                      <p className="text-sm font-medium mb-2" style={{ color: 'var(--text)' }}>
                        {t('recordingComplete')}
                      </p>
                      {/* Progress Bar */}
                      <div 
                        className="h-2 rounded-full cursor-pointer relative overflow-hidden"
                        style={{ backgroundColor: 'var(--bg-secondary)' }}
                        onClick={seekPlayback}
                      >
                        <div 
                          className="absolute top-0 left-0 h-full rounded-full transition-all"
                          style={{ 
                            width: `${playbackProgress}%`, 
                            backgroundColor: 'var(--accent)',
                          }} 
                        />
                      </div>
                      {/* Time Display */}
                      <div className="flex justify-between mt-1">
                        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                          {formatRecordingTime(Math.floor(playbackCurrentTime))}
                        </span>
                        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                          {formatRecordingTime(recordingTime)}
                        </span>
                      </div>
                    </div>
                  </div>
                  
                  {/* Action Buttons */}
                  <div className="recording-playback-actions flex items-center justify-end gap-3">
                    {recordedAudioUrl ? (
                      <a
                        href={recordedAudioUrl}
                        download={recordedFileName}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all"
                        style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                        title={`Download ${recordedFileName}`}
                        aria-label={`Download ${recordedFileName}`}
                      >
                        <Download className="w-4 h-4" />
                        <span className="recording-action-label">{t('download')}</span>
                      </a>
                    ) : null}
                    <button
                      onClick={async () => {
                        if (await confirmDiscardRecording()) clearRecording({ discardDraft: true });
                      }}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all"
                      style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                    >
                      <CloseMd className="w-4 h-4" />
                      <span className="recording-action-label">{t('discard')}</span>
                    </button>
                    <button
                      onClick={useRecording}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all"
                      style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                    >
                      <Check className="w-4 h-4" />
                      <span className="recording-action-label">{t('useRecording')}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Uploaded Files List */}
            <div className={`collapse-container ${uploadedFiles.length > 0 ? 'expanded' : 'collapsed'}`}>
              <div className="collapse-content">
                <div className="space-y-2">
                {uploadedFiles.map(file => (
                  <div
                    key={file.id}
                    className="card rounded-lg p-4 flex items-center gap-4"
                  >
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center" 
                      style={{ backgroundColor: 'var(--accent-light)' }}>
                      <VolumeMax className="h-5 w-5" style={{ color: 'var(--accent)' }} />
                    </div>
                    <div className="flex-grow min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: 'var(--text)' }}>
                        {file.name}
                      </p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {formatFileSize(file.size)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {file.status === 'uploading' && (
                        <span className="text-xs uploading-ellipsis" style={{ color: 'var(--accent)' }}>
                          {t('uploading')}
                          {file.progress != null && file.progress > 0 ? ` ${file.progress}%` : ''}
                        </span>
                      )}
                      {file.status === 'processing' && (
                        <div className="flex items-center gap-1">
                          <Loading className="w-4 h-4 animate-spin" style={{ color: 'var(--accent)' }} />
                          <span className="text-xs" style={{ color: 'var(--accent)' }}>{t('processing')}</span>
                        </div>
                      )}
                      {file.status === 'completed' && (
                        <span className="text-xs px-2 py-1 rounded-full" style={{ backgroundColor: 'var(--success-light)', color: 'var(--success)' }}>
                          {t('ready')}
                        </span>
                      )}
                      {file.status === 'error' && (
                        <span
                          className="inline-block max-w-[12rem] truncate rounded-full px-2 py-1 align-middle text-xs"
                          style={{ backgroundColor: 'var(--error-light)', color: 'var(--error)' }}
                          title={file.error || undefined}
                        >
                          {file.error || t('error')}
                        </span>
                      )}
                      {file.status === 'completed' && (file.publicUrl || file.storagePath) ? (
                        <button
                          type="button"
                          onClick={() => void downloadStorageAudioFile(file.storagePath, file.name, file.bucket, file.publicUrl)}
                          className="p-1 rounded hover:bg-opacity-80"
                          style={{ color: 'var(--text-muted)' }}
                          title={`Download ${file.name}`}
                          aria-label={`Download ${file.name}`}
                        >
                          <Download className="w-4 h-4" />
                        </button>
                      ) : null}
                      <button
                        onClick={() => removeFile(file.id)}
                        className="p-1 rounded hover:bg-opacity-80"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        <CloseMd className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
                </div>
              </div>
            </div>

            {/* Recent Recordings */}
            <div className={`collapse-container ${(isRecording || uploadedFiles.length > 0 || recordedAudioUrl) ? 'collapsed' : 'expanded'}`}>
              <div className="collapse-content">
            <div className="card rounded-lg mt-6 p-4">
              <div className="mb-3">
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                    {t('recentRecordings')}
                  </h3>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {t('recentRecordingsSubtitle')}
                  </p>
                </div>
              </div>

              {recentAudioLoading ? (
                <div className="flex items-center gap-2 py-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  <Loading className="h-4 w-4 animate-spin" aria-hidden />
                  {t('loadingRecentRecordings')}
                </div>
              ) : recentAudioError ? (
                <p className="text-sm" style={{ color: 'var(--error)' }}>
                  {recentAudioError}
                </p>
              ) : recentAudioFiles.length === 0 ? (
                <p className="py-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                  {t('noRecentRecordings')}
                </p>
              ) : (
                <div className="summary-note-list recent-recordings-list custom-scrollbar">
                  {recentAudioFiles.map((file) => (
                    <div
                      key={file.id}
                      role="button"
                      tabIndex={0}
                      className="summary-note-row cursor-pointer"
                      onClick={() => void selectRecentAudioFile(file)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          void selectRecentAudioFile(file);
                        }
                      }}
                    >
                      <span className="summary-note-row-rail" aria-hidden />
                      <div className="summary-note-row-content recent-recording-row-content flex items-center gap-3 px-3">
                        <div
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                          style={{ backgroundColor: 'var(--accent-light)' }}
                        >
                          <VolumeMax className="h-4 w-4" style={{ color: 'var(--accent)' }} aria-hidden />
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col justify-center text-left">
                          <p className="truncate text-sm font-medium" style={{ color: 'var(--text)' }}>
                            {file.name}
                          </p>
                          <p className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                            {[
                              file.size_bytes ? formatFileSize(Number(file.size_bytes)) : null,
                              file.created_at ? `${t('uploaded')} ${formatDate(file.created_at)}` : null,
                              file.recorded_at ? `${t('meetingDate')}: ${formatExactDateTime(file.recorded_at)}` : null,
                            ].filter(Boolean).join(' - ')}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors"
                            style={{ color: 'var(--text-secondary)' }}
                            onClick={(event) => {
                              event.stopPropagation();
                              void downloadStorageAudioFile(file.storage_path, file.name, file.bucket || AUDIO_BUCKET, file.public_url);
                            }}
                            title={`Download ${file.name}`}
                            aria-label={`Download ${file.name}`}
                          >
                            <Download className="h-4 w-4" aria-hidden />
                          </button>
                          <button
                            type="button"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors"
                            style={{ color: 'var(--text-secondary)' }}
                            onClick={(event) => {
                              event.stopPropagation();
                              void deleteRecentAudioFile(file);
                            }}
                            title={`Delete ${file.name}`}
                            aria-label={`Delete ${file.name}`}
                          >
                            <CloseMd className="h-4 w-4" aria-hidden />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
              </div>
            </div>

            {/* Summarize Prompt - collapses on narrow viewports during/after summary flow so results can use height */}
            <div
              className={`collapse-container ${promptSectionLayoutExpanded ? 'expanded' : 'collapsed'}`}
            >
              <div className="collapse-content">
              <div className="prompt-controls-shell card rounded-lg mt-2 p-4">
                <div className="flex w-full min-w-0 flex-col gap-4 md:flex-row md:items-start md:gap-4">
                  <div className="min-w-0 flex-1 basis-0">
                    <label className="mb-2 block text-sm font-medium" style={{ color: 'var(--text)' }}>
                      {t('addInstructionsOptional')}
                    </label>
                    <textarea
                      value={optionalInstructions}
                      onChange={(e) => setOptionalInstructions(e.target.value)}
                      placeholder={t('addInstructionsPlaceholder')}
                      rows={1}
                      className="box-border h-10 min-h-[2.5rem] w-full max-w-full min-w-0 resize-y rounded-lg border px-3 py-2 text-sm leading-normal outline-none focus:ring-2 focus:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60 max-h-[200px]"
                      style={{
                        backgroundColor: 'var(--bg-secondary)',
                        borderColor: 'var(--border)',
                        color: 'var(--text)',
                      }}
                      disabled={isSummarizing}
                      aria-label="Optional additional instructions"
                    />
                  </div>
                  <div className="flex min-w-0 w-full flex-col md:w-auto md:max-w-full md:shrink-0">
                    <label className="mb-2 block text-sm font-medium" style={{ color: 'var(--text)' }}>
                      Select summarization prompt
                    </label>
                    <div className="flex min-w-0 w-full flex-col gap-4 md:w-max md:max-w-full md:flex-row md:flex-nowrap md:items-center md:gap-4">
                      <select
                        value={selectedSummaryPromptId ?? ''}
                        onChange={(e) => handleSummaryPromptSelect(e.target.value)}
                        disabled={
                          summaryPromptsLoading || isSummarizing || summaryPromptRows.length === 0
                        }
                        className="box-border h-10 w-full min-w-0 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60 md:w-[calc(9rem+80px)] md:flex-none md:shrink-0"
                        style={{
                          backgroundColor: 'var(--bg-secondary)',
                          border: '1px solid var(--border)',
                          color: 'var(--text)',
                        }}
                        aria-label="Choose summarization prompt by name"
                      >
                        {summaryPromptsLoading ? (
                          <option value="">Loading templates…</option>
                        ) : summaryPromptRows.length === 0 ? (
                          <option value="">No prompts available</option>
                        ) : (
                          summaryPromptRows.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))
                        )}
                      </select>
                      <NoteImageAttachments
                        mode="pending"
                        pendingImages={pendingNoteImages}
                        disabled={isSummarizing}
                        compact
                        onPendingImagesAdd={handlePendingImagesAdd}
                        onPendingImageRemove={handlePendingImageRemove}
                        className="min-w-0 self-end md:flex-none"
                      />
                      <button
                        type="button"
                        onClick={() => void handleSummarize()}
                        disabled={
                          isSummarizing ||
                          !hasCompletedFiles ||
                          !selectedSummaryPromptId ||
                          summaryPromptRows.length === 0
                        }
                        className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50 sm:px-5"
                        style={{
                          backgroundColor: 'var(--accent)',
                          color: '#ffffff',
                        }}
                      >
                        {isSummarizing ? (
                          <>
                            <Loading className="h-4 w-4 shrink-0 animate-spin" />
                            Generate
                          </>
                        ) : (
                          <>
                            <Play className="h-4 w-4 shrink-0" />
                            Generate
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              </div>
            </div>

            </div>{/* end shrink-0 upload area */}

            {/* Summary Result */}
            {(isSummarizing || summaryResult || summaryError) && (
              <div className="flex flex-1 min-h-0 flex-col overflow-hidden card rounded-lg">
                {isSummarizing && (
                  <div className="flex flex-1 flex-col items-center justify-center py-8">
                    <div className="relative">
                      <div className="w-12 h-12 rounded-full border-4 border-t-transparent animate-spin" 
                        style={{ borderColor: 'var(--border)', borderTopColor: 'var(--accent)' }} />
                    </div>
                    <p className="mt-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
                      {summaryProgress?.stage || 'Analyzing audio and generating summary...'}
                    </p>
                    <div className="mt-4 h-2 w-56 overflow-hidden rounded-full" style={{ backgroundColor: 'var(--bg-secondary)' }}>
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.max(4, Math.min(100, summaryProgress?.progress ?? 8))}%`,
                          backgroundColor: 'var(--accent)',
                        }}
                      />
                    </div>
                  </div>
                )}

                {summaryError && !isSummarizing && (
                  <div className="p-4 rounded-lg" style={{ backgroundColor: 'var(--error-light)' }}>
                    <p className="text-sm font-medium" style={{ color: 'var(--error)' }}>
                      Error: {summaryError}
                    </p>
                  </div>
                )}

                {summaryResult && !isSummarizing && (
                  <div className="flex flex-1 min-h-0 flex-col px-4 pt-4 md:px-6 md:pt-5">
                    <div className="mb-5 min-w-0">
                      <div className="editable-note-title-row">
                        <input
                          ref={generatedTitleInputRef}
                          value={isEditingGeneratedTitle ? generatedTitleDraft : getGeneratedTitle()}
                          onFocus={() => {
                            if (!isEditingGeneratedTitle) {
                              setIsEditingGeneratedTitle(true);
                              setGeneratedTitleDraft(getGeneratedTitle());
                            }
                          }}
                          onChange={(event) => setGeneratedTitleDraft(event.target.value)}
                          onBlur={() => void saveGeneratedTitleEdit()}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              event.currentTarget.blur();
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              setIsEditingGeneratedTitle(false);
                              setGeneratedTitleDraft('');
                              event.currentTarget.blur();
                            }
                          }}
                          className="editable-note-title-input"
                          style={{ color: 'var(--text)' }}
                          aria-label="Edit note title"
                          maxLength={200}
                        />
                        <button
                          type="button"
                          className="editable-note-title-icon"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => startGeneratedTitleEdit(true)}
                          aria-label="Edit note title"
                          title="Edit note title"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          <EditPencilLine01 className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                      <p className="mt-1.5 text-xs font-medium uppercase tracking-[0.08em]" style={{ color: 'var(--text-muted)' }}>
                        Meeting {formatExactDateTime(summaryResult.meetingAt ?? new Date().toISOString())}
                        {formatDurationMeta(summaryResult.audioDurationSeconds) ? (
                          <>
                            <span className="mx-2" aria-hidden>•</span>
                            {formatDurationMeta(summaryResult.audioDurationSeconds)}
                          </>
                        ) : null}
                      </p>
                    </div>
                    {summaryResult.transcript.length > 0 ? (
                      <div
                        className="results-header flex shrink-0 flex-wrap items-end justify-between gap-3 border-b"
                        style={{ borderColor: 'var(--border)' }}
                      >
                        <div
                          className="-mb-px results-tabs flex min-w-0 gap-1 sm:gap-5"
                          role="tablist"
                          aria-label="Summary or transcription"
                        >
                          <button
                            type="button"
                            role="tab"
                            aria-selected={resultsTab === 'summary'}
                            onClick={() => setResultsTab('summary')}
                            className="results-tab px-1 pb-2.5 pt-1 text-sm font-medium transition-colors sm:px-1"
                            style={{
                              color: resultsTab === 'summary' ? 'var(--text)' : 'var(--text-secondary)',
                            }}
                          >
                            {t('summary')}
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={resultsTab === 'transcription'}
                            onClick={() => setResultsTab('transcription')}
                            className="results-tab px-1 pb-2.5 pt-1 text-sm font-medium transition-colors sm:px-1"
                            style={{
                              color:
                                resultsTab === 'transcription' ? 'var(--text)' : 'var(--text-secondary)',
                            }}
                          >
                            {t('transcription')}
                          </button>
                          {generatedNoteImageCount > 0 ? (
                            <button
                              type="button"
                              role="tab"
                              aria-selected={resultsTab === 'images'}
                              onClick={() => setResultsTab('images')}
                              className="results-tab px-1 pb-2.5 pt-1 text-sm font-medium transition-colors sm:px-1"
                              style={{
                                color: resultsTab === 'images' ? 'var(--text)' : 'var(--text-secondary)',
                              }}
                            >
                              Attachments
                            </button>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2 pb-2">
                          {resultsTab === 'summary' ? (
                            <button
                              onClick={() => void handleToggleEditSummary()}
                              className="summary-toolbar-btn flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-all"
                              style={{
                                backgroundColor: isEditingSummary ? 'var(--accent)' : 'var(--bg-secondary)',
                                color: isEditingSummary ? '#fff' : 'var(--text-secondary)',
                              }}
                            >
                              {isEditingSummary ? (
                                <>
                                  <Save className="h-3 w-3" />
                                  {t('done')}
                                </>
                              ) : (
                                <>
                                  <EditPencilLine01 className="h-3 w-3" />
                                  {t('edit')}
                                </>
                              )}
                            </button>
                          ) : null}
                          {resultsTab !== 'images' ? (
                            <button
                              type="button"
                              onClick={() =>
                                void handleCopyText(
                                  resultsTab === 'summary'
                                    ? editedSummary
                                    : getDisplayTranscriptText(summaryResult, getGeneratedTranscriptLanguage()),
                                  resultsTab === 'summary' ? 'summary-result' : 'transcription-result'
                                )
                              }
                              className="summary-toolbar-btn flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-all"
                              style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                              title={resultsTab === 'summary' ? 'Copy summary' : 'Copy transcription'}
                              aria-label={resultsTab === 'summary' ? 'Copy summary' : 'Copy transcription'}
                            >
                              {copiedKey === (resultsTab === 'summary' ? 'summary-result' : 'transcription-result') ? (
                                <Check className="h-3 w-3" aria-hidden />
                              ) : (
                                <Copy className="h-3 w-3" aria-hidden />
                              )}
                              {t('copy')}
                            </button>
                          ) : null}
                          <button
                            onClick={() => setShowDiscardModal(true)}
                            className="summary-toolbar-btn summary-toolbar-btn-danger flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-all"
                            style={{
                              backgroundColor: 'var(--bg-secondary)',
                              color: 'var(--text-muted)',
                            }}
                          >
                            <CloseMd className="h-3 w-3" />
                            {t('discard')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
                        <div className="-mb-px results-tabs flex min-w-0 gap-1 sm:gap-5" role="tablist">
                          <button
                            type="button"
                            role="tab"
                            aria-selected={resultsTab === 'summary'}
                            onClick={() => setResultsTab('summary')}
                            className="results-tab px-1 pb-2.5 pt-1 text-sm font-medium transition-colors sm:px-1"
                            style={{ color: resultsTab === 'summary' ? 'var(--text)' : 'var(--text-secondary)' }}
                          >
                            {t('summary')}
                          </button>
                          {generatedNoteImageCount > 0 ? (
                            <button
                              type="button"
                              role="tab"
                              aria-selected={resultsTab === 'images'}
                              onClick={() => setResultsTab('images')}
                              className="results-tab px-1 pb-2.5 pt-1 text-sm font-medium transition-colors sm:px-1"
                              style={{ color: resultsTab === 'images' ? 'var(--text)' : 'var(--text-secondary)' }}
                            >
                              Attachments
                            </button>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                          {resultsTab === 'summary' ? (
                            <>
                          <button
                            type="button"
                            onClick={() => void handleCopyText(editedSummary, 'summary-result')}
                            className="summary-toolbar-btn flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-all"
                            style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                            title="Copy summary"
                            aria-label="Copy summary"
                          >
                            {copiedKey === 'summary-result' ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
                            {t('copy')}
                          </button>
                          <button
                            onClick={() => setShowDiscardModal(true)}
                            className="summary-toolbar-btn summary-toolbar-btn-danger flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-all"
                            style={{
                              backgroundColor: 'var(--bg-secondary)',
                              color: 'var(--text-muted)',
                            }}
                          >
                            <CloseMd className="h-3 w-3" />
                            {t('discard')}
                          </button>
                          <button
                            onClick={() => void handleToggleEditSummary()}
                            className="summary-toolbar-btn flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-all"
                            style={{
                              backgroundColor: isEditingSummary ? 'var(--accent)' : 'var(--bg-secondary)',
                              color: isEditingSummary ? '#fff' : 'var(--text-secondary)',
                            }}
                          >
                            {isEditingSummary ? (
                              <>
                                <Save className="h-3 w-3" />
                                {t('done')}
                              </>
                            ) : (
                              <>
                                <EditPencilLine01 className="h-3 w-3" />
                                {t('edit')}
                              </>
                            )}
                          </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    )}

                    {(summaryResult.transcript.length === 0 || resultsTab === 'summary') && resultsTab !== 'images' && (
                      <div className="flex flex-1 min-h-0 flex-col pt-4">
                        {isEditingSummary ? (
                          <textarea
                            value={editedSummary}
                            onChange={(e) => {
                              setEditedSummary(e.target.value);
                              setSummaryEditError(null);
                            }}
                            className="custom-scrollbar flex-1 min-h-0 w-full resize-none overflow-y-auto rounded-lg border-2 p-4 text-sm leading-relaxed"
                            style={{
                              backgroundColor: 'transparent',
                              color: 'var(--text)',
                              borderColor: 'var(--accent)',
                            }}
                            placeholder="Edit your summary here... (Markdown supported)"
                          />
                        ) : (
                          <div
                            className="summary-markdown prose prose-sm custom-scrollbar flex-1 min-h-0 max-w-none overflow-y-auto rounded-lg p-4 text-sm leading-relaxed"
                            style={{ backgroundColor: 'transparent', color: 'var(--text)' }}
                          >
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{editedSummary}</ReactMarkdown>
                          </div>
                        )}
                        {summaryEditError ? (
                          <p className="mt-2 text-xs" style={{ color: 'var(--error)' }}>
                            {summaryEditError}
                          </p>
                        ) : null}
                      </div>
                    )}

                    {summaryResult.transcript.length > 0 && resultsTab === 'transcription' ? (
                      <div className="flex flex-1 min-h-0 flex-col pt-4">
                        <div className="mb-3 shrink-0">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <TranscriptSpeakerFilterControls
                              speakers={getTranscriptSpeakerFilters(getGeneratedTranscriptSegments())}
                              selectedSpeakers={transcriptSpeakerFilters}
                              onSelectedSpeakersChange={setTranscriptSpeakerFilters}
                            />
                            {renderGeneratedTranscriptLanguageToggle()}
                          </div>
                        </div>
                        <TranscriptDiarizedEditor
                          segments={getGeneratedTranscriptSegments()}
                          onSegmentsChange={(next) =>
                            updateGeneratedTranscript(getGeneratedTranscriptLanguage(), next)
                          }
                          onPersistSegments={(next) =>
                            persistGeneratedTranscript(getGeneratedTranscriptLanguage(), next)
                          }
                          noteId={currentNoteId}
                          scrollContainerClassName="flex-1 min-h-0"
                          selectedSpeakerFilters={transcriptSpeakerFilters}
                          onSelectedSpeakerFiltersChange={setTranscriptSpeakerFilters}
                          activePlaybackSegmentIndex={resultSegmentPlayback?.segmentIndex ?? null}
                          isPlaybackActive={Boolean(resultSegmentPlayback?.isPlaying)}
                          loadingPlaybackSegmentIndex={resultPlaybackLoadingSegmentIndex}
                          playbackTimeLabel={
                            resultSegmentPlayback
                              ? `${formatRecordingTime(Math.floor(resultSegmentPlayback.currentTime))}${
                                  resultSegmentPlayback.end != null ? ` / ${formatRecordingTime(Math.floor(resultSegmentPlayback.end))}` : ''
                                }`
                              : null
                          }
                          canPlaySegment={isPlayableSegment}
                          onPlaySegment={(segment, index) => void handlePlayResultTranscriptSegment(segment, index)}
                          transcriptLanguage={getGeneratedTranscriptLanguage()}
                          onNoteShared={setGeneratedSharedUserIds}
                        />
                      </div>
                    ) : null}

                    {currentNoteId && resultsTab === 'images' && generatedNoteImageCount > 0 ? (
                      <div className="flex flex-1 min-h-0 flex-col pt-4">
                        <NoteImageAttachments
                          mode="saved"
                          noteId={currentNoteId}
                          userId={user?.id}
                          showCountButton={false}
                          onImagesChange={(images) => {
                            setGeneratedNoteImageCount(images.length);
                            if (images.length === 0) setResultsTab('summary');
                          }}
                        />
                      </div>
                    ) : null}

                    <div
                      className="summary-result-action-row grid max-sm:pb-[max(1rem,calc(env(safe-area-inset-bottom,0px)+3.25rem))] shrink-0 grid-cols-5 gap-1 border-t pt-3 sm:flex sm:flex-wrap sm:justify-end sm:gap-2 sm:py-4 sm:pb-4"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <button
                        type="button"
                        title={t('saveToOneDrive')}
                        aria-label={t('saveToOneDrive')}
                        onClick={() => void (async () => {
                          const completedFile = uploadedFiles.find((f) => f.status === 'completed' && (f.storagePath || f.publicUrl));
                          const signedUrl = completedFile?.storagePath
                            ? await createAudioSignedUrl(completedFile.storagePath, completedFile.bucket || AUDIO_BUCKET)
                            : completedFile?.publicUrl;
                          const audioUrl = signedUrl ? encodeURIComponent(signedUrl) : '';
                          const audioName = completedFile?.name ? encodeURIComponent(completedFile.name) : '';
                          navigate(`/save-summary?note_id=${currentNoteId}&audio_url=${audioUrl}&audio_name=${audioName}`);
                        })()}
                        className={resultActionBtnClass}
                      >
                        <Cloud className="h-4 w-4 shrink-0" aria-hidden />
                        <span className={resultActionBtnLabelClass}>Save</span>
                      </button>
                      <button
                        type="button"
                        title={
                          isForwarding
                            ? t('sending')
                            : forwardSuccess
                              ? t('sent')
                              : t('forwardToTeams')
                        }
                        aria-label={
                          isForwarding
                            ? t('sending')
                            : forwardSuccess
                              ? t('sent')
                              : t('forwardToTeams')
                        }
                        onClick={() => setIsForwardTeamsModalOpen(true)}
                        disabled={isForwarding}
                        className={resultActionBtnClass}
                      >
                        {isForwarding ? (
                          <>
                            <Loading className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                            <span className={resultActionBtnLabelClass}>{t('sending')}</span>
                          </>
                        ) : forwardSuccess ? (
                          <>
                            <Check className="h-4 w-4 shrink-0" style={{ color: 'var(--success)' }} aria-hidden />
                            <span className={resultActionBtnLabelClass}>{t('sent')}</span>
                          </>
                        ) : (
                          <>
                            <Users className="h-4 w-4 shrink-0" aria-hidden />
                            <span className={resultActionBtnLabelClass}>Forward</span>
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        title={t('share')}
                        aria-label={t('share')}
                        onClick={() => setIsShareNoteModalOpen(true)}
                        disabled={!currentNoteId}
                        className={resultActionBtnClass}
                      >
                        <ShareAndroid className="h-4 w-4 shrink-0" aria-hidden />
                        <span className={resultActionBtnLabelClass}>{t('share')}</span>
                      </button>
                      <button
                        type="button"
                        title={t('syncProfile')}
                        aria-label={t('syncProfile')}
                        onClick={() => void handleGenerateProfile()}
                        className={resultActionBtnClass}
                      >
                        <UserCircle className="h-4 w-4 shrink-0" aria-hidden />
                        <span className={resultActionBtnLabelClass}>{t('syncProfile')}</span>
                      </button>
                      <button
                        type="button"
                        title={t('regenerateSummary')}
                        aria-label={t('regenerateSummary')}
                        disabled={isRegenerating || summaryResult.transcript.length === 0}
                        onClick={() => void handleRegenerateSummary()}
                        className={resultActionBtnClass}
                      >
                        {isRegenerating ? (
                          <>
                            <Loading className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                            <span className={resultActionBtnLabelClass}>Regenerating…</span>
                          </>
                        ) : (
                          <>
                            <ArrowsReload01 className="h-4 w-4 shrink-0" aria-hidden />
                            <span className={resultActionBtnLabelClass}>Regenerate</span>
                          </>
                        )}
                      </button>
                    </div>
                    {regenerateError ? (
                      <p className="shrink-0 px-1 pb-2 text-xs" style={{ color: 'var(--error)' }}>
                        {regenerateError}
                      </p>
                    ) : null}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </main>

      <audio
        ref={resultAudioRef}
        className="hidden"
        onTimeUpdate={(event) => {
          const audio = event.currentTarget;
          const stopAt = resultPlaybackStopAtRef.current;
          const currentTime = audio.currentTime;
          setResultSegmentPlayback((prev) => (prev ? { ...prev, currentTime } : prev));
          if (stopAt != null && currentTime >= stopAt) {
            audio.pause();
            resultPlaybackStopAtRef.current = null;
            setResultSegmentPlayback((prev) => (prev ? { ...prev, currentTime: stopAt, isPlaying: false } : prev));
          }
        }}
        onPlay={(event) => {
          const currentTime = event.currentTarget.currentTime;
          setResultSegmentPlayback((prev) => (prev ? { ...prev, currentTime, isPlaying: true } : prev));
        }}
        onPause={(event) => {
          const currentTime = event.currentTarget.currentTime;
          setResultSegmentPlayback((prev) => (prev ? { ...prev, currentTime, isPlaying: false } : prev));
        }}
        onEnded={() => {
          resultPlaybackStopAtRef.current = null;
          setResultSegmentPlayback((prev) => (prev ? { ...prev, isPlaying: false } : prev));
        }}
        onError={() => {
          resultPlaybackStopAtRef.current = null;
          setResultSegmentPlayback(null);
        }}
      />

      {isForwardTeamsModalOpen && summaryResult && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          role="presentation"
          onClick={() => {
            if (!isForwarding) setIsForwardTeamsModalOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="forward-teams-title"
            className="flex max-h-[min(90vh,720px)] w-full max-w-5xl flex-col overflow-hidden rounded-xl app-surface-elevated"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex shrink-0 items-center justify-between gap-3 px-4 py-3 sm:px-5"
              style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 45%, transparent)' }}
            >
              <h2 id="forward-teams-title" className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
                {t('forwardToTeams')}
              </h2>
              <button
                type="button"
                disabled={isForwarding}
                onClick={() => setIsForwardTeamsModalOpen(false)}
                className="rounded-md p-2 transition-opacity disabled:opacity-50"
                style={{ color: 'var(--text-muted)' }}
                aria-label={t('close')}
              >
                <CloseMd className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <p className="shrink-0 px-4 pt-3 text-sm sm:px-5" style={{ color: 'var(--text-secondary)' }}>
              {t('chooseChatForward')}
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-3 sm:px-5">
              {chatsLoading ? (
                <div className="rounded-lg border p-8 text-center" style={{ borderColor: 'var(--border)' }}>
                  <div
                    className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-b-2"
                    style={{ borderColor: 'var(--accent)' }}
                  />
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {t('loadingTeamsChats')}
                  </p>
                </div>
              ) : chatsError ? (
                <div className="rounded-lg border p-6" style={{ borderColor: 'var(--border)' }}>
                  <p className="text-sm font-medium" style={{ color: 'var(--error)' }}>
                    {chatsError}
                  </p>
                  <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {t('teamsPermissionHint')}
                  </p>
                </div>
              ) : chats.length === 0 ? (
                <div className="rounded-lg border p-8 text-center" style={{ borderColor: 'var(--border)' }}>
                  <Chat className="mx-auto mb-4 h-12 w-12" style={{ color: 'var(--text-muted)' }} aria-hidden />
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {t('noTeamsChatsFound')}
                  </p>
                </div>
              ) : (
                <div className="max-h-[min(50vh,22rem)] overflow-y-auto custom-scrollbar rounded-lg border" style={{ borderColor: 'var(--border)' }}>
                  <div className="space-y-2 p-2">
                    {chats
                      .filter((chat) => chat.members && chat.members.length > 1)
                      .map((chat) => (
                        <div
                          key={chat.id}
                          onClick={() => setSelectedChatId(chat.id === selectedChatId ? null : chat.id)}
                          className="chat-item flex cursor-pointer items-center gap-4 rounded-lg p-4 transition-all"
                          style={{
                            borderColor: chat.id === selectedChatId ? 'var(--accent)' : undefined,
                            backgroundColor: chat.id === selectedChatId ? 'var(--accent-light)' : undefined,
                          }}
                        >
                          <div
                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                            style={{
                              backgroundColor: chat.id === selectedChatId ? 'var(--accent)' : 'var(--accent-light)',
                            }}
                          >
                            {chat.chatType === 'oneOnOne' ? (
                              <Chat
                                className="h-5 w-5"
                                style={{ color: chat.id === selectedChatId ? '#fff' : 'var(--accent)' }}
                                aria-hidden
                              />
                            ) : (
                              <Users
                                className="h-5 w-5"
                                style={{ color: chat.id === selectedChatId ? '#fff' : 'var(--accent)' }}
                                aria-hidden
                              />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium" style={{ color: 'var(--text)' }}>
                              {getChatDisplayName(chat)}
                            </p>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              {chat.chatType === 'oneOnOne'
                                ? 'Direct message'
                                : chat.chatType === 'group'
                                  ? 'Group chat'
                                  : 'Meeting chat'}
                              {chat.members && ` • ${chat.members.length} members`}
                              {' • '}
                              {formatDate(chat.lastMessageDateTime || chat.lastUpdatedDateTime)}
                            </p>
                          </div>
                          <div className="relative shrink-0">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenuChatId(openMenuChatId === chat.id ? null : chat.id);
                              }}
                              className="chat-menu-icon rounded-md p-2 transition-all"
                              aria-label="Chat actions"
                            >
                              <MoreVertical style={{ width: '22px', height: '22px' }} aria-hidden />
                            </button>

                            {openMenuChatId === chat.id ? (
                              <div
                                className="absolute right-0 top-full z-10 mt-1 min-w-32 rounded-lg py-1 shadow-lg"
                                style={{ backgroundColor: 'var(--card)', border: '1px solid var(--border)' }}
                              >
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenMenuChatId(null);
                                    navigate(`/history?chat_id=${encodeURIComponent(chat.id)}`);
                                  }}
                                  className="chat-menu-item flex w-full items-center gap-2 px-4 py-2 text-sm transition-all"
                                >
                                  <ListOrdered className="h-4 w-4" aria-hidden />
                                  History
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenMenuChatId(null);
                                    if (chat.webUrl) window.open(chat.webUrl, '_blank');
                                  }}
                                  className="chat-menu-item flex w-full items-center gap-2 px-4 py-2 text-sm transition-all"
                                >
                                  <Chat className="h-4 w-4" aria-hidden />
                                  Chat
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
            <div
              className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-4 py-3 sm:px-5"
              style={{ borderColor: 'var(--border)' }}
            >
              {forwardError ? (
                <p className="mr-auto text-sm" style={{ color: 'var(--error)' }}>
                  {forwardError}
                </p>
              ) : null}
              <button
                type="button"
                disabled={isForwarding}
                onClick={() => setIsForwardTeamsModalOpen(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:opacity-50"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                disabled={!selectedChatId || isForwarding || !editedSummary.trim()}
                onClick={() => void handleForwardSummary()}
                className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
              >
                {isForwarding ? (
                  <>
                    <Loading className="h-4 w-4 animate-spin" aria-hidden />
                    {t('sending')}
                  </>
                ) : (
                  t('forwardSummary')
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      <ShareNoteModal
        isOpen={isShareNoteModalOpen}
        noteId={currentNoteId}
        noteTitle={summaryResult?.title ?? 'Current summary'}
        existingSharedUserIds={generatedSharedUserIds}
        onClose={() => setIsShareNoteModalOpen(false)}
        onShared={(_noteId, sharedUserIds) => setGeneratedSharedUserIds(sharedUserIds)}
      />

      {/* Sync Profile Modal */}
      {isProfileModalOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          role="presentation"
          onClick={() => {
            if (profileGenStep !== 'finding-speakers' && profileGenStep !== 'generating') {
              setIsProfileModalOpen(false);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-modal-title"
            className="flex max-h-[min(92vh,860px)] w-full max-w-5xl flex-col overflow-hidden rounded-xl app-surface-elevated"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div
              className="flex shrink-0 items-center justify-between gap-3 px-5 py-4"
              style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 45%, transparent)' }}
            >
              <div>
                <h2 id="profile-modal-title" className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
                  {t('syncProfile')}
                </h2>
                <p className="mt-0.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  AI-generated speaker profiles from the meeting transcript
                </p>
              </div>
              <button
                type="button"
                disabled={profileGenStep === 'finding-speakers' || profileGenStep === 'generating'}
                onClick={() => setIsProfileModalOpen(false)}
                className="rounded-md p-2 transition-opacity disabled:opacity-40 hover:opacity-70"
                style={{ color: 'var(--text-muted)' }}
                aria-label={t('close')}
              >
                <CloseMd className="h-5 w-5" aria-hidden />
              </button>
            </div>

            {/* Body */}
            <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-5 py-4">
              {(profileGenStep === 'finding-speakers' || profileGenStep === 'generating') && (
                <div className="flex flex-col items-center justify-center py-16">
                  <div
                    className="mb-5 h-10 w-10 animate-spin rounded-full border-4 border-t-transparent"
                    style={{ borderColor: 'var(--border)', borderTopColor: 'var(--accent)' }}
                    aria-hidden
                  />
                  <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                    {profileGenStep === 'finding-speakers' ? t('lookingUpSpeakerData') : t('generatingProfilesAi')}
                  </p>
                </div>
              )}

              {profileGenStep === 'error' && (
                <div
                  className="rounded-lg border p-4"
                  style={{ borderColor: 'var(--error)', backgroundColor: 'var(--error-light)' }}
                >
                  <p className="text-sm font-medium" style={{ color: 'var(--error)' }}>
                    {profileGenError}
                  </p>
                </div>
              )}

              {profileGenStep === 'ready' && (
                <div className="space-y-4">
                  {generatedProfiles.map((profile) => (
                    <div
                      key={profile.speakerName}
                      className="overflow-hidden rounded-lg border"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      {/* Profile header row */}
                      <div
                        className="flex items-center justify-between gap-3 border-b px-4 py-3"
                        style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-secondary)' }}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <div
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                            style={{
                              backgroundColor: 'color-mix(in srgb, var(--accent) 20%, var(--bg-secondary))',
                              color: 'var(--accent)',
                            }}
                          >
                            {profile.speakerName.slice(0, 2).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold" style={{ color: 'var(--text)' }}>
                              {profile.speakerName}
                            </p>
                            <span
                              className="inline-block rounded-full px-2 py-0.5 text-xs font-medium"
                              style={{
                                backgroundColor: profile.isNew
                                  ? 'color-mix(in srgb, var(--accent) 15%, transparent)'
                                  : 'color-mix(in srgb, var(--success) 15%, transparent)',
                                color: profile.isNew ? 'var(--accent)' : 'var(--success)',
                              }}
                            >
                              {profile.isNew ? t('newProfile') : t('updatedProfile')}
                            </span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleCopyText(profile.draft, `profile-${profile.speakerName}`)}
                            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-opacity"
                            style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                            title={`Copy profile for ${profile.speakerName}`}
                            aria-label={`Copy profile for ${profile.speakerName}`}
                          >
                            {copiedKey === `profile-${profile.speakerName}` ? (
                              <Check className="h-3.5 w-3.5" aria-hidden />
                            ) : (
                              <Copy className="h-3.5 w-3.5" aria-hidden />
                            )}
                            Copy
                          </button>
                          {profile.saved && (
                            <span className="flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--success)' }}>
                              <Check className="h-3.5 w-3.5" aria-hidden />
                              Saved
                            </span>
                          )}
                          {profile.saveError && (
                            <span className="text-xs" style={{ color: 'var(--error)' }}>
                              {profile.saveError}
                            </span>
                          )}
                          {!profile.saved && (
                            <button
                              type="button"
                              disabled={profile.saving}
                              onClick={() => void handleSaveProfile(profile.speakerName)}
                              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-opacity disabled:opacity-50"
                              style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                            >
                              {profile.saving ? (
                                <><Loading className="h-3.5 w-3.5 animate-spin" aria-hidden />Saving…</>
                              ) : (
                                <><Save className="h-3.5 w-3.5" aria-hidden />{t('saveProfile')}</>
                              )}
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="p-4">
                        <textarea
                          value={profile.draft}
                          disabled={profile.saved}
                          onChange={(e) =>
                            setGeneratedProfiles((prev) =>
                              prev.map((p) =>
                                p.speakerName === profile.speakerName ? { ...p, draft: e.target.value, saved: false } : p
                              )
                            )
                          }
                          className="custom-scrollbar w-full resize-y rounded-lg border p-3 font-mono text-xs leading-relaxed outline-none disabled:opacity-70"
                          style={{
                            minHeight: '12rem',
                            backgroundColor: 'var(--bg-secondary)',
                            color: 'var(--text)',
                            borderColor: 'var(--border)',
                          }}
                          placeholder="{}"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            {profileGenStep === 'ready' && (
              <div
                className="flex shrink-0 items-center justify-between gap-3 border-t px-5 py-3"
                style={{ borderColor: 'var(--border)' }}
              >
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {generatedProfiles.filter((p) => p.saved).length} of {generatedProfiles.length} profile
                  {generatedProfiles.length !== 1 ? 's' : ''} saved
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsProfileModalOpen(false)}
                    className="rounded-lg px-4 py-2 text-sm font-medium transition-opacity"
                    style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                  >
                    {t('close')}
                  </button>
                  <button
                    type="button"
                    disabled={generatedProfiles.some((p) => p.saving)}
                    onClick={() => {
                      setSaveAllStatus('idle');
                      setSaveAllErrorDetails([]);
                      setIsSaveAllConfirmOpen(true);
                    }}
                    className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:opacity-50"
                    style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                  >
                    {generatedProfiles.some((p) => p.saving) ? (
                      <><Loading className="h-4 w-4 animate-spin" aria-hidden />Saving…</>
                    ) : (
                      'Save All'
                    )}
                  </button>
                </div>
              </div>
            )}

            {profileGenStep === 'error' && (
              <div
                className="flex shrink-0 justify-end border-t px-5 py-3"
                style={{ borderColor: 'var(--border)' }}
              >
                <button
                  type="button"
                  onClick={() => setIsProfileModalOpen(false)}
                  className="rounded-lg px-4 py-2 text-sm font-medium"
                  style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                >
                  {t('close')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {isSaveAllConfirmOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          role="presentation"
          onClick={() => {
            if (saveAllStatus !== 'saving') setIsSaveAllConfirmOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-lg rounded-xl border p-5 shadow-xl"
            style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {saveAllStatus === 'idle' && (
              <>
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('saveAllProfiles')}</h3>
                <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  This will save all unsaved speaker profiles to Supabase.
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsSaveAllConfirmOpen(false)}
                    className="rounded-lg px-4 py-2 text-sm font-medium"
                    style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                  >
                    {t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleConfirmSaveAllProfiles()}
                    className="rounded-lg px-4 py-2 text-sm font-medium"
                    style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                  >
                    {t('confirmSaveAll')}
                  </button>
                </div>
              </>
            )}
            {saveAllStatus === 'saving' && (
              <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                <Loading className="h-4 w-4 animate-spin" aria-hidden />
                {t('savingProfiles')}
              </div>
            )}
            {saveAllStatus === 'success' && (
              <>
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('profilesSaved')}</h3>
                <p className="mt-2 text-sm" style={{ color: 'var(--success)' }}>
                  All profiles were successfully saved to Supabase.
                </p>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setIsSaveAllConfirmOpen(false)}
                    className="rounded-lg px-4 py-2 text-sm font-medium"
                    style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                  >
                    {t('close')}
                  </button>
                </div>
              </>
            )}
            {saveAllStatus === 'error' && (
              <>
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('failedSaveAllProfiles')}</h3>
                <p className="mt-2 text-sm" style={{ color: 'var(--error)' }}>
                  Some profiles could not be saved to Supabase.
                </p>
                <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {saveAllErrorDetails.map((detail, idx) => (
                    <li key={`${detail}-${idx}`}>{detail}</li>
                  ))}
                </ul>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setIsSaveAllConfirmOpen(false)}
                    className="rounded-lg px-4 py-2 text-sm font-medium"
                    style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                  >
                    {t('close')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Discard Confirmation Modal */}
      {showDiscardModal && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          onClick={() => setShowDiscardModal(false)}
        >
          <div 
            className="card rounded-lg p-4 md:p-6 max-w-sm w-full shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--text)' }}>
              {t('discardSummary')}
            </h3>
            <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
              Are you sure you want to discard this summary? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowDiscardModal(false)}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              >
                {t('cancel')}
              </button>
              <button
                onClick={() => {
                  stopResultSegmentPlayback();
                  setSummaryResult(null);
                  setGeneratedTranscriptLanguage('original');
                  setSummaryError(null);
                  setSummaryEditError(null);
                  setEditedSummary('');
                  setIsEditingSummary(false);
                  setIsEditingGeneratedTitle(false);
                  setGeneratedTitleDraft('');
                  setCurrentNoteId(null);
                  setResultsTab('summary');
                  setIsForwardTeamsModalOpen(false);
                  setShowDiscardModal(false);
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
                style={{ backgroundColor: 'var(--error)', color: '#fff' }}
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TranscriptionSummary;
