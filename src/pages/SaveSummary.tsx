import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../theme/ThemeProvider';
import { useMobile } from '../hooks/useMobile';
import { supabase } from '../config/supabaseConfig';
import { 
  LogOut, ArrowLeft, Folder, File, FolderPlus, Trash2, 
  Edit2, Save, X, Loader2, ChevronRight, Home, Check, Sun, Moon
} from 'lucide-react';
import {
  getOneDriveRoot,
  getOneDriveFolderContents,
  getOneDriveItem,
  createOneDriveFolder,
  deleteOneDriveItem,
  renameOneDriveItem,
  uploadTextFile,
  DriveItem,
} from '../services/graphService';

interface Note {
  id: string;
  summary?: string;
  transcription?: string;
  user_name?: string;
  name?: string | null;
  created_at?: string;
}

interface BreadcrumbItem {
  id: string | null;
  name: string;
}

const SaveSummary: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const noteId = searchParams.get('note_id');
  const audioUrl = searchParams.get('audio_url') ? decodeURIComponent(searchParams.get('audio_url')!) : null;
  const audioName = searchParams.get('audio_name') ? decodeURIComponent(searchParams.get('audio_name')!) : null;

  const { theme, toggleTheme } = useTheme();
  const { user, isAuthenticated, isLoading: authLoading, logout, getAccessToken } = useAuth();
  const isMobile = useMobile();

  const [note, setNote] = useState<Note | null>(null);
  const [noteLoading, setNoteLoading] = useState(true);

  const [items, setItems] = useState<DriveItem[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([{ id: null, name: 'OneDrive' }]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolderLoading, setCreatingFolderLoading] = useState(false);

  const [renamingItemId, setRenamingItemId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);

  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveFileName, setSaveFileName] = useState('');
  
  const [isSavingAudio, setIsSavingAudio] = useState(false);
  const [saveAudioSuccess, setSaveAudioSuccess] = useState(false);
  const [audioFileName, setAudioFileName] = useState('');
  
  const [isSavingTranscript, setIsSavingTranscript] = useState(false);
  const [saveTranscriptSuccess, setSaveTranscriptSuccess] = useState(false);
  const [transcriptFileName, setTranscriptFileName] = useState('');

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, authLoading, navigate]);

  // Fetch note data
  useEffect(() => {
    const fetchNote = async () => {
      if (!noteId) {
        setNoteLoading(false);
        return;
      }

      try {
        const { data, error } = await supabase
          .from('note')
          .select('id, summary, transcription, user_name, name, created_at')
          .eq('id', noteId)
          .single();

        if (error) throw error;
        setNote(data);
        
        // Generate default filenames based on note.name
        if (data.name) {
          setSaveFileName(`${data.name}_note.md`);
          setTranscriptFileName(`${data.name}_transcript.md`);
          
          // Set audio filename if audioName is available
          if (audioName) {
            const extension = audioName.split('.').pop() || '';
            setAudioFileName(`${data.name}_audio.${extension}`);
          }
        } else {
          // Fallback to date-based naming if no name
          const date = new Date();
          const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
          setSaveFileName(`Meeting_Note_${dateStr}.md`);
          setTranscriptFileName(`Meeting_Transcript_${dateStr}.md`);
          
          // Fallback audio filename
          if (audioName) {
            setAudioFileName(audioName);
          }
        }
      } catch (err: any) {
        console.error('Error fetching note:', err);
      } finally {
        setNoteLoading(false);
      }
    };

    fetchNote();
  }, [noteId, audioName]);


  // Fetch OneDrive contents
  const fetchContents = async (folderId: string | null = null) => {
    try {
      setLoading(true);
      setError(null);
      const token = await getAccessToken();
      if (!token) throw new Error('No access token');

      const contents = folderId
        ? await getOneDriveFolderContents(token, folderId)
        : await getOneDriveRoot(token);

      // Sort: folders first, then files
      const sorted = contents.sort((a, b) => {
        if (a.folder && !b.folder) return -1;
        if (!a.folder && b.folder) return 1;
        return a.name.localeCompare(b.name);
      });

      setItems(sorted);
    } catch (err: any) {
      console.error('Error fetching OneDrive contents:', err);
      setError(err.message || 'Failed to load OneDrive contents');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated && !authLoading) {
      fetchContents(currentFolderId);
    }
  }, [isAuthenticated, authLoading, currentFolderId]);

  const navigateToFolder = async (folderId: string, folderName: string) => {
    setCurrentFolderId(folderId);
    setBreadcrumbs(prev => [...prev, { id: folderId, name: folderName }]);
  };

  const navigateToBreadcrumb = (index: number) => {
    const newBreadcrumbs = breadcrumbs.slice(0, index + 1);
    setBreadcrumbs(newBreadcrumbs);
    setCurrentFolderId(newBreadcrumbs[newBreadcrumbs.length - 1].id);
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;

    try {
      setCreatingFolderLoading(true);
      const token = await getAccessToken();
      if (!token) throw new Error('No access token');

      await createOneDriveFolder(token, currentFolderId, newFolderName.trim());
      setNewFolderName('');
      setIsCreatingFolder(false);
      await fetchContents(currentFolderId);
    } catch (err: any) {
      console.error('Error creating folder:', err);
      alert('Failed to create folder: ' + err.message);
    } finally {
      setCreatingFolderLoading(false);
    }
  };

  const handleRename = async (itemId: string) => {
    if (!renameValue.trim()) return;

    try {
      const token = await getAccessToken();
      if (!token) throw new Error('No access token');

      await renameOneDriveItem(token, itemId, renameValue.trim());
      setRenamingItemId(null);
      setRenameValue('');
      await fetchContents(currentFolderId);
    } catch (err: any) {
      console.error('Error renaming item:', err);
      alert('Failed to rename: ' + err.message);
    }
  };

  const handleDelete = async (itemId: string) => {
    if (!confirm('Are you sure you want to delete this item?')) return;

    try {
      setDeletingItemId(itemId);
      const token = await getAccessToken();
      if (!token) throw new Error('No access token');

      await deleteOneDriveItem(token, itemId);
      await fetchContents(currentFolderId);
    } catch (err: any) {
      console.error('Error deleting item:', err);
      alert('Failed to delete: ' + err.message);
    } finally {
      setDeletingItemId(null);
    }
  };

  const handleSaveSummary = async () => {
    if (!note?.summary || !saveFileName.trim()) return;

    try {
      setIsSaving(true);
      const token = await getAccessToken();
      if (!token) throw new Error('No access token');

      await uploadTextFile(token, currentFolderId, saveFileName.trim(), note.summary);
      setSaveSuccess(true);
      // Reset after showing success
      setTimeout(() => {
        setSaveSuccess(false);
        fetchContents(currentFolderId); // Refresh to show the new file
      }, 2000);
    } catch (err: any) {
      console.error('Error saving summary:', err);
      alert('Failed to save summary: ' + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveTranscript = async () => {
    if (!note?.transcription || !transcriptFileName.trim()) return;

    try {
      setIsSavingTranscript(true);
      const token = await getAccessToken();
      if (!token) throw new Error('No access token');

      await uploadTextFile(token, currentFolderId, transcriptFileName.trim(), note.transcription);
      setSaveTranscriptSuccess(true);
      // Reset after showing success
      setTimeout(() => {
        setSaveTranscriptSuccess(false);
        fetchContents(currentFolderId); // Refresh to show the new file
      }, 2000);
    } catch (err: any) {
      console.error('Error saving transcript:', err);
      alert('Failed to save transcript: ' + err.message);
    } finally {
      setIsSavingTranscript(false);
    }
  };

  const handleSaveAudio = async () => {
    if (!audioUrl || !audioFileName.trim()) return;

    try {
      setIsSavingAudio(true);
      const token = await getAccessToken();
      if (!token) throw new Error('No access token');

      // Fetch the audio file from Supabase
      const response = await fetch(audioUrl);
      if (!response.ok) throw new Error('Failed to download audio file');
      const audioBlob = await response.blob();

      // Upload to OneDrive using Graph API directly for binary content
      const { Client } = await import('@microsoft/microsoft-graph-client');
      const client = Client.init({
        authProvider: (done) => done(null, token),
      });

      const endpoint = currentFolderId
        ? `/me/drive/items/${currentFolderId}:/${audioFileName.trim()}:/content`
        : `/me/drive/root:/${audioFileName.trim()}:/content`;

      await client.api(endpoint).put(audioBlob);

      setSaveAudioSuccess(true);
      setTimeout(() => {
        setSaveAudioSuccess(false);
        fetchContents(currentFolderId);
      }, 2000);
    } catch (err: any) {
      console.error('Error saving audio:', err);
      alert('Failed to save audio file: ' + err.message);
    } finally {
      setIsSavingAudio(false);
    }
  };

  const formatSize = (bytes?: number): string => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (dateString?: string): string => {
    if (!dateString) return '';
    return new Date(dateString).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  if (authLoading) {
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
              className="p-2 rounded-md transition-all hover:bg-opacity-80"
              style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>
              {noteId ? 'Save to OneDrive' : 'OneDrive'}
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
            <button onClick={toggleTheme} className="p-2 rounded-md" style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
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
      <main className="flex-grow overflow-hidden flex" style={{ flexDirection: isMobile ? 'column' : 'row' }}>
        {/* File Browser */}
        <div className="flex-grow flex flex-col overflow-hidden" style={{ padding: isMobile ? '16px' : '24px', paddingBottom: isMobile ? 'max(80px, env(safe-area-inset-bottom, 80px))' : 'max(24px, env(safe-area-inset-bottom, 24px))' }}>
          <div className="max-w-5xl mx-auto w-full flex-grow flex flex-col overflow-hidden">
            
            {/* Breadcrumbs & Actions */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-1 text-sm overflow-x-auto">
                {breadcrumbs.map((crumb, index) => (
                  <React.Fragment key={index}>
                    {index > 0 && <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />}
                    <button
                      onClick={() => navigateToBreadcrumb(index)}
                      className={`px-2 py-1 rounded hover:bg-opacity-80 transition-all flex items-center gap-1 ${
                        index === breadcrumbs.length - 1 ? 'font-medium' : ''
                      }`}
                      style={{
                        backgroundColor: index === breadcrumbs.length - 1 ? 'var(--bg-secondary)' : 'transparent',
                        color: index === breadcrumbs.length - 1 ? 'var(--text)' : 'var(--text-secondary)',
                      }}
                    >
                      {index === 0 && <Home className="w-4 h-4" />}
                      {crumb.name}
                    </button>
                  </React.Fragment>
                ))}
              </div>

              <button
                onClick={() => setIsCreatingFolder(true)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text)' }}
              >
                <FolderPlus className="w-4 h-4" />
                New Folder
              </button>
            </div>

            {/* Create Folder Input */}
            {isCreatingFolder && (
              <div className="mb-4 flex items-center gap-2">
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="New folder name"
                  className="flex-grow px-3 py-2 rounded-lg text-sm"
                  style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text)', border: '1px solid var(--border)' }}
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
                />
                <button
                  onClick={handleCreateFolder}
                  disabled={creatingFolderLoading || !newFolderName.trim()}
                  className="px-3 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
                  style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                >
                  {creatingFolderLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create'}
                </button>
                <button
                  onClick={() => { setIsCreatingFolder(false); setNewFolderName(''); }}
                  className="p-2 rounded-lg transition-all"
                  style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Items List */}
            <div className="card rounded-lg flex-grow overflow-hidden flex flex-col">
              {loading ? (
                <div className="flex-grow flex items-center justify-center">
                  <div className="text-center">
                    <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" style={{ color: 'var(--accent)' }} />
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Loading...</p>
                  </div>
                </div>
              ) : error ? (
                <div className="flex-grow flex items-center justify-center">
                  <div className="text-center p-6">
                    <p className="text-sm mb-2" style={{ color: 'var(--error)' }}>{error}</p>
                    <button
                      onClick={() => fetchContents(currentFolderId)}
                      className="text-sm underline"
                      style={{ color: 'var(--accent)' }}
                    >
                      Try again
                    </button>
                  </div>
                </div>
              ) : items.length === 0 ? (
                <div className="flex-grow flex items-center justify-center">
                  <div className="text-center p-6">
                    <Folder className="w-12 h-12 mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>This folder is empty</p>
                  </div>
                </div>
              ) : (
                <div className="overflow-y-auto custom-scrollbar">
                  <table className="w-full">
                    <thead>
                      <tr style={{ backgroundColor: 'var(--bg-secondary)' }}>
                        <th className="text-left px-4 py-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Name</th>
                        <th className="text-left px-4 py-3 text-xs font-medium w-24" style={{ color: 'var(--text-muted)' }}>Size</th>
                        <th className="text-left px-4 py-3 text-xs font-medium w-32" style={{ color: 'var(--text-muted)' }}>Modified</th>
                        <th className="px-4 py-3 text-xs font-medium w-24" style={{ color: 'var(--text-muted)' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr
                          key={item.id}
                          className="border-t transition-all hover:bg-opacity-50"
                          style={{ borderColor: 'var(--border)' }}
                          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'}
                          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                        >
                          <td className="px-4 py-3">
                            {renamingItemId === item.id ? (
                              <div className="flex items-center gap-2">
                                <input
                                  type="text"
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  className="flex-grow px-2 py-1 rounded text-sm"
                                  style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--accent)' }}
                                  autoFocus
                                  onKeyDown={(e) => e.key === 'Enter' && handleRename(item.id)}
                                />
                                <button onClick={() => handleRename(item.id)} className="p-1 rounded" style={{ color: 'var(--success)' }}>
                                  <Check className="w-4 h-4" />
                                </button>
                                <button onClick={() => { setRenamingItemId(null); setRenameValue(''); }} className="p-1 rounded" style={{ color: 'var(--text-muted)' }}>
                                  <X className="w-4 h-4" />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-3">
                                {item.folder ? (
                                  <Folder className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--accent)' }} />
                                ) : (
                                  <File className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                                )}
                                {item.folder ? (
                                  <button
                                    onClick={() => navigateToFolder(item.id, item.name)}
                                    className="text-sm font-medium hover:underline text-left"
                                    style={{ color: 'var(--text)' }}
                                  >
                                    {item.name}
                                  </button>
                                ) : (
                                  <span className="text-sm" style={{ color: 'var(--text)' }}>{item.name}</span>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-muted)' }}>
                            {item.folder ? `${item.folder.childCount} items` : formatSize(item.size)}
                          </td>
                          <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-muted)' }}>
                            {formatDate(item.lastModifiedDateTime)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-center gap-1">
                              <button
                                onClick={() => { setRenamingItemId(item.id); setRenameValue(item.name); }}
                                className="p-1.5 rounded transition-all hover:bg-opacity-80"
                                style={{ color: 'var(--text-muted)' }}
                                title="Rename"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleDelete(item.id)}
                                disabled={deletingItemId === item.id}
                                className="p-1.5 rounded transition-all hover:bg-opacity-80"
                                style={{ color: 'var(--error)' }}
                                title="Delete"
                              >
                                {deletingItemId === item.id ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Trash2 className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Save Section */}
            {(note || audioUrl) && (
              <div className="mt-4 card rounded-lg p-4 space-y-4">
                {/* Save Summary */}
                {note && (
                  <div>
                    <div className="flex items-center gap-4">
                      <div className="flex-grow">
                        <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>
                          Summary file name
                        </label>
                        <input
                          type="text"
                          value={saveFileName}
                          onChange={(e) => setSaveFileName(e.target.value)}
                          className="w-full px-3 py-2 rounded-lg text-sm"
                          style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text)', border: '1px solid var(--border)' }}
                          placeholder="filename.md"
                        />
                      </div>
                      <button
                        onClick={handleSaveSummary}
                        disabled={isSaving || !saveFileName.trim() || saveSuccess}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all disabled:opacity-50 mt-5"
                        style={{
                          backgroundColor: saveSuccess ? 'var(--success)' : 'var(--accent)',
                          color: '#fff',
                        }}
                      >
                        {isSaving ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Saving...
                          </>
                        ) : saveSuccess ? (
                          <>
                            <Check className="w-4 h-4" />
                            Saved!
                          </>
                        ) : (
                          <>
                            <Save className="w-4 h-4" />
                            Save Summary
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {/* Divider between summary and transcript */}
                {note?.summary && note?.transcription && (
                  <div className="border-t" style={{ borderColor: 'var(--border)' }} />
                )}

                {/* Save Transcript */}
                {note?.transcription && (
                  <div>
                    <div className="flex items-center gap-4">
                      <div className="flex-grow">
                        <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>
                          Transcript file name
                        </label>
                        <input
                          type="text"
                          value={transcriptFileName}
                          onChange={(e) => setTranscriptFileName(e.target.value)}
                          className="w-full px-3 py-2 rounded-lg text-sm"
                          style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text)', border: '1px solid var(--border)' }}
                          placeholder="transcript.md"
                        />
                      </div>
                      <button
                        onClick={handleSaveTranscript}
                        disabled={isSavingTranscript || !transcriptFileName.trim() || saveTranscriptSuccess}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all disabled:opacity-50 mt-5"
                        style={{
                          backgroundColor: saveTranscriptSuccess ? 'var(--success)' : 'var(--accent)',
                          color: '#fff',
                        }}
                      >
                        {isSavingTranscript ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Saving...
                          </>
                        ) : saveTranscriptSuccess ? (
                          <>
                            <Check className="w-4 h-4" />
                            Saved!
                          </>
                        ) : (
                          <>
                            <Save className="w-4 h-4" />
                            Save Transcript
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {/* Divider before audio */}
                {(note?.summary || note?.transcription) && audioUrl && (
                  <div className="border-t" style={{ borderColor: 'var(--border)' }} />
                )}

                {/* Save Audio */}
                {audioUrl && (
                  <div>
                    <div className="flex items-center gap-4">
                      <div className="flex-grow">
                        <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>
                          Audio file name
                        </label>
                        <input
                          type="text"
                          value={audioFileName}
                          onChange={(e) => setAudioFileName(e.target.value)}
                          className="w-full px-3 py-2 rounded-lg text-sm"
                          style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text)', border: '1px solid var(--border)' }}
                          placeholder="audio.webm"
                        />
                      </div>
                      <button
                        onClick={handleSaveAudio}
                        disabled={isSavingAudio || !audioFileName.trim() || saveAudioSuccess}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all disabled:opacity-50 mt-5"
                        style={{
                          backgroundColor: saveAudioSuccess ? 'var(--success)' : 'var(--accent)',
                          color: '#fff',
                        }}
                      >
                        {isSavingAudio ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Saving...
                          </>
                        ) : saveAudioSuccess ? (
                          <>
                            <Check className="w-4 h-4" />
                            Saved!
                          </>
                        ) : (
                          <>
                            <Save className="w-4 h-4" />
                            Save Audio
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {noteLoading && (
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading note...</p>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};

export default SaveSummary;

