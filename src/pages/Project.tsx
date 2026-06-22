import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../config/supabaseConfig';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  Calendar,
  Check,
  ChevronDown,
  CloseMd,
  Copy,
  EditPencilLine01,
  FileAdd,
  FileDocument,
  Folder,
  FolderRemove,
  Loading,
  MoreHorizontal,
  PaperPlane,
  Save,
  TrashFull,
} from 'react-coolicons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import NoteImageAttachments from '../components/NoteImageAttachments';
import TranscriptDiarizedEditor, {
  getTranscriptSpeakerFilters,
  TranscriptSpeakerFilterControls,
} from '../components/TranscriptDiarizedEditor';
import {
  getNoteDiarizationRaw,
  hasUsableDiarization,
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
} from '../lib/transcriptTranslationDisplay';
import { formatDurationMeta, getNoteDurationSeconds } from '../lib/noteDuration';
import { getNoteImageCounts } from '../lib/noteImages';

interface ProjectRow {
  id: string;
  name: string;
  notes?: Array<string | number> | null;
}

interface NoteRow {
  id: string;
  name?: string | null;
  user_id?: string | null;
  user_name?: string | null;
  summary?: string | null;
  summary_edit?: string | null;
  summary_translations?: Record<string, string> | null;
  transcription?: string | null;
  transcription_language?: string | null;
  transcription_translations?: Record<string, string> | null;
  diarization?: unknown;
  diarization_translations?: Partial<Record<'en' | 'ko', TranscriptSegment[]>> | null;
  tag?: unknown;
  tags?: unknown;
  created_at?: string | null;
  meeting_at?: string | null;
  duration_seconds?: number | null;
  projects?: Array<string | number> | null;
  shared_users?: unknown;
}

type NoteDetailTab = 'summary' | 'transcription' | 'images';

function getNoteSummaryText(note: NoteRow, language: 'en' | 'ko'): string {
  return (note.summary_edit?.trim() || note.summary_translations?.[language]?.trim() || note.summary?.trim() || '').trim();
}

function getNoteTranscriptionText(note: NoteRow): string {
  const plain = note.transcription?.trim();
  if (plain) return plain;
  const segments = normalizeTranscript(getNoteDiarizationRaw(note));
  if (segments.length === 0) return '';
  return segments.map((s) => `${s.speaker}: ${s.text}`).join('\n\n');
}

function getNoteDurationMeta(note: NoteRow): string | null {
  return formatDurationMeta(getNoteDurationSeconds(note));
}

function formatNoteModalDate(createdAt?: string | null): string {
  if (!createdAt) return 'Unknown date';
  try {
    return new Date(createdAt).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'Unknown date';
  }
}

function getNoteSharedUserIds(note: NoteRow): string[] {
  const raw = note.shared_users;
  if (Array.isArray(raw)) return raw.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()));
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      return getNoteSharedUserIds({ ...note, shared_users: JSON.parse(trimmed) as unknown });
    } catch {
      return trimmed.split(',').map((id) => id.trim()).filter(Boolean);
    }
  }
  return [];
}

function isSharedWithUser(note: NoteRow | null, userId?: string | null): boolean {
  if (!note || !userId) return false;
  return note.user_id !== userId && getNoteSharedUserIds(note).includes(userId);
}

/** Fixed scroll height for plain transcription (no diarization). */
const NOTE_DETAIL_SCROLL_BODY =
  'h-72 min-h-0 max-md:min-h-[11rem] max-md:h-[min(52vh,24rem)] overflow-y-auto custom-scrollbar rounded-lg p-4 text-sm max-md:text-base leading-relaxed';

/** Summary: fixed height scroll, no border or fill. */
const NOTE_SUMMARY_SCROLL =
  'h-72 min-h-0 max-md:min-h-[11rem] max-md:h-[min(52vh,24rem)] overflow-y-auto custom-scrollbar rounded-lg p-4 text-sm max-md:text-base leading-relaxed';

const NOTE_TRANSCRIPT_SCROLL_CLASS = 'h-72 min-h-0 max-md:min-h-[11rem] max-md:h-[min(52vh,24rem)]';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface SessionRow {
  id: string;
  created_at?: string | null;
  project_id?: string | number | null;
}

interface ChatRow {
  id: string;
  session_id: string;
  message?: string | null;
  response?: string | null;
  repsonse?: string | null;
  created_at?: string | null;
}

function extractWebhookResponse(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const value = (payload as { response?: unknown }).response;
  return typeof value === 'string' ? value.trim() : '';
}

function generateSessionId(): string {
  const now = new Date();
  const yy = String(now.getFullYear() % 100).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');

  const random = Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => String(n % 10)).join('');
  return `${yy}${mm}${dd}${hh}${min}${ss}_${random}`;
}

