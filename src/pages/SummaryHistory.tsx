import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../config/supabaseConfig';
import {
  FileText,
  Calendar,
  Trash2,
  Loader2,
  Pencil,
  Save,
  MoreHorizontal,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Client } from '@microsoft/microsoft-graph-client';
import TranscriptDiarizedEditor from '../components/TranscriptDiarizedEditor';
import { getNoteDiarizationRaw, hasUsableDiarization, normalizeTranscript } from '../lib/transcriptSegments';

interface Note {
  id: string;
  name?: string | null;
  user_id: string;
  user_name: string;
  chat_id?: string | null;
  projects?: Array<string | number> | null;
  summary?: string;
  summary_edit?: string | null;
  transcription?: string | null;
  diarization?: unknown;
  /** Legacy column name; still read so diarized UI works until fully migrated. */
  created_at?: string;
}

interface ChatInfo {
  topic: string | null;
  chatType: string;
  members: { displayName: string; email: string }[];
}

/** Fixed scroll height for plain transcription (no diarization). */
const NOTE_DETAIL_SCROLL_BODY =
  'h-72 min-h-0 max-md:min-h-[11rem] max-md:h-[min(52vh,24rem)] overflow-y-auto custom-scrollbar rounded-lg p-3 max-md:p-4 text-sm max-md:text-base leading-relaxed';

/** Summary view/edit: fixed height scroll, no border or fill — text uses theme foreground. */
const NOTE_SUMMARY_SCROLL =
  'h-72 min-h-0 max-md:min-h-[11rem] max-md:h-[min(52vh,24rem)] overflow-y-auto custom-scrollbar p-3 max-md:p-4 text-sm max-md:text-base leading-relaxed rounded-lg';

const NOTE_TRANSCRIPT_SCROLL_CLASS = 'h-72 min-h-0 max-md:min-h-[11rem] max-md:h-[min(52vh,24rem)]';

const NOTES_PAGE_SIZE = 10;

/** When totalPages > 5, compress middle with ellipses; otherwise list every page. */
function getPaginationItems(totalPages: number, currentPage: number): (number | 'ellipsis')[] {
  if (totalPages <= 0) return [];
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const s = new Set<number>([1, totalPages, currentPage, currentPage - 1, currentPage + 1]);
  for (const p of [...s]) {
    if (p < 1 || p > totalPages) s.delete(p);
  }
  const sorted = [...s].sort((a, b) => a - b);
  const out: (number | 'ellipsis')[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (i > 0 && p - sorted[i - 1]! > 1) out.push('ellipsis');
    out.push(p);
  }
  return out;
}

