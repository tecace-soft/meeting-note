import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { clampLimit, errorResult, jsonResult } from '../lib/formatters.js';
import { applyNoteAccessScope, fetchProject, getDataContext, getScopedUserId, NOTE_METADATA_SELECT, NOTE_SUMMARY_SELECT, summarizeNote, toIdValue, type NoteRow, type ProjectRow } from '../lib/supabase.js';

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
      accessibleNotesQuery = applyNoteAccessScope(accessibleNotesQuery, userId);
      const { data: noteData, error: noteError } = await accessibleNotesQuery;
      if (noteError) return errorResult(noteError.message);
      const accessibleProjectIds = uniqueProjectIdsFromNotes((noteData as NoteRow[]) ?? []);
      const missingProjectIds = accessibleProjectIds.filter((id) => !projectsById.has(id));
      try {
        for (const project of await fetchProjectRowsByIds(missingProjectIds)) {
          projectsById.set(String(project.id), project);
        }
      } catch (projectError) {
        return errorResult(projectError instanceof Error ? projectError.message : String(projectError));
      }

      const projects = [...projectsById.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, resolvedLimit);
      return jsonResult({
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          noteCount: Array.isArray(project.notes) ? project.notes.length : null,
          createdAt: project.created_at ?? null,
          access: project.user_id === userId ? 'owned' : 'from-accessible-shared-notes',
        })),
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
      query = applyNoteAccessScope(query, userId);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const notes = ((data as NoteRow[]) ?? []);
      const project = await fetchProject(projectId)
        .catch(() => null)
        ?? (await fetchProjectRowsByIds([String(projectId)]).catch(() => []))[0]
        ?? null;
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