function getChatResponseValue(chat: ChatRow): string {
  const value = chat.response ?? chat.repsonse ?? '';
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTagList(raw: unknown): string[] {
  if (raw == null) return [];
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        return normalizeTagList(JSON.parse(s) as unknown);
      } catch {
        return s.split(',').map((t) => t.trim()).filter(Boolean);
      }
    }
    return s.split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (item == null) continue;
    if (typeof item === 'string') {
      const t = item.trim();
      if (t) out.push(t);
    } else if (typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const label = o.label ?? o.name ?? o.value;
      if (typeof label === 'string' && label.trim()) out.push(label.trim());
    } else {
      const t = String(item).trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function buildChatMessages(rows: ChatRow[]): ChatMessage[] {
  const sorted = [...rows].sort(
    (a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime()
  );
  return sorted.flatMap((row) => {
    const items: ChatMessage[] = [];
    const userContent = (row.message || '').trim();
    const assistantContent = getChatResponseValue(row);
    if (userContent) items.push({ id: `u-${row.id}`, role: 'user', content: userContent });
    if (assistantContent) items.push({ id: `a-${row.id}`, role: 'assistant', content: assistantContent });
    return items;
  });
}

const PROJECT_CHAT_WEBHOOK_URL =
  'https://n8n.srv1153481.hstgr.cloud/webhook/9fe1b3b5-9e2e-4b23-8775-b38fc21e4b4d';

const Project: React.FC = () => {
  const { user } = useAuth();
  const { appLanguage, t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get('id');
  const projectIdFilterValue: string | number =
    projectId == null ? '' : Number.isNaN(Number(projectId)) ? projectId : Number(projectId);

  const [project, setProject] = useState<ProjectRow | null>(null);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
  const [noteExpandedTab, setNoteExpandedTab] = useState<Record<string, NoteDetailTab>>({});
  const [noteImageCounts, setNoteImageCounts] = useState<Record<string, number>>({});
  const [noteSpeakerFilters, setNoteSpeakerFilters] = useState<Record<string, string[]>>({});
  const [noteTranscriptLanguage, setNoteTranscriptLanguage] = useState<Record<string, TranscriptLanguage>>({});
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteEditDraft, setNoteEditDraft] = useState('');
  const [savingNoteId, setSavingNoteId] = useState<string | null>(null);
  const [noteEditError, setNoteEditError] = useState<string | null>(null);
  const [openNoteMenuId, setOpenNoteMenuId] = useState<string | null>(null);
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null);
  const [renameNoteDraft, setRenameNoteDraft] = useState('');
  const [noteActionError, setNoteActionError] = useState<string | null>(null);
  const [deleteNoteTarget, setDeleteNoteTarget] = useState<NoteRow | null>(null);
  const [isDeleteNoteOpen, setIsDeleteNoteOpen] = useState(false);
  const [deletingNote, setDeletingNote] = useState(false);
  const [deleteNoteError, setDeleteNoteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [projectSessions, setProjectSessions] = useState<SessionRow[]>([]);
  const [sessionChatsById, setSessionChatsById] = useState<Record<string, ChatRow[]>>({});
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'notes' | 'chats'>('chats');
  const [isLowerSectionExpanded, setIsLowerSectionExpanded] = useState(true);

  const [isAddNotesModalOpen, setIsAddNotesModalOpen] = useState(false);
  const [pickerNotes, setPickerNotes] = useState<NoteRow[]>([]);
  const [addNotesPickerLoading, setAddNotesPickerLoading] = useState(false);
  const [selectedNoteIdsToAdd, setSelectedNoteIdsToAdd] = useState<string[]>([]);
  const [addModalExpandedNoteId, setAddModalExpandedNoteId] = useState<string | null>(null);
  const [addNotesSaving, setAddNotesSaving] = useState(false);
  const [addNotesModalError, setAddNotesModalError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const noteMenuRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const hasConversation = chatMessages.length > 0 || chatSending;
  const chatInputLineCount = chatInput.split('\n').length;
  const visibleChatInputRows = Math.min(chatInputLineCount, 5);
  const isChatInputExpanded = chatInputLineCount > 1;
  const isChatInputScrollable = chatInputLineCount > 5;

  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [chatMessages, chatSending]);

  useEffect(() => {
    if (!openNoteMenuId) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (!noteMenuRef.current) return;
      if (!noteMenuRef.current.contains(event.target as Node)) {
        setOpenNoteMenuId(null);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [openNoteMenuId]);

  useEffect(() => {
    const load = async () => {
      if (!projectId) {
        setError('Missing project id.');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        const { data: pData, error: pErr } = await supabase
          .from('project')
          .select('id, name, notes')
          .eq('id', projectId)
          .single();

        if (pErr) throw pErr;
        setProject(pData as ProjectRow);

        const { data: nData, error: nErr } = await supabase
          .from('note')
          .select('*')
          .contains('projects', [projectIdFilterValue])
          .order('created_at', { ascending: false });

        if (nErr) throw nErr;
        setNotes((nData as NoteRow[]) || []);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load project data.');
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [projectId, projectIdFilterValue]);

  useEffect(() => {
    let cancelled = false;
    const noteIds = notes.map((note) => note.id);
    if (noteIds.length === 0) {
      setNoteImageCounts({});
      return;
    }

    getNoteImageCounts(noteIds)
      .then((counts) => {
        if (cancelled) return;
        setNoteImageCounts(counts);
        setNoteExpandedTab((prev) => {
          const next = { ...prev };
          for (const [noteId, tab] of Object.entries(next)) {
            if (tab === 'images' && !counts[noteId]) next[noteId] = 'summary';
          }
          return next;
        });
      })
      .catch((error) => console.error('Failed to load project note image counts:', error));

    return () => {
      cancelled = true;
    };
  }, [notes]);

  useEffect(() => {
    setChatMessages([]);
    setChatError(null);
    setChatInput('');
    setChatSessionId(null);
    setSelectedSessionId(null);
    setProjectSessions([]);
    setSessionChatsById({});
    setSessionsError(null);
    setActiveTab('chats');
    setIsLowerSectionExpanded(true);
  }, [projectId]);

  useEffect(() => {
    const resolvedProjectId = project?.id ?? projectId;
    if (!resolvedProjectId) return;

    const loadSessions = async () => {
      try {
        setSessionsLoading(true);
        setSessionsError(null);

        const { data: sessionData, error: sessionError } = await supabase
          .from('session')
          .select('id, created_at, project_id')
          .eq('project_id', resolvedProjectId)
          .order('created_at', { ascending: false });

        if (sessionError) throw sessionError;
        const sessions = (sessionData as SessionRow[]) || [];
        setProjectSessions(sessions);

        if (sessions.length === 0) {
          setSessionChatsById({});
          return;
        }

        const sessionIds = sessions.map((s) => s.id);
        const { data: chatData, error: chatLoadError } = await supabase
          .from('chat')
          .select('*')
          .in('session_id', sessionIds)
          .order('created_at', { ascending: true });
        if (chatLoadError) throw chatLoadError;

        const grouped = ((chatData as ChatRow[]) || []).reduce<Record<string, ChatRow[]>>((acc, row) => {
          if (!acc[row.session_id]) acc[row.session_id] = [];
          acc[row.session_id].push(row);
          return acc;
        }, {});
        setSessionChatsById(grouped);

        if (selectedSessionId && !sessions.some((s) => s.id === selectedSessionId)) {
          setSelectedSessionId(null);
          setChatSessionId(null);
          setChatMessages([]);
        }
      } catch (err: unknown) {
        setSessionsError(err instanceof Error ? err.message : 'Failed to load chat sessions');
      } finally {
        setSessionsLoading(false);
      }
    };

    void loadSessions();
  }, [project?.id, projectId, selectedSessionId]);

  const handleSelectSession = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setChatSessionId(sessionId);
    setChatMessages(buildChatMessages(sessionChatsById[sessionId] || []));
    setChatError(null);
    setIsLowerSectionExpanded(false);
  };

  const handleLowerTabClick = (tab: 'notes' | 'chats') => {
    if (activeTab === tab) {
      setIsLowerSectionExpanded((prev) => !prev);
      return;
    }
    setActiveTab(tab);
    setIsLowerSectionExpanded(true);
  };

  const formatDate = (value?: string | null): string => {
    if (!value) return 'Unknown date';
    return new Date(value).toLocaleDateString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getNoteDisplayTitle = (note: NoteRow): string => {
    const n = note.name?.trim();
    if (n) return n;
    return 'Untitled note';
  };

  const getNoteTags = (note: NoteRow): string[] => {
    const fromTag = normalizeTagList(note.tag);
    if (fromTag.length) return fromTag;
    return normalizeTagList(note.tags);
  };

  const getNoteParticipantsLabel = (note: NoteRow): string => {
    const diarRaw = getNoteDiarizationRaw(note);
    if (!hasUsableDiarization(diarRaw)) return 'None';
    const participants = Array.from(
      new Set(
        normalizeTranscript(diarRaw)
          .map((seg) => seg.speaker.trim())
          .filter((name) => Boolean(name))
      )
    );
    if (participants.length === 0) return 'None';
    return participants.join(', ');
  };

  const handleNoteImagesChange = (noteId: string, imageCount: number) => {
    setNoteImageCounts((prev) => ({ ...prev, [noteId]: imageCount }));
    if (imageCount === 0) {
      setNoteExpandedTab((prev) => (prev[noteId] === 'images' ? { ...prev, [noteId]: 'summary' } : prev));
    }
  };

  const toIdValue = (id: string): string | number => {
    const asNumber = Number(id);
    return Number.isNaN(asNumber) ? id : asNumber;
  };

  const removeNoteFromProjectNotes = async (noteId: string) => {
    if (!projectId || !project) return;
    const next = (project.notes || []).filter((id) => String(id) !== noteId);
    const { error: projectUpdateError } = await supabase
      .from('project')
      .update({ notes: next })
      .eq('id', projectId);
    if (projectUpdateError) throw projectUpdateError;
    setProject((prev) => (prev ? { ...prev, notes: next } : prev));
  };

  const addNoteIdsToProjectNotes = async (noteIds: string[]) => {
    if (!projectId || !project) return;
    const existing = (project.notes || []).map(String);
    const mergedIds = [...existing];
    for (const id of noteIds) {
      if (!mergedIds.includes(id)) mergedIds.push(id);
    }
    const next = mergedIds.map((id) => {
      const n = Number(id);
      return Number.isNaN(n) ? id : n;
    });
    const { error: projectUpdateError } = await supabase
      .from('project')
      .update({ notes: next })
      .eq('id', projectId);
    if (projectUpdateError) throw projectUpdateError;
    setProject((prev) => (prev ? { ...prev, notes: next } : prev));
  };

  const notesAvailableToAdd = useMemo(() => {
    const pid = String(projectIdFilterValue);
    return [...pickerNotes]
      .filter((n) => !(n.projects || []).some((p) => String(p) === pid))
      .sort(
        (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
      );
  }, [pickerNotes, projectIdFilterValue]);

  const handleSendChat = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = chatInput.trim();
    if (!trimmed || !projectId || chatSending) return;
    if (!user?.id) {
      setChatError('Missing authenticated user.');
      return;
    }

    const resolvedProjectId = project?.id ?? projectId;

    setChatError(null);
    setChatSending(true);
    setIsLowerSectionExpanded(false);

    const userMsg: ChatMessage = {
      id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
    };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatInput('');

    try {
      const res = await fetch(PROJECT_CHAT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, project_id: resolvedProjectId }),
      });

      const rawText = await res.text();
      if (!res.ok) {
        throw new Error(rawText.trim() || `Request failed with status ${res.status}`);
      }

      let assistantContent = '';
      if (rawText.trim()) {
        try {
          assistantContent = extractWebhookResponse(JSON.parse(rawText) as unknown);
        } catch {
          throw new Error('Webhook returned invalid JSON');
        }
      }
      if (!assistantContent) {
        throw new Error('Webhook response missing "response" field');
      }

      const isNewSession = chatSessionId == null;
      const sessionIdForMessage = chatSessionId ?? generateSessionId();

      if (isNewSession) {
        const { error: sessionInsertError } = await supabase.from('session').insert({
          id: sessionIdForMessage,
          project_id: resolvedProjectId,
        });
        if (sessionInsertError) throw sessionInsertError;
      }

      const basePayload = {
        message: trimmed,
        user_id: user.id,
        session_id: sessionIdForMessage,
        project_id: resolvedProjectId,
      };

      let insertError: Error | null = null;
      const { error: preferredInsertError } = await supabase
        .from('chat')
        .insert([{ ...basePayload, response: assistantContent }]);

      if (preferredInsertError) {
        const missingResponseColumn = /response/i.test(preferredInsertError.message || '');
        if (missingResponseColumn) {
          const { error: fallbackInsertError } = await supabase
            .from('chat')
            .insert([{ ...basePayload, repsonse: assistantContent }]);
          if (fallbackInsertError) {
            insertError = fallbackInsertError;
          }
        } else {
          insertError = preferredInsertError;
        }
      }

      if (insertError) throw insertError;
      if (!chatSessionId) setChatSessionId(sessionIdForMessage);
      if (!selectedSessionId) setSelectedSessionId(sessionIdForMessage);

      const insertedAt = new Date().toISOString();
      if (isNewSession) {
        setProjectSessions((prev) => [
          { id: sessionIdForMessage, created_at: insertedAt, project_id: resolvedProjectId },
          ...prev,
        ]);
      }
      setSessionChatsById((prev) => ({
        ...prev,
        [sessionIdForMessage]: [
          ...(prev[sessionIdForMessage] || []),
          {
            id: `local-${Date.now()}`,
            session_id: sessionIdForMessage,
            message: trimmed,
            response: assistantContent,
            created_at: insertedAt,
          },
        ],
      }));

      setChatMessages((prev) => [
        ...prev,
        {
          id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `a-${Date.now()}`,
          role: 'assistant',
          content: assistantContent,
        },
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send message';
      setChatError(msg);
    } finally {
      setChatSending(false);
    }
  };

  const handleStartNoteEdit = (note: NoteRow) => {
    setEditingNoteId(note.id);
    setNoteEditDraft(getNoteSummaryText(note, appLanguage));
    setNoteEditError(null);
  };

  const handleSaveNoteEdit = async (note: NoteRow) => {
    setSavingNoteId(note.id);
    setNoteEditError(null);
    try {
      const { error: updateError } = await supabase
        .from('note')
        .update({ summary_edit: noteEditDraft })
        .eq('id', note.id);

      if (updateError) throw updateError;

      setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, summary_edit: noteEditDraft } : n)));
      setEditingNoteId(null);
    } catch (err: unknown) {
      setNoteEditError(err instanceof Error ? err.message : 'Failed to save note edit');
    } finally {
      setSavingNoteId(null);
    }
  };

  const handleStartRenameNote = (note: NoteRow) => {
    setOpenNoteMenuId(null);
    setNoteActionError(null);
    setRenamingNoteId(note.id);
    setRenameNoteDraft(note.name?.trim() || '');
  };

  const handleSaveRenameNote = async (noteId: string) => {
    const name = renameNoteDraft.trim();
    if (!name) {
      setNoteActionError('Note name is required.');
      return;
    }
    try {
      setNoteActionError(null);
      const { error: renameError } = await supabase
        .from('note')
        .update({ name })
        .eq('id', noteId);
      if (renameError) throw renameError;
      setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, name } : n)));
      setRenamingNoteId(null);
      setRenameNoteDraft('');
    } catch (err: unknown) {
      setNoteActionError(err instanceof Error ? err.message : 'Failed to rename note');
    }
  };

  const handleRemoveFromProject = async (note: NoteRow) => {
    if (!projectId) return;
    try {
      setOpenNoteMenuId(null);
      setNoteActionError(null);
      const noteProjectId = toIdValue(projectId);
      const nextProjects = (note.projects || []).filter((pid) => String(pid) !== String(noteProjectId));
      const { error: noteUpdateError } = await supabase
        .from('note')
        .update({ projects: nextProjects })
        .eq('id', note.id);
      if (noteUpdateError) throw noteUpdateError;

      await removeNoteFromProjectNotes(note.id);
      setNotes((prev) => prev.filter((n) => n.id !== note.id));
      if (expandedNoteId === note.id) setExpandedNoteId(null);
      if (editingNoteId === note.id) setEditingNoteId(null);
      if (renamingNoteId === note.id) setRenamingNoteId(null);
    } catch (err: unknown) {
      setNoteActionError(err instanceof Error ? err.message : 'Failed to remove note from project');
    }
  };

  const openAddNotesModal = useCallback(async () => {
    if (!user?.id) return;
    setAddNotesModalError(null);
    setSelectedNoteIdsToAdd([]);
    setAddModalExpandedNoteId(null);
    setIsAddNotesModalOpen(true);
    setAddNotesPickerLoading(true);
    setPickerNotes([]);
    try {
      const { data, error } = await supabase
        .from('note')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setPickerNotes((data as NoteRow[]) || []);
    } catch (err: unknown) {
      setAddNotesModalError(err instanceof Error ? err.message : 'Failed to load notes');
    } finally {
      setAddNotesPickerLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    const flag = searchParams.get('addNotes');
    if (!projectId || (flag !== '1' && flag !== 'true')) return;
    setActiveTab('notes');
    void openAddNotesModal();
    const next = new URLSearchParams(searchParams);
    next.delete('addNotes');
    setSearchParams(next, { replace: true });
  }, [projectId, searchParams, setSearchParams, openAddNotesModal]);

  const toggleAddNoteSelection = (noteId: string) => {
    setSelectedNoteIdsToAdd((prev) =>
      prev.includes(noteId) ? prev.filter((id) => id !== noteId) : [...prev, noteId]
    );
  };

  const handleConfirmAddNotesToProject = async () => {
    if (!projectId || !project || selectedNoteIdsToAdd.length === 0) return;
    const noteProjectIdTyped = toIdValue(projectId);
    setAddNotesSaving(true);
    setAddNotesModalError(null);
    try {
      const mergedLocalNotes: NoteRow[] = [];
      for (const noteId of selectedNoteIdsToAdd) {
        const note = pickerNotes.find((n) => n.id === noteId);
        if (!note) continue;
        const existing = Array.isArray(note.projects) ? note.projects : [];
        const nextProjects = Array.from(
          new Set([...existing.map((p) => String(p)), String(noteProjectIdTyped)])
        ).map((p) => {
          const asNumber = Number(p);
          return Number.isNaN(asNumber) ? p : asNumber;
        });
        const { error } = await supabase.from('note').update({ projects: nextProjects }).eq('id', noteId);
        if (error) throw error;
        mergedLocalNotes.push({ ...note, projects: nextProjects });
      }
      await addNoteIdsToProjectNotes(selectedNoteIdsToAdd);
      setNotes((prev) => {
        const existingIds = new Set(prev.map((n) => n.id));
        const newOnes = mergedLocalNotes.filter((n) => !existingIds.has(n.id));
        const combined = [...newOnes, ...prev];
        combined.sort(
          (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
        );
        return combined;
      });
      setIsAddNotesModalOpen(false);
      setSelectedNoteIdsToAdd([]);
      setAddModalExpandedNoteId(null);
    } catch (err: unknown) {
      setAddNotesModalError(err instanceof Error ? err.message : 'Failed to add notes to project');
    } finally {
      setAddNotesSaving(false);
    }
  };

  const handleOpenDeleteNote = (note: NoteRow) => {
    setOpenNoteMenuId(null);
    setDeleteNoteError(null);
    setDeleteNoteTarget(note);
    setIsDeleteNoteOpen(true);
  };

  const handleConfirmDeleteNote = async () => {
    if (!deleteNoteTarget || !user?.id) return;
    try {
      setDeletingNote(true);
      setDeleteNoteError(null);
      setNoteActionError(null);
      if (isSharedWithUser(deleteNoteTarget, user.id)) {
        const { error: removeShareError } = await supabase.rpc('remove_current_user_from_note_shared_users', {
          p_note_id: deleteNoteTarget.id,
        });
        if (removeShareError) throw removeShareError;
      } else {
        const { error: deleteError } = await supabase
          .from('note')
          .delete()
          .eq('id', deleteNoteTarget.id)
          .eq('user_id', user.id);
        if (deleteError) throw deleteError;

        await removeNoteFromProjectNotes(deleteNoteTarget.id);
      }
      setNotes((prev) => prev.filter((n) => n.id !== deleteNoteTarget.id));
      if (expandedNoteId === deleteNoteTarget.id) setExpandedNoteId(null);
      if (editingNoteId === deleteNoteTarget.id) setEditingNoteId(null);
      if (renamingNoteId === deleteNoteTarget.id) setRenamingNoteId(null);
      setIsDeleteNoteOpen(false);
      setDeleteNoteTarget(null);
    } catch (err: unknown) {
      setDeleteNoteError(err instanceof Error ? err.message : 'Failed to delete note');
    } finally {
      setDeletingNote(false);
    }
  };

  const handleCopyText = async (text: string, key: string) => {
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
  };

  const getSelectedTranscriptLanguage = (note: NoteRow): TranscriptLanguage => {
    const selected = noteTranscriptLanguage[note.id] ?? 'original';
    return getAvailableTranscriptLanguages(note).includes(selected) ? selected : 'original';
  };

  const persistDisplayedTranscript = async (note: NoteRow, language: TranscriptLanguage, next: TranscriptSegment[]) => {
    if (language === 'original') {
      await persistNoteDiarization(note.id, next);
      return;
    }
    const nextTranslations = updateTranslationMap(note.diarization_translations, language, next);
    const { data, error } = await supabase
      .from('note')
      .update({
        diarization_translations: nextTranslations,
        transcription_translations: {
          ...(note.transcription_translations ?? {}),
          [language]: next.map((segment) => `${segment.speaker}: ${segment.text}`).join('\n\n'),
        },
      })
      .eq('id', note.id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Transcript translation save did not update the note.');
  };

  const updateDisplayedTranscript = (note: NoteRow, language: TranscriptLanguage, next: TranscriptSegment[]) => {
    setNotes((prev) =>
      prev.map((item) => {
        if (item.id !== note.id) return item;
        if (language === 'original') return { ...item, diarization: next };
        return {
          ...item,
          diarization_translations: updateTranslationMap(item.diarization_translations, language, next),
          transcription_translations: {
            ...(item.transcription_translations ?? {}),
            [language]: next.map((segment) => `${segment.speaker}: ${segment.text}`).join('\n\n'),
          },
        };
      })
    );
  };

  const renderTranscriptLanguageToggle = (note: NoteRow) => {
    const languages = getAvailableTranscriptLanguages(note);
    if (languages.length <= 1) return null;
    const selected = getSelectedTranscriptLanguage(note);
    return (
      <div className="transcript-language-toggle" role="radiogroup" aria-label="Transcript language">
        {languages.map((language) => (
          <button
            key={language}
            type="button"
            role="radio"
            aria-checked={selected === language}
            className={`transcript-language-toggle-option ${selected === language ? 'transcript-language-toggle-option-active' : ''}`}
            onClick={() => setNoteTranscriptLanguage((prev) => ({ ...prev, [note.id]: language }))}
          >
            {getTranscriptLanguageLabel(language)}
          </button>
        ))}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center" style={{ backgroundColor: 'var(--bg)' }}>
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 mx-auto mb-4" style={{ borderColor: 'var(--accent)' }} />
          <p style={{ color: 'var(--text-secondary)' }}>{t('loadingProject')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg)' }}>
      <main className="flex h-full min-h-0 flex-1 flex-col overflow-hidden p-4 md:p-6">
        <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-1 flex-col gap-4">
          <div className="app-page-header">
            <h1 className="app-page-title app-page-title-with-icon">
              <Folder className="app-page-title-icon" aria-hidden />
              <span className="min-w-0 truncate">{project?.name || t('project')}</span>
            </h1>
            <p className="app-page-subtitle">
              {t('projectSubtitle')}
            </p>
          </div>

          <div
            className={`min-h-0 overflow-hidden transition-all duration-300 ease-out ${
              hasConversation
                ? 'flex min-h-0 flex-1 flex-col opacity-100'
                : 'max-h-0 shrink-0 overflow-hidden opacity-0'
            }`}
          >
            <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <h2 className="mb-3 flex-shrink-0 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                {t('conversation')}
              </h2>
              <div
                ref={chatScrollRef}
                className="custom-scrollbar flex min-h-0 w-full min-w-0 flex-1 flex-col gap-6 overflow-y-auto py-1"
              >
                {chatMessages.map((m) =>
                  m.role === 'user' ? (
                    <div key={m.id} className="flex w-full justify-end">
                      <div
                        className="max-w-[min(90%,36rem)] rounded-3xl px-4 py-2.5 text-[calc(1rem+2px)] leading-relaxed"
                        style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                      >
                        <p className="whitespace-pre-wrap">{m.content}</p>
                      </div>
                    </div>
                  ) : (
                    <div
                      key={m.id}
                      className="w-full min-w-0 text-[calc(1rem+2px)] font-medium leading-relaxed"
                      style={{ color: 'var(--text)' }}
                    >
                      <div className="prose max-w-none prose-headings:scroll-mt-4 prose-headings:font-semibold">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      </div>
                    </div>
                  )
                )}
                {chatSending ? (
                  <div className="flex w-full items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    <Loading className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                    {t('waitingForReply')}
                  </div>
                ) : null}
              </div>
            </section>
          </div>

          <form
            onSubmit={(ev) => {
              void handleSendChat(ev);
            }}
            className={`project-chat-input-shell flex flex-shrink-0 border-0 shadow-none transition-[background-color] duration-200 ${
              isChatInputExpanded
                ? 'flex-col gap-1 rounded-[1.75rem] pb-1.5 pl-4 pr-1.5 pt-2'
                : 'items-center gap-2 rounded-full py-1.5 pl-4 pr-1.5'
            }`}
            style={{ backgroundColor: 'var(--surface)' }}
          >
            <textarea
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                if (e.shiftKey) {
                  e.preventDefault();
                  const target = e.currentTarget;
                  const start = target.selectionStart ?? chatInput.length;
                  const end = target.selectionEnd ?? chatInput.length;
                  const next = `${chatInput.slice(0, start)}\n${chatInput.slice(end)}`;
                  setChatInput(next);
                  window.requestAnimationFrame(() => {
                    target.selectionStart = start + 1;
                    target.selectionEnd = start + 1;
                  });
                  return;
                }
                e.preventDefault();
                void handleSendChat();
              }}
              placeholder={`${t('newProject')} ${project?.name || t('project')}`}
              disabled={chatSending || !projectId}
              rows={visibleChatInputRows}
              className={`project-chat-input custom-scrollbar max-h-40 min-w-0 flex-1 resize-none bg-transparent text-[calc(1rem+2px)] leading-relaxed placeholder:text-[color:var(--text-muted)] placeholder:opacity-90 disabled:opacity-60 ${
                isChatInputExpanded ? 'min-h-0 w-full py-0' : 'min-h-[2.75rem] py-2.5'
              } ${
                isChatInputScrollable ? 'overflow-y-auto' : 'overflow-y-hidden'
              }`}
              style={{
                color: 'var(--text)',
                border: 0,
                outline: 'none',
                boxShadow: 'none',
              }}
              aria-label={t('chatMessage')}
            />
            <div className={`flex items-center justify-end ${isChatInputExpanded ? 'w-full' : 'shrink-0'}`}>
              <button
                type="submit"
                disabled={chatSending || !chatInput.trim() || !projectId}
                className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full disabled:opacity-50"
                style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                title={t('sendMessage')}
                aria-label={t('sendMessage')}
              >
                {chatSending ? <Loading className="h-4 w-4 animate-spin" aria-hidden /> : <PaperPlane className="h-4 w-4" aria-hidden />}
              </button>
            </div>
          </form>

          {chatError ? (
            <p className="text-xs" style={{ color: 'var(--error)' }}>
              {chatError}
            </p>
          ) : null}

          <div className="flex flex-shrink-0 items-center">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleLowerTabClick('chats')}
                className={`project-lower-tab rounded-full px-3 py-1.5 text-sm font-medium ${
                  activeTab === 'chats' ? 'project-lower-tab-active' : 'project-lower-tab-inactive'
                }`}
                style={
                  activeTab === 'chats'
                    ? { backgroundColor: 'var(--bg-secondary)', color: 'var(--text)' }
                    : { backgroundColor: 'transparent', color: 'var(--text-secondary)' }
                }
              >
                {t('chats')}
              </button>
              <button
                type="button"
                onClick={() => handleLowerTabClick('notes')}
                className={`project-lower-tab rounded-full px-3 py-1.5 text-sm font-medium ${
                  activeTab === 'notes' ? 'project-lower-tab-active' : 'project-lower-tab-inactive'
                }`}
                style={
                  activeTab === 'notes'
                    ? { backgroundColor: 'var(--bg-secondary)', color: 'var(--text)' }
                    : { backgroundColor: 'transparent', color: 'var(--text-secondary)' }
                }
              >
                {t('projectNotes')}
              </button>
            </div>
          </div>

          <div
            className={`project-lower-section flex min-h-0 flex-col overflow-hidden ${
              isLowerSectionExpanded
                ? 'project-lower-section-expanded'
                : 'project-lower-section-collapsed pointer-events-none'
            }`}
          >
            <section
              className={`flex min-h-0 flex-1 flex-col overflow-hidden ${
                activeTab !== 'notes' ? 'px-4 md:px-6' : ''
              }`}
            >
              {activeTab === 'notes' ? (
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 md:px-6">
                  <div className="custom-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-0">
                  {error ? (
                    <p className="text-sm" style={{ color: 'var(--error)' }}>{error}</p>
                  ) : notes.length === 0 ? (
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                      {t('noProjectNotes')}
                    </p>
                  ) : (
                    <>
                      {noteActionError ? (
                        <p className="text-xs" style={{ color: 'var(--error)' }}>
                          {noteActionError}
                        </p>
                      ) : null}
                    <div className="summary-note-list project-note-list">
                      {notes.map((note) => {
                        const noteTags = getNoteTags(note);
                        const isSelected = expandedNoteId === note.id;
                        const visibleTags = noteTags.slice(0, 3);
                        const hasMoreTags = noteTags.length > 3;
                        const allTagsTooltip = noteTags.join(', ');
                        return (
                        <div key={note.id} className={`summary-note-row project-note-row ${isSelected ? 'summary-note-row-active' : ''}`}>
                          <span className="summary-note-row-rail" aria-hidden />
                          <div
                            onClick={() => setExpandedNoteId(isSelected ? null : note.id)}
                            className="summary-note-row-content grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-stretch gap-x-3 gap-y-0 px-3 py-2.5 transition-all sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] sm:px-4 sm:py-3.5"
                          >
                            <div className="hidden min-h-0 w-[2.5rem] shrink-0 items-center justify-center self-stretch sm:flex">
                              <div
                                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                                style={{ backgroundColor: 'var(--accent-light)' }}
                              >
                                <FileDocument className="h-5 w-5 shrink-0" style={{ color: 'var(--accent)' }} />
                              </div>
                            </div>
                            <div className="min-w-0 pr-1">
                              {renamingNoteId === note.id ? (
                                <input
                                  autoFocus
                                  value={renameNoteDraft}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => setRenameNoteDraft(e.target.value)}
                                  onBlur={() => {
                                    void handleSaveRenameNote(note.id);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      void handleSaveRenameNote(note.id);
                                    } else if (e.key === 'Escape') {
                                      e.preventDefault();
                                      setRenamingNoteId(null);
                                      setRenameNoteDraft('');
                                    }
                                  }}
                                  maxLength={200}
                                  className="w-full min-w-0 rounded px-1 py-0.5 text-sm font-medium"
                                  style={{
                                    color: 'var(--text)',
                                    backgroundColor: 'var(--accent-light)',
                                    outline: '1px solid var(--accent)',
                                  }}
                                />
                              ) : (
                                <>
                                  <p
                                    className="block w-[min(350px,100%)] max-w-[350px] truncate text-base font-semibold leading-snug"
                                    style={{ color: 'var(--text)' }}
                                    title={getNoteDisplayTitle(note)}
                                  >
                                    {getNoteDisplayTitle(note)}
                                  </p>
                                  {noteTags.length > 0 ? (
                                    <div className="mt-0 flex flex-wrap gap-1.5">
                                      {visibleTags.map((tagLabel, tagIdx) => (
                                        <span
                                          key={`${note.id}-tag-${tagIdx}`}
                                          className="inline-flex max-w-full rounded-full px-2.5 py-0.5 text-xs font-medium leading-snug break-words"
                                          style={{
                                            backgroundColor: 'var(--accent-light)',
                                            color: 'var(--text-secondary)',
                                          }}
                                          title={tagLabel}
                                        >
                                          {tagLabel}
                                        </span>
                                      ))}
                                      {hasMoreTags ? (
                                        <span
                                          className="inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium leading-snug"
                                          style={{
                                            backgroundColor: 'var(--bg-secondary)',
                                            color: 'var(--text-secondary)',
                                          }}
                                          title={allTagsTooltip}
                                        >
                                          +{noteTags.length - visibleTags.length}
                                        </span>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </>
                              )}
                            </div>
                            <div className="flex min-h-0 shrink-0 items-center justify-end gap-2 self-stretch sm:gap-3">
                              <div className="flex min-h-0 min-w-0 max-w-[13rem] flex-col items-end justify-center text-right">
                                <div
                                  className="flex min-w-0 items-center gap-1 text-sm"
                                  style={{ color: 'var(--text-secondary)' }}
                                  title={formatDate(note.created_at)}
                                >
                                  <Calendar className="h-3 w-3 shrink-0" aria-hidden />
                                  <span className="min-w-0 truncate">Created {formatDate(note.created_at)}</span>
                                </div>
                                {note.meeting_at ? (
                                  <div
                                    className="mt-1 flex min-w-0 items-center gap-1 text-sm"
                                    style={{ color: 'var(--text-secondary)' }}
                                    title={formatDate(note.meeting_at)}
                                  >
                                    <Calendar className="h-3 w-3 shrink-0" aria-hidden />
                                    <span className="min-w-0 truncate">Meeting {formatDate(note.meeting_at)}</span>
                                  </div>
                                ) : null}
                                {getNoteDurationMeta(note) ? (
                                  <div
                                    className="mt-1 flex min-w-0 items-center gap-1 text-sm"
                                    style={{ color: 'var(--text-secondary)' }}
                                    title={getNoteDurationMeta(note) ?? undefined}
                                  >
                                    <span aria-hidden>•</span>
                                    <span className="min-w-0 truncate">{getNoteDurationMeta(note)}</span>
                                  </div>
                                ) : null}
                                <p
                                  className="mt-1 truncate text-sm leading-snug"
                                  style={{ color: 'var(--text-secondary)' }}
                                  title={getNoteParticipantsLabel(note)}
                                >
                                  {getNoteParticipantsLabel(note)}
                                </p>
                              </div>
                              <div
                                className="relative flex h-10 w-10 shrink-0 items-center justify-center"
                                ref={openNoteMenuId === note.id ? noteMenuRef : undefined}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  onClick={() => setOpenNoteMenuId((prev) => (prev === note.id ? null : note.id))}
                                  className="flex h-9 w-9 items-center justify-center rounded-md transition-opacity hover:opacity-80"
                                  style={{ color: 'var(--text-muted)' }}
                                  aria-label={`Note actions for ${note.name?.trim() || 'Untitled note'}`}
                                >
                                  <MoreHorizontal className="h-5 w-5 shrink-0" aria-hidden />
                                </button>
                                {openNoteMenuId === note.id ? (
                                  <div
                                    className="absolute right-0 top-full z-20 mt-1 w-44 rounded-xl border p-2 shadow-lg"
                                    style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => handleStartRenameNote(note)}
                                      className="chat-menu-item flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
                                      style={{ color: 'var(--text)' }}
                                    >
                                      <EditPencilLine01 className="h-4 w-4" aria-hidden />
                                      Rename Note
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        void handleRemoveFromProject(note);
                                      }}
                                      className="chat-menu-item flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
                                      style={{ color: 'var(--text)' }}
                                    >
                                      <FolderRemove className="h-4 w-4" aria-hidden />
                                      {t('removeFromProject')}
                                    </button>
                                    <div className="my-1 h-px" style={{ backgroundColor: 'var(--border)' }} />
                                    <button
                                      type="button"
                                      onClick={() => handleOpenDeleteNote(note)}
                                      className="chat-menu-item chat-menu-item-danger flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
                                      style={{ color: 'var(--error)' }}
                                    >
                                      <TrashFull className="h-4 w-4" aria-hidden />
                                      {t('deleteNote')}
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </div>

                          <div className={`collapse-container collapse-container--instant ${isSelected ? 'expanded' : 'collapsed'}`}>
                            <div className="collapse-content">
                              {(() => {
                                const selectedTranscriptLanguage = getSelectedTranscriptLanguage(note);
                                const diarRaw = getDisplayTranscriptSegments(note, selectedTranscriptLanguage);
                                const showDiarized = diarRaw.length > 0;
                                const plainTx = getDisplayTranscriptText(note, selectedTranscriptLanguage);
                                const hasTranscription = showDiarized || Boolean(plainTx);
                                const activeTab = noteExpandedTab[note.id] ?? 'summary';

                                return (
                                  <div className="project-note-expanded-detail min-h-0 border-t" style={{ borderColor: 'var(--border)' }}>
                                    <div className="results-header flex flex-wrap items-end justify-between gap-3 border-b px-4 pt-3 md:px-5" style={{ borderColor: 'var(--border)' }}>
                                      <div className="-mb-px results-tabs flex min-w-0 gap-1 sm:gap-5" role="tablist">
                                        <button
                                          type="button"
                                          role="tab"
                                          aria-selected={activeTab === 'summary'}
                                          onClick={() => setNoteExpandedTab((prev) => ({ ...prev, [note.id]: 'summary' }))}
                                          className="results-tab px-1 pb-2.5 pt-1 text-sm font-medium transition-colors sm:px-1"
                                          style={{
                                            color: activeTab === 'summary' ? 'var(--text)' : 'var(--text-secondary)',
                                          }}
                                        >
                                          {t('summary')}
                                        </button>
                                        {hasTranscription ? (
                                          <button
                                            type="button"
                                            role="tab"
                                            aria-selected={activeTab === 'transcription'}
                                            onClick={() => setNoteExpandedTab((prev) => ({ ...prev, [note.id]: 'transcription' }))}
                                            className="results-tab px-1 pb-2.5 pt-1 text-sm font-medium transition-colors sm:px-1"
                                            style={{
                                              color: activeTab === 'transcription' ? 'var(--text)' : 'var(--text-secondary)',
                                            }}
                                          >
                                            {t('transcription')}
                                          </button>
                                        ) : null}
                                        {(noteImageCounts[note.id] ?? 0) > 0 ? (
                                          <button
                                            type="button"
                                            role="tab"
                                            aria-selected={activeTab === 'images'}
                                            onClick={() => setNoteExpandedTab((prev) => ({ ...prev, [note.id]: 'images' }))}
                                            className="results-tab px-1 pb-2.5 pt-1 text-sm font-medium transition-colors sm:px-1"
                                            style={{
                                              color: activeTab === 'images' ? 'var(--text)' : 'var(--text-secondary)',
                                            }}
                                          >
                                            Attachments
                                          </button>
                                        ) : null}
                                      </div>
                                      <div className="flex shrink-0 flex-col items-end gap-2 pb-2">
                                        <div className="flex items-center gap-2">
                                        {activeTab === 'summary' ? (
                                          <>
                                            {editingNoteId === note.id ? (
                                              <button
                                                type="button"
                                                onClick={() => void handleSaveNoteEdit(note)}
                                                disabled={savingNoteId === note.id}
                                                className="summary-toolbar-btn flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-all disabled:opacity-50"
                                                style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                                              >
                                                {savingNoteId === note.id ? <Loading className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                                                Done
                                              </button>
                                            ) : (
                                              <button
                                                type="button"
                                                onClick={() => handleStartNoteEdit(note)}
                                                className="summary-toolbar-btn flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-all"
                                                style={{ backgroundColor: 'var(--bg)', color: 'var(--text-secondary)' }}
                                              >
                                                <EditPencilLine01 className="h-3 w-3" />
                                                Edit
                                              </button>
                                            )}
                                          </>
                                        ) : null}
                                        {activeTab !== 'images' ? (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              void handleCopyText(
                                                activeTab === 'summary'
                                                  ? noteEditDraft || getNoteSummaryText(note, appLanguage)
                                                  : showDiarized
                                                    ? diarRaw.map((s) => `${s.speaker}: ${s.text}`).join('\n\n')
                                                    : plainTx || '',
                                                activeTab === 'summary'
                                                  ? `project-summary-${note.id}`
                                                  : `project-transcription-${note.id}`
                                              )
                                            }
                                            className="summary-toolbar-btn flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-all"
                                            style={{ backgroundColor: 'var(--bg)', color: 'var(--text-secondary)' }}
                                            title={activeTab === 'summary' ? 'Copy summary' : 'Copy transcription'}
                                            aria-label={activeTab === 'summary' ? 'Copy summary' : 'Copy transcription'}
                                          >
                                            {copiedKey ===
                                            (activeTab === 'summary'
                                              ? `project-summary-${note.id}`
                                              : `project-transcription-${note.id}`) ? (
                                              <Check className="h-3 w-3" />
                                            ) : (
                                              <Copy className="h-3 w-3" />
                                            )}
                                            Copy
                                          </button>
                                        ) : null}
                                        </div>
                                      </div>
                                    </div>

                                    <div className="min-h-0 px-4 pb-4 pt-4 md:px-5">
                                      {activeTab === 'summary' ? (
                                        <>
                                          {editingNoteId === note.id ? (
                                            <textarea
                                              value={noteEditDraft}
                                              onChange={(e) => setNoteEditDraft(e.target.value)}
                                              className={`w-full resize-none border-2 ${NOTE_SUMMARY_SCROLL}`}
                                              style={{
                                                backgroundColor: 'transparent',
                                                color: 'var(--text)',
                                                borderColor: 'var(--accent)',
                                              }}
                                            />
                                          ) : getNoteSummaryText(note, appLanguage) ? (
                                            <div className={`summary-markdown prose prose-sm max-w-none ${NOTE_SUMMARY_SCROLL}`} style={{ backgroundColor: 'transparent', color: 'var(--text)' }}>
                                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{getNoteSummaryText(note, appLanguage)}</ReactMarkdown>
                                            </div>
                                          ) : (
                                            <div className={`flex items-center justify-center italic ${NOTE_SUMMARY_SCROLL}`} style={{ color: 'var(--text-muted)' }}>
                                              No summary available
                                            </div>
                                          )}
                                          {editingNoteId === note.id && noteEditError ? (
                                            <p className="mt-2 text-xs" style={{ color: 'var(--error)' }}>
                                              {noteEditError}
                                            </p>
                                          ) : null}
                                        </>
                                      ) : null}

                                      {activeTab === 'transcription' && hasTranscription ? (
                                        <>
                                          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                            {showDiarized ? (
                                              <TranscriptSpeakerFilterControls
                                                speakers={getTranscriptSpeakerFilters(diarRaw)}
                                                selectedSpeakers={noteSpeakerFilters[note.id] ?? []}
                                                onSelectedSpeakersChange={(next) =>
                                                  setNoteSpeakerFilters((prev) => ({ ...prev, [note.id]: next }))
                                                }
                                              />
                                            ) : <span />}
                                            {renderTranscriptLanguageToggle(note)}
                                          </div>
                                          {showDiarized ? (
                                            <TranscriptDiarizedEditor
                                              segments={diarRaw}
                                              onSegmentsChange={(next) => updateDisplayedTranscript(note, selectedTranscriptLanguage, next)}
                                              onPersistSegments={(next) => persistDisplayedTranscript(note, selectedTranscriptLanguage, next)}
                                              noteId={note.id}
                                              scrollContainerClassName={NOTE_TRANSCRIPT_SCROLL_CLASS}
                                              selectedSpeakerFilters={noteSpeakerFilters[note.id] ?? []}
                                              onSelectedSpeakerFiltersChange={(next) =>
                                                setNoteSpeakerFilters((prev) => ({ ...prev, [note.id]: next }))
                                              }
                                            />
                                          ) : (
                                            <div
                                              className={`whitespace-pre-wrap ${NOTE_DETAIL_SCROLL_BODY}`}
                                              style={{
                                                backgroundColor: 'transparent',
                                                color: 'var(--text-secondary)',
                                              }}
                                            >
                                              {plainTx || ''}
                                            </div>
                                          )}
                                        </>
                                      ) : null}
                                      {activeTab === 'images' && (noteImageCounts[note.id] ?? 0) > 0 ? (
                                        <div className="min-h-0">
                                          <NoteImageAttachments
                                            mode="saved"
                                            noteId={note.id}
                                            userId={note.user_id === user?.id ? user?.id ?? null : null}
                                            showCountButton={false}
                                            onImagesChange={(images) => handleNoteImagesChange(note.id, images.length)}
                                          />
                                        </div>
                                      ) : null}
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          </div>
                        </div>
                      )})}
                    </div>
                    </>
                  )}
                </div>
                  <div className="flex shrink-0 justify-start pt-3">
                    <button
                      type="button"
                      onClick={() => void openAddNotesModal()}
                      disabled={!projectId || !user?.id}
                      className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                    >
                      <FileAdd className="h-4 w-4 shrink-0" aria-hidden />
                      Add notes
                    </button>
                  </div>
                </div>
              ) : (
                <div className="custom-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
                  {sessionsLoading ? (
                    <div className="flex h-full items-center justify-center py-10">
                      <Loading className="h-5 w-5 animate-spin" style={{ color: 'var(--text-muted)' }} />
                    </div>
                  ) : sessionsError ? (
                    <div className="py-6 text-sm" style={{ color: 'var(--error)' }}>
                      {sessionsError}
                    </div>
                  ) : projectSessions.length === 0 ? (
                    <div className="py-6 text-sm" style={{ color: 'var(--text-muted)' }}>
                      No chat sessions yet.
                    </div>
                  ) : (
                    <div className="summary-note-list project-chat-list">
                      {projectSessions.map((session) => {
                        const rows = sessionChatsById[session.id] || [];
                        const firstResponse =
                          rows.map((row) => getChatResponseValue(row)).find((value) => Boolean(value)) ||
                          'No response yet';
                        const firstMessage = rows.map((row) => (row.message || '').trim()).find((value) => Boolean(value)) || '';
                        const isSelected = selectedSessionId === session.id;
                        return (
                          <div
                            key={session.id}
                            className={`summary-note-row project-chat-row ${isSelected ? 'summary-note-row-active' : ''}`}
                          >
                            <span className="summary-note-row-rail" aria-hidden />
                            <button
                              type="button"
                              onClick={() => handleSelectSession(session.id)}
                              className="summary-note-row-content grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-3 py-3.5 text-left transition-all sm:px-4"
                            >
                              <div className="min-w-0">
                                <p className="truncate text-base font-semibold" style={{ color: 'var(--text)' }}>
                                  {firstResponse}
                                </p>
                                {firstMessage ? (
                                  <p className="mt-1 truncate text-sm" style={{ color: 'var(--text-secondary)' }}>
                                    {firstMessage}
                                  </p>
                                ) : null}
                              </div>
                              <p className="shrink-0 text-sm" style={{ color: 'var(--text-secondary)' }}>
                                {new Date(session.created_at || Date.now()).toLocaleDateString([], {
                                  month: 'short',
                                  day: 'numeric',
                                })}
                              </p>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
      </main>

      {isAddNotesModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          role="presentation"
          onClick={() => {
            if (!addNotesSaving) {
              setIsAddNotesModalOpen(false);
              setAddModalExpandedNoteId(null);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-notes-to-project-title"
            className="project-note-picker-modal flex max-h-[min(92vh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-xl app-surface-elevated sm:max-w-6xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-4 sm:px-6 sm:py-5"
              style={{ borderColor: 'var(--border)' }}
            >
              <div>
                <h3 id="add-notes-to-project-title" className="text-lg font-semibold sm:text-xl" style={{ color: 'var(--text)' }}>
                  Add notes to project
                </h3>
                <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Select meeting notes that are not already in this project. Expand a row to preview summary and transcription.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!addNotesSaving) {
                    setIsAddNotesModalOpen(false);
                    setAddModalExpandedNoteId(null);
                  }
                }}
                className="montage-icon-button montage-icon-button--secondary inline-flex h-10 w-10 items-center justify-center rounded-lg"
                aria-label="Close modal"
                disabled={addNotesSaving}
              >
                <CloseMd className="h-5 w-5" aria-hidden />
              </button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-2 pt-4 sm:px-6 sm:pt-5">
              <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">
                {addNotesPickerLoading ? (
                  <div className="flex min-h-[12rem] flex-1 items-center justify-center py-6">
                    <div className="card rounded-lg p-8 text-center">
                      <div
                        className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-b-2"
                        style={{ borderColor: 'var(--accent)' }}
                        aria-hidden
                      />
                      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        Loading your notes...
                      </p>
                    </div>
                  </div>
                ) : notesAvailableToAdd.length === 0 ? (
                  <div className="flex min-h-[12rem] flex-1 items-center justify-center py-6">
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                      No other notes available to add (all your notes are already in this project, or you have no notes yet).
                    </p>
                  </div>
                ) : (
                  <ul className="summary-note-list project-note-picker-list">
                    {notesAvailableToAdd.map((note) => {
                      const checked = selectedNoteIdsToAdd.includes(note.id);
                      const expanded = addModalExpandedNoteId === note.id;
                      const title = note.name?.trim() || 'Untitled note';
                      const summaryPreview = getNoteSummaryText(note, appLanguage);
                      const transcriptionPreview = getNoteTranscriptionText(note);
                      return (
                        <li
                          key={note.id}
                          className={`summary-note-row project-note-picker-row ${expanded || checked ? 'summary-note-row-active' : ''}`}
                        >
                          <span className="summary-note-row-rail" aria-hidden />
                          <div
                            onClick={() =>
                              setAddModalExpandedNoteId((id) => (id === note.id ? null : note.id))
                            }
                            className="summary-note-row-content grid cursor-pointer grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-3 transition-all sm:px-4 sm:py-3.5"
                            aria-expanded={expanded}
                          >
                            <label
                              className="project-note-picker-checkbox-wrap flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleAddNoteSelection(note.id)}
                                className="sr-only"
                                aria-label={`Add ${title} to project`}
                              />
                              <span
                                className={`project-note-picker-checkbox ${checked ? 'project-note-picker-checkbox-checked' : ''}`}
                                aria-hidden
                              >
                                {checked ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
                              </span>
                            </label>
                            <div className="min-w-0 overflow-hidden pr-1">
                              <p
                                className="truncate text-sm font-medium leading-snug"
                                style={{ color: 'var(--text)' }}
                                title={title}
                              >
                                {title}
                              </p>
                              <p
                                className="mt-0.5 truncate text-xs leading-snug"
                                style={{ color: 'var(--text-muted)' }}
                                title={`Created ${formatNoteModalDate(note.created_at)}${note.meeting_at ? `, Meeting ${formatNoteModalDate(note.meeting_at)}` : ''}${getNoteDurationMeta(note) ? `, ${getNoteDurationMeta(note)}` : ''}`}
                              >
                                Created {formatNoteModalDate(note.created_at)}
                                {note.meeting_at ? ` - Meeting ${formatNoteModalDate(note.meeting_at)}` : ''}
                                {getNoteDurationMeta(note) ? ` - ${getNoteDurationMeta(note)}` : ''}
                              </p>
                            </div>
                            <div className="flex h-10 shrink-0 items-center justify-end">
                              <span
                                className="flex h-9 w-9 items-center justify-center rounded-md"
                                style={{ color: 'var(--text-muted)' }}
                                aria-hidden
                              >
                                <ChevronDown
                                  className={`h-5 w-5 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
                                  aria-hidden
                                />
                              </span>
                            </div>
                          </div>
                          {expanded ? (
                            <div
                              className="project-note-picker-expanded border-t p-4"
                              style={{ borderColor: 'var(--border)' }}
                            >
                              <div>
                                <div className="mb-2 flex items-center justify-between gap-2">
                                  <h4 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                                    {t('summary')}
                                  </h4>
                                  <button
                                    type="button"
                                    onClick={() => void handleCopyText(summaryPreview, `picker-summary-${note.id}`)}
                                    className="summary-toolbar-btn inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium"
                                    title="Copy summary"
                                    aria-label="Copy summary"
                                  >
                                    {copiedKey === `picker-summary-${note.id}` ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                                  </button>
                                </div>
                                <div
                                  className="custom-scrollbar project-note-picker-preview max-h-48 min-h-0 overflow-y-auto whitespace-pre-wrap p-3 text-sm leading-relaxed max-md:text-base"
                                  style={{ color: 'var(--text)' }}
                                >
                                  {summaryPreview || 'No summary for this note.'}
                                </div>
                              </div>
                              <div
                                className="mt-6 border-t pt-4"
                                style={{ borderColor: 'var(--border)' }}
                              >
                                <div className="mb-2 flex items-center justify-between gap-2">
                                  <h4 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                                    {t('transcription')}
                                  </h4>
                                  <button
                                    type="button"
                                    onClick={() => void handleCopyText(transcriptionPreview, `picker-transcription-${note.id}`)}
                                    className="summary-toolbar-btn inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium"
                                    title="Copy transcription"
                                    aria-label="Copy transcription"
                                  >
                                    {copiedKey === `picker-transcription-${note.id}` ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                                  </button>
                                </div>
                                <div
                                  className="custom-scrollbar project-note-picker-preview max-h-56 min-h-0 overflow-y-auto whitespace-pre-wrap p-3 text-sm leading-relaxed max-md:text-base"
                                  style={{ color: 'var(--text-secondary)' }}
                                >
                                  {transcriptionPreview || 'No transcription for this note.'}
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>

            {addNotesModalError ? (
              <p className="shrink-0 px-4 py-2 text-sm sm:px-6" style={{ color: 'var(--error)' }}>
                {addNotesModalError}
              </p>
            ) : null}

            <div
              className="flex shrink-0 justify-end gap-3 border-t px-4 py-4 sm:px-6"
              style={{ borderColor: 'var(--border)' }}
            >
              <button
                type="button"
                onClick={() => {
                  setIsAddNotesModalOpen(false);
                  setAddModalExpandedNoteId(null);
                }}
                className="rounded-lg px-4 py-2.5 text-sm font-medium"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                disabled={addNotesSaving}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmAddNotesToProject()}
                className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium disabled:opacity-60"
                style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                disabled={addNotesSaving || selectedNoteIdsToAdd.length === 0}
              >
                {addNotesSaving ? <Loading className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Add to project
              </button>
            </div>
          </div>
        </div>
      )}

      {isDeleteNoteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}>
          <div className="w-full max-w-sm rounded-lg border p-4 sm:p-5" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
            <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
              {isSharedWithUser(deleteNoteTarget, user?.id) ? 'Remove shared note?' : `${t('deleteNote')}?`}
            </h3>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {isSharedWithUser(deleteNoteTarget, user?.id) ? (
                <>
                  This will remove{' '}
                  <span className="font-medium" style={{ color: 'var(--text)' }}>
                    {deleteNoteTarget?.name?.trim() || 'Untitled note'}
                  </span>{' '}
                  from your shared notes. The owner and other shared users will still have access.
                </>
              ) : (
                <>
                  This will permanently delete{' '}
                  <span className="font-medium" style={{ color: 'var(--text)' }}>
                    {deleteNoteTarget?.name?.trim() || 'Untitled note'}
                  </span>
                  .
                </>
              )}
            </p>
            {deleteNoteError ? (
              <p className="mt-2 text-xs" style={{ color: 'var(--error)' }}>
                {deleteNoteError}
              </p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsDeleteNoteOpen(false);
                  setDeleteNoteTarget(null);
                }}
                className="rounded-lg px-3 py-2 text-sm"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                disabled={deletingNote}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleConfirmDeleteNote();
                }}
                className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-60"
                style={{ backgroundColor: 'var(--error)', color: '#fff' }}
                disabled={deletingNote}
              >
                {deletingNote ? <Loading className="h-4 w-4 animate-spin" aria-hidden /> : null}
                {isSharedWithUser(deleteNoteTarget, user?.id) ? 'Remove' : t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Project;
