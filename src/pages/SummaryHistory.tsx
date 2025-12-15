import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../theme/ThemeProvider';
import { supabase } from '../config/supabaseConfig';
import { LogOut, ArrowLeft, FileText, Calendar, ChevronDown, ChevronUp, Sun, Moon } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Client } from '@microsoft/microsoft-graph-client';

interface Note {
  id: string;
  user_id: string;
  user_name: string;
  chat_id: string;
  summary?: string;
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
  
  const { theme, toggleTheme } = useTheme();
  const { user, isAuthenticated, isLoading, logout, getAccessToken } = useAuth();
  
  const [chatInfo, setChatInfo] = useState<ChatInfo | null>(null);
  const [chatLoading, setChatLoading] = useState(true);
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesLoading, setNotesLoading] = useState(true);
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, isLoading, navigate]);

  // Fetch chat info from Graph API
  useEffect(() => {
    const fetchChatInfo = async () => {
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
  }, [chatId, isAuthenticated, getAccessToken]);

  // Fetch notes from Supabase
  useEffect(() => {
    const fetchNotes = async () => {
      if (!chatId) return;
      
      try {
        setNotesLoading(true);
        const { data, error } = await supabase
          .from('note')
          .select('*')
          .eq('chat_id', chatId)
          .order('created_at', { ascending: false });

        if (error) throw error;
        setNotes(data || []);
      } catch (error) {
        console.error('Error fetching notes:', error);
      } finally {
        setNotesLoading(false);
      }
    };

    fetchNotes();
  }, [chatId]);

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
            <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Summary History</h1>
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
      <main className="flex-grow overflow-y-auto custom-scrollbar p-6">
        <div className="max-w-7xl mx-auto space-y-6">
          {/* Chat Name Header */}
          <div className="card rounded-lg p-6">
            {chatLoading ? (
              <div className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2" style={{ borderColor: 'var(--accent)' }}></div>
                <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Loading chat info...</span>
              </div>
            ) : (
              <h2 className="text-2xl font-semibold" style={{ color: 'var(--text)' }}>
                {getChatDisplayName()}
              </h2>
            )}
          </div>

          {/* Notes List */}
          <div>
            <h3 className="text-lg font-medium mb-4" style={{ color: 'var(--text)' }}>
              Meeting Notes
            </h3>

            {notesLoading ? (
              <div className="card rounded-lg p-8 text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 mx-auto mb-4" style={{ borderColor: 'var(--accent)' }}></div>
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Loading notes...</p>
              </div>
            ) : notes.length === 0 ? (
              <div className="card rounded-lg p-8 text-center">
                <FileText className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--text-muted)' }} />
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>No meeting notes found for this chat</p>
              </div>
            ) : (
              <div className="space-y-3">
                {notes.map(note => (
                  <div
                    key={note.id}
                    className="card rounded-lg overflow-hidden transition-all"
                  >
                    <div 
                      onClick={() => setExpandedNoteId(expandedNoteId === note.id ? null : note.id)}
                      className="p-4 flex items-center gap-4 cursor-pointer hover:bg-opacity-80 transition-all"
                      style={{ backgroundColor: expandedNoteId === note.id ? 'var(--bg-secondary)' : undefined }}
                    >
                      <div className="w-10 h-10 rounded-lg flex items-center justify-center" 
                        style={{ backgroundColor: 'var(--accent-light)' }}>
                        <FileText className="w-5 h-5" style={{ color: 'var(--accent)' }} />
                      </div>
                      <div className="flex-grow min-w-0">
                        <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                          Note ID: {note.id}
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          Created by {note.user_name}
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
                          className="p-4 border-t prose prose-sm max-w-none"
                          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-secondary)' }}
                        >
                          {note.summary ? (
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{note.summary}</ReactMarkdown>
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
      </main>
    </div>
  );
};

export default SummaryHistory;
