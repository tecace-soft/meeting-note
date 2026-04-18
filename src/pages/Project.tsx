import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../config/supabaseConfig';
import {
  Calendar,
  ChevronDown,
  ChevronUp,
  FileText,
  Folder,
  FolderMinus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Save,
  Send,
  Trash2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import TranscriptDiarizedEditor from '../components/TranscriptDiarizedEditor';
import { getNoteDiarizationRaw, hasUsableDiarization, normalizeTranscript } from '../lib/transcriptSegments';

interface ProjectRow {
  id: string;
  name: string;
  notes?: string[] | null;
}

interface NoteRow {
  id: string;
  name?: string | null;
  user_name?: string | null;
  summary?: string | null;
  summary_edit?: string | null;
  transcription?: string | null;
  diarization?: unknown;
  diatrization?: unknown;
  created_at?: string | null;
  projects?: Array<string | number> | null;
}

/** Fixed scroll height for plain transcription (no diarization). */
const NOTE_DETAIL_SCROLL_BODY =
  'h-72 min-h-0 max-md:min-h-[11rem] max-md:h-[min(52vh,24rem)] overflow-y-auto custom-scrollbar rounded-lg p-3 max-md:p-4 text-sm max-md:text-base leading-relaxed';

/** Summary: fixed height scroll, no border or fill. */
const NOTE_SUMMARY_SCROLL =
  'h-72 min-h-0 max-md:min-h-[11rem] max-md:h-[min(52vh,24rem)] overflow-y-auto custom-scrollbar p-3 max-md:p-4 text-sm max-md:text-base leading-relaxed rounded-lg';

const NOTE_TRANSCRIPT_SCROLL_CLASS = 'h-72 min-h-0 max-md:min-h-[11rem] max-md:h-[min(52vh,24rem)]';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

function extractWebhookResponse(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const value = (payload as { response?: unknown }).response;
  return typeof value === 'string' ? value.trim() : '';
}

const PROJECT_CHAT_WEBHOOK_URL =
  'https://n8n.srv1153481.hstgr.cloud/webhook/9fe1b3b5-9e2e-4b23-8775-b38fc21e4b4d';

const Project: React.FC = () => {
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get('id');
  const projectIdFilterValue: string | number =
    projectId == null ? '' : Number.isNaN(Number(projectId)) ? projectId : Number(projectId);

  const [project, setProject] = useState<ProjectRow | null>(null);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
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
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'notes' | 'chats'>('notes');
  const [isLowerSectionExpanded, setIsLowerSectionExpanded] = useState(true);

  const noteMenuRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const hasConversation = chatMessages.length > 0 || chatSending;

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
  }, [projectId]);

  useEffect(() => {
    setChatMessages([]);
    setChatError(null);
    setChatInput('');
    setActiveTab('notes');
    setIsLowerSectionExpanded(true);
  }, [projectId]);

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

  const handleSendChat = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = chatInput.trim();
    if (!trimmed || !projectId || chatSending) return;

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
        body: JSON.stringify({ message: trimmed, project_id: projectId }),
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
    setNoteEditDraft(note.summary_edit || note.summary || '');
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

  const handleOpenDeleteNote = (note: NoteRow) => {
    setOpenNoteMenuId(null);
    setDeleteNoteError(null);
    setDeleteNoteTarget(note);
    setIsDeleteNoteOpen(true);
  };

  const handleConfirmDeleteNote = async () => {
    if (!deleteNoteTarget) return;
    try {
      setDeletingNote(true);
      setDeleteNoteError(null);
      setNoteActionError(null);
      const { error: deleteError } = await supabase.from('note').delete().eq('id', deleteNoteTarget.id);
      if (deleteError) throw deleteError;

      await removeNoteFromProjectNotes(deleteNoteTarget.id);
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

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center" style={{ backgroundColor: 'var(--bg)' }}>
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 mx-auto mb-4" style={{ borderColor: 'var(--accent)' }} />
          <p style={{ color: 'var(--text-secondary)' }}>Loading project...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg)' }}>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 md:p-6">
        <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-4">
          <h1
            className="flex flex-shrink-0 items-center gap-3 text-3xl font-semibold"
            style={{ color: 'var(--text)' }}
          >
            <Folder className="h-8 w-8 shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
            <span className="min-w-0 truncate">{project?.name || 'Project'}</span>
          </h1>

          <div
            className={`overflow-hidden transition-all duration-300 ease-out ${
              hasConversation ? 'max-h-[60vh] opacity-100' : 'max-h-0 opacity-0'
            }`}
          >
            <section className="card flex min-h-0 flex-col overflow-hidden rounded-lg p-4">
              <h2 className="mb-2 flex-shrink-0 text-base font-medium" style={{ color: 'var(--text)' }}>
                Conversation
              </h2>
              <div
                ref={chatScrollRef}
                className="custom-scrollbar flex min-h-0 max-h-[45vh] flex-1 flex-col gap-3 overflow-y-auto rounded-lg border p-4"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-secondary)' }}
              >
                {chatMessages.map((m) => (
                  <div
                    key={m.id}
                    className={`max-w-[95%] rounded-lg px-3 py-2 text-sm ${m.role === 'user' ? 'ml-auto' : 'mr-auto'}`}
                    style={{
                      backgroundColor: m.role === 'user' ? 'var(--accent-light)' : 'var(--card)',
                      color: 'var(--text)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {m.role === 'assistant' ? (
                      <div className="prose prose-sm max-w-none">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    )}
                  </div>
                ))}
                {chatSending ? (
                  <div className="mr-auto flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    Waiting for reply...
                  </div>
                ) : null}
              </div>
            </section>
          </div>

          <form
            onSubmit={(ev) => {
              void handleSendChat(ev);
            }}
            className="card flex flex-shrink-0 items-center gap-2 rounded-xl p-2"
          >
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={`New chat in ${project?.name || 'Project'}`}
              disabled={chatSending || !projectId}
              className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm disabled:opacity-60"
              style={{
                backgroundColor: 'var(--bg)',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
              aria-label="Chat message"
            />
            <button
              type="submit"
              disabled={chatSending || !chatInput.trim() || !projectId}
              className="inline-flex flex-shrink-0 items-center justify-center rounded-lg px-3 py-2 disabled:opacity-50"
              style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
              title="Send message"
              aria-label="Send message"
            >
              {chatSending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
            </button>
          </form>

          {chatError ? (
            <p className="text-xs" style={{ color: 'var(--error)' }}>
              {chatError}
            </p>
          ) : null}

          <div className="flex flex-shrink-0 items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveTab('notes')}
                className="rounded-full px-3 py-1.5 text-sm font-medium"
                style={
                  activeTab === 'notes'
                    ? { backgroundColor: 'var(--bg-secondary)', color: 'var(--text)' }
                    : { backgroundColor: 'transparent', color: 'var(--text-secondary)' }
                }
              >
                Project Notes
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('chats')}
                className="rounded-full px-3 py-1.5 text-sm font-medium"
                style={
                  activeTab === 'chats'
                    ? { backgroundColor: 'var(--bg-secondary)', color: 'var(--text)' }
                    : { backgroundColor: 'transparent', color: 'var(--text-secondary)' }
                }
              >
                Chats
              </button>
            </div>

            <button
              type="button"
              onClick={() => setIsLowerSectionExpanded((prev) => !prev)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm"
              style={{ color: 'var(--text-secondary)' }}
            >
              {isLowerSectionExpanded ? 'Hide Section' : 'Show Section'}
              {isLowerSectionExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          </div>

          <div
            className={`flex min-h-0 flex-col overflow-hidden transition-opacity duration-300 ease-out ${
              isLowerSectionExpanded
                ? 'min-h-0 flex-1 opacity-100'
                : 'h-0 shrink-0 flex-[0_0_0] opacity-0 pointer-events-none'
            }`}
          >
            <section className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 md:px-6">
              {activeTab === 'notes' ? (
                <div className="custom-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-0 md:px-5">
                  {error ? (
                    <p className="text-sm" style={{ color: 'var(--error)' }}>{error}</p>
                  ) : notes.length === 0 ? (
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                      No notes found in this project.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {noteActionError ? (
                        <p className="text-xs" style={{ color: 'var(--error)' }}>
                          {noteActionError}
                        </p>
                      ) : null}
                      {notes.map((note) => (
                        <div key={note.id} className="chat-item card rounded-lg overflow-visible">
                          <div
                            onClick={() => setExpandedNoteId(expandedNoteId === note.id ? null : note.id)}
                            className="grid cursor-pointer grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-3 sm:px-4 sm:py-3.5"
                            style={{ backgroundColor: expandedNoteId === note.id ? 'var(--bg-secondary)' : undefined }}
                          >
                            <div
                              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                              style={{ backgroundColor: 'var(--accent-light)' }}
                            >
                              <FileText className="h-5 w-5 shrink-0" style={{ color: 'var(--accent)' }} />
                            </div>
                            <div className="min-w-0 overflow-hidden pr-1">
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
                                <p
                                  className="truncate text-sm font-medium leading-snug"
                                  style={{ color: 'var(--text)' }}
                                  title={note.name?.trim() || 'Untitled note'}
                                >
                                  {note.name?.trim() || 'Untitled note'}
                                </p>
                              )}
                              <p
                                className="mt-0.5 truncate text-xs leading-snug"
                                style={{ color: 'var(--text-muted)' }}
                                title={`Created by ${note.user_name || 'Unknown'}`}
                              >
                                Created by {note.user_name || 'Unknown'}
                              </p>
                            </div>
                            <div className="flex h-10 shrink-0 items-center justify-end gap-1.5 sm:gap-3">
                              <div
                                className="flex min-w-0 max-w-[5rem] items-center gap-1 truncate text-xs sm:max-w-[9rem] md:max-w-none"
                                style={{ color: 'var(--text-muted)' }}
                                title={formatDate(note.created_at)}
                              >
                                <Calendar className="h-3 w-3 shrink-0" aria-hidden />
                                <span className="min-w-0 truncate">{formatDate(note.created_at)}</span>
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
                                      className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
                                      style={{ color: 'var(--text)' }}
                                    >
                                      <Pencil className="h-4 w-4" aria-hidden />
                                      Rename Note
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        void handleRemoveFromProject(note);
                                      }}
                                      className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
                                      style={{ color: 'var(--text)' }}
                                    >
                                      <FolderMinus className="h-4 w-4" aria-hidden />
                                      Remove from Project
                                    </button>
                                    <div className="my-1 h-px" style={{ backgroundColor: 'var(--border)' }} />
                                    <button
                                      type="button"
                                      onClick={() => handleOpenDeleteNote(note)}
                                      className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
                                      style={{ color: 'var(--error)' }}
                                    >
                                      <Trash2 className="h-4 w-4" aria-hidden />
                                      Delete Note
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </div>

                          <div className={`collapse-container collapse-container--instant ${expandedNoteId === note.id ? 'expanded' : 'collapsed'}`}>
                            <div className="collapse-content">
                              <div className="p-4 border-t" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-secondary)' }}>
                                <div className="mb-2 flex items-center justify-between gap-3">
                                  <h4 className="shrink-0 text-sm font-semibold" style={{ color: 'var(--text)' }}>
                                    Summary
                                  </h4>
                                  <div className="flex shrink-0 items-center gap-2">
                                    {editingNoteId === note.id ? (
                                      <button
                                        type="button"
                                        onClick={() => void handleSaveNoteEdit(note)}
                                        disabled={savingNoteId === note.id}
                                        className="flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium disabled:opacity-50"
                                        style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                                      >
                                        {savingNoteId === note.id ? (
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                          <Save className="h-3 w-3" />
                                        )}
                                        Done
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => handleStartNoteEdit(note)}
                                        className="flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium"
                                        style={{ backgroundColor: 'var(--bg)', color: 'var(--text-secondary)' }}
                                      >
                                        <Pencil className="h-3 w-3" />
                                        Edit
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {editingNoteId === note.id ? (
                                  <textarea
                                    value={noteEditDraft}
                                    onChange={(e) => setNoteEditDraft(e.target.value)}
                                    className={`w-full resize-none ${NOTE_SUMMARY_SCROLL}`}
                                    style={{ color: 'var(--text)' }}
                                  />
                                ) : note.summary_edit || note.summary ? (
                                  <div
                                    className={`prose prose-sm max-w-none ${NOTE_SUMMARY_SCROLL}`}
                                    style={{ color: 'var(--text)' }}
                                  >
                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                      {note.summary_edit || note.summary || ''}
                                    </ReactMarkdown>
                                  </div>
                                ) : (
                                  <div
                                    className={`flex items-center justify-center italic ${NOTE_SUMMARY_SCROLL}`}
                                    style={{ color: 'var(--text-muted)' }}
                                  >
                                    No summary available
                                  </div>
                                )}

                                {editingNoteId === note.id && noteEditError ? (
                                  <p className="mt-2 text-xs" style={{ color: 'var(--error)' }}>
                                    {noteEditError}
                                  </p>
                                ) : null}

                                {(() => {
                                  const diarRaw = getNoteDiarizationRaw(note);
                                  const showDiarized = hasUsableDiarization(diarRaw);
                                  const plainTx = note.transcription?.trim();
                                  if (!showDiarized && !plainTx) return null;
                                  return (
                                    <div className="mt-6 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
                                      <h4 className="mb-2 text-sm font-semibold" style={{ color: 'var(--text)' }}>
                                        Transcription
                                      </h4>
                                      {showDiarized ? (
                                        <TranscriptDiarizedEditor
                                          segments={normalizeTranscript(diarRaw)}
                                          onSegmentsChange={(next) =>
                                            setNotes((prev) =>
                                              prev.map((n) =>
                                                n.id === note.id
                                                  ? { ...n, diarization: next, diatrization: undefined }
                                                  : n
                                              )
                                            )
                                          }
                                          noteId={note.id}
                                          scrollContainerClassName={NOTE_TRANSCRIPT_SCROLL_CLASS}
                                        />
                                      ) : (
                                        <div
                                          className={`whitespace-pre-wrap ${NOTE_DETAIL_SCROLL_BODY}`}
                                          style={{
                                            backgroundColor: 'var(--bg)',
                                            color: 'var(--text-secondary)',
                                          }}
                                        >
                                          {plainTx}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div
                  className="flex min-h-0 flex-1 items-center justify-center rounded-lg border py-8"
                  style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-secondary)' }}
                >
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    Chats tab coming soon.
                  </p>
                </div>
              )}
            </section>
          </div>
        </div>
      </main>

      {isDeleteNoteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}>
          <div className="w-full max-w-sm rounded-lg border p-4 sm:p-5" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
            <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
              Delete note?
            </h3>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              This will permanently delete `{deleteNoteTarget?.name?.trim() || 'Untitled note'}`.
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
                Cancel
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
                {deletingNote ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Project;
