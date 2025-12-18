import React, { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../theme/ThemeProvider';
import { supabase } from '../config/supabaseConfig';
import { LogOut, ArrowLeft, FileText, Calendar, ChevronDown, ChevronUp, Sun, Moon, Download, Trash2, Pencil, Save, Loader2, Plus, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Client } from '@microsoft/microsoft-graph-client';

interface Note {
  id: string;
  user_id: string;
  user_name: string;
  chat_id: string;
  summary?: string;
  transcription?: string;
  audio_file?: string | null;
  name?: string | null;
  tags?: string[];
  created_at?: string;
}

interface ChatInfo {
  topic: string | null;
  chatType: string;
  members: { displayName: string; email: string }[];
}

const SummaryHistory: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const chatId = searchParams.get('chat_id');
  const userId = searchParams.get('user_id');
  
  const { theme, toggleTheme } = useTheme();
  const { user, isAuthenticated, isLoading, logout, getAccessToken } = useAuth();
  
  const [chatInfo, setChatInfo] = useState<ChatInfo | null>(null);
  const [chatLoading, setChatLoading] = useState(true);
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesLoading, setNotesLoading] = useState(true);
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
  const [deleteNoteId, setDeleteNoteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>('');
  const [isSavingName, setIsSavingName] = useState(false);
  const [openDownloadMenuId, setOpenDownloadMenuId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; right: number } | null>(null);
  const downloadButtonRefs = useRef<{ [key: string]: HTMLButtonElement | null }>({});
  const [editingSummaryId, setEditingSummaryId] = useState<string | null>(null);
  const [editedSummary, setEditedSummary] = useState<string>('');
  const [isSavingSummary, setIsSavingSummary] = useState(false);
  const [editingTagsNoteId, setEditingTagsNoteId] = useState<string | null>(null);
  const [editingTags, setEditingTags] = useState<string[]>([]);
  const [newTagValue, setNewTagValue] = useState<string>('');
  const [isSavingTags, setIsSavingTags] = useState(false);
  
  // Mode: 'chat' for chat-specific notes, 'user' for all user notes
  const mode = userId ? 'user' : 'chat';

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, isLoading, navigate]);

  // Close download menu when clicking outside and calculate menu position
  useEffect(() => {
    const handleClickOutside = () => {
      setOpenDownloadMenuId(null);
      setMenuPosition(null);
    };
    
    if (openDownloadMenuId) {
      const button = downloadButtonRefs.current[openDownloadMenuId];
      if (button) {
        const rect = button.getBoundingClientRect();
        setMenuPosition({
          top: rect.bottom + 4,
          right: window.innerWidth - rect.right,
        });
      }
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    } else {
      setMenuPosition(null);
    }
  }, [openDownloadMenuId]);

  // Fetch chat info from Graph API (only in chat mode)
  useEffect(() => {
    const fetchChatInfo = async () => {
      if (mode === 'user') {
        setChatLoading(false);
        return;
      }
      if (!chatId || !isAuthenticated) return;
      
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
  }, [chatId, isAuthenticated, getAccessToken, mode]);

  // Fetch notes from Supabase
  useEffect(() => {
    const fetchNotes = async () => {
      if (mode === 'user' && !userId) return;
      if (mode === 'chat' && !chatId) return;
      
      try {
        setNotesLoading(true);
        let query = supabase.from('note').select('*');
        
        if (mode === 'user') {
          query = query.eq('user_id', userId);
        } else {
          query = query.eq('chat_id', chatId);
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
  }, [chatId, userId, mode]);

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

  const downloadFile = (content: string | Blob, fileName: string, mimeType?: string) => {
    let blob: Blob;
    if (content instanceof Blob) {
      blob = content;
    } else {
      blob = new Blob([content], { type: mimeType || 'text/plain' });
    }
    
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };

  const handleDownloadSummary = (note: Note) => {
    if (!note.summary) return;
    const fileName = note.name ? `${note.name}_summary.md` : `summary_${note.id}.md`;
    downloadFile(note.summary, fileName, 'text/markdown');
    setOpenDownloadMenuId(null);
  };

  const handleDownloadTranscript = (note: Note) => {
    if (!note.transcription) return;
    const fileName = note.name ? `${note.name}_transcript.md` : `transcript_${note.id}.md`;
    downloadFile(note.transcription, fileName, 'text/markdown');
    setOpenDownloadMenuId(null);
  };

  const handleDownloadAudio = async (note: Note) => {
    if (!note.audio_file) return;
    
    try {
      const response = await fetch(note.audio_file);
      if (!response.ok) throw new Error('Failed to download audio file');
      
      const blob = await response.blob();
      const urlParts = note.audio_file.split('/');
      const originalFileName = urlParts[urlParts.length - 1] || `audio_${note.id}`;
      const extension = originalFileName.split('.').pop() || '';
      const fileName = note.name ? `${note.name}_audio.${extension}` : originalFileName;
      
      downloadFile(blob, fileName);
      setOpenDownloadMenuId(null);
    } catch (error) {
      console.error('Error downloading audio:', error);
      alert('Failed to download audio file');
    }
  };

  const handleDeleteNote = async () => {
    if (!deleteNoteId) return;
    
    try {
      setIsDeleting(true);
      const { error } = await supabase
        .from('note')
        .delete()
        .eq('id', deleteNoteId);
      
      if (error) throw error;
      
      // Remove note from local state
      setNotes(prev => prev.filter(note => note.id !== deleteNoteId));
      setDeleteNoteId(null);
    } catch (error) {
      console.error('Error deleting note:', error);
      alert('Failed to delete note');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleStartEditName = (note: Note, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingNoteId(note.id);
    setEditingName(note.name || '');
  };

  const handleSaveName = async (noteId: string) => {
    if (!editingName.trim()) {
      // If empty, don't save and revert
      setEditingNoteId(null);
      return;
    }

    try {
      setIsSavingName(true);
      const { error } = await supabase
        .from('note')
        .update({ name: editingName.trim() })
        .eq('id', noteId);
      
      if (error) throw error;
      
      // Update local state
      setNotes(prev => prev.map(note => 
        note.id === noteId ? { ...note, name: editingName.trim() } : note
      ));
      
      setEditingNoteId(null);
    } catch (error) {
      console.error('Error updating note name:', error);
      alert('Failed to update note name');
    } finally {
      setIsSavingName(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingNoteId(null);
    setEditingName('');
  };

  const handleNameKeyDown = (e: React.KeyboardEvent, noteId: string) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveName(noteId);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelEdit();
    }
  };

  const handleStartEditSummary = (note: Note) => {
    setEditingSummaryId(note.id);
    setEditedSummary(note.summary || '');
  };

  const handleSaveSummary = async (noteId: string) => {
    try {
      setIsSavingSummary(true);
      const { error } = await supabase
        .from('note')
        .update({ summary: editedSummary.trim() })
        .eq('id', noteId);
      
      if (error) throw error;
      
      // Update local state
      setNotes(prev => prev.map(note => 
        note.id === noteId ? { ...note, summary: editedSummary.trim() } : note
      ));
      
      setEditingSummaryId(null);
    } catch (error) {
      console.error('Error updating summary:', error);
      alert('Failed to update summary');
    } finally {
      setIsSavingSummary(false);
    }
  };

  const handleCancelEditSummary = () => {
    setEditingSummaryId(null);
    setEditedSummary('');
  };

  const handleStartEditTags = (note: Note) => {
    setEditingTagsNoteId(note.id);
    setEditingTags(note.tags ? [...note.tags] : []);
    setNewTagValue('');
  };

  const handleAddTag = () => {
    const trimmed = newTagValue.trim();
    if (trimmed && !editingTags.includes(trimmed)) {
      setEditingTags([...editingTags, trimmed]);
      setNewTagValue('');
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setEditingTags(editingTags.filter(tag => tag !== tagToRemove));
  };

  const handleSaveTags = async (noteId: string) => {
    try {
      setIsSavingTags(true);
      const { error } = await supabase
        .from('note')
        .update({ tags: editingTags })
        .eq('id', noteId);
      
      if (error) throw error;
      
      // Update local state
      setNotes(prev => prev.map(note => 
        note.id === noteId ? { ...note, tags: editingTags } : note
      ));
      
      setEditingTagsNoteId(null);
      setEditingTags([]);
      setNewTagValue('');
    } catch (error) {
      console.error('Error updating tags:', error);
      alert('Failed to update tags');
    } finally {
      setIsSavingTags(false);
    }
  };

  const handleCancelEditTags = () => {
    setEditingTagsNoteId(null);
    setEditingTags([]);
    setNewTagValue('');
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--bg)' }}>
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 mx-auto mb-4" style={{ borderColor: 'var(--accent)' }}></div>
          <p style={{ color: 'var(--text-secondary)' }}>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg)' }}>
      {/* Header */}
      <header className="border-b px-6 py-4" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--card)' }}>
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate('/transcription-summary')}
              className="p-2 rounded-md transition-all"
              style={{ backgroundColor: 'var(--bg-secondary)' }}
            >
              <ArrowLeft className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
            </button>
            <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>
              {mode === 'user' ? 'My Notes' : 'Summary History'}
            </h1>
          </div>
          <div className="flex items-center gap-4">
            {user && (
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium" 
                  style={{ backgroundColor: 'var(--accent)', color: '#fff' }}>
                  {user.displayName.charAt(0).toUpperCase()}
                </div>
                <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{user.displayName}</span>
              </div>
            )}
            <button
              onClick={toggleTheme}
              className="p-2 rounded-md"
              style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
            >
              {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            </button>
            <button
              onClick={logout}
              className="p-2 rounded-md"
              style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-grow flex flex-col overflow-hidden p-6">
        <div className="max-w-7xl mx-auto flex flex-col" style={{ height: '100%' }}>
          {/* Notes List */}
          <div className="flex flex-col" style={{ height: '100%' }}>
            <h3 className="text-lg font-medium mb-4 flex-shrink-0" style={{ color: 'var(--text)' }}>
              Meeting Notes
              {mode === 'chat' && chatInfo && !chatLoading ? ` - ${getChatDisplayName()}` : ''}
              {mode === 'chat' && chatLoading ? ' - Loading...' : ''}
              {mode === 'user' && user ? ` - ${user.displayName}` : ''}
            </h3>

            <div className="overflow-y-auto custom-scrollbar" style={{ flex: '1 1 0', minHeight: 0 }}>
              {notesLoading ? (
                <div className="card rounded-lg p-8 text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 mx-auto mb-4" style={{ borderColor: 'var(--accent)' }}></div>
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Loading notes...</p>
                </div>
              ) : notes.length === 0 ? (
                <div className="card rounded-lg p-8 text-center">
                  <FileText className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--text-muted)' }} />
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {mode === 'user' ? 'No meeting notes found' : 'No meeting notes found for this chat'}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {notes.map(note => (
                  <div
                    key={note.id}
                    className="card rounded-lg overflow-hidden transition-all"
                  >
                    <div 
                      className="p-4 flex items-center gap-4 hover:bg-opacity-80 transition-all"
                      style={{ backgroundColor: expandedNoteId === note.id ? 'var(--bg-secondary)' : undefined }}
                    >
                      <div 
                        onClick={() => setExpandedNoteId(expandedNoteId === note.id ? null : note.id)}
                        className="w-10 h-10 rounded-lg flex items-center justify-center cursor-pointer" 
                        style={{ backgroundColor: 'var(--accent-light)' }}
                      >
                        <FileText className="w-5 h-5" style={{ color: 'var(--accent)' }} />
                      </div>
                      <div 
                        onClick={() => setExpandedNoteId(expandedNoteId === note.id ? null : note.id)}
                        className="flex-grow min-w-0 cursor-pointer"
                      >
                        {editingNoteId === note.id ? (
                          <div className="flex items-center gap-2 flex-1" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="text"
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              onBlur={() => handleSaveName(note.id)}
                              onKeyDown={(e) => handleNameKeyDown(e, note.id)}
                              disabled={isSavingName}
                              className="text-sm font-medium px-2 rounded"
                              style={{ 
                                backgroundColor: 'var(--bg-secondary)', 
                                color: 'var(--text)',
                                border: '2px solid var(--accent)',
                                width: '60%',
                                height: '20px',
                                lineHeight: '20px',
                                paddingTop: '0',
                                paddingBottom: '0'
                              }}
                              autoFocus
                            />
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            {note.name ? (
                              <>
                                <p 
                                  className="text-sm font-medium" 
                                  style={{ color: 'var(--text)' }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleStartEditName(note, e);
                                  }}
                                  title="Click to edit name"
                                >
                                  {note.name}
                                </p>
                                <button
                                  onClick={(e) => handleStartEditName(note, e)}
                                  className="p-1 rounded transition-all hover:bg-opacity-80"
                                  style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
                                  title="Edit name"
                                >
                                  <Pencil className="w-3 h-3" />
                                </button>
                              </>
                            ) : (
                              <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                                {note.id}
                              </p>
                            )}
                          </div>
                        )}
                        <div className="mt-1">
                          <div className="flex items-center gap-3">
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              Created by {note.user_name}
                            </p>
                            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                              <Calendar className="w-3 h-3" />
                              {formatDate(note.created_at)}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                            {note.tags && note.tags.length > 0 && (
                              <>
                                {note.tags.map((tag, index) => (
                                  <span
                                    key={index}
                                    className="text-xs px-2 py-0.5 rounded-full"
                                    style={{
                                      backgroundColor: 'var(--accent-light)',
                                      color: 'var(--accent)',
                                    }}
                                  >
                                    {tag}
                                  </span>
                                ))}
                              </>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStartEditTags(note);
                              }}
                              className="flex items-center justify-center w-6 h-6 rounded-full transition-all hover:bg-opacity-80"
                              style={{
                                backgroundColor: 'var(--bg-secondary)',
                                color: 'var(--text-secondary)',
                                border: '1px dashed var(--border)',
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.backgroundColor = 'var(--accent-light)';
                                e.currentTarget.style.color = 'var(--accent)';
                                e.currentTarget.style.borderColor = 'var(--accent)';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = 'var(--bg-secondary)';
                                e.currentTarget.style.color = 'var(--text-secondary)';
                                e.currentTarget.style.borderColor = 'var(--border)';
                              }}
                              title="Add or edit tags"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {(note.summary || note.transcription || note.audio_file) && (
                          <>
                            <button
                              ref={(el) => {
                                downloadButtonRefs.current[note.id] = el;
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenDownloadMenuId(openDownloadMenuId === note.id ? null : note.id);
                              }}
                              className="p-1.5 rounded-md transition-all hover:bg-opacity-80"
                              style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--accent)' }}
                              title="Download"
                            >
                              <Download className="w-4 h-4" />
                            </button>
                            
                            {openDownloadMenuId === note.id && menuPosition && (
                              <div 
                                className="fixed py-1 rounded-lg shadow-lg min-w-40"
                                style={{ 
                                  backgroundColor: 'var(--card)', 
                                  border: '1px solid var(--border)',
                                  zIndex: 9999,
                                  top: `${menuPosition.top}px`,
                                  right: `${menuPosition.right}px`
                                }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                {note.summary && (
                                  <button
                                    onClick={() => handleDownloadSummary(note)}
                                    className="w-full flex items-center gap-2 px-4 py-2 text-sm transition-all menu-item-hover text-left"
                                    style={{ color: 'var(--text)' }}
                                  >
                                    <FileText className="w-4 h-4" />
                                    Summary
                                  </button>
                                )}
                                {note.transcription && (
                                  <button
                                    onClick={() => handleDownloadTranscript(note)}
                                    className="w-full flex items-center gap-2 px-4 py-2 text-sm transition-all menu-item-hover text-left"
                                    style={{ color: 'var(--text)' }}
                                  >
                                    <FileText className="w-4 h-4" />
                                    Transcript
                                  </button>
                                )}
                                {note.audio_file && (
                                  <button
                                    onClick={() => handleDownloadAudio(note)}
                                    className="w-full flex items-center gap-2 px-4 py-2 text-sm transition-all menu-item-hover text-left"
                                    style={{ color: 'var(--text)' }}
                                  >
                                    <Download className="w-4 h-4" />
                                    Audio
                                  </button>
                                )}
                              </div>
                            )}
                          </>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteNoteId(note.id);
                          }}
                          className="p-1.5 rounded-md transition-all hover:bg-opacity-80"
                          style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--error)' }}
                          title="Delete note"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setExpandedNoteId(expandedNoteId === note.id ? null : note.id)}
                          className="p-1.5 rounded-md transition-all"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {expandedNoteId === note.id ? (
                            <ChevronUp className="w-5 h-5" />
                          ) : (
                            <ChevronDown className="w-5 h-5" />
                          )}
                        </button>
                      </div>
                    </div>
                    
                    <div className={`collapse-container ${expandedNoteId === note.id ? 'expanded' : 'collapsed'}`}>
                      <div className="collapse-content">
                        <div 
                          className="p-4 border-t"
                          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-secondary)' }}
                        >
                          {note.summary ? (
                            <div className="space-y-3">
                              <div className="flex justify-end">
                                {editingSummaryId === note.id ? (
                                  <button
                                    onClick={() => handleSaveSummary(note.id)}
                                    disabled={isSavingSummary}
                                    className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all disabled:opacity-50"
                                    style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                                  >
                                    {isSavingSummary ? (
                                      <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Saving...
                                      </>
                                    ) : (
                                      <>
                                        <Save className="w-4 h-4" />
                                        Save
                                      </>
                                    )}
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => handleStartEditSummary(note)}
                                    className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all"
                                    style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                                  >
                                    <Pencil className="w-4 h-4" />
                                    Edit
                                  </button>
                                )}
                              </div>
                              {editingSummaryId === note.id ? (
                                <textarea
                                  value={editedSummary}
                                  onChange={(e) => setEditedSummary(e.target.value)}
                                  className="w-full p-4 rounded-lg text-sm leading-relaxed min-h-48 max-h-96 resize-y custom-scrollbar"
                                  style={{ 
                                    backgroundColor: 'var(--card)', 
                                    color: 'var(--text)',
                                    border: '2px solid var(--accent)',
                                  }}
                                  placeholder="Edit your summary here... (Markdown supported)"
                                />
                              ) : (
                                <div className="prose prose-sm max-w-none">
                                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{note.summary}</ReactMarkdown>
                                </div>
                              )}
                            </div>
                          ) : (
                            <p className="text-sm italic" style={{ color: 'var(--text-muted)' }}>
                              No summary available
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Delete Confirmation Modal */}
      {deleteNoteId && (
        <div 
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          onClick={() => setDeleteNoteId(null)}
        >
          <div 
            className="card rounded-lg p-8 max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--text)' }}>
              Delete Meeting Note
            </h3>
            <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
              Are you sure you want to permanently delete this meeting note? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteNoteId(null)}
                disabled={isDeleting}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteNote}
                disabled={isDeleting}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
                style={{ backgroundColor: 'var(--error)', color: '#fff' }}
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tag Management Modal */}
      {editingTagsNoteId && (
        <div 
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          onClick={handleCancelEditTags}
        >
          <div 
            className="card rounded-lg p-6 max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text)' }}>
              Manage Tags
            </h3>
            
            {/* Current Tags */}
            <div className="mb-4">
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text)' }}>
                Tags
              </label>
              <div className="flex flex-wrap gap-2 min-h-[60px] p-3 rounded-lg" style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                {editingTags.length > 0 ? (
                  editingTags.map((tag, index) => (
                    <span
                      key={index}
                      className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full"
                      style={{
                        backgroundColor: 'var(--accent-light)',
                        color: 'var(--accent)',
                      }}
                    >
                      {tag}
                      <button
                        onClick={() => handleRemoveTag(tag)}
                        className="hover:opacity-70 transition-opacity"
                        title="Remove tag"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))
                ) : (
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>No tags</span>
                )}
              </div>
            </div>

            {/* Add New Tag */}
            <div className="mb-6">
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text)' }}>
                Add Tag
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newTagValue}
                  onChange={(e) => setNewTagValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddTag();
                    }
                  }}
                  placeholder="Enter tag name"
                  className="flex-1 px-3 py-2 rounded-lg text-sm"
                  style={{
                    backgroundColor: 'var(--bg-secondary)',
                    color: 'var(--text)',
                    border: '1px solid var(--border)',
                  }}
                />
                <button
                  onClick={handleAddTag}
                  disabled={!newTagValue.trim()}
                  className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    backgroundColor: 'var(--accent)',
                    color: '#fff',
                  }}
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3">
              <button
                onClick={handleCancelEditTags}
                disabled={isSavingTags}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleSaveTags(editingTagsNoteId)}
                disabled={isSavingTags}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
                style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
              >
                {isSavingTags ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                    Saving...
                  </>
                ) : (
                  'Save'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SummaryHistory;

