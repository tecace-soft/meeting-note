import React, { useState, useEffect, useRef, useCallback, startTransition } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getTeamsChats, TeamsChat, sendChatMessage } from '../services/graphService';
import { supabase, AUDIO_BUCKET, SUPABASE_URL, SUPABASE_ANON_KEY } from '../config/supabaseConfig';
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
  PaperPlane,
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
import TranscriptDiarizedEditor, {
  getTranscriptSpeakerFilters,
  TranscriptSpeakerFilterControls,
} from '../components/TranscriptDiarizedEditor';
import {
  normalizeTranscript,
  persistNoteDiarization,
  type TranscriptSegment,
} from '../lib/transcriptSegments';
import { buildSpeakerContextForSummary, canonicalOntologyProfileString } from '../lib/speakerOntology';
import { DEFAULT_SUMMARY_PROMPT, DEFAULT_SUMMARY_PROMPT_NAME } from '../constants/defaultSummaryPrompt';
import ShareNoteModal from '../components/ShareNoteModal';

const SUMMARY_PROMPT_TABLE = 'summary_prompt';

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
  created_at?: string | null;
}

interface RecordingFormat {
  mimeType: string;
  extension: string;
}

const RECORDING_FORMATS: RecordingFormat[] = [
  { mimeType: 'audio/mp4;codecs=mp4a.40.2', extension: 'm4a' },
  { mimeType: 'audio/mp4', extension: 'm4a' },
  { mimeType: 'audio/aac', extension: 'm4a' },
  { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
  { mimeType: 'audio/webm', extension: 'webm' },
];

const TranscriptionSummary: React.FC = () => {
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading, getAccessToken } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadProgressGateRef = useRef<Map<string, { pct: number; at: number }>>(new Map());
  const screenWakeLockRef = useRef<WakeLockSentinel | null>(null);
  const keepScreenAwakeRef = useRef(false);
  const wakeLockKeepAliveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const activeUploadsRef = useRef(0);

  /** Call from file input / recording handlers (user gesture) so Android Chrome grants wake lock. */
  const ensureScreenWakeLockFromGesture = useCallback(async () => {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (screenWakeLockRef.current) return;
    await navigator.wakeLock
      .request('screen')
      .then((w) => {
        screenWakeLockRef.current = w;
        w.addEventListener('release', () => {
          if (screenWakeLockRef.current === w) {
            screenWakeLockRef.current = null;
          }
        });
      })
      .catch(() => {
        /* denied or unsupported */
      });
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

  const stopScreenWakeLockKeepAlive = () => {
    keepScreenAwakeRef.current = false;
    if (wakeLockKeepAliveIntervalRef.current) {
      clearInterval(wakeLockKeepAliveIntervalRef.current);
      wakeLockKeepAliveIntervalRef.current = null;
    }
  };

  const releaseScreenWakeLock = async () => {
    stopScreenWakeLockKeepAlive();
    try {
      await screenWakeLockRef.current?.release();
    } catch {
      /* denied, unsupported, or already released */
    } finally {
      screenWakeLockRef.current = null;
    }
  };

  const [chats, setChats] = useState<TeamsChat[]>([]);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [summaryPromptRows, setSummaryPromptRows] = useState<{ id: string; name: string; prompt: string }[]>([]);
  const [selectedSummaryPromptId, setSelectedSummaryPromptId] = useState<string | null>(null);
  const [summaryPromptsLoading, setSummaryPromptsLoading] = useState(true);
  /** Optional free-text instructions; separate from the saved summarization template (`promptId`). */
  const [optionalInstructions, setOptionalInstructions] = useState('');
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryResult, setSummaryResult] = useState<{ transcript: TranscriptSegment[]; summary: string } | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [isForwarding, setIsForwarding] = useState(false);
  const [forwardSuccess, setForwardSuccess] = useState(false);
  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [editedSummary, setEditedSummary] = useState<string>('');
  const [currentNoteId, setCurrentNoteId] = useState<string | null>(null);
  const [summaryEditError, setSummaryEditError] = useState<string | null>(null);
  const [openMenuChatId, setOpenMenuChatId] = useState<string | null>(null);
  const [showDiscardModal, setShowDiscardModal] = useState(false);
  const [isForwardTeamsModalOpen, setIsForwardTeamsModalOpen] = useState(false);
  const [isShareNoteModalOpen, setIsShareNoteModalOpen] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [profileGenStep, setProfileGenStep] = useState<'idle' | 'finding-speakers' | 'generating' | 'ready' | 'error'>('idle');
  const [profileGenError, setProfileGenError] = useState<string | null>(null);
  const [generatedProfiles, setGeneratedProfiles] = useState<GeneratedProfile[]>([]);
  const [isSaveAllConfirmOpen, setIsSaveAllConfirmOpen] = useState(false);
  const [saveAllStatus, setSaveAllStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [saveAllErrorDetails, setSaveAllErrorDetails] = useState<string[]>([]);
  const [resultsTab, setResultsTab] = useState<'summary' | 'transcription'>('summary');
  const [transcriptSpeakerFilters, setTranscriptSpeakerFilters] = useState<string[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Recording states
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedFileName, setRecordedFileName] = useState('Recording.m4a');
  const [recordedMimeType, setRecordedMimeType] = useState('audio/mp4');
  const [isPlayingRecording, setIsPlayingRecording] = useState(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [playbackCurrentTime, setPlaybackCurrentTime] = useState(0);
  const [recentAudioFiles, setRecentAudioFiles] = useState<RecentAudioFile[]>([]);
  const [recentAudioLoading, setRecentAudioLoading] = useState(false);
  const [recentAudioError, setRecentAudioError] = useState<string | null>(null);
  /** Tailwind `md` is 768px — used to mirror “mobile” layout behavior. */
  const [isNarrowViewport, setIsNarrowViewport] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 767px)').matches : false
  );
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingFormatRef = useRef<RecordingFormat>({ mimeType: 'audio/mp4', extension: 'm4a' });
  const isRecordingRef = useRef(false);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);

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

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && (isRecording || activeUploadsRef.current > 0)) {
        startScreenWakeLockKeepAlive();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isRecording, startScreenWakeLockKeepAlive]);

  /** Must match Supabase `note.id` type (uuid). The summarize webhook receives this value. */
  const generateNoteId = (): string => crypto.randomUUID();

  const getPreferredRecordingFormat = (): RecordingFormat => {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      return { mimeType: 'audio/webm', extension: 'webm' };
    }

    return (
      RECORDING_FORMATS.find((format) => MediaRecorder.isTypeSupported(format.mimeType)) ??
      { mimeType: 'audio/webm', extension: 'webm' }
    );
  };

  const createRecordingFileName = (extension: string): string => {
    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    return `Recording_${timestamp}.${extension}`;
  };

  const formatRecordingTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const streamRef = useRef<MediaStream | null>(null);

  const startRecording = async () => {
    try {
      startScreenWakeLockKeepAlive();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recordingFormat = getPreferredRecordingFormat();
      recordingFormatRef.current = recordingFormat;
      const mediaRecorder = new MediaRecorder(stream, { mimeType: recordingFormat.mimeType });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const mimeType = mediaRecorder.mimeType || recordingFormat.mimeType;
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        const audioUrl = URL.createObjectURL(audioBlob);
        setRecordedAudioUrl(audioUrl);
        setRecordedBlob(audioBlob);
        setRecordedMimeType(mimeType);
        setRecordedFileName(createRecordingFileName(recordingFormat.extension));
        
        // Stop all tracks
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      setRecordedAudioUrl(null);
      setRecordedBlob(null);
      setRecordedMimeType(recordingFormat.mimeType);
      setPlaybackProgress(0);
      setPlaybackCurrentTime(0);
      
      // Start timer
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (error) {
      void releaseScreenWakeLock();
      console.error('Error starting recording:', error);
      alert('Could not access microphone. Please ensure you have granted microphone permissions.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
        recordingIntervalRef.current = null;
      }
      void releaseScreenWakeLock();
    }
  };

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
    uploadToSupabase(newFile.id, audioFile, 'recording');
    
    // Clean up playback
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current = null;
    }
    setIsPlayingRecording(false);
  };

  const togglePlayRecording = () => {
    if (!recordedAudioUrl) return;
    
    if (!audioPlayerRef.current) {
      audioPlayerRef.current = new Audio(recordedAudioUrl);
      audioPlayerRef.current.onended = () => {
        setIsPlayingRecording(false);
        setPlaybackProgress(0);
        setPlaybackCurrentTime(0);
      };
      audioPlayerRef.current.ontimeupdate = () => {
        if (audioPlayerRef.current) {
          const current = audioPlayerRef.current.currentTime;
          const duration = audioPlayerRef.current.duration;
          setPlaybackCurrentTime(current);
          setPlaybackProgress(duration > 0 ? (current / duration) * 100 : 0);
        }
      };
    }
    
    if (isPlayingRecording) {
      audioPlayerRef.current.pause();
      setIsPlayingRecording(false);
    } else {
      audioPlayerRef.current.play();
      setIsPlayingRecording(true);
    }
  };

  const seekPlayback = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioPlayerRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = x / rect.width;
    const newTime = percentage * audioPlayerRef.current.duration;
    audioPlayerRef.current.currentTime = newTime;
    setPlaybackCurrentTime(newTime);
    setPlaybackProgress(percentage * 100);
  };

  const clearRecording = () => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current = null;
    }
    if (recordedAudioUrl) {
      URL.revokeObjectURL(recordedAudioUrl);
    }
    setRecordedAudioUrl(null);
    setRecordedBlob(null);
    setRecordedFileName('Recording.m4a');
    setRecordedMimeType('audio/mp4');
    setRecordingTime(0);
    setIsPlayingRecording(false);
    setPlaybackProgress(0);
    setPlaybackCurrentTime(0);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (recordedAudioUrl) {
        URL.revokeObjectURL(recordedAudioUrl);
      }
    };
  }, [recordedAudioUrl]);

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
      setSelectedSummaryPromptId(promptId);
      if (user?.id && typeof localStorage !== 'undefined') {
        localStorage.setItem(`mn.selectedSummaryPrompt.${user.id}`, promptId);
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
      const { data, error } = await supabase
        .from('file')
        .select('id, name, bucket, storage_path, public_url, mime_type, size_bytes, source, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(10);
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
      publicUrl: string,
      source: 'upload' | 'recording'
    ) => {
      if (!user?.id) return;
      const { error } = await supabase.from('file').insert({
        user_id: user.id,
        name: file.name,
        bucket: AUDIO_BUCKET,
        storage_path: storagePath,
        public_url: publicUrl,
        mime_type: file.type || 'application/octet-stream',
        size_bytes: file.size,
        source,
      });
      if (error) throw error;
      await loadRecentAudioFiles();
    },
    [loadRecentAudioFiles, user?.id]
  );

  const selectRecentAudioFile = (file: RecentAudioFile) => {
    ensureScreenWakeLockFromGesture();
    clearRecording();
    setUploadedFiles([
      {
        id: file.id,
        name: file.name,
        size: Number(file.size_bytes ?? 0),
        type: file.mime_type || 'audio/*',
        status: 'completed',
        progress: 100,
        publicUrl: file.public_url,
      },
    ]);
    setSummaryError(null);
  };

  const deleteRecentAudioFile = async (file: RecentAudioFile) => {
    if (!user?.id) return;

    setRecentAudioError(null);
    try {
      const { error: storageError } = await supabase.storage
        .from(file.bucket || AUDIO_BUCKET)
        .remove([file.storage_path]);

      if (storageError) throw storageError;

      const { error: deleteError } = await supabase
        .from('file')
        .delete()
        .eq('id', file.id)
        .eq('user_id', user.id);

      if (deleteError) throw deleteError;

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

  const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB - matches Supabase bucket limit

  const handleFiles = (files: File[]) => {
    const audioFiles = files.filter(file => 
      file.type.startsWith('audio/') || 
      file.name.match(/\.(mp3|wav|m4a|ogg|flac|aac|wma)$/i)
    );

    if (audioFiles.length === 0) {
      alert('Please upload audio files only (mp3, wav, m4a, etc.)');
      return;
    }

    const oversizedFiles = audioFiles.filter(f => f.size > MAX_FILE_SIZE);
    if (oversizedFiles.length > 0) {
      alert(`File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB. Your file: ${(oversizedFiles[0].size / 1024 / 1024).toFixed(1)}MB`);
      return;
    }

    const newUploadedFiles: UploadedFile[] = audioFiles.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      type: file.type,
      status: 'pending' as const,
    }));

    setUploadedFiles((prev) => [...prev, ...newUploadedFiles]);

    newUploadedFiles.forEach((meta, i) => {
      uploadToSupabase(meta.id, audioFiles[i], 'upload');
    });
  };

  const uploadToSupabase = async (fileId: string, file: File, source: 'upload' | 'recording') => {
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
        await uploadWithTus(
          filePath,
          file,
          SUPABASE_URL,
          SUPABASE_ANON_KEY,
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

      const { data: urlData } = supabase.storage.from(AUDIO_BUCKET).getPublicUrl(filePath);

      await ensureStorageObjectReady(AUDIO_BUCKET, filePath, urlData.publicUrl);
      try {
        await saveAudioFileRecord(file, filePath, urlData.publicUrl, source);
      } catch (recordError) {
        console.error('Failed to save audio file metadata:', recordError);
      }

      setUploadedFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? {
                ...f,
                status: 'completed',
                progress: 100,
                publicUrl: urlData.publicUrl,
              }
            : f
        )
      );
    } catch (error: any) {
      console.error('Upload error:', error);
      setUploadedFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? {
                ...f,
                status: 'error',
                error: error.message || 'Upload failed',
              }
            : f
        )
      );
    } finally {
      uploadProgressGateRef.current.delete(fileId);
      activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1);
      if (activeUploadsRef.current === 0 && !isRecordingRef.current) {
        await releaseScreenWakeLock();
      }
    }
  };

  const removeFile = (fileId: string) => {
    setUploadedFiles(prev => prev.filter(f => f.id !== fileId));
    clearRecording();
  };

  const hasCompletedFiles = uploadedFiles.some(f => f.status === 'completed');
  const showPromptSection = isRecording || recordedAudioUrl || uploadedFiles.length > 0;
  const summaryFlowActive =
    isSummarizing || isRegenerating || summaryResult !== null || summaryError !== null;
  const promptSectionLayoutExpanded =
    showPromptSection &&
    (!isNarrowViewport || !summaryFlowActive);

  const handleSummarize = async () => {
    if (!hasCompletedFiles) return;
    if (!selectedSummaryPromptId) {
      setSummaryError('Select a summarization prompt.');
      return;
    }

    const completedFiles = uploadedFiles.filter(f => f.status === 'completed' && f.publicUrl);
    if (completedFiles.length === 0) return;

    setIsSummarizing(true);
    setSummaryResult(null);
    setSummaryError(null);
    
    try {
      const file = completedFiles[0];
      const noteId = generateNoteId();
      setCurrentNoteId(noteId);

      // Fetch saved speaker profiles to enrich the summary prompt with ontology context
      let speakerContext = '';
      if (user?.id) {
        try {
          const { data: speakerRows } = await supabase
            .from('speaker')
            .select('name, profile')
            .eq('user_id', user.id);
          if (speakerRows && speakerRows.length > 0) {
            const contexts = (speakerRows as { name: string; profile: string | null }[])
              .map((s) => buildSpeakerContextForSummary(s.name, s.profile))
              .filter(Boolean);
            if (contexts.length > 0) {
              speakerContext = contexts.join('\n\n');
            }
          }
        } catch {
          // Non-fatal: proceed without speaker context
        }
      }

      const response = await fetch(
        'https://n8n.srv1153481.hstgr.cloud/webhook/e616c0f9-df5f-471b-ad68-579919548ed7',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            downloadUrl: file.publicUrl,
            fileName: file.name,
            instructions: optionalInstructions,
            promptId: selectedSummaryPromptId,
            userId: user?.id || '',
            userName: user?.displayName || '',
            noteId: noteId,
            ...(speakerContext ? { speakerContext } : {}),
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      const result = await response.json();
      const summaryText =
        typeof result.summary === 'string' ? result.summary : String(result.summary ?? '');
      const transcript = normalizeTranscript(result.transcript);
      setSummaryResult({
        summary: summaryText,
        transcript,
      });
      setEditedSummary(summaryText);
      setResultsTab('summary');

      if (transcript.length > 0) {
        try {
          await persistNoteDiarization(noteId, transcript);
        } catch (dErr: unknown) {
          console.error('Failed to persist transcript diarization on note:', dErr);
        }
      }
      
    } catch (error: any) {
      console.error('Error summarizing:', error);
      setSummaryError(error.message || 'Failed to generate summary');
    } finally {
      setIsSummarizing(false);
    }
  };

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

      const { error } = await supabase
        .from('note')
        .update({ summary_edit: summaryText })
        .eq('id', currentNoteId);

      if (error) throw error;
      return true;
    } catch (err: unknown) {
      console.error('Error saving summary edit:', err);
      setSummaryEditError(err instanceof Error ? err.message : 'Failed to save summary edit');
      return false;
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
      alert('Failed to forward summary: ' + (error.message || 'Unknown error'));
    } finally {
      setIsForwarding(false);
    }
  };

  const formatTranscriptText = (segments: TranscriptSegment[]): string =>
    segments.map((s) => `${s.speaker}: ${s.text}`).join('\n\n');

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

      const results = await Promise.all(
        uniqueSpeakers.map(async (speakerName): Promise<GeneratedProfile> => {
          const record = speakerMap.get(speakerName.toLowerCase()) ?? null;
          const existingProfile = record?.profile?.trim() || null;

          const geminiKey =
            (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) ??
            (import.meta.env.VITE_GOOGLE_API_KEY as string | undefined) ??
            '';
          const { data, error } = await supabase.functions.invoke<{ profile?: string; error?: string }>(
            'generate-profile',
            {
              body: { speakerName, speakerId: record?.id ?? '', transcriptText, existingProfile, apiKey: geminiKey },
              headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
            }
          );

          if (error) {
            const detail = (data as { error?: string } | null)?.error ?? error.message;
            throw new Error(`Edge function error for "${speakerName}": ${detail}`);
          }
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
        const { error } = await supabase
          .from('speaker')
          .update({ profile: toSave })
          .eq('id', profile.speakerId)
          .eq('user_id', user.id);
        if (error) throw error;
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

  const REGENERATE_WEBHOOK = 'https://n8n.srv1153481.hstgr.cloud/webhook/532f465d-d198-4f59-ba75-20c39d41a079';

  const handleRegenerateSummary = async () => {
    if (!summaryResult || !currentNoteId || !user?.id) return;
    setIsRegenerating(true);
    setRegenerateError(null);
    try {
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

      const response = await fetch(REGENERATE_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          noteId: currentNoteId,
          diarization: summaryResult.transcript,
          previousSummary: editedSummary,
          speakerProfiles,
        }),
      });

      if (!response.ok) throw new Error(`Request failed: ${response.status}`);

      const result = await response.json();
      const newSummary = typeof result.summary === 'string' ? result.summary : String(result.summary ?? '');
      if (!newSummary) throw new Error('No summary returned from webhook');

      setEditedSummary(newSummary);
      setSummaryResult((prev) => (prev ? { ...prev, summary: newSummary } : prev));
      setResultsTab('summary');
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
                    Summarize Audio File
              </h1>
              <p className="app-page-subtitle">
                    Record or upload an audio file to transcribe and summarize
              </p>
            </div>
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
                          Record Audio
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          Click to start recording
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
                          Recording... Click to stop
                        </p>
                      </>
                    )}
                  </button>

                  {/* OR Divider */}
                  <div className="audio-source-divider flex md:flex-col items-center justify-center gap-2 py-2 md:py-0 md:px-2">
                    <div className="flex-1 h-px md:h-auto md:w-px md:flex-1" style={{ backgroundColor: 'var(--border)' }} />
                    <span className="text-xs font-medium px-2" style={{ color: 'var(--text-muted)' }}>or</span>
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
                      accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac,.wma"
                      multiple
                      onChange={handleFileSelect}
                      className="sr-only"
                    />
                    <CloudUpload className="mx-auto mb-3 h-10 w-10" style={{ color: 'var(--text-muted)' }} />
                    <p className="text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>
                      Upload Audio File
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Drop files or click to browse
                    </p>
                    <p className="text-xs mt-2 max-w-xs mx-auto" style={{ color: 'var(--text-muted)' }}>
                      Large files: keep this tab open and screen on until upload finishes.
                    </p>
                  </label>
                </div>
              </div>
            </div>

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
                        Recording Complete
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
                        <span className="recording-action-label">Download</span>
                      </a>
                    ) : null}
                    <button
                      onClick={clearRecording}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all"
                      style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                    >
                      <CloseMd className="w-4 h-4" />
                      <span className="recording-action-label">Discard</span>
                    </button>
                    <button
                      onClick={useRecording}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all"
                      style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                    >
                      <Check className="w-4 h-4" />
                      <span className="recording-action-label">Use Recording</span>
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
                          Uploading
                          {file.progress != null && file.progress > 0 ? ` ${file.progress}%` : ''}
                        </span>
                      )}
                      {file.status === 'processing' && (
                        <div className="flex items-center gap-1">
                          <Loading className="w-4 h-4 animate-spin" style={{ color: 'var(--accent)' }} />
                          <span className="text-xs" style={{ color: 'var(--accent)' }}>Processing...</span>
                        </div>
                      )}
                      {file.status === 'completed' && (
                        <span className="text-xs px-2 py-1 rounded-full" style={{ backgroundColor: 'var(--success-light)', color: 'var(--success)' }}>
                          Ready
                        </span>
                      )}
                      {file.status === 'error' && (
                        <span className="text-xs px-2 py-1 rounded-full" style={{ backgroundColor: 'var(--error-light)', color: 'var(--error)' }}>
                          Error
                        </span>
                      )}
                      {file.status === 'completed' && file.publicUrl ? (
                        <a
                          href={file.publicUrl}
                          download={file.name}
                          className="p-1 rounded hover:bg-opacity-80"
                          style={{ color: 'var(--text-muted)' }}
                          title={`Download ${file.name}`}
                          aria-label={`Download ${file.name}`}
                        >
                          <Download className="w-4 h-4" />
                        </a>
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
                    Recent Recordings
                  </h3>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Reuse one of your 10 most recent uploaded or recorded audio files
                  </p>
                </div>
              </div>

              {recentAudioLoading ? (
                <div className="flex items-center gap-2 py-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  <Loading className="h-4 w-4 animate-spin" aria-hidden />
                  Loading recent recordings...
                </div>
              ) : recentAudioError ? (
                <p className="text-sm" style={{ color: 'var(--error)' }}>
                  {recentAudioError}
                </p>
              ) : recentAudioFiles.length === 0 ? (
                <p className="py-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                  No recent recordings yet.
                </p>
              ) : (
                <div className="summary-note-list recent-recordings-list custom-scrollbar">
                  {recentAudioFiles.map((file) => (
                    <div
                      key={file.id}
                      role="button"
                      tabIndex={0}
                      className="summary-note-row cursor-pointer"
                      onClick={() => selectRecentAudioFile(file)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          selectRecentAudioFile(file);
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
                            {file.source === 'recording' ? 'Recorded' : 'Uploaded'}
                            {file.size_bytes ? ` - ${formatFileSize(Number(file.size_bytes))}` : ''}
                            {file.created_at ? ` - ${formatDate(file.created_at)}` : ''}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <a
                            href={file.public_url}
                            download={file.name}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors"
                            style={{ color: 'var(--text-secondary)' }}
                            onClick={(event) => event.stopPropagation()}
                            title={`Download ${file.name}`}
                            aria-label={`Download ${file.name}`}
                          >
                            <Download className="h-4 w-4" aria-hidden />
                          </a>
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
                      Add instructions (optional)
                    </label>
                    <textarea
                      value={optionalInstructions}
                      onChange={(e) => setOptionalInstructions(e.target.value)}
                      placeholder="e.g., Focus on action items and decisions..."
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
                            Summarize
                          </>
                        ) : (
                          <>
                            <PaperPlane className="h-4 w-4 shrink-0" />
                            Summarize
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
                      Analyzing audio and generating summary...
                    </p>
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
                            Summary
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
                            Transcription
                          </button>
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
                                  Done
                                </>
                              ) : (
                                <>
                                  <EditPencilLine01 className="h-3 w-3" />
                                  Edit
                                </>
                              )}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() =>
                              void handleCopyText(
                                resultsTab === 'summary' ? editedSummary : formatTranscriptText(summaryResult.transcript),
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
                            Copy
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
                            Discard
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                          Summary
                        </h3>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleCopyText(editedSummary, 'summary-result')}
                            className="summary-toolbar-btn flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-all"
                            style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                            title="Copy summary"
                            aria-label="Copy summary"
                          >
                            {copiedKey === 'summary-result' ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
                            Copy
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
                            Discard
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
                                Done
                              </>
                            ) : (
                              <>
                                <EditPencilLine01 className="h-3 w-3" />
                                Edit
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    )}

                    {(summaryResult.transcript.length === 0 || resultsTab === 'summary') && (
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
                          <TranscriptSpeakerFilterControls
                            speakers={getTranscriptSpeakerFilters(summaryResult.transcript)}
                            selectedSpeakers={transcriptSpeakerFilters}
                            onSelectedSpeakersChange={setTranscriptSpeakerFilters}
                          />
                        </div>
                        <TranscriptDiarizedEditor
                          segments={summaryResult.transcript}
                          onSegmentsChange={(next) =>
                            setSummaryResult((prev) => (prev ? { ...prev, transcript: next } : prev))
                          }
                          noteId={currentNoteId}
                          scrollContainerClassName="flex-1 min-h-0"
                          selectedSpeakerFilters={transcriptSpeakerFilters}
                          onSelectedSpeakerFiltersChange={setTranscriptSpeakerFilters}
                        />
                      </div>
                    ) : null}

                    <div
                      className="summary-result-action-row grid max-sm:pb-[max(1rem,calc(env(safe-area-inset-bottom,0px)+3.25rem))] shrink-0 grid-cols-5 gap-1 border-t pt-3 sm:flex sm:flex-wrap sm:justify-end sm:gap-2 sm:py-4 sm:pb-4"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <button
                        type="button"
                        title="Save to OneDrive"
                        aria-label="Save to OneDrive"
                        onClick={() => {
                          const completedFile = uploadedFiles.find((f) => f.status === 'completed' && f.publicUrl);
                          const audioUrl = completedFile?.publicUrl ? encodeURIComponent(completedFile.publicUrl) : '';
                          const audioName = completedFile?.name ? encodeURIComponent(completedFile.name) : '';
                          navigate(`/save-summary?note_id=${currentNoteId}&audio_url=${audioUrl}&audio_name=${audioName}`);
                        }}
                        className={resultActionBtnClass}
                      >
                        <Cloud className="h-4 w-4 shrink-0" aria-hidden />
                        <span className={resultActionBtnLabelClass}>Save</span>
                      </button>
                      <button
                        type="button"
                        title={
                          isForwarding
                            ? 'Sending to Teams'
                            : forwardSuccess
                              ? 'Sent to Teams'
                              : 'Forward to Teams'
                        }
                        aria-label={
                          isForwarding
                            ? 'Sending to Teams'
                            : forwardSuccess
                              ? 'Sent to Teams'
                              : 'Forward to Teams'
                        }
                        onClick={() => setIsForwardTeamsModalOpen(true)}
                        disabled={isForwarding}
                        className={resultActionBtnClass}
                      >
                        {isForwarding ? (
                          <>
                            <Loading className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                            <span className={resultActionBtnLabelClass}>Sending...</span>
                          </>
                        ) : forwardSuccess ? (
                          <>
                            <Check className="h-4 w-4 shrink-0" style={{ color: 'var(--success)' }} aria-hidden />
                            <span className={resultActionBtnLabelClass}>Sent!</span>
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
                        title="Share"
                        aria-label="Share"
                        onClick={() => setIsShareNoteModalOpen(true)}
                        disabled={!currentNoteId}
                        className={resultActionBtnClass}
                      >
                        <ShareAndroid className="h-4 w-4 shrink-0" aria-hidden />
                        <span className={resultActionBtnLabelClass}>Share</span>
                      </button>
                      <button
                        type="button"
                        title="Sync Profile"
                        aria-label="Sync Profile"
                        onClick={() => void handleGenerateProfile()}
                        className={resultActionBtnClass}
                      >
                        <UserCircle className="h-4 w-4 shrink-0" aria-hidden />
                        <span className={resultActionBtnLabelClass}>Sync Profile</span>
                      </button>
                      <button
                        type="button"
                        title={isRegenerating ? 'Regenerating summary' : 'Regenerate Summary'}
                        aria-label={isRegenerating ? 'Regenerating summary' : 'Regenerate Summary'}
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
                Forward to Teams
              </h2>
              <button
                type="button"
                disabled={isForwarding}
                onClick={() => setIsForwardTeamsModalOpen(false)}
                className="rounded-md p-2 transition-opacity disabled:opacity-50"
                style={{ color: 'var(--text-muted)' }}
                aria-label="Close"
              >
                <CloseMd className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <p className="shrink-0 px-4 pt-3 text-sm sm:px-5" style={{ color: 'var(--text-secondary)' }}>
              Choose a chat, then click <span className="font-medium" style={{ color: 'var(--text)' }}>Forward Summary</span>.
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-3 sm:px-5">
              {chatsLoading ? (
                <div className="rounded-lg border p-8 text-center" style={{ borderColor: 'var(--border)' }}>
                  <div
                    className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-b-2"
                    style={{ borderColor: 'var(--accent)' }}
                  />
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    Loading your Teams chats...
                  </p>
                </div>
              ) : chatsError ? (
                <div className="rounded-lg border p-6" style={{ borderColor: 'var(--border)' }}>
                  <p className="text-sm font-medium" style={{ color: 'var(--error)' }}>
                    {chatsError}
                  </p>
                  <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    Make sure you have the necessary permissions to access Teams chats.
                  </p>
                </div>
              ) : chats.length === 0 ? (
                <div className="rounded-lg border p-8 text-center" style={{ borderColor: 'var(--border)' }}>
                  <Chat className="mx-auto mb-4 h-12 w-12" style={{ color: 'var(--text-muted)' }} aria-hidden />
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    No Teams chats found
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
              <button
                type="button"
                disabled={isForwarding}
                onClick={() => setIsForwardTeamsModalOpen(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:opacity-50"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              >
                Cancel
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
                    Sending...
                  </>
                ) : (
                  'Forward Summary'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      <ShareNoteModal
        isOpen={isShareNoteModalOpen}
        noteId={currentNoteId}
        noteTitle="Current summary"
        existingSharedUserIds={[]}
        onClose={() => setIsShareNoteModalOpen(false)}
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
                  Sync Profile
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
                aria-label="Close"
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
                    {profileGenStep === 'finding-speakers' ? 'Looking up speaker data…' : 'Generating profiles with AI…'}
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
                              {profile.isNew ? 'New profile' : 'Updated profile'}
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
                                <><Save className="h-3.5 w-3.5" aria-hidden />Save Profile</>
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
                    Close
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
                  Close
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
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Save all profiles?</h3>
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
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleConfirmSaveAllProfiles()}
                    className="rounded-lg px-4 py-2 text-sm font-medium"
                    style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                  >
                    Confirm Save All
                  </button>
                </div>
              </>
            )}
            {saveAllStatus === 'saving' && (
              <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                <Loading className="h-4 w-4 animate-spin" aria-hidden />
                Saving profiles...
              </div>
            )}
            {saveAllStatus === 'success' && (
              <>
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Profiles saved</h3>
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
                    Close
                  </button>
                </div>
              </>
            )}
            {saveAllStatus === 'error' && (
              <>
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Failed to save all profiles</h3>
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
                    Close
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
              Discard Summary
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
                Cancel
              </button>
              <button
                onClick={() => {
                  setSummaryResult(null);
                  setSummaryError(null);
                  setSummaryEditError(null);
                  setEditedSummary('');
                  setIsEditingSummary(false);
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