const SummaryHistory: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const chatId = searchParams.get('chat_id');
  
  const { user, isAuthenticated, isLoading, getAccessToken } = useAuth();
  
  const [chatInfo, setChatInfo] = useState<ChatInfo | null>(null);
  const [chatLoading, setChatLoading] = useState(true);
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesTotalCount, setNotesTotalCount] = useState(0);
  const [notesPage, setNotesPage] = useState(1);
  const [notesLoading, setNotesLoading] = useState(true);
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);

  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteEditDraft, setNoteEditDraft] = useState('');
  const [savingNoteId, setSavingNoteId] = useState<string | null>(null);
  const [noteEditError, setNoteEditError] = useState<string | null>(null);
  const noteMenuRef = useRef<HTMLDivElement>(null);
  const [openNoteMenuId, setOpenNoteMenuId] = useState<string | null>(null);
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null);
  const [renameNoteDraft, setRenameNoteDraft] = useState('');
  const [deleteNoteTarget, setDeleteNoteTarget] = useState<Note | null>(null);
  const [isDeleteNoteOpen, setIsDeleteNoteOpen] = useState(false);
  const [deletingNote, setDeletingNote] = useState(false);
  const [deleteNoteError, setDeleteNoteError] = useState<string | null>(null);
  const [noteListActionError, setNoteListActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, isLoading, navigate]);

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

  // Fetch chat info from Graph API
  useEffect(() => {
    const fetchChatInfo = async () => {
      if (!chatId) {
        setChatInfo(null);
        setChatLoading(false);
        return;
      }
      if (!isAuthenticated) return;
      
      try {
        setChatLoading(true);
        const token = await getAccessToken();
        if (!token) return;

        const client = Client.init({
          authProvider: (done) => done(null, token),
        });

        const chat = await client.api(`/chats/${chatId}`)
          .select('topic,chatType')
          .expand('members')
          .get();

        const members = chat.members?.map((m: any) => ({
          displayName: m.displayName || 'Unknown',
          email: m.email || '',
        })) || [];

        setChatInfo({
          topic: chat.topic,
          chatType: chat.chatType,
          members,
        });
      } catch (error) {
        console.error('Error fetching chat info:', error);
      } finally {
        setChatLoading(false);
      }
    };

    fetchChatInfo();
  }, [chatId, isAuthenticated, getAccessToken]);

  const notesScopeKey = `${chatId ?? ''}|${user?.id ?? ''}`;
  const prevNotesScopeRef = useRef(notesScopeKey);

  useEffect(() => {
    setExpandedNoteId(null);
  }, [notesPage]);

  useEffect(() => {
    let cancelled = false;

    const loadNotes = async () => {
      try {
        setNotesLoading(true);

        let effectivePage = notesPage;
        if (prevNotesScopeRef.current !== notesScopeKey) {
          prevNotesScopeRef.current = notesScopeKey;
          effectivePage = 1;
          setNotesPage(1);
          setExpandedNoteId(null);
        }

        let query = supabase.from('note').select('*', { count: 'exact' });

        if (chatId) {
          query = query.eq('chat_id', chatId);
        } else {
          if (!user?.id) {
            if (!cancelled) {
              setNotes([]);
              setNotesTotalCount(0);
            }
            return;
          }
          query = query.eq('user_id', user.id);
        }

        const from = (effectivePage - 1) * NOTES_PAGE_SIZE;
        const to = from + NOTES_PAGE_SIZE - 1;

        const { data, error, count } = await query
          .order('created_at', { ascending: false })
          .range(from, to);

        if (cancelled) return;
        if (error) throw error;
        setNotes((data as Note[]) || []);
        setNotesTotalCount(typeof count === 'number' ? count : 0);
      } catch (error) {
        console.error('Error fetching notes:', error);
        if (!cancelled) {
          setNotes([]);
          setNotesTotalCount(0);
        }
      } finally {
        if (!cancelled) setNotesLoading(false);
      }
    };

    void loadNotes();
    return () => {
      cancelled = true;
    };
  }, [notesScopeKey, notesPage, chatId, user?.id]);

  const getChatDisplayName = (): string => {
    if (!chatInfo) return 'Loading...';
    if (chatInfo.topic) return chatInfo.topic;
    
    const otherMembers = chatInfo.members.filter(m => 
      m.email?.toLowerCase() !== user?.email?.toLowerCase()
    );
    
    if (otherMembers.length > 0) {
      return otherMembers.map(m => m.displayName).join(', ');
    }
    
    return chatInfo.chatType === 'oneOnOne' ? 'Direct Message' : 'Group Chat';
  };

  const formatDate = (dateString?: string): string => {
    if (!dateString) return 'Unknown date';
    const date = new Date(dateString);
    return date.toLocaleDateString([], { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getNoteDisplayTitle = (note: Note): string => {
    const n = note.name?.trim();
    if (n) return n;
    return 'Untitled note';
  };

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(notesTotalCount / NOTES_PAGE_SIZE)),
    [notesTotalCount]
  );

  const paginationItems = useMemo(
    () => getPaginationItems(totalPages, notesPage),
    [totalPages, notesPage]
  );

  const notesRangeStart = notesTotalCount === 0 ? 0 : (notesPage - 1) * NOTES_PAGE_SIZE + 1;
  const notesRangeEnd = Math.min(notesPage * NOTES_PAGE_SIZE, notesTotalCount);

  const handleStartNoteEdit = (note: Note) => {
    setEditingNoteId(note.id);
    setNoteEditDraft(note.summary_edit || note.summary || '');
    setNoteEditError(null);
  };

  const handleSaveNoteEdit = async (note: Note) => {
    if (!user?.id) return;
    setSavingNoteId(note.id);
    setNoteEditError(null);
    try {
      const { error } = await supabase
        .from('note')
        .update({ summary_edit: noteEditDraft })
        .eq('id', note.id)
        .eq('user_id', user.id);

      if (error) throw error;

      setNotes((prev) =>
        prev.map((n) => (n.id === note.id ? { ...n, summary_edit: noteEditDraft } : n))
      );
      setEditingNoteId(null);
    } catch (err: unknown) {
      setNoteEditError(err instanceof Error ? err.message : 'Failed to save note edit');
    } finally {
      setSavingNoteId(null);
    }
  };

  const handleStartRenameNote = (note: Note) => {
    setOpenNoteMenuId(null);
    setNoteListActionError(null);
    setRenamingNoteId(note.id);
    setRenameNoteDraft(note.name?.trim() || '');
  };

  const handleSaveRenameNote = async (noteId: string) => {
    if (!user?.id) return;
    const name = renameNoteDraft.trim();
    if (!name) {
      setNoteListActionError('Note name is required.');
      return;
    }
    try {
      setNoteListActionError(null);
      const { error } = await supabase
        .from('note')
        .update({ name })
        .eq('id', noteId)
        .eq('user_id', user.id);
      if (error) throw error;
      setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, name } : n)));
      setRenamingNoteId(null);
      setRenameNoteDraft('');
    } catch (err: unknown) {
      setNoteListActionError(err instanceof Error ? err.message : 'Failed to rename note');
    }
  };

  const handleOpenDeleteNote = (note: Note) => {
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
      setNoteListActionError(null);
      const { error: deleteError } = await supabase
        .from('note')
        .delete()
        .eq('id', deleteNoteTarget.id)
        .eq('user_id', user.id);
      if (deleteError) throw deleteError;

      const removedId = deleteNoteTarget.id;
      const newTotal = Math.max(0, notesTotalCount - 1);
      const maxPage = Math.max(1, Math.ceil(newTotal / NOTES_PAGE_SIZE));
      const onlyNoteOnPage = notes.length === 1;
      let nextPage = notesPage;
      if (notesPage > maxPage) nextPage = maxPage;
      else if (onlyNoteOnPage && notesPage > 1) nextPage = notesPage - 1;

      setNotesTotalCount(newTotal);
      if (nextPage !== notesPage) {
        setNotesPage(nextPage);
      } else {
        setNotes((prev) => prev.filter((n) => n.id !== removedId));
      }
      if (expandedNoteId === removedId) setExpandedNoteId(null);
      if (editingNoteId === removedId) setEditingNoteId(null);
      if (renamingNoteId === removedId) setRenamingNoteId(null);
      setIsDeleteNoteOpen(false);
      setDeleteNoteTarget(null);
    } catch (err: unknown) {
      setDeleteNoteError(err instanceof Error ? err.message : 'Failed to delete note');
    } finally {
      setDeletingNote(false);
    }
  };

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
    <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg)' }}>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 md:p-6">
        <div className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col gap-6">
          {/* Chat / scope header */}
          <div className="shrink-0">
            {chatId ? (
              chatLoading ? (
                <div className="flex items-center gap-2">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2" style={{ borderColor: 'var(--accent)' }}></div>
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Loading chat info...</span>
                </div>
              ) : (
                <h2 className="text-2xl font-semibold" style={{ color: 'var(--text)' }}>
                  {getChatDisplayName()}
                </h2>
              )
            ) : (
              <>
                <h2 className="text-2xl font-semibold" style={{ color: 'var(--text)' }}>
                  History
                </h2>
                <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                  Meeting notes you created across all chats
                </p>
              </>
            )}
          </div>

          {/* Notes List — flex-1 column; rows scroll, pagination pinned to bottom */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {notesLoading ? (
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <div className="card rounded-lg p-8 text-center">
                  <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-b-2" style={{ borderColor: 'var(--accent)' }} />
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    Loading notes...
                  </p>
                </div>
              </div>
            ) : notesTotalCount === 0 ? (
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <div className="card rounded-lg p-8 text-center">
                  <FileText className="mx-auto mb-4 h-12 w-12" style={{ color: 'var(--text-muted)' }} />
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {chatId ? 'No meeting notes found for this chat' : 'No meeting notes found for your account'}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="mb-2 shrink-0 space-y-1">
                  {noteListActionError ? (
                    <p className="text-xs" style={{ color: 'var(--error)' }}>
                      {noteListActionError}
                    </p>
                  ) : null}
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    Showing {notesRangeStart}–{notesRangeEnd} of {notesTotalCount}
                  </p>
                  {notes.length === 0 && !notesLoading ? (
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                      No notes on this page.
                    </p>
                  ) : null}
                </div>
                <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">
                  <div className="space-y-3">
                {notes.map(note => (
                  <div
                    key={note.id}
                    className="chat-item card rounded-lg overflow-visible transition-all"
                  >
                    <div
                      onClick={() => setExpandedNoteId(expandedNoteId === note.id ? null : note.id)}
                      className="grid cursor-pointer grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0 px-3 py-3 transition-all sm:px-4 sm:py-3.5"
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
                            title={getNoteDisplayTitle(note)}
                          >
                            {getNoteDisplayTitle(note)}
                          </p>
                        )}
                        <p
                          className="mt-0.5 truncate text-xs leading-snug"
                          style={{ color: 'var(--text-muted)' }}
                          title={
                            !chatId && note.chat_id
                              ? `Created by ${note.user_name} · Chat ${note.chat_id}`
                              : `Created by ${note.user_name}`
                          }
                        >
                          Created by {note.user_name}
                          {!chatId && note.chat_id ? (
                            <>
                              {' '}
                              · Chat:{' '}
                              <span className="tabular-nums">{note.chat_id}</span>
                            </>
                          ) : null}
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
                            aria-label={`Note actions for ${getNoteDisplayTitle(note)}`}
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
                    
                    <div className={`collapse-container ${expandedNoteId === note.id ? 'expanded' : 'collapsed'}`}>
                      <div className="collapse-content">
                        <div 
                          className="p-4 border-t"
                          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-secondary)' }}
                        >
                          <div className="mb-2 flex items-center justify-between gap-3">
                            <h4 className="text-sm font-semibold shrink-0" style={{ color: 'var(--text)' }}>
                              Summary
                            </h4>
                            <div className="flex shrink-0 items-center gap-2">
                              {editingNoteId === note.id ? (
                                <button
                                  type="button"
                                  onClick={() => void handleSaveNoteEdit(note)}
                                  disabled={savingNoteId === note.id}
                                  className="flex items-center gap-1 px-3 py-1 rounded-md text-xs font-medium transition-all disabled:opacity-50"
                                  style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                                >
                                  {savingNoteId === note.id ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <Save className="w-3 h-3" />
                                  )}
                                  Done
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => handleStartNoteEdit(note)}
                                  className="flex items-center gap-1 px-3 py-1 rounded-md text-xs font-medium transition-all"
                                  style={{ backgroundColor: 'var(--bg)', color: 'var(--text-secondary)' }}
                                >
                                  <Pencil className="w-3 h-3" />
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
                            <p className="text-xs mt-2" style={{ color: 'var(--error)' }}>
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
                                <h4 className="text-sm font-semibold mb-2" style={{ color: 'var(--text)' }}>
                                  Transcription
                                </h4>
                                {showDiarized ? (
                                  <TranscriptDiarizedEditor
                                    segments={normalizeTranscript(diarRaw)}
                                    onSegmentsChange={(next) =>
                                      setNotes((prev) =>
                                        prev.map((n) =>
                                          n.id === note.id
                                            ? { ...n, diarization: next }
                                            : n
                                        )
                                      )
                                    }
                                    noteId={note.id}
                                    onSummaryEditChange={(nextSummary) =>
                                      setNotes((prev) =>
                                        prev.map((n) =>
                                          n.id === note.id ? { ...n, summary_edit: nextSummary } : n
                                        )
                                      )
                                    }
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
                </div>
                {totalPages > 1 ? (
                  <nav
                    className="mt-3 flex shrink-0 flex-col items-stretch gap-3 border-t pt-3 sm:flex-row sm:items-center sm:justify-between"
                    style={{ borderColor: 'var(--border)' }}
                    aria-label="Meeting notes pages"
                  >
                    <div className="flex items-center justify-center gap-2">
                      <button
                        type="button"
                        onClick={() => setNotesPage((p) => Math.max(1, p - 1))}
                        disabled={notesPage <= 1 || notesLoading}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border text-sm transition-opacity disabled:opacity-40"
                        style={{
                          borderColor: 'var(--border)',
                          backgroundColor: 'var(--bg-secondary)',
                          color: 'var(--text-secondary)',
                        }}
                        aria-label="Previous page"
                      >
                        <ChevronLeft className="h-4 w-4" aria-hidden />
                      </button>
                      <div className="flex flex-wrap items-center justify-center gap-1">
                        {paginationItems.map((item, idx) =>
                          item === 'ellipsis' ? (
                            <span
                              key={`e-${idx}`}
                              className="px-1 text-sm font-medium"
                              style={{ color: 'var(--text-muted)' }}
                              aria-hidden
                            >
                              …
                            </span>
                          ) : (
                            <button
                              key={item}
                              type="button"
                              onClick={() => setNotesPage(item)}
                              disabled={notesLoading}
                              className="min-w-[2.25rem] rounded-lg px-2 py-1.5 text-sm font-medium transition-opacity disabled:opacity-40"
                              style={
                                notesPage === item
                                  ? { backgroundColor: 'var(--accent)', color: '#fff' }
                                  : {
                                      backgroundColor: 'var(--bg-secondary)',
                                      color: 'var(--text-secondary)',
                                    }
                              }
                              aria-label={`Page ${item}`}
                              aria-current={notesPage === item ? 'page' : undefined}
                            >
                              {item}
                            </button>
                          )
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setNotesPage((p) => Math.min(totalPages, p + 1))}
                        disabled={notesPage >= totalPages || notesLoading}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border text-sm transition-opacity disabled:opacity-40"
                        style={{
                          borderColor: 'var(--border)',
                          backgroundColor: 'var(--bg-secondary)',
                          color: 'var(--text-secondary)',
                        }}
                        aria-label="Next page"
                      >
                        <ChevronRight className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                    <p className="text-center text-xs sm:text-right" style={{ color: 'var(--text-muted)' }}>
                      Page {notesPage} of {totalPages}
                    </p>
                  </nav>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </main>

      {isDeleteNoteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          onClick={() => {
            if (!deletingNote) {
              setIsDeleteNoteOpen(false);
              setDeleteNoteTarget(null);
            }
          }}
        >
          <div
            className="w-full max-w-sm rounded-lg border p-4 sm:p-5"
            style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
              Delete note?
            </h3>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              This will permanently delete{' '}
              <span className="font-medium" style={{ color: 'var(--text)' }}>
                {deleteNoteTarget?.name?.trim() || 'Untitled note'}
              </span>
              .
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

export default SummaryHistory;

