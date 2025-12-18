import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../theme/ThemeProvider';
import { useMobile } from '../hooks/useMobile';
import { getTeamsChats, TeamsChat, sendChatMessage } from '../services/graphService';
import { supabase, AUDIO_BUCKET } from '../config/supabaseConfig';
import { Upload, File, MessageSquare, Users, Clock, LogOut, X, Loader2, Send, Check, Forward, Pencil, Save, MoreVertical, History, HardDrive, Sun, Moon, Mic, Square, Play, Pause } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { marked } from 'marked';

// Type definition for Wake Lock API
interface WakeLockSentinel extends EventTarget {
  released: boolean;
  type: 'screen';
  release(): Promise<void>;
}

interface NavigatorWithWakeLock {
  wakeLock?: {
    request(type: 'screen'): Promise<WakeLockSentinel>;
  };
}

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  file: File;
  status: 'pending' | 'uploading' | 'processing' | 'completed' | 'error';
  progress?: number;
  error?: string;
  publicUrl?: string;
}

const TranscriptionSummary: React.FC = () => {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { user, isAuthenticated, isLoading, logout, getAccessToken } = useAuth();
  const isMobile = useMobile();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [chats, setChats] = useState<TeamsChat[]>([]);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [summaryPrompt, setSummaryPrompt] = useState('');
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryResult, setSummaryResult] = useState<{ transcript: string; summary: string } | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [isForwarding, setIsForwarding] = useState(false);
  const [forwardSuccess, setForwardSuccess] = useState(false);
  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [editedSummary, setEditedSummary] = useState<string>('');
  const [currentNoteId, setCurrentNoteId] = useState<string | null>(null);
  const [openMenuChatId, setOpenMenuChatId] = useState<string | null>(null);
  const [showDiscardModal, setShowDiscardModal] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);

  // Recording states
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [isPlayingRecording, setIsPlayingRecording] = useState(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const [playbackCurrentTime, setPlaybackCurrentTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setOpenMenuChatId(null);
    if (openMenuChatId) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [openMenuChatId]);

  const generateNoteId = (): string => {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let randomPart = '';
    for (let i = 0; i < 10; i++) {
      randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `${yy}${mm}${dd}${randomPart}`;
  };

  const formatRecordingTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const streamRef = useRef<MediaStream | null>(null);

  const startRecording = async () => {
    try {
      // Request wake lock to keep screen on during recording
      if ('wakeLock' in navigator) {
        try {
          const nav = navigator as NavigatorWithWakeLock;
          if (nav.wakeLock) {
            const wakeLock = await nav.wakeLock.request('screen');
            wakeLockRef.current = wakeLock;
            
            // Handle wake lock release (e.g., when user switches tabs)
            wakeLock.addEventListener('release', () => {
              console.log('Wake lock released');
            });
          }
        } catch (err: any) {
          console.warn('Wake lock request failed:', err);
          // Continue with recording even if wake lock fails
        }
      }
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const audioUrl = URL.createObjectURL(audioBlob);
        setRecordedAudioUrl(audioUrl);
        setRecordedBlob(audioBlob);
        
        // Stop all tracks
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      setRecordedAudioUrl(null);
      setRecordedBlob(null);
      setPlaybackProgress(0);
      setPlaybackCurrentTime(0);
      
      // Start timer
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (error) {
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
      
      // Release wake lock
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch((err: any) => {
          console.warn('Error releasing wake lock:', err);
        });
        wakeLockRef.current = null;
      }
    }
  };

  const useRecording = () => {
    if (!recordedBlob) return;
    
    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const fileName = `Recording_${timestamp}.webm`;
    const audioFile = new window.File([recordedBlob], fileName, { type: 'audio/webm' });
    
    const newFile: UploadedFile = {
      id: crypto.randomUUID(),
      name: fileName,
      size: recordedBlob.size,
      type: 'audio/webm',
      file: audioFile,
      status: 'pending',
    };
    
    setUploadedFiles([newFile]);
    uploadToSupabase(newFile.id, audioFile);
    
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
      audioPlayerRef.current.onloadedmetadata = () => {
        setPlaybackDuration(audioPlayerRef.current?.duration || 0);
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
    setRecordingTime(0);
    setIsPlayingRecording(false);
    setPlaybackProgress(0);
    setPlaybackCurrentTime(0);
    setPlaybackDuration(0);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
      }
      if (recordedAudioUrl) {
        URL.revokeObjectURL(recordedAudioUrl);
      }
      // Release wake lock if still active
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch((err: any) => {
          console.warn('Error releasing wake lock on unmount:', err);
        });
        wakeLockRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, isLoading, navigate]);

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

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files);
      handleFiles(files);
    }
  };

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

    const newUploadedFiles: UploadedFile[] = audioFiles.map(file => ({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      type: file.type,
      file: file,
      status: 'pending' as const,
    }));

    setUploadedFiles(prev => [...prev, ...newUploadedFiles]);

    newUploadedFiles.forEach(uploadedFile => {
      uploadToSupabase(uploadedFile.id, uploadedFile.file);
    });
  };

  const uploadToSupabase = async (fileId: string, file: File) => {
    setUploadedFiles(prev => 
      prev.map(f => f.id === fileId ? { ...f, status: 'uploading', progress: 0 } : f)
    );

    try {
      // Sanitize filename: remove non-ASCII chars, replace spaces with underscores
      const ext = file.name.split('.').pop() || 'audio';
      const sanitizedName = file.name
        .replace(/[^\x00-\x7F]/g, '') // Remove non-ASCII
        .replace(/\s+/g, '_') // Replace spaces with underscores
        .replace(/[^a-zA-Z0-9._-]/g, '') // Keep only safe chars
        || `audio_${Date.now()}`; // Fallback if empty
      const filePath = `${fileId}-${sanitizedName.includes('.') ? sanitizedName : `${sanitizedName}.${ext}`}`;
      
      const { error } = await supabase.storage
        .from(AUDIO_BUCKET)
        .upload(filePath, file, {
          cacheControl: '3600',
          upsert: false,
        });

      if (error) throw error;

      const { data: urlData } = supabase.storage
        .from(AUDIO_BUCKET)
        .getPublicUrl(filePath);

      console.log('Supabase public URL:', urlData.publicUrl);

      setUploadedFiles(prev => 
        prev.map(f => f.id === fileId ? { 
          ...f, 
          status: 'completed', 
          progress: 100,
          publicUrl: urlData.publicUrl 
        } : f)
      );
    } catch (error: any) {
      console.error('Upload error:', error);
      setUploadedFiles(prev => 
        prev.map(f => f.id === fileId ? { 
          ...f, 
          status: 'error', 
          error: error.message || 'Upload failed' 
        } : f)
      );
    }
  };

  const removeFile = (fileId: string) => {
    setUploadedFiles(prev => prev.filter(f => f.id !== fileId));
    clearRecording();
  };

  const hasCompletedFiles = uploadedFiles.some(f => f.status === 'completed');
  const showPromptSection = isRecording || recordedAudioUrl || uploadedFiles.length > 0;

  const handleSummarize = async () => {
    if (!hasCompletedFiles) return;
    
    const completedFiles = uploadedFiles.filter(f => f.status === 'completed' && f.publicUrl);
    if (completedFiles.length === 0) return;

    setIsSummarizing(true);
    setSummaryResult(null);
    setSummaryError(null);
    
    try {
      const file = completedFiles[0];
      const noteId = generateNoteId();
      setCurrentNoteId(noteId);

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
            instructions: summaryPrompt,
            userId: user?.id || '',
            userName: user?.displayName || '',
            noteId: noteId,
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      const result = await response.json();
      setSummaryResult(result);
      setEditedSummary(result.summary);
      
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
      setTimeout(() => setForwardSuccess(false), 3000);
    } catch (error: any) {
      console.error('Error forwarding summary:', error);
      alert('Failed to forward summary: ' + (error.message || 'Unknown error'));
    } finally {
      setIsForwarding(false);
    }
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
            <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Meeting Note</h1>
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
              onClick={() => navigate(`/summary-history?user_id=${user?.id}`)}
              className="p-2 rounded-md"
              style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              title="My Notes"
            >
              <History className="w-4 h-4" />
            </button>
            <button
              onClick={() => navigate('/save-summary')}
              className="p-2 rounded-md"
              style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              title="OneDrive"
            >
              <HardDrive className="w-4 h-4" />
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
        className={`flex-grow overflow-y-auto custom-scrollbar ${isMobile ? 'mobile-bottom-padding' : ''}`}
        style={{ 
          padding: isMobile ? '16px' : '24px',
          paddingBottom: isMobile ? undefined : 'calc(24px + env(safe-area-inset-bottom, 0px))'
        }}
      >
        <div className={`${isMobile ? 'w-full' : 'max-w-7xl'} mx-auto space-y-8`}>
          {/* File Upload Section */}
          <section>
            <h2 className="text-lg font-medium mb-4" style={{ color: 'var(--text)' }}>
              Summarize Audio File
            </h2>
            
            {/* Record/Upload Options - Hidden when files are uploaded or recording complete */}
            <div className={`collapse-container ${(uploadedFiles.length > 0 || recordedAudioUrl) ? 'collapsed' : 'expanded'}`}>
              <div className="collapse-content">
                <div className="flex flex-col md:flex-row items-stretch gap-4">
                  {/* Record Option */}
                  <div
                    className="flex-1 card rounded-lg p-6 text-center transition-all"
                    style={{ border: isRecording ? '2px solid var(--error)' : '2px dashed var(--border)' }}
                  >
                    {!isRecording ? (
                      <>
                        <button
                          onClick={startRecording}
                          className="w-16 h-16 rounded-full mx-auto mb-3 flex items-center justify-center transition-all hover:scale-105"
                          style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                        >
                          <Mic className="w-7 h-7" />
                        </button>
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
                          <button
                            onClick={stopRecording}
                            className="relative w-16 h-16 rounded-full flex items-center justify-center transition-all hover:scale-105"
                            style={{ backgroundColor: 'var(--error)', color: '#fff' }}
                          >
                            <Square className="w-6 h-6" fill="currentColor" />
                          </button>
                        </div>
                        <p className="text-lg font-mono font-medium mb-1" style={{ color: 'var(--error)' }}>
                          {formatRecordingTime(recordingTime)}
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          Recording... Click to stop
                        </p>
                      </>
                    )}
                  </div>

                  {/* OR Divider */}
                  <div className="flex md:flex-col items-center justify-center gap-2 py-2 md:py-0 md:px-2">
                    <div className="flex-1 h-px md:h-auto md:w-px md:flex-1" style={{ backgroundColor: 'var(--border)' }} />
                    <span className="text-xs font-medium px-2" style={{ color: 'var(--text-muted)' }}>or</span>
                    <div className="flex-1 h-px md:h-auto md:w-px md:flex-1" style={{ backgroundColor: 'var(--border)' }} />
                  </div>

                  {/* Upload Option */}
                  <div
                    className={`flex-1 drop-zone rounded-lg p-6 text-center cursor-pointer transition-all ${isDragging ? 'drag-over' : ''}`}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac,.wma"
                      multiple
                      onChange={handleFileSelect}
                      className="hidden"
                    />
                    <Upload className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
                    <p className="text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>
                      Upload Audio File
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Drop files or click to browse
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Recording Playback - Shows when recording is complete but not uploaded */}
            <div className={`collapse-container ${(recordedAudioUrl && uploadedFiles.length === 0) ? 'expanded' : 'collapsed'}`}>
              <div className="collapse-content">
                <div className="card rounded-lg p-6">
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
                  <div className="flex items-center justify-end gap-3">
                    <button
                      onClick={clearRecording}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all"
                      style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                    >
                      <X className="w-4 h-4" />
                      Discard
                    </button>
                    <button
                      onClick={useRecording}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all"
                      style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                    >
                      <Check className="w-4 h-4" />
                      Use Recording
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
                      <File className="w-5 h-5" style={{ color: 'var(--accent)' }} />
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
                        </span>
                      )}
                      {file.status === 'processing' && (
                        <div className="flex items-center gap-1">
                          <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--accent)' }} />
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
                      <button
                        onClick={() => removeFile(file.id)}
                        className="p-1 rounded hover:bg-opacity-80"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
                </div>
              </div>
            </div>

            {/* Summarize Prompt */}
            <div className={`collapse-container ${showPromptSection ? 'expanded' : 'collapsed'}`}>
              <div className="collapse-content">
              <div className="mt-4 card rounded-lg p-4">
                <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text)' }}>
                  Add instructions (optional)
                </label>
                <div className="flex gap-3 items-end">
                  <textarea
                    value={summaryPrompt}
                    onChange={(e) => setSummaryPrompt(e.target.value)}
                    placeholder="e.g., Focus on action items and decisions..."
                    className="flex-grow px-4 py-2 rounded-lg text-sm resize-y min-h-[40px]"
                    style={{
                      backgroundColor: 'var(--bg-secondary)',
                      border: '1px solid var(--border)',
                      color: 'var(--text)',
                      height: '40px',
                      maxHeight: '200px',
                    }}
                    disabled={isSummarizing}
                  />
                  <button
                    onClick={handleSummarize}
                    disabled={isSummarizing || !hasCompletedFiles}
                    className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed h-[40px]"
                    style={{
                      backgroundColor: 'var(--accent)',
                      color: '#ffffff',
                    }}
                  >
                    {isSummarizing ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Summarizing...
                      </>
                    ) : (
                      <>
                        <Send className="w-4 h-4" />
                        Summarize
                      </>
                    )}
                  </button>
                </div>
              </div>
              </div>
            </div>

            {/* Summary Result */}
            {(isSummarizing || summaryResult || summaryError) && (
              <div className="mt-4 card rounded-lg p-6">
                {isSummarizing && (
                  <div className="flex flex-col items-center justify-center py-8">
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
                  <div className="space-y-4">
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                          Summary
                        </h3>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setShowDiscardModal(true)}
                            className="flex items-center gap-1 px-3 py-1 rounded-md text-xs font-medium transition-all"
                            style={{ 
                              backgroundColor: 'var(--bg-secondary)',
                              color: 'var(--text-muted)',
                            }}
                          >
                            <X className="w-3 h-3" />
                            Discard
                          </button>
                          <button
                            onClick={() => setIsEditingSummary(!isEditingSummary)}
                            className="flex items-center gap-1 px-3 py-1 rounded-md text-xs font-medium transition-all"
                            style={{ 
                              backgroundColor: isEditingSummary ? 'var(--accent)' : 'var(--bg-secondary)',
                              color: isEditingSummary ? '#fff' : 'var(--text-secondary)',
                            }}
                          >
                            {isEditingSummary ? (
                              <>
                                <Save className="w-3 h-3" />
                                Done
                              </>
                            ) : (
                              <>
                                <Pencil className="w-3 h-3" />
                                Edit
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                      
                      {isEditingSummary ? (
                        <textarea
                          value={editedSummary}
                          onChange={(e) => setEditedSummary(e.target.value)}
                          className="w-full p-4 rounded-lg text-sm leading-relaxed max-h-96 min-h-48 custom-scrollbar resize-y"
                          style={{ 
                            backgroundColor: 'var(--bg-secondary)', 
                            color: 'var(--text)',
                            border: '2px solid var(--accent)',
                          }}
                          placeholder="Edit your summary here... (Markdown supported)"
                        />
                      ) : (
                        <div 
                          className="p-4 rounded-lg text-sm leading-relaxed prose prose-sm max-w-none max-h-96 overflow-y-auto custom-scrollbar"
                          style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text)' }}
                        >
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{editedSummary}</ReactMarkdown>
                        </div>
                      )}
                    </div>

                    {/* View Transcript Toggle */}
                    {summaryResult.transcript && (
                      <div style={{ marginTop: '24px' }}>
                        <button
                          onClick={() => setShowTranscript(!showTranscript)}
                          className="flex items-center gap-2 text-sm font-medium transition-all"
                          style={{ color: 'var(--accent)' }}
                        >
                          <span>{showTranscript ? '▼' : '▶'}</span>
                          {showTranscript ? 'Hide Original Transcript' : 'View Original Transcript'}
                        </button>
                        
                        <div className={`collapse-container ${showTranscript ? 'expanded' : 'collapsed'}`}>
                          <div className="collapse-content">
                            <div 
                              className="mt-3 p-4 rounded-lg text-sm leading-relaxed max-h-96 overflow-y-auto custom-scrollbar whitespace-pre-wrap"
                              style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                            >
                              {summaryResult.transcript}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Teams Chats Section */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-medium" style={{ color: 'var(--text)' }}>
                Teams Chats
              </h2>
              {summaryResult && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const completedFile = uploadedFiles.find(f => f.status === 'completed' && f.publicUrl);
                      const audioUrl = completedFile?.publicUrl ? encodeURIComponent(completedFile.publicUrl) : '';
                      const audioName = completedFile?.name ? encodeURIComponent(completedFile.name) : '';
                      navigate(`/save-summary?note_id=${currentNoteId}&audio_url=${audioUrl}&audio_name=${audioName}`);
                    }}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all"
                    style={{
                      backgroundColor: 'var(--bg-secondary)',
                      color: 'var(--text)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    <HardDrive className="w-4 h-4" />
                    Save to OneDrive
                  </button>
                  <button
                    onClick={handleForwardSummary}
                    disabled={!selectedChatId || isForwarding}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      backgroundColor: forwardSuccess ? 'var(--success)' : 'var(--accent)',
                      color: '#ffffff',
                    }}
                  >
                    {isForwarding ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Sending...
                      </>
                    ) : forwardSuccess ? (
                      <>
                        <Check className="w-4 h-4" />
                        Sent!
                      </>
                    ) : (
                      <>
                        <Forward className="w-4 h-4" />
                        Forward Summary
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>

            {summaryResult && !selectedChatId && (
              <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                Select a chat below to forward the summary
              </p>
            )}

            {chatsLoading ? (
              <div className="card rounded-lg p-8 text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 mx-auto mb-4" style={{ borderColor: 'var(--accent)' }}></div>
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Loading your Teams chats...</p>
              </div>
            ) : chatsError ? (
              <div className="card rounded-lg p-8 text-center error">
                <p className="text-sm mb-2">{chatsError}</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Make sure you have the necessary permissions to access Teams chats.
                </p>
              </div>
            ) : chats.length === 0 ? (
              <div className="card rounded-lg p-8 text-center">
                <MessageSquare className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--text-muted)' }} />
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>No Teams chats found</p>
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto custom-scrollbar rounded-lg" style={{ border: '1px solid var(--border)' }}>
                <div className="space-y-2 p-2">
                  {chats.filter(chat => chat.members && chat.members.length > 1).map(chat => (
                    <div
                      key={chat.id}
                      onClick={() => summaryResult && setSelectedChatId(chat.id === selectedChatId ? null : chat.id)}
                      className={`chat-item rounded-lg p-4 flex items-center gap-4 transition-all ${summaryResult ? 'cursor-pointer' : ''}`}
                      style={{
                        borderColor: chat.id === selectedChatId ? 'var(--accent)' : undefined,
                        backgroundColor: chat.id === selectedChatId ? 'var(--accent-light)' : undefined,
                      }}
                    >
                      <div className="w-10 h-10 rounded-full flex items-center justify-center" 
                        style={{ backgroundColor: chat.id === selectedChatId ? 'var(--accent)' : 'var(--accent-light)' }}>
                        {chat.chatType === 'oneOnOne' ? (
                          <MessageSquare className="w-5 h-5" style={{ color: chat.id === selectedChatId ? '#fff' : 'var(--accent)' }} />
                        ) : (
                          <Users className="w-5 h-5" style={{ color: chat.id === selectedChatId ? '#fff' : 'var(--accent)' }} />
                        )}
                      </div>
                      <div className="flex-grow min-w-0">
                        <p className="text-sm font-medium truncate" style={{ color: 'var(--text)' }}>
                          {getChatDisplayName(chat)}
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {chat.chatType === 'oneOnOne' ? 'Direct message' : 
                           chat.chatType === 'group' ? 'Group chat' : 'Meeting chat'}
                          {chat.members && ` • ${chat.members.length} members`}
                          {' • '}{formatDate(chat.lastMessageDateTime || chat.lastUpdatedDateTime)}
                        </p>
                      </div>
                      <div className="relative">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenMenuChatId(openMenuChatId === chat.id ? null : chat.id);
                          }}
                          className="p-2 rounded-md transition-all chat-menu-icon"
                        >
                          <MoreVertical style={{ width: '22px', height: '22px' }} />
                        </button>
                        
                        {openMenuChatId === chat.id && (
                          <div 
                            className="absolute right-0 top-full mt-1 py-1 rounded-lg shadow-lg z-10 min-w-32"
                            style={{ backgroundColor: 'var(--card)', border: '1px solid var(--border)' }}
                          >
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenuChatId(null);
                                navigate(`/summary-history?chat_id=${encodeURIComponent(chat.id)}`);
                              }}
                              className="w-full flex items-center gap-2 px-4 py-2 text-sm transition-all chat-menu-item"
                            >
                              <History className="w-4 h-4" />
                              History
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenuChatId(null);
                                if (chat.webUrl) {
                                  window.open(chat.webUrl, '_blank');
                                }
                              }}
                              className="w-full flex items-center gap-2 px-4 py-2 text-sm transition-all chat-menu-item"
                            >
                              <MessageSquare className="w-4 h-4" />
                              Chat
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </main>

      {/* Discard Confirmation Modal */}
      {showDiscardModal && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          onClick={() => setShowDiscardModal(false)}
        >
          <div 
            className="card rounded-lg p-6 max-w-sm w-full shadow-xl"
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
                  setEditedSummary('');
                  setIsEditingSummary(false);
                  setCurrentNoteId(null);
                  setShowTranscript(false);
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

