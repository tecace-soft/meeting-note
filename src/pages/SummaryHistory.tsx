import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../config/supabaseConfig';
import {
  FileText,
  Calendar,
  ChevronDown,
  ChevronUp,
  Folder,
  Plus,
  Trash2,
  Loader2,
  Pencil,
  Save,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Client } from '@microsoft/microsoft-graph-client';

interface Note {
  id: string;
  name?: string | null;
  user_id: string;
  user_name: string;
  chat_id?: string | null;
  projects?: Array<string | number> | null;
  summary?: string;
  summary_edit?: string | null;
  created_at?: string;
}

interface ChatInfo {
  topic: string | null;
  chatType: string;
  members: { displayName: string; email: string }[];
}

interface Project {
  id: string;
  name: string;
  user_id: string;
  notes?: string[] | null;
  created_at?: string;
}

const SummaryHistory: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const chatId = searchParams.get('chat_id');
  
  const { user, isAuthenticated, isLoading, getAccessToken } = useAuth();
  
  const [chatInfo, setChatInfo] = useState<ChatInfo | null>(null);
  const [chatLoading, setChatLoading] = useState(true);
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesLoading, setNotesLoading] = useState(true);
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [newProjectName, setNewProjectName] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [movingProjectId, setMovingProjectId] = useState<string | null>(null);
  const [targetProjectId, setTargetProjectId] = useState<string>('');
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [projectActionError, setProjectActionError] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteEditDraft, setNoteEditDraft] = useState('');
  const [savingNoteId, setSavingNoteId] = useState<string | null>(null);
  const [noteEditError, setNoteEditError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, isLoading, navigate]);

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

  // Fetch notes from Supabase (by chat when chat_id present, else all for signed-in user)
  useEffect(() => {
    const fetchNotes = async () => {
      try {
        setNotesLoading(true);
        let query = supabase.from('note').select('*');

        if (chatId) {
          query = query.eq('chat_id', chatId);
        } else {
          if (!user?.id) {
            setNotes([]);
            return;
          }
          query = query.eq('user_id', user.id);
        }

        const { data, error } = await query.order('created_at', { ascending: false });

        if (error) throw error;
        setNotes(data || []);
      } catch (error) {
        console.error('Error fetching notes:', error);
      } finally {
        setNotesLoading(false);
      }
    };

    fetchNotes();
  }, [chatId, user?.id]);

  useEffect(() => {
    if (isLoading || !isAuthenticated) return;

    if (!user?.id) {
      setProjects([]);
      setProjectsLoading(false);
      return;
    }

    const uid = user.id;
    let cancelled = false;

    const load = async () => {
      try {
        setProjectsLoading(true);
        setProjectActionError(null);
        const { data, error } = await supabase
          .from('project')
          .select('id, name, user_id, notes, created_at')
          .eq('user_id', uid)
          .order('name', { ascending: true });

        if (error) throw error;
        if (!cancelled) setProjects((data as Project[]) || []);
      } catch (err: unknown) {
        if (!cancelled) {
          console.error('Error fetching projects:', err);
          setProjectActionError(err instanceof Error ? err.message : 'Failed to load projects');
          setProjects([]);
        }
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [user?.id, isAuthenticated, isLoading]);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newProjectName.trim();
    if (!name || !user?.id) return;

    setCreatingProject(true);
    setProjectActionError(null);
    try {
      const { data, error } = await supabase
        .from('project')
        .insert({ name, user_id: user.id })
        .select('id, name, user_id, notes, created_at')
        .single();

      if (error) throw error;
      if (data) {
        setProjects((prev) => [...prev, data as Project].sort((a, b) => a.name.localeCompare(b.name)));
        setNewProjectName('');
      }
    } catch (err: unknown) {
      console.error('Error creating project:', err);
      setProjectActionError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setCreatingProject(false);
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    if (!user?.id) return;
    if (!window.confirm('Delete this project? Notes inside are not deleted, only the project record.')) return;

    setDeletingProjectId(projectId);
    setProjectActionError(null);
    try {
      const { error } = await supabase
        .from('project')
        .delete()
        .eq('id', projectId)
        .eq('user_id', user.id);

      if (error) throw error;
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
    } catch (err: unknown) {
      console.error('Error deleting project:', err);
      setProjectActionError(err instanceof Error ? err.message : 'Failed to delete project');
    } finally {
      setDeletingProjectId(null);
    }
  };

  const toggleNoteSelection = (noteId: string) => {
    setSelectedNoteIds((prev) =>
      prev.includes(noteId) ? prev.filter((id) => id !== noteId) : [...prev, noteId]
    );
  };

  const toggleSelectAllNotes = () => {
    setSelectedNoteIds((prev) => (prev.length === notes.length ? [] : notes.map((n) => n.id)));
  };

  const handleMoveSelectedNotesToProject = async (project: Project) => {
    if (!user?.id || selectedNoteIds.length === 0) return;

    const selected = [...selectedNoteIds];
    const selectedSet = new Set(selected);

    setMovingProjectId(project.id);
    setProjectActionError(null);

    try {
      const { data: selectedNotesData, error: notesFetchError } = await supabase
        .from('note')
        .select('id, projects')
        .in('id', selected)
        .eq('user_id', user.id);

      if (notesFetchError) throw notesFetchError;

      const targetProjectId = project.id as string | number;
      const updates = ((selectedNotesData as Note[]) || []).map((note) => {
        const existing = Array.isArray(note.projects) ? note.projects : [];
        const nextProjects = Array.from(
          new Set([...existing.map((p) => String(p)), String(targetProjectId)])
        ).map((p) => {
          const asNumber = Number(p);
          return Number.isNaN(asNumber) ? p : asNumber;
        });

        return supabase
          .from('note')
          .update({ projects: nextProjects })
          .eq('id', note.id)
          .eq('user_id', user.id);
      });

      const updateResults = await Promise.all(updates);
      const noteUpdateFailed = updateResults.find((r) => r.error);
      if (noteUpdateFailed?.error) throw noteUpdateFailed.error;

      const targetNotes = Array.from(new Set([...(project.notes || []), ...selected]));
      const { error: projectUpdateError } = await supabase
        .from('project')
        .update({ notes: targetNotes })
        .eq('id', project.id)
        .eq('user_id', user.id);

      if (projectUpdateError) throw projectUpdateError;

      setNotes((prev) =>
        prev.map((n) => {
          if (!selectedSet.has(n.id)) return n;
          const existing = Array.isArray(n.projects) ? n.projects : [];
          const merged = Array.from(
            new Set([...existing.map((p) => String(p)), String(targetProjectId)])
          ).map((p) => {
            const asNumber = Number(p);
            return Number.isNaN(asNumber) ? p : asNumber;
          });
          return { ...n, projects: merged };
        })
      );
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id === project.id) return { ...p, notes: targetNotes };
          return p;
        })
      );
      setSelectedNoteIds([]);
      setTargetProjectId('');
    } catch (err: unknown) {
      console.error('Error moving notes to project:', err);
      setProjectActionError(err instanceof Error ? err.message : 'Failed to move notes');
    } finally {
      setMovingProjectId(null);
    }
  };

  const handleMoveToSelectedProject = async () => {
    if (selectedNoteIds.length === 0) {
      setProjectActionError('Select at least one note to move.');
      return;
    }
    if (!targetProjectId) {
      setProjectActionError('Choose a project before clicking Move.');
      return;
    }
    const normalizedTargetId = targetProjectId.trim();
    let target = projects.find((p) => String(p.id).trim() === normalizedTargetId);

    // Fallback: if local state is stale, fetch the selected project directly.
    if (!target && user?.id) {
      const { data, error } = await supabase
        .from('project')
        .select('id, name, user_id, notes, created_at')
        .eq('id', normalizedTargetId)
        .eq('user_id', user.id)
        .single();

      if (error) {
        setProjectActionError(error.message || 'Selected project was not found. Please choose again.');
        return;
      }
      target = data as Project;
    }

    if (!target) {
      setProjectActionError('Selected project was not found. Please choose again.');
      return;
    }
    await handleMoveSelectedNotesToProject(target);
  };

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
      <main className="min-h-0 flex-1 overflow-y-auto custom-scrollbar p-6">
        <div className="max-w-7xl mx-auto space-y-6">
          {/* Chat / scope header */}
          <div>
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
                  All summaries
                </h2>
                <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                  Meeting notes you created across all chats
                </p>
              </>
            )}
          </div>

          {/* Projects (user-owned) */}
          {user?.id ? (
            <div className="card rounded-lg p-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
                <div>
                  <h3 className="text-lg font-medium" style={{ color: 'var(--text)' }}>
                    Projects
                  </h3>
                  <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                    Group your notes into projects
                  </p>
                </div>
                <form onSubmit={handleCreateProject} className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto sm:min-w-[280px]">
                  <input
                    type="text"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    placeholder="New project name"
                    maxLength={200}
                    className="flex-grow px-3 py-2 rounded-lg text-sm border"
                    style={{
                      backgroundColor: 'var(--bg)',
                      borderColor: 'var(--border)',
                      color: 'var(--text)',
                    }}
                    disabled={creatingProject}
                  />
                  <button
                    type="submit"
                    disabled={creatingProject || !newProjectName.trim()}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-opacity disabled:opacity-50"
                    style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                  >
                    {creatingProject ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Plus className="w-4 h-4" />
                    )}
                    Create
                  </button>
                </form>
              </div>

              {projectActionError ? (
                <p className="text-sm mb-3" style={{ color: 'var(--error)' }}>
                  {projectActionError}
                </p>
              ) : null}

              {projectsLoading ? (
                <div className="flex items-center gap-2 py-6 justify-center">
                  <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--accent)' }} />
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    Loading projects...
                  </span>
                </div>
              ) : projects.length === 0 ? (
                <p className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>
                  No projects yet. Create one above.
                </p>
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {projects.map((p) => (
                    <li
                      key={p.id}
                      onClick={() => navigate(`/project?id=${encodeURIComponent(p.id)}`)}
                      className="folder-item flex items-center gap-3 rounded-lg px-3 py-3 border cursor-pointer"
                      style={{ backgroundColor: 'var(--bg-secondary)' }}
                    >
                      <div
                        className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                        style={{ backgroundColor: 'var(--accent-light)' }}
                      >
                        <Folder className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                      </div>
                      <span className="text-sm font-medium truncate flex-grow min-w-0" style={{ color: 'var(--text)' }} title={p.name}>
                        {p.name}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteProject(p.id);
                        }}
                        disabled={deletingProjectId === p.id || movingProjectId !== null}
                        className="p-2 rounded-md flex-shrink-0 transition-opacity disabled:opacity-50"
                        style={{ backgroundColor: 'var(--bg)', color: 'var(--text-muted)' }}
                        title="Delete project"
                        aria-label={`Delete project ${p.name}`}
                      >
                        {deletingProjectId === p.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {/* Notes List */}
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
              <h3 className="text-lg font-medium" style={{ color: 'var(--text)' }}>
                Meeting Notes
              </h3>
              <div className="flex items-center gap-3">
                <label className="inline-flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={notes.length > 0 && selectedNoteIds.length === notes.length}
                    onChange={toggleSelectAllNotes}
                    className="w-4 h-4 rounded border appearance-none checked:appearance-auto"
                    style={{ borderColor: 'var(--border)', backgroundColor: 'transparent' }}
                  />
                  Select all
                </label>
                {selectedNoteIds.length > 0 ? (
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {selectedNoteIds.length} selected
                  </span>
                ) : null}
                <select
                  value={targetProjectId}
                  onChange={(e) => {
                    setTargetProjectId(e.target.value);
                    setProjectActionError(null);
                  }}
                  className="px-3 py-2 rounded-md text-sm border"
                  style={{
                    backgroundColor: 'var(--bg)',
                    borderColor: 'var(--border)',
                    color: 'var(--text)',
                  }}
                  disabled={projectsLoading || projects.length === 0 || movingProjectId !== null}
                >
                  <option value="">Move to project...</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleMoveToSelectedProject}
                  disabled={!targetProjectId || selectedNoteIds.length === 0 || movingProjectId !== null}
                  className="px-3 py-2 rounded-md text-sm font-medium transition-opacity disabled:opacity-50"
                  style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                >
                  {movingProjectId !== null ? 'Moving...' : 'Move'}
                </button>
              </div>
            </div>
            {projectActionError ? (
              <p className="text-sm mb-3" style={{ color: 'var(--error)' }}>
                {projectActionError}
              </p>
            ) : null}

            {notesLoading ? (
              <div className="card rounded-lg p-8 text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 mx-auto mb-4" style={{ borderColor: 'var(--accent)' }}></div>
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Loading notes...</p>
              </div>
            ) : notes.length === 0 ? (
              <div className="card rounded-lg p-8 text-center">
                <FileText className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--text-muted)' }} />
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  {chatId ? 'No meeting notes found for this chat' : 'No meeting notes found for your account'}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {notes.map(note => (
                  <div
                    key={note.id}
                    className="chat-item card rounded-lg overflow-hidden transition-all"
                  >
                    <div 
                      onClick={() => setExpandedNoteId(expandedNoteId === note.id ? null : note.id)}
                      className="p-4 flex items-center gap-4 cursor-pointer transition-all"
                      style={{ backgroundColor: expandedNoteId === note.id ? 'var(--bg-secondary)' : undefined }}

                    >
                      <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedNoteIds.includes(note.id)}
                          onChange={() => toggleNoteSelection(note.id)}
                          aria-label={`Select note ${getNoteDisplayTitle(note)}`}
                          className="w-4 h-4 rounded border appearance-none checked:appearance-auto"
                          style={{ borderColor: 'var(--border)', backgroundColor: 'transparent' }}
                        />
                      </div>
                      <div className="w-10 h-10 rounded-lg flex items-center justify-center" 
                        style={{ backgroundColor: 'var(--accent-light)' }}>
                        <FileText className="w-5 h-5" style={{ color: 'var(--accent)' }} />
                      </div>
                      <div className="flex-grow min-w-0">
                        <p className="text-sm font-medium truncate" style={{ color: 'var(--text)' }} title={getNoteDisplayTitle(note)}>
                          {getNoteDisplayTitle(note)}
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          Created by {note.user_name}
                          {!chatId && note.chat_id ? (
                            <span className="block truncate mt-0.5" title={note.chat_id}>
                              Chat: {note.chat_id}
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                          <Calendar className="w-3 h-3" />
                          {formatDate(note.created_at)}
                        </div>
                        {expandedNoteId === note.id ? (
                          <ChevronUp className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
                        ) : (
                          <ChevronDown className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
                        )}
                      </div>
                    </div>
                    
                    <div className={`collapse-container ${expandedNoteId === note.id ? 'expanded' : 'collapsed'}`}>
                      <div className="collapse-content">
                        <div 
                          className="p-4 border-t"
                          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-secondary)' }}
                        >
                          <div className="flex items-center justify-end gap-2 mb-3">
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

                          {editingNoteId === note.id ? (
                            <textarea
                              value={noteEditDraft}
                              onChange={(e) => setNoteEditDraft(e.target.value)}
                              className="w-full p-3 rounded-lg text-sm leading-relaxed max-h-96 min-h-40 custom-scrollbar resize-y"
                              style={{
                                backgroundColor: 'var(--bg)',
                                color: 'var(--text)',
                                border: '1px solid var(--border)',
                              }}
                            />
                          ) : note.summary_edit || note.summary ? (
                            <div className="prose prose-sm max-w-none">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {note.summary_edit || note.summary || ''}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <p className="text-sm italic" style={{ color: 'var(--text-muted)' }}>
                              No summary available
                            </p>
                          )}
                          {editingNoteId === note.id && noteEditError ? (
                            <p className="text-xs mt-2" style={{ color: 'var(--error)' }}>
                              {noteEditError}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};

export default SummaryHistory;

