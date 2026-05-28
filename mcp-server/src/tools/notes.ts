import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { applyCreatedAtFilter, describeDateFilter, resolveDateFilter } from '../lib/dateFilters.js';
import { clampLimit, errorResult, jsonResult, truncateText } from '../lib/formatters.js';
import {
  fetchNote,
  getDataContext,
  getNoteSummary,
  getNoteTranscriptText,
  getScopedUserId,
  summarizeNote,
  toIdValue,
  type NoteRow,
} from '../lib/supabase.js';
import { formatTranscript, normalizeTranscript } from '../lib/transcript.js';

const dateFilterSchema = {
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD format.').optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
};

function noteMatchesQuery(note: NoteRow, query: string): boolean {
  const needle = query.toLowerCase();
  const haystack = [
    note.name,
    note.user_name,
    note.summary,
    note.summary_edit,
    note.transcription,
    JSON.stringify(note.diarization ?? ''),
    JSON.stringify(note.tags ?? ''),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return haystack.includes(needle);
}

function normalizeOwnerName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ownerNameMatches(noteOwnerName: string | null | undefined, ownerName: string): boolean {
  const haystack = normalizeOwnerName(noteOwnerName ?? '');
  const needle = normalizeOwnerName(ownerName);
  if (!haystack || !needle) return false;
  if (haystack.includes(needle)) return true;
  const ownerTokens = needle.split(' ').filter(Boolean);
  const noteTokens = new Set(haystack.split(' ').filter(Boolean));
  return ownerTokens.length > 0 && ownerTokens.every((token) => noteTokens.has(token));
}

export function registerNoteTools(server: McpServer): void {
  server.registerTool(
    'list_recent_notes',
    {
      title: 'List Recent Notes',
      description: 'List recent meeting notes with metadata, tags, projects, and speaker availability.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional(),
        projectId: z.string().optional(),
        ...dateFilterSchema,
      },
    },
    async ({ limit, projectId, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const resolvedLimit = clampLimit(limit, 10, 50);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      let query = supabase.from('note').select('*').order('created_at', { ascending: false }).limit(resolvedLimit);
      if (userId) query = query.eq('user_id', userId);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyCreatedAtFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      return jsonResult({ dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter), notes: ((data as NoteRow[]) ?? []).map(summarizeNote) });
    },
  );

  server.registerTool(
    'list_personal_notes',
    {
      title: 'List Personal Notes',
      description: 'List notes owned by the current user only, excluding notes shared by others.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional(),
        projectId: z.string().optional(),
        ...dateFilterSchema,
      },
    },
    async ({ limit, projectId, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      if (!userId) return errorResult('A scoped user id is required to list personal notes.');
      const resolvedLimit = clampLimit(limit, 10, 50);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      let query = supabase.from('note').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(resolvedLimit);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyCreatedAtFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      return jsonResult({
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        notes: ((data as NoteRow[]) ?? []).map(summarizeNote),
      });
    },
  );

  server.registerTool(
    'list_shared_notes',
    {
      title: 'List Shared Notes',
      description: 'List notes shared with the current user by other note owners.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional(),
        projectId: z.string().optional(),
        ...dateFilterSchema,
      },
    },
    async ({ limit, projectId, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      if (!userId) return errorResult('A scoped user id is required to list shared notes.');
      const resolvedLimit = clampLimit(limit, 10, 50);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      let query = supabase
        .from('note')
        .select('*')
        .contains('shared_users', [userId])
        .neq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(resolvedLimit);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyCreatedAtFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      return jsonResult({
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        notes: ((data as NoteRow[]) ?? []).map((note) => ({
          ...summarizeNote(note),
          sharedBy: note.user_name?.trim() || 'Unknown user',
        })),
      });
    },
  );

  server.registerTool(
    'get_shared_notes_by_owner',
    {
      title: 'Get Shared Notes By Owner',
      description: 'Find notes shared with the current user where the owner name matches a passed name, such as "Gene" matching "Gene Kim (김진)".',
      inputSchema: {
        ownerName: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        projectId: z.string().optional(),
        maxCharactersPerSummary: z.number().int().min(100).max(50000).optional(),
        ...dateFilterSchema,
      },
    },
    async ({ ownerName, limit, projectId, maxCharactersPerSummary, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      if (!userId) return errorResult('A scoped user id is required to list shared notes by owner.');
      const resolvedLimit = clampLimit(limit, 10, 50);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      let query = supabase
        .from('note')
        .select('*')
        .contains('shared_users', [userId])
        .neq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(200);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyCreatedAtFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const notes = ((data as NoteRow[]) ?? [])
        .filter((note) => ownerNameMatches(note.user_name, ownerName))
        .slice(0, resolvedLimit);
      return jsonResult({
        ownerName,
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        notes: notes.map((note) => ({
          ...summarizeNote(note),
          sharedBy: note.user_name?.trim() || 'Unknown user',
          summary: truncateText(getNoteSummary(note) || 'No summary for this note.', maxCharactersPerSummary),
        })),
      });
    },
  );

  server.registerTool(
    'search_notes',
    {
      title: 'Search Notes',
      description: 'Search notes by title, tags, summary, transcription, or diarized transcript content.',
      inputSchema: {
        query: z.string().min(1),
        projectId: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        ...dateFilterSchema,
      },
    },
    async ({ query, projectId, limit, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const resolvedLimit = clampLimit(limit, 10, 50);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      let dbQuery = supabase.from('note').select('*').order('created_at', { ascending: false }).limit(200);
      if (userId) dbQuery = dbQuery.eq('user_id', userId);
      if (projectId) dbQuery = dbQuery.contains('projects', [toIdValue(projectId)]);
      dbQuery = applyCreatedAtFilter(dbQuery, dateFilter);
      const { data, error } = await dbQuery;
      if (error) return errorResult(error.message);
      const notes = ((data as NoteRow[]) ?? []).filter((note) => noteMatchesQuery(note, query)).slice(0, resolvedLimit);
      return jsonResult({ query, dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter), notes: notes.map(summarizeNote) });
    },
  );

  server.registerTool(
    'get_notes_by_date',
    {
      title: 'Get Notes By Date',
      description: 'Retrieve note metadata for notes created on a single date or within a date range.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        projectId: z.string().optional(),
        ...dateFilterSchema,
      },
    },
    async ({ limit, projectId, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const resolvedLimit = clampLimit(limit, 25, 100);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      if (!dateFilter.startIso && !dateFilter.endIso) return errorResult('Provide date, startDate, or endDate.');
      let query = supabase.from('note').select('*').order('created_at', { ascending: false }).limit(resolvedLimit);
      if (userId) query = query.eq('user_id', userId);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyCreatedAtFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      return jsonResult({ dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter), notes: ((data as NoteRow[]) ?? []).map(summarizeNote) });
    },
  );

  server.registerTool(
    'get_summaries_by_date',
    {
      title: 'Get Summaries By Date',
      description: 'Retrieve note summaries for notes created on a single date or within a date range.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        projectId: z.string().optional(),
        maxCharactersPerSummary: z.number().int().min(100).max(50000).optional(),
        ...dateFilterSchema,
      },
    },
    async ({ limit, projectId, maxCharactersPerSummary, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const resolvedLimit = clampLimit(limit, 25, 100);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      if (!dateFilter.startIso && !dateFilter.endIso) return errorResult('Provide date, startDate, or endDate.');
      let query = supabase.from('note').select('*').order('created_at', { ascending: false }).limit(resolvedLimit);
      if (userId) query = query.eq('user_id', userId);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyCreatedAtFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      return jsonResult({
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        summaries: ((data as NoteRow[]) ?? []).map((note) => ({
          ...summarizeNote(note),
          summary: truncateText(getNoteSummary(note) || 'No summary for this note.', maxCharactersPerSummary),
        })),
      });
    },
  );

  server.registerTool(
    'get_transcripts_by_date',
    {
      title: 'Get Transcripts By Date',
      description: 'Retrieve note transcripts for notes created on a single date or within a date range.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        projectId: z.string().optional(),
        format: z.enum(['plain', 'diarized']).optional(),
        maxCharactersPerTranscript: z.number().int().min(100).max(100000).optional(),
        maxSegmentsPerTranscript: z.number().int().min(1).max(1000).optional(),
        ...dateFilterSchema,
      },
    },
    async ({ limit, projectId, format = 'plain', maxCharactersPerTranscript, maxSegmentsPerTranscript, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const resolvedLimit = clampLimit(limit, 25, 100);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      if (!dateFilter.startIso && !dateFilter.endIso) return errorResult('Provide date, startDate, or endDate.');
      let query = supabase.from('note').select('*').order('created_at', { ascending: false }).limit(resolvedLimit);
      if (userId) query = query.eq('user_id', userId);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyCreatedAtFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      return jsonResult({
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        transcripts: ((data as NoteRow[]) ?? []).map((note) => {
          const segments = normalizeTranscript(note.diarization);
          const base = summarizeNote(note);
          if (format === 'diarized') {
            return {
              ...base,
              segments: maxSegmentsPerTranscript ? segments.slice(0, maxSegmentsPerTranscript) : segments,
              totalSegments: segments.length,
            };
          }
          return {
            ...base,
            transcript: truncateText(getNoteTranscriptText(note) || formatTranscript(segments) || 'No transcript for this note.', maxCharactersPerTranscript),
          };
        }),
      });
    },
  );

  server.registerTool(
    'get_note',
    {
      title: 'Get Note',
      description: 'Get one note metadata record and availability flags without returning full transcript text.',
      inputSchema: { noteId: z.string().min(1) },
    },
    async ({ noteId }) => {
      const note = await fetchNote(noteId);
      if (!note) return errorResult(`Note not found: ${noteId}`);
      return jsonResult({ note: summarizeNote(note) });
    },
  );

  server.registerTool(
    'get_note_summary',
    {
      title: 'Get Note Summary',
      description: 'Return the edited summary when present, otherwise the generated summary.',
      inputSchema: {
        noteId: z.string().min(1),
        maxCharacters: z.number().int().min(100).max(50000).optional(),
      },
    },
    async ({ noteId, maxCharacters }) => {
      const note = await fetchNote(noteId);
      if (!note) return errorResult(`Note not found: ${noteId}`);
      const summary = getNoteSummary(note);
      return jsonResult({ noteId, summary: truncateText(summary || 'No summary for this note.', maxCharacters) });
    },
  );

  server.registerTool(
    'get_note_transcript',
    {
      title: 'Get Note Transcript',
      description: 'Return plain transcript text or structured diarized transcript segments for a note.',
      inputSchema: {
        noteId: z.string().min(1),
        format: z.enum(['plain', 'diarized']).optional(),
        maxCharacters: z.number().int().min(100).max(100000).optional(),
        maxSegments: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ noteId, format = 'plain', maxCharacters, maxSegments }) => {
      const note = await fetchNote(noteId);
      if (!note) return errorResult(`Note not found: ${noteId}`);
      const segments = normalizeTranscript(note.diarization);
      if (format === 'diarized') {
        const limitedSegments = maxSegments ? segments.slice(0, maxSegments) : segments;
        return jsonResult({ noteId, segments: limitedSegments, totalSegments: segments.length });
      }
      const text = getNoteTranscriptText(note) || formatTranscript(segments);
      return jsonResult({ noteId, transcript: truncateText(text || 'No transcript for this note.', maxCharacters) });
    },
  );

  server.registerTool(
    'get_note_speaker_segments',
    {
      title: 'Get Note Speaker Segments',
      description: 'Return diarized transcript segments for one or more speakers.',
      inputSchema: {
        noteId: z.string().min(1),
        speakers: z.array(z.string().min(1)).min(1),
        maxSegments: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ noteId, speakers, maxSegments }) => {
      const note = await fetchNote(noteId);
      if (!note) return errorResult(`Note not found: ${noteId}`);
      const wanted = new Set(speakers.map((speaker) => speaker.trim().toLowerCase()));
      const segments = normalizeTranscript(note.diarization).filter((segment) => wanted.has(segment.speaker.trim().toLowerCase()));
      return jsonResult({
        noteId,
        speakers,
        segments: maxSegments ? segments.slice(0, maxSegments) : segments,
        totalSegments: segments.length,
      });
    },
  );
}
