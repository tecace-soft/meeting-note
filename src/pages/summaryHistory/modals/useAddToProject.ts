import { useState, type Dispatch, type SetStateAction } from 'react';
import { supabase } from '../../../config/supabaseConfig';
import type { Note } from '../types';

export interface ProjectOption {
  id: string;
  name: string;
  notes?: Array<string | number> | null;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

function toProjectIdValue(id: string): string | number {
  const asNumber = Number(id);
  return Number.isNaN(asNumber) ? id : asNumber;
}

export interface UseAddToProjectOptions {
  userId: string | undefined;
  /** The list owns the notes; the added project is applied to it after the rpc succeeds. */
  setNotes: Dispatch<SetStateAction<Note[]>>;
  /** Closes the row action menu when the dialog is opened from it. */
  closeNoteMenu: () => void;
}

/** State and actions of the "add note to project" dialog. */
export function useAddToProject(options: UseAddToProjectOptions) {
  const { userId, setNotes, closeNoteMenu } = options;
  const [addToProjectNote, setAddToProjectNote] = useState<Note | null>(null);
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [addToProjectSavingId, setAddToProjectSavingId] = useState<string | null>(null);
  const [addToProjectError, setAddToProjectError] = useState<string | null>(null);

  const openAddToProject = async (note: Note) => {
    closeNoteMenu();
    setAddToProjectNote(note);
    setAddToProjectError(null);
    if (!userId) return;
    setProjectsLoading(true);
    try {
      const { data, error } = await supabase
        .from('project')
        .select('id, name, notes')
        .order('name', { ascending: true });
      if (error) throw error;
      setProjectOptions((data as ProjectOption[]) || []);
    } catch (err: unknown) {
      setProjectOptions([]);
      setAddToProjectError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setProjectsLoading(false);
    }
  };

  const addNoteToProject = async (project: ProjectOption) => {
    if (!addToProjectNote || !userId) return;
    const projectIdValue = toProjectIdValue(project.id);
    const existingNoteProjects = Array.isArray(addToProjectNote.projects) ? addToProjectNote.projects : [];
    const alreadyInProject = existingNoteProjects.some((id) => String(id) === String(projectIdValue));
    if (alreadyInProject) return;

    setAddToProjectSavingId(project.id);
    setAddToProjectError(null);
    try {
      const existingProjectNotes = Array.isArray(project.notes) ? project.notes : [];
      const nextProjectNotes = Array.from(
        new Set([...existingProjectNotes.map((id) => String(id)), addToProjectNote.id])
      ).map(toProjectIdValue);
      const nextNoteProjects = Array.from(
        new Set([...existingNoteProjects.map((id) => String(id)), String(projectIdValue)])
      ).map(toProjectIdValue);
      const { error: addProjectError } = await supabase.rpc('add_accessible_note_to_project', {
        p_note_id: addToProjectNote.id,
        p_project_id: project.id,
      });
      if (addProjectError) throw addProjectError;

      setNotes((prev) =>
        prev.map((note) => (note.id === addToProjectNote.id ? { ...note, projects: nextNoteProjects } : note))
      );
      setProjectOptions((prev) =>
        prev.map((p) => (p.id === project.id ? { ...p, notes: nextProjectNotes } : p))
      );
      setAddToProjectNote(null);
      setAddToProjectSavingId(null);
    } catch (err: unknown) {
      setAddToProjectError(getErrorMessage(err, 'Failed to add note to project'));
      setAddToProjectSavingId(null);
    }
  };

  return {
    addToProjectNote,
    closeAddToProject: () => setAddToProjectNote(null),
    projectOptions,
    projectsLoading,
    addToProjectSavingId,
    addToProjectError,
    openAddToProject,
    addNoteToProject,
  };
}
