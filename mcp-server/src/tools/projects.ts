import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { clampLimit, errorResult, jsonResult } from '../lib/formatters.js';
import { applyNoteAccessScope, noteAccessFilter, fetchProject, getDataContext, getScopedUserId, NOTE_METADATA_SELECT, NOTE_SUMMARY_SELECT, summarizeNote, toIdValue, type NoteRow, type ProjectRow } from '../lib/supabase.js';

function optionalInt(min: number, max: number) {
  return z.preprocess((value) => (value === '' ? undefined : value), z.coerce.number().int().min(min).max(max).optional());
}

function uniqueProjectIdsFromNotes(notes: NoteRow[]): string[] {
  const ids = new Set<string>();
  for (const note of notes) {
    for (const projectId of note.projects ?? []) {
      ids.add(String(projectId));
    }
  }
  return [...ids];
}

async function fetchProjectRowsByIds(projectIds: string[]): Promise<ProjectRow[]> {
  if (projectIds.length === 0) return [];
  const { supabase } = getDataContext();
  const { data, error } = await supabase
    .from('project')
    .select('id, user_id, name, notes, created_at')
    .in('id', projectIds);
  if (error) throw error;
  return ((data as ProjectRow[]) ?? []);
}

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    'list_projects',
    {
      title: 'List Projects',
      description: 'List projects with basic metadata and note counts when available.',
      inputSchema: {
        limit: optionalInt(1, 100),
      },
    },
    async ({ limit }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const resolvedLimit = clampLimit(limit, 50, 100);
      let ownedProjectQuery = supabase.from('project').select('id, user_id, name, notes, created_at').order('name').limit(resolvedLimit);
      if (userId) ownedProjectQuery = ownedProjectQuery.eq('user_id', userId);
      const { data, error } = await ownedProjectQuery;
      if (error) return errorResult(error.message);
      const ownedProjects = ((data as ProjectRow[]) ?? []);
      const projectsById = new Map(ownedProjects.map((project) => [String(project.id), project]));

      let accessibleNotesQuery = supabase.from('note').select(NOTE_METADATA_SELECT).order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(500);
      accessibleNotesQuery = applyNoteAccessScope(accessibleNotesQuery, await noteAccessFilter(userId));
      const { data: noteData, error: noteError } = await accessibleNotesQuery;
      if (noteError) return errorResult(noteError.message);
      const accessibleNotes = (noteData as NoteRow[]) ?? [];
      const accessibleProjectIds = uniqueProjectIdsFromNotes(accessibleNotes);
      const missingProjectIds = accessibleProjectIds.filter((id) => !projectsById.has(id));
      // How many notes the CALLER can actually access, per project. For a project the caller
      // does not own, `project.notes.length` would leak the project's true size (counting notes
      // the caller can't read) — a note-derived project the owner never shared at the project
      // level should not reveal its full note count. So non-owned projects report only this
      // accessible-derived count. Capped at the 500-note accessible sample above (a metadata
      // count, not a correctness value); owned projects keep their exact full count.
      const accessibleNoteCountByProject = new Map<string, number>();
      for (const note of accessibleNotes) {
        for (const projectId of note.projects ?? []) {
          const key = String(projectId);
          accessibleNoteCountByProject.set(key, (accessibleNoteCountByProject.get(key) ?? 0) + 1);
        }
      }
      try {
        for (const project of await fetchProjectRowsByIds(missingProjectIds)) {
          projectsById.set(String(project.id), project);
        }
      } catch (projectError) {
        return errorResult(projectError instanceof Error ? projectError.message : String(projectError));
      }

      const projects = [...projectsById.values()]
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
        .slice(0, resolvedLimit);
      return jsonResult({
        projects: projects.map((project) => {
          const owned = project.user_id === userId;
          // Owned → exact full count (no leak, you own every note). Non-owned → only the notes
          // the caller can actually access, so the count never exposes unshared notes.
          const noteCount = owned
            ? (Array.isArray(project.notes) ? project.notes.length : null)
            : (accessibleNoteCountByProject.get(String(project.id)) ?? 0);
          return {
            id: project.id,
            name: project.name ?? `Project ${project.id}`,
            noteCount,
            createdAt: project.created_at ?? null,
            access: owned ? 'owned' : 'from-accessible-shared-notes',
          };
        }),
      });
    },
  );

  server.registerTool(
    'get_project_context',
    {
      title: 'Get Project Context',
      description: 'Get a project with recent notes, summaries, speakers, and transcript availability.',
      inputSchema: {
        projectId: z.string().min(1),
        noteLimit: optionalInt(1, 50),
      },
    },
    async ({ projectId, noteLimit }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const limit = clampLimit(noteLimit, 20, 50);
      let query = supabase
        .from('note')
        .select(NOTE_SUMMARY_SELECT)
        .contains('projects', [toIdValue(projectId)])
        .order('created_at', { ascending: false })
        .limit(limit);
      query = applyNoteAccessScope(query, await noteAccessFilter(userId));
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const notes = ((data as NoteRow[]) ?? []);
      // Only surface a project row the caller OWNS (fetchProject is owner-scoped). The
      // previous unscoped `fetchProjectRowsByIds` fallback returned ANY project by id,
      // leaking another user's project name, created_at, and full note-id list for an
      // enumerable numeric id (IDOR). For a project the caller merely has accessible
      // notes in, `project` stays null and name/noteIds are derived from the
      // access-scoped `notes` below — never from the unowned project row.
      const project = await fetchProject(projectId).catch(() => null);
      if (!project && notes.length === 0) return errorResult(`Project not found or no accessible notes found for project: ${projectId}`);
      return jsonResult({
        project: {
          id: project?.id ?? projectId,
          name: project?.name ?? `Project ${projectId}`,
          noteIds: project?.notes ?? notes.map((note) => note.id),
          createdAt: project?.created_at ?? null,
          access: project?.user_id === userId ? 'owned' : 'from-accessible-shared-notes',
        },
        notes: notes.map(summarizeNote),
      });
    },
  );
}
