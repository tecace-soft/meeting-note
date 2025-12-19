import React, { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../theme/ThemeProvider';
import { supabase } from '../config/supabaseConfig';
import { useMobile } from '../hooks/useMobile';
import { LogOut, ArrowLeft, FileText, Calendar, ChevronDown, ChevronUp, Sun, Moon, Download, Trash2, Pencil, Save, Loader2, Plus, X, Search, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Client } from '@microsoft/microsoft-graph-client';
import JSZip from 'jszip';

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
  const isMobile = useMobile();
  
  const [chatInfo, setChatInfo] = useState<ChatInfo | null>(null);
  const [chatLoading, setChatLoading] = useState(true);
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesLoading, setNotesLoading] = useState(true);
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
  const [deleteNoteId, setDeleteNoteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>('');
  const [isSavingName, setIsSavingName] = useState(false);
  const [openDownloadMenuId, setOpenDownloadMenuId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; right: number } | null>(null);
  const downloadButtonRefs = useRef<{ [key: string]: HTMLButtonElement | null }>({});
  const [showBulkDownloadMenu, setShowBulkDownloadMenu] = useState(false);
  const [bulkDownloadMenuPosition, setBulkDownloadMenuPosition] = useState<{ top: number; right: number } | null>(null);
  const bulkDownloadButtonRef = useRef<HTMLButtonElement | null>(null);
  const [isBulkDownloading, setIsBulkDownloading] = useState(false);
  const [editingSummaryId, setEditingSummaryId] = useState<string | null>(null);
  const [editedSummary, setEditedSummary] = useState<string>('');
  const [isSavingSummary, setIsSavingSummary] = useState(false);
  const [editingTagsNoteId, setEditingTagsNoteId] = useState<string | null>(null);
  const [editingTags, setEditingTags] = useState<string[]>([]);
  const [newTagValue, setNewTagValue] = useState<string>('');
  const [isSavingTags, setIsSavingTags] = useState(false);
  const tagContainerRefs = useRef<{ [key: string]: HTMLDivElement | null }>({});
  const [visibleTagCounts, setVisibleTagCounts] = useState<{ [key: string]: number }>({});
  const [searchKeyword, setSearchKeyword] = useState<string>('');
  const [sortField, setSortField] = useState<'name' | 'created_at' | 'user_name'>('created_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(new Set());
  
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

  // Close bulk download menu when clicking outside and calculate menu position
  useEffect(() => {
    const handleClickOutside = () => {
      setShowBulkDownloadMenu(false);
      setBulkDownloadMenuPosition(null);
    };
    
    if (showBulkDownloadMenu) {
      const button = bulkDownloadButtonRef.current;
      if (button) {
        const rect = button.getBoundingClientRect();
        setBulkDownloadMenuPosition({
          top: rect.bottom + 4,
          right: window.innerWidth - rect.right,
        });
      }
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    } else {
      setBulkDownloadMenuPosition(null);
    }
  }, [showBulkDownloadMenu]);

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

  // Calculate visible tag counts based on container width
  useEffect(() => {
    const calculateVisibleTags = () => {
      const newCounts: { [key: string]: number } = {};
      
      Object.keys(tagContainerRefs.current).forEach(noteId => {
        const container = tagContainerRefs.current[noteId];
        if (!container) return;
        
        const containerWidth = container.offsetWidth;
        const plusButtonWidth = 32; // Approximate width of + button with gap
        const ellipsisWidth = 40; // Approximate width of "..." tag
        const availableWidth = containerWidth - plusButtonWidth;
        
        const tags = notes.find(n => n.id === noteId)?.tags || [];
        if (tags.length === 0) return;
        
        // Create a temporary element to measure tag widths
        const tempSpan = document.createElement('span');
        tempSpan.className = 'text-xs px-2 py-0.5 rounded-full';
        tempSpan.style.visibility = 'hidden';
        tempSpan.style.position = 'absolute';
        tempSpan.style.whiteSpace = 'nowrap';
        document.body.appendChild(tempSpan);
        
        let totalWidth = 0;
        let visibleCount = 0;
        const gap = 6; // gap-1.5 = 6px
        
        for (let i = 0; i < tags.length; i++) {
          tempSpan.textContent = tags[i];
          const tagWidth = tempSpan.offsetWidth;
          
          const widthWithGap = totalWidth + (i > 0 ? gap : 0) + tagWidth;
          
          // Check if we need to show ellipsis
          if (i < tags.length - 1) {
            // If adding this tag plus ellipsis would exceed, show ellipsis instead
            if (widthWithGap + gap + ellipsisWidth > availableWidth) {
              break;
            }
          }
          
          if (widthWithGap <= availableWidth) {
            totalWidth = widthWithGap;
            visibleCount = i + 1;
          } else {
            break;
          }
        }
        
        document.body.removeChild(tempSpan);
        newCounts[noteId] = visibleCount;
      });
      
      setVisibleTagCounts(newCounts);
    };
    
    // Calculate after a short delay to ensure DOM is ready
    const timeoutId = setTimeout(calculateVisibleTags, 100);
    
    // Recalculate on window resize
    window.addEventListener('resize', calculateVisibleTags);
    
    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener('resize', calculateVisibleTags);
    };
  }, [notes]);

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

  const handleBulkDownloadSummaries = async () => {
    if (selectedNoteIds.size === 0) return;
    
    try {
      setIsBulkDownloading(true);
      const zip = new JSZip();
      const selectedNotes = notes.filter(note => selectedNoteIds.has(note.id) && note.summary);
      
      if (selectedNotes.length === 0) {
        alert('No summaries available for selected notes');
        setShowBulkDownloadMenu(false);
        return;
      }
      
      for (const note of selectedNotes) {
        if (note.summary) {
          const fileName = note.name ? `${note.name}_summary.md` : `summary_${note.id}.md`;
          zip.file(fileName, note.summary);
        }
      }
      
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadFile(blob, 'meeting_notes_summaries.zip', 'application/zip');
      setShowBulkDownloadMenu(false);
    } catch (error) {
      console.error('Error downloading summaries:', error);
      alert('Failed to download summaries');
    } finally {
      setIsBulkDownloading(false);
    }
  };

  const handleBulkDownloadTranscripts = async () => {
    if (selectedNoteIds.size === 0) return;
    
    try {
      setIsBulkDownloading(true);
      const zip = new JSZip();
      const selectedNotes = notes.filter(note => selectedNoteIds.has(note.id) && note.transcription);
      
      if (selectedNotes.length === 0) {
        alert('No transcripts available for selected notes');
        setShowBulkDownloadMenu(false);
        return;
      }
      
      for (const note of selectedNotes) {
        if (note.transcription) {
          const fileName = note.name ? `${note.name}_transcript.md` : `transcript_${note.id}.md`;
          zip.file(fileName, note.transcription);
        }
      }
      
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadFile(blob, 'meeting_notes_transcripts.zip', 'application/zip');
      setShowBulkDownloadMenu(false);
    } catch (error) {
      console.error('Error downloading transcripts:', error);
      alert('Failed to download transcripts');
    } finally {
      setIsBulkDownloading(false);
    }
  };

  const handleBulkDownloadAudio = async () => {
    if (selectedNoteIds.size === 0) return;
    
    try {
      setIsBulkDownloading(true);
      const zip = new JSZip();
      const selectedNotes = notes.filter(note => selectedNoteIds.has(note.id) && note.audio_file);
      
      if (selectedNotes.length === 0) {
        alert('No audio files available for selected notes');
        setShowBulkDownloadMenu(false);
        return;
      }
      
      for (const note of selectedNotes) {
        if (note.audio_file) {
          try {
            const response = await fetch(note.audio_file);
            if (!response.ok) throw new Error(`Failed to download audio for note ${note.id}`);
            
            const blob = await response.blob();
            const urlParts = note.audio_file.split('/');
            const originalFileName = urlParts[urlParts.length - 1] || `audio_${note.id}`;
            const extension = originalFileName.split('.').pop() || '';
            const fileName = note.name ? `${note.name}_audio.${extension}` : originalFileName;
            
            zip.file(fileName, blob);
          } catch (error) {
            console.error(`Error downloading audio for note ${note.id}:`, error);
          }
        }
      }
      
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadFile(blob, 'meeting_notes_audio.zip', 'application/zip');
      setShowBulkDownloadMenu(false);
    } catch (error) {
      console.error('Error downloading audio files:', error);
      alert('Failed to download audio files');
    } finally {
      setIsBulkDownloading(false);
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

  const handleBulkDeleteNotes = async () => {
    if (selectedNoteIds.size === 0) return;
    
    try {
      setIsBulkDeleting(true);
      const noteIdsArray = Array.from(selectedNoteIds);
      
      // Delete all selected notes
      const { error } = await supabase
        .from('note')
        .delete()
        .in('id', noteIdsArray);
      
      if (error) throw error;
      
      // Remove notes from local state
      setNotes(prev => prev.filter(note => !selectedNoteIds.has(note.id)));
      setSelectedNoteIds(new Set());
      setShowBulkDeleteModal(false);
    } catch (error) {
      console.error('Error deleting notes:', error);
      alert('Failed to delete notes');
    } finally {
      setIsBulkDeleting(false);
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

  // Filter and sort notes
  const filteredAndSortedNotes = React.useMemo(() => {
    let filtered = [...notes];

    // Apply search filter
    if (searchKeyword.trim()) {
      const keyword = searchKeyword.toLowerCase().trim();
      filtered = filtered.filter(note => {
        const nameMatch = note.name?.toLowerCase().includes(keyword) || false;
        const idMatch = note.id.toLowerCase().includes(keyword);
        const userMatch = note.user_name?.toLowerCase().includes(keyword) || false;
        const tagsMatch = note.tags?.some(tag => tag.toLowerCase().includes(keyword)) || false;
        
        return nameMatch || idMatch || userMatch || tagsMatch;
      });
    }

    // Apply sorting
    filtered.sort((a, b) => {
      let comparison = 0;
      
      switch (sortField) {
        case 'created_at':
          comparison = new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
          break;
        case 'name':
          comparison = (a.name || a.id).localeCompare(b.name || b.id);
          break;
        case 'user_name':
          comparison = (a.user_name || '').localeCompare(b.user_name || '');
          break;
        default:
          return 0;
      }
      
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return filtered;
  }, [notes, searchKeyword, sortField, sortDirection]);

  // Select all/deselect all handler
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedNoteIds(new Set(filteredAndSortedNotes.map(note => note.id)));
    } else {
      setSelectedNoteIds(new Set());
    }
  };

  // Toggle individual note selection
  const handleToggleNoteSelection = (noteId: string) => {
    setSelectedNoteIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(noteId)) {
        newSet.delete(noteId);
      } else {
        newSet.add(noteId);
      }
      return newSet;
    });
  };

  const allSelected = filteredAndSortedNotes.length > 0 && filteredAndSortedNotes.every(note => selectedNoteIds.has(note.id));
  const someSelected = filteredAndSortedNotes.some(note => selectedNoteIds.has(note.id)) && !allSelected;

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
      <header className="border-b px-6 py-4 flex-shrink-0" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--card)', width: '100%' }}>
        <div className={`${isMobile ? 'w-full' : 'max-w-7xl'} mx-auto flex items-center justify-between`} style={{ width: '100%', minWidth: 0 }}>
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
            {user && !isMobile && (
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
      <main 
        className="flex-grow flex flex-col overflow-hidden" 
        style={{ 
          padding: isMobile ? '16px' : '24px',
          paddingBottom: isMobile 
            ? 'calc(80px + env(safe-area-inset-bottom, 0px))' 
            : 'calc(24px + env(safe-area-inset-bottom, 0px))',
          width: '100%',
          minWidth: 0
        }}
      >
        <div className={`${isMobile ? 'w-full' : 'max-w-7xl'} mx-auto flex flex-col`} style={{ height: '100%', width: '100%', minWidth: 0, flexShrink: 0 }}>
          {/* Notes List */}
          <div className="flex flex-col flex-1 min-h-0" style={{ width: '100%', minWidth: 0 }}>
            <div className="flex-shrink-0" style={{ width: '100%', minWidth: 0, marginBottom: '16px' }}>
              <div className="flex items-center gap-4 mb-4">
                <h3 className="text-lg font-medium" style={{ color: 'var(--text)' }}>
                  Meeting Notes
                  {mode === 'chat' && chatInfo && !chatLoading ? ` - ${getChatDisplayName()}` : ''}
                  {mode === 'chat' && chatLoading ? ' - Loading...' : ''}
                  {mode === 'user' && user ? ` - ${user.displayName}` : ''}
                </h3>
              </div>
              
              {/* Search and Sort Controls */}
              {isMobile ? (
                <div className="flex flex-col gap-3" style={{ width: '100%' }}>
                  {/* Search Input */}
                  <div className="relative flex-1" style={{ minWidth: 0, width: '100%' }}>
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                    <input
                      type="text"
                      placeholder="Search by name, tags, ID, or user..."
                      value={searchKeyword}
                      onChange={(e) => setSearchKeyword(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 rounded-lg text-sm"
                      style={{
                        backgroundColor: 'var(--bg-secondary)',
                        color: 'var(--text)',
                        border: '1px solid var(--border)',
                      }}
                    />
                  </div>
                  
                  {/* Sort Controls */}
                  <div className="flex items-center gap-3 flex-shrink-0 w-full">
                    <label className="text-sm font-medium flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>
                      Sort:
                    </label>
                    <select
                      value={sortField}
                      onChange={(e) => setSortField(e.target.value as typeof sortField)}
                      className="px-3 py-2 rounded-lg text-sm flex-1"
                      style={{
                        backgroundColor: 'var(--bg-secondary)',
                        color: 'var(--text)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <option value="created_at">Date</option>
                      <option value="name">Name</option>
                      <option value="user_name">Creator</option>
                    </select>
                    <button
                      onClick={() => setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')}
                      className="p-2 rounded-lg transition-all flex-shrink-0"
                      style={{
                        color: 'var(--text-secondary)',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = 'var(--bg-secondary)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                      title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
                    >
                      {sortDirection === 'asc' ? (
                        <ArrowUp className="w-4 h-4" />
                      ) : (
                        <ArrowDown className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                  
                  {/* Action Buttons Row with Checkbox */}
                  <div className="flex items-center gap-3 w-full">
                    {/* Select All Checkbox */}
                    <div className="flex items-center flex-shrink-0" style={{ paddingLeft: '15px' }}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(input) => {
                          if (input) input.indeterminate = someSelected;
                        }}
                        onChange={(e) => handleSelectAll(e.target.checked)}
                        className="w-5 h-5 rounded cursor-pointer"
                        style={{
                          accentColor: 'var(--accent)',
                        }}
                        title={allSelected ? 'Deselect all' : 'Select all'}
                      />
                    </div>
                    
                    {/* Bulk Download Button */}
                    <button
                      ref={bulkDownloadButtonRef}
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowBulkDownloadMenu(!showBulkDownloadMenu);
                      }}
                      disabled={selectedNoteIds.size === 0 || isBulkDownloading}
                      className="py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{
                        backgroundColor: selectedNoteIds.size > 0 ? 'var(--accent)' : 'var(--bg-secondary)',
                        color: selectedNoteIds.size > 0 ? '#fff' : 'var(--text-muted)',
                        justifyContent: 'center',
                        paddingLeft: selectedNoteIds.size > 0 ? '12px' : '16px',
                        paddingRight: selectedNoteIds.size > 0 ? '12px' : '16px',
                      }}
                      title={selectedNoteIds.size > 0 ? `Download ${selectedNoteIds.size} selected note(s)` : 'Select notes to download'}
                    >
                      <Download className="w-4 h-4" />
                      {selectedNoteIds.size > 0 && (
                        <span>{selectedNoteIds.size}</span>
                      )}
                    </button>
                    
                    {/* Bulk Delete Button */}
                    <button
                      onClick={() => setShowBulkDeleteModal(true)}
                      disabled={selectedNoteIds.size === 0}
                      className="py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{
                        backgroundColor: selectedNoteIds.size > 0 ? 'var(--error)' : 'var(--bg-secondary)',
                        color: selectedNoteIds.size > 0 ? '#fff' : 'var(--text-muted)',
                        justifyContent: 'center',
                        paddingLeft: selectedNoteIds.size > 0 ? '12px' : '16px',
                        paddingRight: selectedNoteIds.size > 0 ? '12px' : '16px',
                      }}
                      title={selectedNoteIds.size > 0 ? `Delete ${selectedNoteIds.size} selected note(s)` : 'Select notes to delete'}
                    >
                      <Trash2 className="w-4 h-4" />
                      {selectedNoteIds.size > 0 && (
                        <span>{selectedNoteIds.size}</span>
                      )}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-4" style={{ width: '100%' }}>
                  {/* Select All Checkbox */}
                  <div className="flex items-center flex-shrink-0" style={{ paddingLeft: '15px' }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(input) => {
                        if (input) input.indeterminate = someSelected;
                      }}
                      onChange={(e) => handleSelectAll(e.target.checked)}
                      className="w-5 h-5 rounded cursor-pointer"
                      style={{
                        accentColor: 'var(--accent)',
                      }}
                      title={allSelected ? 'Deselect all' : 'Select all'}
                    />
                  </div>
                  
                  {/* Search Input */}
                  <div className="relative flex-1" style={{ minWidth: 0 }}>
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                    <input
                      type="text"
                      placeholder="Search by name, tags, ID, or user..."
                      value={searchKeyword}
                      onChange={(e) => setSearchKeyword(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 rounded-lg text-sm"
                      style={{
                        backgroundColor: 'var(--bg-secondary)',
                        color: 'var(--text)',
                        border: '1px solid var(--border)',
                      }}
                    />
                  </div>
                  
                  {/* Sort Controls */}
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                      Sort:
                    </label>
                    <select
                      value={sortField}
                      onChange={(e) => setSortField(e.target.value as typeof sortField)}
                      className="px-3 py-2 rounded-lg text-sm"
                      style={{
                        backgroundColor: 'var(--bg-secondary)',
                        color: 'var(--text)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <option value="created_at">Date</option>
                      <option value="name">Name</option>
                      <option value="user_name">Creator</option>
                    </select>
                    <button
                      onClick={() => setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')}
                      className="p-2 rounded-lg transition-all flex-shrink-0"
                      style={{
                        color: 'var(--text-secondary)',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = 'var(--bg-secondary)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                      title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
                    >
                      {sortDirection === 'asc' ? (
                        <ArrowUp className="w-4 h-4" />
                      ) : (
                        <ArrowDown className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                  
                  {/* Bulk Download Button */}
                  <button
                    ref={bulkDownloadButtonRef}
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowBulkDownloadMenu(!showBulkDownloadMenu);
                    }}
                    disabled={selectedNoteIds.size === 0 || isBulkDownloading}
                    className="py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      backgroundColor: selectedNoteIds.size > 0 ? 'var(--accent)' : 'var(--bg-secondary)',
                      color: selectedNoteIds.size > 0 ? '#fff' : 'var(--text-muted)',
                      minWidth: '80px',
                      justifyContent: 'center',
                      paddingLeft: selectedNoteIds.size > 0 ? '12px' : '16px',
                      paddingRight: selectedNoteIds.size > 0 ? '12px' : '16px',
                    }}
                    title={selectedNoteIds.size > 0 ? `Download ${selectedNoteIds.size} selected note(s)` : 'Select notes to download'}
                  >
                    <Download className="w-4 h-4" />
                    {selectedNoteIds.size > 0 && (
                      <span>{selectedNoteIds.size}</span>
                    )}
                  </button>
                  
                  {/* Bulk Delete Button */}
                  <button
                    onClick={() => setShowBulkDeleteModal(true)}
                    disabled={selectedNoteIds.size === 0}
                    className="py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      backgroundColor: selectedNoteIds.size > 0 ? 'var(--error)' : 'var(--bg-secondary)',
                      color: selectedNoteIds.size > 0 ? '#fff' : 'var(--text-muted)',
                      minWidth: '80px',
                      justifyContent: 'center',
                      paddingLeft: selectedNoteIds.size > 0 ? '12px' : '16px',
                      paddingRight: selectedNoteIds.size > 0 ? '12px' : '16px',
                      marginRight: '15px',
                    }}
                    title={selectedNoteIds.size > 0 ? `Delete ${selectedNoteIds.size} selected note(s)` : 'Select notes to delete'}
                  >
                    <Trash2 className="w-4 h-4" />
                    {selectedNoteIds.size > 0 && (
                      <span>{selectedNoteIds.size}</span>
                    )}
                  </button>
                </div>
              )}
            </div>
            
            {/* Bulk Download Menu */}
            {showBulkDownloadMenu && bulkDownloadMenuPosition && (
              <div 
                className="fixed py-1 rounded-lg shadow-lg min-w-40 z-50"
                style={{ 
                  backgroundColor: 'var(--card)', 
                  border: '1px solid var(--border)',
                  top: `${bulkDownloadMenuPosition.top}px`,
                  right: `${bulkDownloadMenuPosition.right}px`,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {notes.filter(note => selectedNoteIds.has(note.id) && note.summary).length > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleBulkDownloadSummaries();
                    }}
                    disabled={isBulkDownloading}
                    className="w-full flex items-center gap-2 px-4 py-2 text-sm transition-all menu-item-hover text-left disabled:opacity-50"
                    style={{ color: 'var(--text)' }}
                  >
                    <FileText className="w-4 h-4" />
                    Summary
                  </button>
                )}
                {notes.filter(note => selectedNoteIds.has(note.id) && note.transcription).length > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleBulkDownloadTranscripts();
                    }}
                    disabled={isBulkDownloading}
                    className="w-full flex items-center gap-2 px-4 py-2 text-sm transition-all menu-item-hover text-left disabled:opacity-50"
                    style={{ color: 'var(--text)' }}
                  >
                    <FileText className="w-4 h-4" />
                    Transcript
                  </button>
                )}
                {notes.filter(note => selectedNoteIds.has(note.id) && note.audio_file).length > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleBulkDownloadAudio();
                    }}
                    disabled={isBulkDownloading}
                    className="w-full flex items-center gap-2 px-4 py-2 text-sm transition-all menu-item-hover text-left disabled:opacity-50"
                    style={{ color: 'var(--text)' }}
                  >
                    <Download className="w-4 h-4" />
                    Audio
                  </button>
                )}
              </div>
            )}

            <div className="overflow-y-auto custom-scrollbar flex-1 min-h-0" style={{ width: '100%', minWidth: 0 }}>
              {notesLoading ? (
                <div className="card rounded-lg p-8 text-center" style={{ width: '100%' }}>
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 mx-auto mb-4" style={{ borderColor: 'var(--accent)' }}></div>
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Loading notes...</p>
                </div>
              ) : filteredAndSortedNotes.length === 0 ? (
                <div className="space-y-3" style={{ width: '100%' }}>
                  <div className="card rounded-lg p-8 text-center" style={{ width: '100%' }}>
                    <FileText className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--text-muted)' }} />
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                      {searchKeyword.trim() 
                        ? 'No notes match your search' 
                        : mode === 'user' 
                          ? 'No meeting notes found' 
                          : 'No meeting notes found for this chat'}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3" style={{ width: '100%' }}>
                  {filteredAndSortedNotes.map(note => (
                  <div
                    key={note.id}
                    className="card rounded-lg overflow-hidden transition-all"
                    style={{ border: '1px solid var(--border)' }}
                  >
                    <div 
                      className={`p-4 flex ${isMobile ? 'flex-col gap-3' : 'items-center gap-4'} hover:bg-opacity-80 transition-all cursor-pointer`}
                      style={{ backgroundColor: expandedNoteId === note.id ? 'var(--bg-secondary)' : undefined }}
                      onClick={() => setExpandedNoteId(expandedNoteId === note.id ? null : note.id)}
                      onMouseEnter={(e) => {
                        const card = e.currentTarget.closest('.card') as HTMLElement;
                        if (card) {
                          card.style.borderColor = 'var(--accent)';
                        }
                        const chevronButton = e.currentTarget.querySelector('[data-chevron-button]') as HTMLElement;
                        if (chevronButton) {
                          chevronButton.style.color = 'var(--accent)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        const card = e.currentTarget.closest('.card') as HTMLElement;
                        if (card) {
                          card.style.borderColor = 'var(--border)';
                        }
                        const chevronButton = e.currentTarget.querySelector('[data-chevron-button]') as HTMLElement;
                        if (chevronButton) {
                          chevronButton.style.color = 'var(--text-muted)';
                        }
                      }}
                    >
                      <div className={`flex ${isMobile ? 'w-full gap-3 items-center' : 'items-center gap-4 flex-grow min-w-0'}`}>
                        <div className="flex items-center justify-center flex-shrink-0">
                          <input
                            type="checkbox"
                            checked={selectedNoteIds.has(note.id)}
                            onChange={(e) => {
                              e.stopPropagation();
                              handleToggleNoteSelection(note.id);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="w-5 h-5 rounded cursor-pointer"
                            style={{
                              accentColor: 'var(--accent)',
                            }}
                            title={selectedNoteIds.has(note.id) ? 'Deselect' : 'Select'}
                          />
                        </div>
                        <div 
                          className={`flex flex-col flex-grow min-w-0 ${isMobile ? 'gap-2' : ''}`}
                        >
                          <div>
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
                              <div className="flex items-center gap-2 min-w-0">
                                {note.name ? (
                                  <>
                                    <p 
                                      className="text-sm font-medium truncate" 
                                      style={{ 
                                        color: 'var(--text)',
                                        maxWidth: isMobile ? 'calc(100vw - 200px)' : 'none'
                                      }}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleStartEditName(note, e);
                                      }}
                                      title={note.name}
                                    >
                                      {note.name}
                                    </p>
                                    <button
                                      onClick={(e) => handleStartEditName(note, e)}
                                      className="p-1 rounded transition-all hover:bg-opacity-80 flex-shrink-0"
                                      style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
                                      title="Edit name"
                                    >
                                      <Pencil className="w-3 h-3" />
                                    </button>
                                  </>
                                ) : (
                                  <p className="text-sm font-medium truncate" style={{ color: 'var(--text)', maxWidth: isMobile ? 'calc(100vw - 200px)' : 'none' }}>
                                    {note.id}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              Created by {note.user_name}
                            </p>
                            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                              <Calendar className="w-3 h-3" />
                              {formatDate(note.created_at)}
                            </div>
                          </div>
                          <div 
                            ref={(el) => { tagContainerRefs.current[note.id] = el; }}
                            className="flex items-center gap-1.5 overflow-hidden"
                          >
                            {note.tags && note.tags.length > 0 && (
                              <>
                                {note.tags.slice(0, visibleTagCounts[note.id] || note.tags.length).map((tag, index) => (
                                  <span
                                    key={index}
                                    className="text-xs px-2 py-0.5 rounded-full flex-shrink-0"
                                    style={{
                                      backgroundColor: 'var(--accent-light)',
                                      color: 'var(--accent)',
                                    }}
                                  >
                                    {tag}
                                  </span>
                                ))}
                                {(visibleTagCounts[note.id] || note.tags.length) < note.tags.length && (
                                  <span
                                    className="text-xs px-2 py-0.5 rounded-full flex-shrink-0 relative group"
                                    style={{
                                      backgroundColor: 'var(--accent-light)',
                                      color: 'var(--accent)',
                                    }}
                                    title={note.tags.slice(visibleTagCounts[note.id] || note.tags.length).join(', ')}
                                  >
                                    ...
                                    <div className="absolute bottom-full left-0 mb-2 hidden group-hover:block z-50 px-3 py-2 rounded-lg shadow-lg max-w-xs"
                                      style={{
                                        backgroundColor: 'var(--card)',
                                        border: '1px solid var(--border)',
                                        color: 'var(--text)',
                                      }}
                                    >
                                      <div className="text-xs whitespace-normal">
                                        {note.tags && note.tags.slice(visibleTagCounts[note.id] || (note.tags?.length || 0)).map((tag, idx) => {
                                          const remainingTags = note.tags?.slice(visibleTagCounts[note.id] || (note.tags?.length || 0)) || [];
                                          return (
                                            <span key={idx} className="inline-block mr-1 mb-1">
                                              {tag}
                                              {idx < remainingTags.length - 1 && ','}
                                            </span>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  </span>
                                )}
                              </>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStartEditTags(note);
                              }}
                              className="flex items-center justify-center w-6 h-6 rounded-full transition-all hover:bg-opacity-80 flex-shrink-0"
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
                          {isMobile && (
                            <div className="w-full flex items-center justify-between mt-2">
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
                                  className="p-1.5 rounded-md transition-all hover:bg-opacity-80 flex-shrink-0"
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
                                      right: isMobile ? '16px' : `${menuPosition.right}px`,
                                      left: isMobile ? '16px' : 'auto',
                                      maxWidth: isMobile ? 'calc(100vw - 32px)' : 'none'
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
                              className="p-1.5 rounded-md transition-all hover:bg-opacity-80 flex-shrink-0"
                              style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--error)' }}
                              title="Delete note"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => setExpandedNoteId(expandedNoteId === note.id ? null : note.id)}
                              className="p-1.5 rounded-md transition-all flex-shrink-0"
                              style={{ color: 'var(--text-muted)', backgroundColor: 'transparent' }}
                              data-chevron-button
                            >
                              {expandedNoteId === note.id ? (
                                <ChevronUp className="w-5 h-5" />
                              ) : (
                                <ChevronDown className="w-5 h-5" />
                              )}
                            </button>
                            </div>
                          )}
                        </div>
                      </div>
                      {!isMobile && (
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
                            className="p-1.5 rounded-md transition-all hover:bg-opacity-80 flex-shrink-0"
                            style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--error)' }}
                            title="Delete note"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setExpandedNoteId(expandedNoteId === note.id ? null : note.id)}
                            className="p-1.5 rounded-md transition-all flex-shrink-0"
                            style={{ color: 'var(--text-muted)', backgroundColor: 'transparent' }}
                            data-chevron-button
                          >
                            {expandedNoteId === note.id ? (
                              <ChevronUp className="w-5 h-5" />
                            ) : (
                              <ChevronDown className="w-5 h-5" />
                            )}
                          </button>
                        </div>
                      )}
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

      {/* Bulk Delete Confirmation Modal */}
      {showBulkDeleteModal && (
        <div 
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          onClick={() => setShowBulkDeleteModal(false)}
        >
          <div 
            className="card rounded-lg p-8 max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--text)' }}>
              Delete Selected Meeting Notes
            </h3>
            <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
              Are you sure you want to permanently delete {selectedNoteIds.size} meeting note{selectedNoteIds.size !== 1 ? 's' : ''}? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowBulkDeleteModal(false)}
                disabled={isBulkDeleting}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              >
                Cancel
              </button>
              <button
                onClick={handleBulkDeleteNotes}
                disabled={isBulkDeleting}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
                style={{ backgroundColor: 'var(--error)', color: '#fff' }}
              >
                {isBulkDeleting ? 'Deleting...' : 'Delete'}
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

