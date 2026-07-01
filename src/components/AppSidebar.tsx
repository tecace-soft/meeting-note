import React, { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  ChartBarVertical01,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  CloseMd,
  Cloud,
  EditPencilLine01,
  FileAdd,
  FileDocument,
  Folder,
  FolderAdd,
  ListOrdered,
  Loading,
  LogOut,
  Moon,
  MoreHorizontal,
  Settings,
  ShareAndroid,
  Sun,
  TrashFull,
  UserAdd,
} from 'react-coolicons';
import { IconButton } from '../ui/wantedCompat';
import { useAuth } from '../context/AuthContext';
import { useLanguage, type TranslationKey } from '../context/LanguageContext';
import { useTheme } from '../theme/ThemeProvider';
import { supabase } from '../config/supabaseConfig';
import { normalizeTranscript } from '../lib/transcriptSegments';
import { formatDurationMeta, getNoteDurationSeconds } from '../lib/noteDuration';
import { canAccessTranscriptionModelTest, isAdminMicrosoftUser } from '../lib/adminAccess';
import ShareProjectModal from './ShareProjectModal';
import tecaceLogoNavy from '../assets/tecace-logo-navy.svg';
import tecaceLogoWhite from '../assets/tecace-logo-white.svg';

const STORAGE_KEY = 'meeting_note_sidebar_collapsed';
const MOBILE_STORAGE_KEY = 'meeting_note_sidebar_mobile_collapsed';

export function readSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** Mobile drawer: default collapsed when key unset. */
export function readMobileSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const v = window.localStorage.getItem(MOBILE_STORAGE_KEY);
    if (v === null) return true;
    return v === '1';
  } catch {
    return true;
  }
}

export function writeMobileSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MOBILE_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    /* ignore */
  }
}

interface SidebarProject {
  id: string;
  name: string;
  user_id?: string | null;
  shared_users?: string[] | null;
}

interface SidebarNote {
  id: string;
  name?: string | null;
  created_at?: string | null;
  duration_seconds?: number | null;
  projects?: Array<string | number> | null;
  summary?: string | null;
  summary_edit?: string | null;
  transcription?: string | null;
  diarization?: unknown;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
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

function getNoteSummaryText(note: SidebarNote): string {
  return (note.summary_edit?.trim() || note.summary?.trim() || '').trim();
}

function getNoteTranscriptionText(note: SidebarNote): string {
  const plain = note.transcription?.trim();
  if (plain) return plain;
  const diarized = note.diarization;
  const segments = normalizeTranscript(diarized);
  if (segments.length === 0) return '';
  return segments.map((s) => `${s.speaker}: ${s.text}`).join('\n\n');
}

function getNoteDurationMeta(note: SidebarNote): string | null {
  return formatDurationMeta(getNoteDurationSeconds(note));
}

const navItems = [
  { to: '/transcription-summary', labelKey: 'meetingNote' as TranslationKey, icon: FileDocument, end: true as const },
  { to: '/history', labelKey: 'history' as TranslationKey, icon: ListOrdered, end: false as const, projects: true as const },
  { to: '/save-summary', label: 'OneDrive', icon: Cloud, end: false as const },
] as const;

interface AppSidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onExpandSidebar: () => void;
  mobileOverlay?: boolean;
  onMobileOverlayNavigate?: () => void;
}

