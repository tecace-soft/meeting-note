import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { clampLimit, errorResult, jsonResult } from '../lib/formatters.js';
import { applyNoteAccessScope, fetchProject, getDataContext, getScopedUserId, NOTE_SUMMARY_SELECT, summarizeNote, toIdValue, type NoteRow, type ProjectRow } from '../lib/supabase.js';

function optionalInt(min: number, max: number) {
  return z.preprocess((value) => (value === '' ? undefined : value), z.coerce.number().int().min(min).max(max).optional());
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
      let query = supabase.from('project').select('id, user_id, name, notes, created_at').order('name').limit(resolvedLimit);
      if (userId) query = query.eq('user_id', userId);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      return jsonResult({
        projects: ((data as ProjectRow[]) ?? []).map((project) => ({
          id: project.id,
          name: project.name,
          noteCount: Array.isArray(project.notes) ? project.notes.length : null,
          createdAt: project.created_at ?? null,
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
      const project = await fetchProject(projectId);
      if (!project) return errorResult(`Project not found: ${projectId}`);
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
      return jsonResult({
        project: {
          id: project.id,
          name: project.name,
          noteIds: project.notes ?? [],
          createdAt: project.created_at ?? null,
        },
        notes: ((data as NoteRow[]) ?? []).map(summarizeNote),
      });
    },
  );
}
