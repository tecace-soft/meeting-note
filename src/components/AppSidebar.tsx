import React, { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  Check,
  FileText,
  FolderPlus,
  History,
  HardDrive,
  Folder,
  LogIn,
  LogOut,
  Loader2,
  MoreHorizontal,
  Moon,
  Pencil,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../theme/ThemeProvider';
import { supabase } from '../config/supabaseConfig';

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
}

interface SidebarNote {
  id: string;
  name?: string | null;
  created_at?: string | null;
  projects?: Array<string | number> | null;
}

const navItems = [
  { to: '/transcription-summary', label: 'Meeting Note', icon: FileText, end: true as const },
  { to: '/summary-history', label: 'Summary History', icon: History, end: false as const, projects: true as const },
  { to: '/save-summary', label: 'OneDrive', icon: HardDrive, end: false as const },
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
  const { theme, toggleTheme } = useTheme();
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
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [renameProjectId, setRenameProjectId] = useState<string | null>(null);
  const [renameProjectName, setRenameProjectName] = useState('');
  const [renamingProject, setRenamingProject] = useState(false);
  const [renameProjectError, setRenameProjectError] = useState<string | null>(null);
  const [isDeleteProjectOpen, setIsDeleteProjectOpen] = useState(false);
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [deleteProjectError, setDeleteProjectError] = useState<string | null>(null);

  const showProjectNav =
    !collapsed &&
    isAuthenticated &&
    (location.pathname === '/summary-history' || location.pathname === '/project');

  const summaryHistorySectionActive = location.pathname === '/summary-history';

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
      path === '/summary-history' &&
      collapsed &&
      (prev === null || prev !== '/summary-history')
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
          .select('id, name')
          .eq('user_id', user.id)
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
          .select('id, name, created_at, projects')
          .eq('user_id', user.id)
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
    setIsCreateProjectOpen(true);
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.id) return;
    const projectName = newProjectName.trim();
    if (!projectName) {
      setCreateProjectError('Project name is required.');
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
          notes: selectedNoteIds,
        })
        .select('id, name')
        .single();

      if (insertError || !createdProject) throw insertError || new Error('Failed to create project');

      if (selectedNoteIds.length > 0) {
        const { data: selectedNotes, error: notesFetchError } = await supabase
          .from('note')
          .select('id, projects')
          .in('id', selectedNoteIds)
          .eq('user_id', user.id);

        if (notesFetchError) throw notesFetchError;

        const createdProjectId = createdProject.id as string | number;
        const updates = ((selectedNotes as SidebarNote[]) || []).map((note) => {
          const existing = Array.isArray(note.projects) ? note.projects : [];
          const nextProjects = Array.from(
            new Set([...existing.map((p) => String(p)), String(createdProjectId)])
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
    } catch (err: unknown) {
      console.error('Sidebar: failed to create project', err);
      setCreateProjectError(err instanceof Error ? err.message : 'Failed to create project');
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
      setRenameProjectError('Project name is required.');
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

  const handleConfirmDeleteProject = async () => {
    if (!user?.id || !deleteProjectId) return;
    setDeleteProjectError(null);
    setDeletingProject(true);
    try {
      await removeProjectIdFromNotes(deleteProjectId);
      const { error } = await supabase
        .from('project')
        .delete()
        .eq('id', deleteProjectId)
        .eq('user_id', user.id);
      if (error) throw error;

      setProjects((prev) => prev.filter((p) => p.id !== deleteProjectId));
      setNotes((prev) =>
        prev.map((n) => ({
          ...n,
          projects: (n.projects || []).filter((pid) => String(pid) !== String(deleteProjectId)),
        }))
      );
      if (String(activeProjectId) === String(deleteProjectId)) {
        navigate('/summary-history');
      }
      setIsDeleteProjectOpen(false);
      setDeleteProjectId(null);
    } catch (err: unknown) {
      setDeleteProjectError(err instanceof Error ? err.message : 'Failed to delete project');
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

  return (
    <aside
      className={
        mobileOverlay
          ? 'fixed left-0 top-0 z-50 flex h-full flex-col border-r shadow-xl transition-transform duration-200 ease-out'
          : 'flex flex-shrink-0 flex-col border-r transition-[width] duration-200 ease-out'
      }
      style={
        mobileOverlay
          ? {
              width: 'min(260px, 88vw)',
              borderColor: 'var(--border)',
              backgroundColor: 'var(--card)',
              transform: collapsed ? 'translateX(-100%)' : 'translateX(0)',
              pointerEvents: collapsed ? 'none' : 'auto',
            }
          : {
              width: collapsed ? 60 : 240,
              borderColor: 'var(--border)',
              backgroundColor: 'var(--card)',
            }
      }
    >
      <div
        className={`flex items-center border-b py-2 ${
          collapsed ? 'justify-center px-0' : 'justify-between gap-1 px-2'
        }`}
        style={{ borderColor: 'var(--border)' }}
      >
        {!collapsed && (
          <span
            className="flex-1 truncate px-2 text-xs font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            Meeting Note
          </span>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="rounded-md p-2 transition-colors hover:opacity-90"
          style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
          title={collapsed ? 'Expand Menu' : 'Collapse Menu'}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand Menu' : 'Collapse Menu'}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronLeft className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-3" aria-label="Main">
        {navItems.map((item) => {
          const Icon = item.icon;
          if ('projects' in item && item.projects) {
            return (
              <div key={item.to} className="flex flex-col gap-0.5">
                <NavLink
                  to={item.to}
                  end={item.end}
                  title={collapsed ? item.label : undefined}
                  onClick={handleNavPress}
                  className={`flex items-center gap-3 rounded-lg py-2.5 text-sm font-medium opacity-90 transition-opacity hover:opacity-100 ${
                    collapsed ? 'justify-center px-2' : 'px-3'
                  }`}
                  style={({ isActive }) => linkStyle(isActive || summaryHistorySectionActive)}
                >
                  <Icon className="h-4 w-4 flex-shrink-0" aria-hidden />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </NavLink>

                {showProjectNav && (
                  <div
                    className="mb-1 ml-2 mt-0.5 space-y-0.5 border-l pl-2"
                    style={{ borderColor: 'var(--border)' }}
                    role="group"
                    aria-label="Projects"
                  >
                    <button
                      type="button"
                      onClick={handleOpenCreateProject}
                      className="flex w-full items-center gap-2 rounded-md py-1.5 pl-1 pr-2 text-left text-xs font-medium opacity-90 transition-opacity hover:opacity-100"
                      style={linkStyle(false)}
                    >
                      <FolderPlus className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                      <span className="truncate">New Project</span>
                    </button>

                    {projectsLoading ? (
                      <div className="flex items-center gap-2 py-2 pl-1">
                        <Loader2
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
                                className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-1 pr-1 text-xs font-medium opacity-90 transition-opacity hover:opacity-100"
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
                              className="absolute right-0 top-full z-30 mt-1 w-44 rounded-xl border p-2 shadow-lg"
                              style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
                            >
                              <button
                                type="button"
                                onClick={() => handleOpenRenameProject(p)}
                                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
                                style={{ color: 'var(--text)' }}
                              >
                                <Pencil className="h-4 w-4" aria-hidden />
                                Rename project
                              </button>
                              <div
                                className="my-1 h-px"
                                style={{ backgroundColor: 'var(--border)' }}
                              />
                              <button
                                type="button"
                                onClick={() => handleOpenDeleteProject(p.id)}
                                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm"
                                style={{ color: 'var(--error)' }}
                              >
                                <Trash2 className="h-4 w-4" aria-hidden />
                                Delete project
                              </button>
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
              title={collapsed ? item.label : undefined}
              onClick={handleNavPress}
              className={`flex items-center gap-3 rounded-lg py-2.5 text-sm font-medium opacity-90 transition-opacity hover:opacity-100 ${
                collapsed ? 'justify-center px-2' : 'px-3'
              }`}
              style={({ isActive }) => linkStyle(isActive)}
            >
              <Icon className="h-4 w-4 flex-shrink-0" aria-hidden />
              {!collapsed && <span className="truncate">{item.label}</span>}
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
          className={`flex items-center gap-3 rounded-lg py-2 text-sm transition-colors hover:opacity-95 ${
            collapsed ? 'justify-center px-2' : 'px-3'
          }`}
          style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
          title={collapsed ? (theme === 'light' ? 'Dark Mode' : 'Light Mode') : undefined}
        >
          {theme === 'light' ? (
            <Moon className="h-4 w-4 flex-shrink-0" aria-hidden />
          ) : (
            <Sun className="h-4 w-4 flex-shrink-0" aria-hidden />
          )}
          {!collapsed && <span>Theme</span>}
        </button>

        {isAuthenticated && user ? (
          <>
            <div
              className={`flex items-center gap-2 rounded-lg py-1 ${collapsed ? 'justify-center px-0' : 'px-2'}`}
              style={{ color: 'var(--text)' }}
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
            </div>
            <button
              type="button"
              onClick={logout}
              className={`flex items-center gap-3 rounded-lg py-2.5 text-sm font-medium transition-colors hover:opacity-95 ${
                collapsed ? 'justify-center px-2' : 'px-3'
              }`}
              style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
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
            <LogIn className="h-4 w-4 flex-shrink-0" aria-hidden />
            {!collapsed && <span>Sign In</span>}
          </NavLink>
        )}
      </div>

      {isCreateProjectOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
        >
          <div
            className="w-full max-w-lg rounded-lg border p-4 sm:p-5"
            style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
                New Project
              </h3>
              <button
                type="button"
                onClick={() => setIsCreateProjectOpen(false)}
                className="rounded-md p-1.5"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                aria-label="Close modal"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            <form onSubmit={handleCreateProject} className="space-y-3">
              <div>
                <label
                  htmlFor="new-project-name"
                  className="mb-1 block text-xs font-medium uppercase tracking-wide"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Project Name
                </label>
                <input
                  id="new-project-name"
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  maxLength={200}
                  placeholder="Enter project name"
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  style={{
                    backgroundColor: 'var(--bg)',
                    borderColor: 'var(--border)',
                    color: 'var(--text)',
                  }}
                  disabled={creatingProject}
                />
              </div>

              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Select Notes
                </p>
                <div
                  className="custom-scrollbar max-h-64 space-y-1 overflow-y-auto rounded-lg border p-2"
                  style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-secondary)' }}
                >
                  {notesLoading ? (
                    <div className="flex items-center gap-2 px-1 py-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      Loading notes...
                    </div>
                  ) : sortedNotes.length === 0 ? (
                    <p className="px-1 py-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                      No notes found.
                    </p>
                  ) : (
                    sortedNotes.map((note) => {
                      const checked = selectedNoteIds.includes(note.id);
                      return (
                        <button
                          key={note.id}
                          type="button"
                          onClick={() => toggleNoteSelection(note.id)}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left"
                          style={{
                            backgroundColor: checked ? 'var(--accent-light)' : 'transparent',
                            color: checked ? 'var(--accent)' : 'var(--text)',
                          }}
                        >
                          <span
                            className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border"
                            style={{
                              borderColor: checked ? 'var(--accent)' : 'var(--border)',
                              backgroundColor: checked ? 'var(--accent)' : 'transparent',
                              color: '#fff',
                            }}
                          >
                            {checked ? <Check className="h-3 w-3" aria-hidden /> : null}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {note.name?.trim() || 'Untitled note'}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {createProjectError ? (
                <p className="text-xs" style={{ color: 'var(--error)' }}>
                  {createProjectError}
                </p>
              ) : null}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setIsCreateProjectOpen(false)}
                  className="rounded-lg px-3 py-2 text-sm"
                  style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                  disabled={creatingProject}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-60"
                  style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                  disabled={creatingProject || !newProjectName.trim()}
                >
                  {creatingProject ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  Create Project
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
            className="w-full max-w-sm rounded-lg border p-4 sm:p-5"
            style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
          >
            <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
              Delete project?
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
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                disabled={deletingProject}
              >
                Cancel
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
                {deletingProject ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};

export default AppSidebar;