const AppSidebar: React.FC<AppSidebarProps> = ({
  collapsed,
  onToggleCollapsed,
  onExpandSidebar,
  mobileOverlay = false,
  onMobileOverlayNavigate,
}) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout, isAuthenticated } = useAuth();
  const { t } = useLanguage();
  const { theme, toggleTheme } = useTheme();
  const tecaceLogo = theme === 'dark' ? tecaceLogoWhite : tecaceLogoNavy;
  const prevPathRef = useRef<string | null>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  const [projects, setProjects] = useState<SidebarProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [notes, setNotes] = useState<SidebarNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [creatingProject, setCreatingProject] = useState(false);
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);
  const [createModalExpandedNoteId, setCreateModalExpandedNoteId] = useState<string | null>(null);
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [renameProjectId, setRenameProjectId] = useState<string | null>(null);
  const [renameProjectName, setRenameProjectName] = useState('');
  const [renamingProject, setRenamingProject] = useState(false);
  const [renameProjectError, setRenameProjectError] = useState<string | null>(null);
  const [isDeleteProjectOpen, setIsDeleteProjectOpen] = useState(false);
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [deleteProjectError, setDeleteProjectError] = useState<string | null>(null);
  const [shareProjectTarget, setShareProjectTarget] = useState<SidebarProject | null>(null);

  const showProjectNav =
    !collapsed &&
    isAuthenticated &&
    (location.pathname === '/history' || location.pathname === '/summary-history' || location.pathname === '/project');

  const summaryHistorySectionActive = location.pathname === '/history' || location.pathname === '/summary-history';
  const visibleNavItems = [
    ...navItems,
    ...(isAdminMicrosoftUser(user?.id)
      ? [
          { to: '/admin-controls', labelKey: 'adminControls' as TranslationKey, icon: Settings, end: false as const },
          { to: '/admin-analytics', labelKey: 'adminAnalytics' as TranslationKey, icon: ChartBarVertical01, end: false as const },
        ]
      : []),
    ...(canAccessTranscriptionModelTest(user?.id)
      ? [{ to: '/transcription-model-test', label: 'Model Test', icon: FileDocument, end: false as const }]
      : []),
  ];

  const getNavItemLabel = (item: { label?: string; labelKey?: TranslationKey }): string =>
    item.labelKey ? t(item.labelKey) : item.label ?? '';

  const activeProjectId =
    location.pathname === '/project'
      ? new URLSearchParams(location.search).get('id')
      : null;

  const sortedNotes = [...notes].sort((a, b) => {
    const da = a.created_at ? new Date(a.created_at).getTime() : 0;
    const db = b.created_at ? new Date(b.created_at).getTime() : 0;
    return db - da;
  });

  const toProjectIdValue = (id: string): string | number => {
    const asNumber = Number(id);
    return Number.isNaN(asNumber) ? id : asNumber;
  };

  const removeProjectIdFromNotes = async (projectId: string) => {
    if (!user?.id) return;
    const projectIdValue = toProjectIdValue(projectId);
    const projectIdText = String(projectIdValue);
    const { data, error } = await supabase
      .from('note')
      .select('id, projects')
      .eq('user_id', user.id)
      .contains('projects', [projectIdValue]);

    if (error) throw error;

    const updates = ((data as SidebarNote[]) || []).map((note) => {
      const current = Array.isArray(note.projects) ? note.projects : [];
      const next = current.filter((p) => String(p) !== projectIdText);
      return supabase.from('note').update({ projects: next }).eq('id', note.id).eq('user_id', user.id);
    });

    if (updates.length > 0) {
      const results = await Promise.all(updates);
      const failed = results.find((r) => r.error);
      if (failed?.error) throw failed.error;
    }
  };

  useEffect(() => {
    const path = location.pathname;
    const prev = prevPathRef.current;
    if (
      (path === '/history' || path === '/summary-history') &&
      collapsed &&
      (prev === null || (prev !== '/history' && prev !== '/summary-history'))
    ) {
      onExpandSidebar();
    }
    prevPathRef.current = path;
  }, [location.pathname, collapsed, onExpandSidebar]);

  useEffect(() => {
    if (!openProjectMenuId) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (!projectMenuRef.current) return;
      if (!projectMenuRef.current.contains(event.target as Node)) {
        setOpenProjectMenuId(null);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [openProjectMenuId]);

  useEffect(() => {
    if (!isAuthenticated || !user?.id) {
      setProjects([]);
      setProjectsLoading(false);
      setNotes([]);
      setNotesLoading(false);
      return;
    }

    let cancelled = false;

    const load = async () => {
      try {
        setProjectsLoading(true);
        const { data, error } = await supabase
          .from('project')
          .select('id, name, user_id, shared_users')
          .order('name', { ascending: true });

        if (error) throw error;
        if (!cancelled) setProjects((data as SidebarProject[]) || []);
      } catch (err) {
        console.error('Sidebar: failed to load projects', err);
        if (!cancelled) setProjects([]);
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.id]);

  useEffect(() => {
    if (!isAuthenticated || !user?.id) {
      setNotes([]);
      setNotesLoading(false);
      return;
    }

    let cancelled = false;

    const loadNotes = async () => {
      try {
        setNotesLoading(true);
        const { data, error } = await supabase
          .from('note')
          .select('*')
          .or(`user_id.eq.${user.id},shared_users.cs.{${user.id}}`)
          .order('created_at', { ascending: false });

        if (error) throw error;
        if (!cancelled) setNotes((data as SidebarNote[]) || []);
      } catch (err) {
        console.error('Sidebar: failed to load notes', err);
        if (!cancelled) setNotes([]);
      } finally {
        if (!cancelled) setNotesLoading(false);
      }
    };

    void loadNotes();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.id]);

  const toggleNoteSelection = (noteId: string) => {
    setSelectedNoteIds((prev) =>
      prev.includes(noteId) ? prev.filter((id) => id !== noteId) : [...prev, noteId]
    );
  };

  const handleOpenCreateProject = () => {
    setCreateProjectError(null);
    setNewProjectName('');
    setSelectedNoteIds([]);
    setCreateModalExpandedNoteId(null);
    setIsCreateProjectOpen(true);
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.id) return;
    const projectName = newProjectName.trim();
    if (!projectName) {
      setCreateProjectError(t('projectNameRequired'));
      return;
    }

    setCreateProjectError(null);
    setCreatingProject(true);

    try {
      const { data: createdProject, error: insertError } = await supabase
        .from('project')
        .insert({
          name: projectName,
          user_id: user.id,
        })
        .select('id, name')
        .single();

      if (insertError || !createdProject) throw insertError || new Error('Failed to create project');

      if (selectedNoteIds.length > 0) {
        const createdProjectId = String(createdProject.id);
        const updates = selectedNoteIds.map((noteId) =>
          supabase.rpc('add_accessible_note_to_project', {
            p_note_id: noteId,
            p_project_id: createdProjectId,
          })
        );
        const results = await Promise.all(updates);
        const failed = results.find((r) => r.error);
        if (failed?.error) throw failed.error;
      }

      setProjects((prev) =>
        [...prev, createdProject as SidebarProject].sort((a, b) => a.name.localeCompare(b.name))
      );
      setIsCreateProjectOpen(false);
      setNewProjectName('');
      setSelectedNoteIds([]);
      setCreateModalExpandedNoteId(null);
    } catch (err: unknown) {
      console.error('Sidebar: failed to create project', err);
      setCreateProjectError(getErrorMessage(err, 'Failed to create project'));
    } finally {
      setCreatingProject(false);
    }
  };

  const handleOpenRenameProject = (project: SidebarProject) => {
    setOpenProjectMenuId(null);
    setRenameProjectError(null);
    setRenameProjectId(project.id);
    setRenameProjectName(project.name);
  };

  const handleCancelRenameProject = () => {
    setRenameProjectError(null);
    setRenameProjectId(null);
    setRenameProjectName('');
  };

  const handleRenameProject = async () => {
    if (!user?.id || !renameProjectId || renamingProject) return;
    const name = renameProjectName.trim();
    if (!name) {
      setRenameProjectError(t('projectNameRequired'));
      return;
    }

    setRenameProjectError(null);
    setRenamingProject(true);
    try {
      const { error } = await supabase
        .from('project')
        .update({ name })
        .eq('id', renameProjectId)
        .eq('user_id', user.id);
      if (error) throw error;

      setProjects((prev) =>
        prev
          .map((p) => (p.id === renameProjectId ? { ...p, name } : p))
          .sort((a, b) => a.name.localeCompare(b.name))
      );
      handleCancelRenameProject();
    } catch (err: unknown) {
      setRenameProjectError(err instanceof Error ? err.message : 'Failed to rename project');
    } finally {
      setRenamingProject(false);
    }
  };

  const handleOpenDeleteProject = (projectId: string) => {
    setOpenProjectMenuId(null);
    setDeleteProjectError(null);
    setDeleteProjectId(projectId);
    setIsDeleteProjectOpen(true);
  };

  const handleOpenShareProject = (project: SidebarProject) => {
    setOpenProjectMenuId(null);
    setShareProjectTarget(project);
  };

  const handleProjectShared = (projectId: string, sharedUserIds: string[]) => {
    setProjects((prev) =>
      prev.map((project) => (project.id === projectId ? { ...project, shared_users: sharedUserIds } : project))
    );
  };

  const handleConfirmDeleteProject = async () => {
    if (!user?.id || !deleteProjectId) return;
    setDeleteProjectError(null);
    setDeletingProject(true);
    try {
      const { error } = await supabase.rpc('delete_owned_project', {
        p_project_id: deleteProjectId,
      });
      if (error) throw error;

      setProjects((prev) => prev.filter((p) => p.id !== deleteProjectId));
      setNotes((prev) =>
        prev.map((n) => ({
          ...n,
          projects: (n.projects || []).filter((pid) => String(pid) !== String(deleteProjectId)),
        }))
      );
      if (String(activeProjectId) === String(deleteProjectId)) {
        navigate('/history');
      }
      setIsDeleteProjectOpen(false);
      setDeleteProjectId(null);
    } catch (err: unknown) {
      setDeleteProjectError(getErrorMessage(err, 'Failed to delete project'));
    } finally {
      setDeletingProject(false);
    }
  };

  const linkStyle = useCallback(
    (isActive: boolean) => ({
      backgroundColor: isActive ? 'var(--accent-light)' : 'transparent',
      color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
    }),
    []
  );

  const handleNavPress = () => {
    if (collapsed) onExpandSidebar();
    else if (mobileOverlay) onMobileOverlayNavigate?.();
  };

  const handleOpenAccountSettings = () => {
    navigate('/account-settings');
    if (mobileOverlay) onMobileOverlayNavigate?.();
  };

  return (
    <aside
      className={
        mobileOverlay
          ? 'fixed left-0 top-0 z-50 flex h-full flex-col transition-transform duration-200 ease-out'
          : 'flex flex-shrink-0 flex-col transition-[width] duration-200 ease-out'
      }
      style={
        mobileOverlay
          ? {
              width: 'min(260px, 88vw)',
              borderRight: '1px solid color-mix(in srgb, var(--border) 40%, transparent)',
              backgroundColor: 'var(--surface)',
              transform: collapsed ? 'translateX(-100%)' : 'translateX(0)',
              pointerEvents: collapsed ? 'none' : 'auto',
              boxShadow: collapsed ? undefined : 'var(--shadow-lg)',
            }
          : {
              width: collapsed ? 60 : 240,
              borderRight: '1px solid color-mix(in srgb, var(--border) 40%, transparent)',
              backgroundColor: 'var(--surface)',
            }
      }
    >
      <div
        className={`flex items-center py-2 ${
          collapsed ? 'flex-col justify-center gap-1 px-0' : 'justify-between gap-2 px-2'
        }`}
        style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 45%, transparent)' }}
      >
        {!collapsed ? (
          <div className="flex min-w-0 flex-1 flex-col px-2 py-1">
            <img
              src={tecaceLogo}
              alt="TecAce"
              className="h-auto w-[7.75rem] max-w-full"
            />
            <span
              className="mt-1 truncate text-[10px] font-semibold uppercase tracking-[0.16em]"
              style={{ color: 'var(--text-muted)', marginLeft: 14 }}
            >
              Meeting Note
            </span>
          </div>
        ) : null}
        <IconButton
          type="button"
          variant="background"
          className="sidebar-toggle-btn"
          onClick={onToggleCollapsed}
          title={collapsed ? 'Expand Menu' : 'Collapse Menu'}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand Menu' : 'Collapse Menu'}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronLeft className="h-4 w-4" aria-hidden />
          )}
        </IconButton>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-3" aria-label="Main">
        {visibleNavItems.map((item) => {
          const Icon = item.icon;
          if ('projects' in item && item.projects) {
            return (
              <div key={item.to} className="flex flex-col gap-0.5">
                <NavLink
                  to={item.to}
                  end={item.end}
                  title={collapsed ? getNavItemLabel(item) : undefined}
                  onClick={handleNavPress}
                  className={({ isActive }) =>
                    `sidebar-nav-link flex items-center gap-3 rounded-lg py-2.5 text-sm font-medium opacity-90 transition-opacity ${
                      isActive || summaryHistorySectionActive ? 'sidebar-nav-link-active' : 'hover:opacity-90'
                    } ${
                      collapsed ? 'justify-center px-2' : 'px-3'
                    }`
                  }
                  style={({ isActive }) => linkStyle(isActive || summaryHistorySectionActive)}
                >
                  <Icon className="h-4 w-4 flex-shrink-0" aria-hidden />
                  {!collapsed && <span className="truncate">{getNavItemLabel(item)}</span>}
                </NavLink>

                {showProjectNav && (
                  <div
                    className="mb-1 ml-2 mt-0.5 space-y-0.5 border-l pl-2"
                    style={{ borderColor: 'var(--border)' }}
                    role="group"
                    aria-label={t('projects')}
                  >
                    <button
                      type="button"
                      onClick={handleOpenCreateProject}
                      className="sidebar-footer-action flex w-full items-center gap-2 rounded-md py-1.5 pl-1 pr-2 text-left text-xs font-medium transition-opacity hover:opacity-90"
                      style={linkStyle(false)}
                    >
                      <FolderAdd className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                      <span className="truncate">{t('newProject')}</span>
                    </button>

                    {projectsLoading ? (
                      <div className="flex items-center gap-2 py-2 pl-1">
                        <Loading
                          className="h-3.5 w-3.5 flex-shrink-0 animate-spin"
                          style={{ color: 'var(--text-muted)' }}
                          aria-hidden
                        />
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          Loading...
                        </span>
                      </div>
                    ) : projects.length === 0 ? (
                      <p className="py-1.5 pl-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                        No folders yet
                      </p>
                    ) : (
                      projects.map((p) => (
                        <div key={p.id} className="relative" ref={openProjectMenuId === p.id ? projectMenuRef : undefined}>
                          <div className="flex items-center gap-1">
                            {p.user_id !== user?.id ? (
                              <span className="sr-only">Shared project</span>
                            ) : null}
                            {renameProjectId === p.id ? (
                              <div
                                className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-1 pr-1 text-xs font-medium"
                                style={{ backgroundColor: 'var(--accent-light)', color: 'var(--accent)' }}
                              >
                                <Folder className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                                <input
                                  autoFocus
                                  value={renameProjectName}
                                  onChange={(e) => setRenameProjectName(e.target.value)}
                                  onBlur={() => {
                                    void handleRenameProject();
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      void handleRenameProject();
                                    } else if (e.key === 'Escape') {
                                      e.preventDefault();
                                      handleCancelRenameProject();
                                    }
                                  }}
                                  disabled={renamingProject}
                                  maxLength={200}
                                  className="min-w-0 flex-1 bg-transparent p-0 text-xs font-medium outline-none"
                                  style={{ color: 'var(--accent)' }}
                                />
                              </div>
                            ) : (
                              <NavLink
                                to={`/project?id=${encodeURIComponent(p.id)}`}
                                title={p.name}
                                onClick={handleNavPress}
                                className={({ isActive }) =>
                                  `sidebar-nav-link flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-1 pr-1 text-xs font-medium opacity-90 transition-opacity ${
                                    isActive && String(activeProjectId) === String(p.id) ? 'sidebar-nav-link-active' : 'hover:opacity-90'
                                  }`
                                }
                                style={({ isActive }) =>
                                  linkStyle(isActive && String(activeProjectId) === String(p.id))
                                }
                              >
                                <Folder className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                              </NavLink>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                setOpenProjectMenuId((prev) => (prev === p.id ? null : p.id))
                              }
                              disabled={renameProjectId === p.id}
                              className="rounded-md p-1"
                              style={{ color: 'var(--text-muted)' }}
                              aria-label={`Project actions for ${p.name}`}
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
                            </button>
                          </div>

                          {renameProjectId === p.id && renameProjectError ? (
                            <p className="px-1 pb-1 text-[11px]" style={{ color: 'var(--error)' }}>
                              {renameProjectError}
                            </p>
                          ) : null}

                          {openProjectMenuId === p.id ? (
                            <div
                              className="absolute right-0 top-full z-30 mt-1 w-44 rounded-xl p-2 app-surface-elevated"
                              style={{ backgroundColor: 'var(--surface)' }}
                            >
                              {p.user_id === user?.id ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setOpenProjectMenuId(null);
                                      navigate(`/project?id=${encodeURIComponent(p.id)}&addNotes=1`);
                                      if (mobileOverlay) onMobileOverlayNavigate?.();
                                    }}
                                    className="chat-menu-item flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
                                    style={{ color: 'var(--text)' }}
                                  >
                                    <FileAdd className="h-4 w-4" aria-hidden />
                                    Add notes
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleOpenShareProject(p)}
                                    className="chat-menu-item flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
                                    style={{ color: 'var(--text)' }}
                                  >
                                    <ShareAndroid className="h-4 w-4" aria-hidden />
                                    Share project
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleOpenRenameProject(p)}
                                    className="chat-menu-item flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
                                    style={{ color: 'var(--text)' }}
                                  >
                                    <EditPencilLine01 className="h-4 w-4" aria-hidden />
                                    Rename project
                                  </button>
                                  <div
                                    className="my-1 h-px"
                                    style={{ backgroundColor: 'var(--border)' }}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => handleOpenDeleteProject(p.id)}
                                    className="chat-menu-item chat-menu-item-danger flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
                                    style={{ color: 'var(--error)' }}
                                  >
                                    <TrashFull className="h-4 w-4" aria-hidden />
                                    {t('deleteProject')}
                                  </button>
                                </>
                              ) : (
                                <div className="px-2 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                                  Shared with you
                                </div>
                              )}
                            </div>
                          ) : null}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          }

          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={collapsed ? getNavItemLabel(item) : undefined}
              onClick={handleNavPress}
              className={({ isActive }) =>
                `sidebar-nav-link flex items-center gap-3 rounded-lg py-2.5 text-sm font-medium opacity-90 transition-opacity ${
                  isActive ? 'sidebar-nav-link-active' : 'hover:opacity-90'
                } ${
                  collapsed ? 'justify-center px-2' : 'px-3'
                }`
              }
              style={({ isActive }) => linkStyle(isActive)}
            >
              <Icon className="h-4 w-4 flex-shrink-0" aria-hidden />
              {!collapsed && <span className="truncate">{getNavItemLabel(item)}</span>}
            </NavLink>
          );
        })}
      </nav>

      <div
        className="mt-auto flex flex-col gap-2 border-t p-2"
        style={{ borderColor: 'var(--border)' }}
      >
        <button
          type="button"
          onClick={toggleTheme}
          className={`sidebar-footer-action flex items-center gap-3 rounded-lg py-2 text-sm transition-opacity hover:opacity-90 ${
            collapsed ? 'justify-center px-2' : 'px-3'
          }`}
          style={{ color: 'var(--text-secondary)' }}
          title={collapsed ? (theme === 'light' ? t('darkMode') : t('lightMode')) : undefined}
        >
          {theme === 'light' ? (
            <Moon className="h-4 w-4 flex-shrink-0" aria-hidden />
          ) : (
            <Sun className="h-4 w-4 flex-shrink-0" aria-hidden />
          )}
          {!collapsed && <span>{t('theme')}</span>}
        </button>

        {isAuthenticated && user ? (
          <>
            <button
              type="button"
              onClick={handleOpenAccountSettings}
              className={`sidebar-footer-action flex w-full items-center gap-2 rounded-lg py-1 text-left transition-opacity hover:opacity-90 ${collapsed ? 'justify-center px-0' : 'px-2'}`}
              style={{ color: 'var(--text)' }}
              title={collapsed ? t('accountSettings') : undefined}
              aria-label={t('openAccountSettings')}
            >
              <div
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-sm font-medium"
                style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                title={user.displayName}
              >
                {user.displayName.charAt(0).toUpperCase()}
              </div>
              {!collapsed && (
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{user.displayName}</p>
                  <p className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                    {user.email}
                  </p>
                </div>
              )}
            </button>
            <button
              type="button"
              onClick={logout}
              className={`sidebar-footer-action flex items-center gap-3 rounded-lg py-2.5 text-sm font-medium transition-opacity hover:opacity-90 ${
                collapsed ? 'justify-center px-2' : 'px-3'
              }`}
              style={{ color: 'var(--text-secondary)' }}
              title={collapsed ? 'Sign Out' : undefined}
            >
              <LogOut className="h-4 w-4 flex-shrink-0" aria-hidden />
              {!collapsed && <span>Sign Out</span>}
            </button>
          </>
        ) : (
          <NavLink
            to="/"
            onClick={handleNavPress}
            className={`flex items-center gap-3 rounded-lg py-2.5 text-sm font-medium ${
              collapsed ? 'justify-center px-2' : 'px-3'
            }`}
            style={{ backgroundColor: 'var(--accent-light)', color: 'var(--accent)' }}
            title="Sign In"
          >
            <UserAdd className="h-4 w-4 flex-shrink-0" aria-hidden />
            {!collapsed && <span>Sign In</span>}
          </NavLink>
        )}
      </div>

      {isCreateProjectOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          role="presentation"
          onClick={() => {
            if (!creatingProject) {
              setIsCreateProjectOpen(false);
              setCreateModalExpandedNoteId(null);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-project-dialog-title"
            className="project-note-picker-modal flex max-h-[min(92vh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-xl app-surface-elevated sm:max-w-6xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex shrink-0 items-center justify-between gap-3 px-4 py-4 sm:px-6 sm:py-5"
              style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 45%, transparent)' }}
            >
              <div>
                <h3 id="new-project-dialog-title" className="text-lg font-semibold sm:text-xl" style={{ color: 'var(--text)' }}>
                  {t('newProject')}
                </h3>
                <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Name your folder and choose which meeting notes to include.
                </p>
              </div>
              <IconButton
                type="button"
                variant="background"
                onClick={() => {
                  setIsCreateProjectOpen(false);
                  setCreateModalExpandedNoteId(null);
                }}
                aria-label="Close modal"
                disabled={creatingProject}
              >
                <CloseMd className="h-5 w-5" aria-hidden />
              </IconButton>
            </div>

            <form onSubmit={handleCreateProject} className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="shrink-0 space-y-4 px-4 pb-2 pt-4 sm:px-6 sm:pt-5">
                <div>
                  <label
                    htmlFor="new-project-name"
                    className="mb-1.5 block text-sm font-medium"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {t('projectName')}
                  </label>
                  <input
                    id="new-project-name"
                    type="text"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    maxLength={200}
                    placeholder="e.g. Q1 customer calls"
                    className="input w-full px-3 py-2.5 text-base"
                    style={{
                      backgroundColor: 'var(--bg)',
                      color: 'var(--text)',
                    }}
                    disabled={creatingProject}
                  />
                </div>
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                    Include notes
                  </p>
                  <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                    Check notes to add to this project. Expand a row to read the summary and transcription.
                  </p>
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col px-4 pb-2 sm:px-6">
                <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">
                  {notesLoading ? (
                    <div className="flex min-h-[12rem] flex-1 items-center justify-center py-6">
                        <div className="rounded-lg p-8 text-center" style={{ backgroundColor: 'var(--surface-subtle)' }}>
                        <div
                          className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-b-2"
                          style={{ borderColor: 'var(--accent)' }}
                          aria-hidden
                        />
                        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                          Loading notes...
                        </p>
                      </div>
                    </div>
                  ) : sortedNotes.length === 0 ? (
                    <div className="flex min-h-[12rem] flex-1 items-center justify-center py-6">
                      <div className="rounded-lg p-8 text-center" style={{ backgroundColor: 'var(--surface-subtle)' }}>
                        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                          No notes found.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <ul className="summary-note-list project-note-picker-list">
                      {sortedNotes.map((note) => {
                        const checked = selectedNoteIds.includes(note.id);
                        const expanded = createModalExpandedNoteId === note.id;
                        const title = note.name?.trim() || 'Untitled note';
                        const summaryPreview = getNoteSummaryText(note);
                        const transcriptionPreview = getNoteTranscriptionText(note);
                        return (
                          <li
                            key={note.id}
                            className={`summary-note-row project-note-picker-row ${expanded || checked ? 'summary-note-row-active' : ''}`}
                          >
                            <span className="summary-note-row-rail" aria-hidden />
                            <div
                              onClick={() =>
                                setCreateModalExpandedNoteId((id) => (id === note.id ? null : note.id))
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
                                  onChange={() => toggleNoteSelection(note.id)}
                                  className="sr-only"
                                  aria-label={`Include ${title} in project`}
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
                                  title={`${formatNoteModalDate(note.created_at)}${getNoteDurationMeta(note) ? `, ${getNoteDurationMeta(note)}` : ''}`}
                                >
                                  {formatNoteModalDate(note.created_at)}
                                  {getNoteDurationMeta(note) ? (
                                    <>
                                      <span className="mx-1.5" aria-hidden>•</span>
                                      {getNoteDurationMeta(note)}
                                    </>
                                  ) : null}
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
                                  <h4 className="mb-2 text-sm font-semibold" style={{ color: 'var(--text)' }}>
                                    {t('summary')}
                                  </h4>
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
                                  <h4 className="mb-2 text-sm font-semibold" style={{ color: 'var(--text)' }}>
                                    {t('transcription')}
                                  </h4>
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

              {createProjectError ? (
                <p className="shrink-0 px-4 py-2 text-sm sm:px-6" style={{ color: 'var(--error)' }}>
                  {createProjectError}
                </p>
              ) : null}

              <div
                className="flex shrink-0 justify-end gap-3 border-t px-4 py-4 sm:px-6"
                style={{ borderColor: 'var(--border)' }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setIsCreateProjectOpen(false);
                    setCreateModalExpandedNoteId(null);
                  }}
                  className="rounded-lg px-4 py-2.5 text-sm font-medium"
                  style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                  disabled={creatingProject}
                >
                  {t('cancel')}
                </button>
                <button
                  type="submit"
                  className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium disabled:opacity-60"
                  style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                  disabled={creatingProject || !newProjectName.trim()}
                >
                  {creatingProject ? <Loading className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  Create project
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isDeleteProjectOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
        >
          <div
            className="w-full max-w-sm rounded-lg app-surface-elevated p-4 sm:p-5"
          style={{ backgroundColor: 'var(--surface)' }}
          >
            <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
              {t('deleteProject')}?
            </h3>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              This will remove the project and unlink it from all notes. Notes are not deleted.
            </p>
            {deleteProjectError ? (
              <p className="mt-2 text-xs" style={{ color: 'var(--error)' }}>
                {deleteProjectError}
              </p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsDeleteProjectOpen(false)}
                className="rounded-lg px-3 py-2 text-sm"
                style={{ backgroundColor: 'var(--surface-subtle)', color: 'var(--text-secondary)' }}
                disabled={deletingProject}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleConfirmDeleteProject();
                }}
                className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-60"
                style={{ backgroundColor: 'var(--error)', color: '#fff' }}
                disabled={deletingProject}
              >
                {deletingProject ? <Loading className="h-4 w-4 animate-spin" aria-hidden /> : null}
                {t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}
      <ShareProjectModal
        isOpen={Boolean(shareProjectTarget)}
        projectId={shareProjectTarget?.id ?? null}
        projectTitle={shareProjectTarget?.name}
        existingSharedUserIds={shareProjectTarget?.shared_users ?? []}
        onClose={() => setShareProjectTarget(null)}
        onShared={handleProjectShared}
      />
    </aside>
  );
};

export default AppSidebar;
