import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { applyMeetingDateFilter, describeDateFilter, resolveDateFilter } from '../lib/dateFilters.js';
import { clampLimit, errorResult, jsonResult, truncateText } from '../lib/formatters.js';
import { decryptNotesForMcp } from '../lib/noteEncryption.js';
import {
  fetchNote,
  getDataContext,
  getNoteSummary,
  getNoteTranscriptText,
  getScopedUserId,
  hasMcpScope,
  applyNoteAccessScope,
  summarizeNote,
  toIdValue,
  type NoteRow,
} from '../lib/supabase.js';
import { formatTranscript, normalizeTranscript } from '../lib/transcript.js';

const SUMMARY_DEFAULT_CHARS = 8000;
const SUMMARY_MAX_CHARS = 20000;
const TRANSCRIPT_DEFAULT_CHARS = 12000;
const TRANSCRIPT_MAX_CHARS = 30000;
const TRANSCRIPT_DEFAULT_SEGMENTS = 100;
const TRANSCRIPT_MAX_SEGMENTS = 300;
const BULK_TRANSCRIPT_DEFAULT_LIMIT = 3;
const BULK_TRANSCRIPT_MAX_LIMIT = 10;
const BULK_SUMMARY_DEFAULT_LIMIT = 10;
const BULK_SUMMARY_MAX_LIMIT = 25;
const BROAD_NOTE_SEARCH_LIMIT = 100;

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

function normalizeSpeakerName(value: string, options: { stripParentheticals?: boolean } = {}): string {
  let normalized = value.toLowerCase();
  if (options.stripParentheticals) normalized = normalized.replace(/\([^)]*\)/g, ' ');
  return normalized
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function speakerNameMatches(segmentSpeaker: string | null | undefined, speakerName: string): boolean {
  const haystack = normalizeSpeakerName(segmentSpeaker ?? '');
  const haystackNoParen = normalizeSpeakerName(segmentSpeaker ?? '', { stripParentheticals: true });
  const needle = normalizeSpeakerName(speakerName);
  const needleNoParen = normalizeSpeakerName(speakerName, { stripParentheticals: true });
  if (!haystack || !needle) return false;
  if (haystack === needle || haystackNoParen === needleNoParen) return true;
  if (haystack.includes(needle) || haystackNoParen.includes(needleNoParen)) return true;
  const speakerTokens = new Set(haystackNoParen.split(' ').filter(Boolean));
  const requestedTokens = needleNoParen.split(' ').filter(Boolean);
  return requestedTokens.length > 0 && requestedTokens.every((token) => speakerTokens.has(token));
}

function requireScope(scope: 'notes:metadata' | 'notes:summary' | 'notes:transcript') {
  return hasMcpScope(scope) ? null : errorResult(`This MCP token does not include the ${scope} scope.`);
}

function clampCharacters(value: number | undefined, fallback: number, max: number): number {
  return clampLimit(value, fallback, max);
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
      const denied = requireScope('notes:metadata');
      if (denied) return denied;
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const resolvedLimit = clampLimit(limit, 10, 50);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      let query = supabase.from('note').select('*').order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(resolvedLimit);
      query = applyNoteAccessScope(query, userId);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const notes = decryptNotesForMcp((data as NoteRow[]) ?? []);
      return jsonResult({ dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter), notes: notes.map(summarizeNote) });
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
      const denied = requireScope('notes:metadata');
      if (denied) return denied;
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      if (!userId) return errorResult('A scoped user id is required to list personal notes.');
      const resolvedLimit = clampLimit(limit, 10, 50);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      let query = supabase.from('note').select('*').eq('user_id', userId).order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(resolvedLimit);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const notes = decryptNotesForMcp((data as NoteRow[]) ?? []);
      return jsonResult({
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        notes: notes.map(summarizeNote),
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
      const denied = requireScope('notes:metadata');
      if (denied) return denied;
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
        .order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
        .limit(resolvedLimit);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const notes = decryptNotesForMcp((data as NoteRow[]) ?? []);
      return jsonResult({
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        notes: notes.map((note) => ({
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
        maxCharactersPerSummary: z.number().int().min(100).max(SUMMARY_MAX_CHARS).optional(),
        ...dateFilterSchema,
      },
    },
    async ({ ownerName, limit, projectId, maxCharactersPerSummary, date, startDate, endDate }) => {
      const denied = requireScope('notes:summary');
      if (denied) return denied;
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
        .order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
        .limit(BROAD_NOTE_SEARCH_LIMIT);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const notes = decryptNotesForMcp((data as NoteRow[]) ?? [])
        .filter((note) => ownerNameMatches(note.user_name, ownerName))
        .slice(0, resolvedLimit);
      return jsonResult({
        ownerName,
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        notes: notes.map((note) => ({
          ...summarizeNote(note),
          sharedBy: note.user_name?.trim() || 'Unknown user',
          summary: truncateText(getNoteSummary(note) || 'No summary for this note.', clampCharacters(maxCharactersPerSummary, SUMMARY_DEFAULT_CHARS, SUMMARY_MAX_CHARS)),
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
      const denied = requireScope('notes:transcript');
      if (denied) return denied;
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const resolvedLimit = clampLimit(limit, 10, 50);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      let dbQuery = supabase.from('note').select('*').order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(BROAD_NOTE_SEARCH_LIMIT);
      dbQuery = applyNoteAccessScope(dbQuery, userId);
      if (projectId) dbQuery = dbQuery.contains('projects', [toIdValue(projectId)]);
      dbQuery = applyMeetingDateFilter(dbQuery, dateFilter);
      const { data, error } = await dbQuery;
      if (error) return errorResult(error.message);
      const notes = decryptNotesForMcp((data as NoteRow[]) ?? []).filter((note) => noteMatchesQuery(note, query)).slice(0, resolvedLimit);
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
      const denied = requireScope('notes:metadata');
      if (denied) return denied;
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const resolvedLimit = clampLimit(limit, 25, 100);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      if (!dateFilter.startIso && !dateFilter.endIso) return errorResult('Provide date, startDate, or endDate.');
      let query = supabase.from('note').select('*').order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(resolvedLimit);
      query = applyNoteAccessScope(query, userId);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const notes = decryptNotesForMcp((data as NoteRow[]) ?? []);
      return jsonResult({ dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter), notes: notes.map(summarizeNote) });
    },
  );

  server.registerTool(
    'get_summaries_by_date',
    {
      title: 'Get Summaries By Date',
      description: 'Retrieve note summaries for notes created on a single date or within a date range.',
      inputSchema: {
        limit: z.number().int().min(1).max(BULK_SUMMARY_MAX_LIMIT).optional(),
        projectId: z.string().optional(),
        maxCharactersPerSummary: z.number().int().min(100).max(SUMMARY_MAX_CHARS).optional(),
        ...dateFilterSchema,
      },
    },
    async ({ limit, projectId, maxCharactersPerSummary, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const denied = requireScope('notes:summary');
      if (denied) return denied;
      const resolvedLimit = clampLimit(limit, BULK_SUMMARY_DEFAULT_LIMIT, BULK_SUMMARY_MAX_LIMIT);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      if (!dateFilter.startIso && !dateFilter.endIso) return errorResult('Provide date, startDate, or endDate.');
      let query = supabase.from('note').select('*').order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(resolvedLimit);
      query = applyNoteAccessScope(query, userId);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const notes = decryptNotesForMcp((data as NoteRow[]) ?? []);
      return jsonResult({
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        summaries: notes.map((note) => ({
          ...summarizeNote(note),
          summary: truncateText(getNoteSummary(note) || 'No summary for this note.', clampCharacters(maxCharactersPerSummary, SUMMARY_DEFAULT_CHARS, SUMMARY_MAX_CHARS)),
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
        limit: z.number().int().min(1).max(BULK_TRANSCRIPT_MAX_LIMIT).optional(),
        projectId: z.string().optional(),
        format: z.enum(['plain', 'diarized']).optional(),
        maxCharactersPerTranscript: z.number().int().min(100).max(TRANSCRIPT_MAX_CHARS).optional(),
        maxSegmentsPerTranscript: z.number().int().min(1).max(TRANSCRIPT_MAX_SEGMENTS).optional(),
        ...dateFilterSchema,
      },
    },
    async ({ limit, projectId, format = 'plain', maxCharactersPerTranscript, maxSegmentsPerTranscript, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const denied = requireScope('notes:transcript');
      if (denied) return denied;
      const resolvedLimit = clampLimit(limit, BULK_TRANSCRIPT_DEFAULT_LIMIT, BULK_TRANSCRIPT_MAX_LIMIT);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      if (!dateFilter.startIso && !dateFilter.endIso) return errorResult('Provide date, startDate, or endDate.');
      let query = supabase.from('note').select('*').order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(resolvedLimit);
      query = applyNoteAccessScope(query, userId);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const notes = decryptNotesForMcp((data as NoteRow[]) ?? []);
      return jsonResult({
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        transcripts: notes.map((note) => {
          const segments = normalizeTranscript(note.diarization);
          const base = summarizeNote(note);
          if (format === 'diarized') {
            return {
              ...base,
              segments: segments.slice(0, clampLimit(maxSegmentsPerTranscript, TRANSCRIPT_DEFAULT_SEGMENTS, TRANSCRIPT_MAX_SEGMENTS)),
              totalSegments: segments.length,
            };
          }
          return {
            ...base,
            transcript: truncateText(
              getNoteTranscriptText(note) || formatTranscript(segments) || 'No transcript for this note.',
              clampCharacters(maxCharactersPerTranscript, TRANSCRIPT_DEFAULT_CHARS, TRANSCRIPT_MAX_CHARS),
            ),
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
      const denied = requireScope('notes:metadata');
      if (denied) return denied;
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
        maxCharacters: z.number().int().min(100).max(SUMMARY_MAX_CHARS).optional(),
      },
    },
    async ({ noteId, maxCharacters }) => {
      const denied = requireScope('notes:summary');
      if (denied) return denied;
      const note = await fetchNote(noteId);
      if (!note) return errorResult(`Note not found: ${noteId}`);
      const summary = getNoteSummary(note);
      return jsonResult({
        noteId,
        ...summarizeNote(note),
        summary: truncateText(summary || 'No summary for this note.', clampCharacters(maxCharacters, SUMMARY_DEFAULT_CHARS, SUMMARY_MAX_CHARS)),
      });
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
        maxCharacters: z.number().int().min(100).max(TRANSCRIPT_MAX_CHARS).optional(),
        maxSegments: z.number().int().min(1).max(TRANSCRIPT_MAX_SEGMENTS).optional(),
      },
    },
    async ({ noteId, format = 'plain', maxCharacters, maxSegments }) => {
      const denied = requireScope('notes:transcript');
      if (denied) return denied;
      const note = await fetchNote(noteId);
      if (!note) return errorResult(`Note not found: ${noteId}`);
      const segments = normalizeTranscript(note.diarization);
      if (format === 'diarized') {
        const limitedSegments = segments.slice(0, clampLimit(maxSegments, TRANSCRIPT_DEFAULT_SEGMENTS, TRANSCRIPT_MAX_SEGMENTS));
        return jsonResult({ noteId, segments: limitedSegments, totalSegments: segments.length });
      }
      const text = getNoteTranscriptText(note) || formatTranscript(segments);
      return jsonResult({
        noteId,
        ...summarizeNote(note),
        transcript: truncateText(text || 'No transcript for this note.', clampCharacters(maxCharacters, TRANSCRIPT_DEFAULT_CHARS, TRANSCRIPT_MAX_CHARS)),
      });
    },
  );

  server.registerTool(
    'get_note_speaker_segments',
    {
      title: 'Get Note Speaker Segments',
      description: 'Return diarized transcript segments for one or more speakers in a single note.',
      inputSchema: {
        noteId: z.string().min(1),
        speakers: z.array(z.string().min(1)).min(1),
        maxSegments: z.number().int().min(1).max(TRANSCRIPT_MAX_SEGMENTS).optional(),
      },
    },
    async ({ noteId, speakers, maxSegments }) => {
      const denied = requireScope('notes:transcript');
      if (denied) return denied;
      const note = await fetchNote(noteId);
      if (!note) return errorResult(`Note not found: ${noteId}`);
      const segments = normalizeTranscript(note.diarization).filter((segment) =>
        speakers.some((speaker) => speakerNameMatches(segment.speaker, speaker)),
      );
      return jsonResult({
        noteId,
        speakers,
        segments: segments.slice(0, clampLimit(maxSegments, TRANSCRIPT_DEFAULT_SEGMENTS, TRANSCRIPT_MAX_SEGMENTS)),
        totalSegments: segments.length,
      });
    },
  );

  server.registerTool(
    'get_speaker_segments',
    {
      title: 'Get Speaker Segments',
      description:
        'Find diarized transcript segments by speaker name. Use this for questions like "points made by Gene"; pass noteId for one meeting, or omit noteId to search accessible personal and shared notes.',
      inputSchema: {
        speakerName: z.string().min(1),
        noteId: z.string().min(1).optional(),
        noteScope: z.enum(['all', 'personal', 'shared']).optional(),
        projectId: z.string().optional(),
        noteLimit: z.number().int().min(1).max(BROAD_NOTE_SEARCH_LIMIT).optional(),
        maxSegments: z.number().int().min(1).max(TRANSCRIPT_MAX_SEGMENTS).optional(),
        ...dateFilterSchema,
      },
    },
    async ({ speakerName, noteId, noteScope = 'all', projectId, noteLimit, maxSegments, date, startDate, endDate }) => {
      const userId = getScopedUserId();
      const denied = requireScope('notes:transcript');
      if (denied) return denied;
      const resolvedNoteLimit = clampLimit(noteLimit, 50, BROAD_NOTE_SEARCH_LIMIT);
      const resolvedSegmentLimit = clampLimit(maxSegments, TRANSCRIPT_DEFAULT_SEGMENTS, TRANSCRIPT_MAX_SEGMENTS);

      let notes: NoteRow[];
      let dateFilter = resolveDateFilter({ date, startDate, endDate });

      if (noteId) {
        const note = await fetchNote(noteId);
        if (!note) return errorResult(`Note not found: ${noteId}`);
        notes = [note];
        dateFilter = resolveDateFilter({});
      } else {
        const { supabase } = getDataContext();
        let query = supabase.from('note').select('*').order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(resolvedNoteLimit);
        if (noteScope === 'personal') {
          if (!userId) return errorResult('A scoped user id is required to search personal notes.');
          query = query.eq('user_id', userId);
        } else if (noteScope === 'shared') {
          if (!userId) return errorResult('A scoped user id is required to search shared notes.');
          query = query.contains('shared_users', [userId]).neq('user_id', userId);
        } else {
          query = applyNoteAccessScope(query, userId);
        }
        if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
        query = applyMeetingDateFilter(query, dateFilter);
        const { data, error } = await query;
        if (error) return errorResult(error.message);
        notes = decryptNotesForMcp((data as NoteRow[]) ?? []);
      }

      const segments: Array<{
        noteId: string;
        noteTitle: string;
        createdAt: string | null;
        ownerName: string;
        speaker: string;
        text: string;
      }> = [];

      for (const note of notes) {
        for (const segment of normalizeTranscript(note.diarization)) {
          if (!speakerNameMatches(segment.speaker, speakerName)) continue;
          segments.push({
            noteId: note.id,
            noteTitle: summarizeNote(note).title,
            createdAt: note.created_at ?? null,
            ownerName: note.user_name?.trim() || 'Unknown user',
            speaker: segment.speaker,
            text: segment.text,
          });
          if (segments.length >= resolvedSegmentLimit) break;
        }
        if (segments.length >= resolvedSegmentLimit) break;
      }

      return jsonResult({
        speakerName,
        noteId: noteId ?? null,
        noteScope: noteId ? 'single-note' : noteScope,
        dateFilter: noteId ? null : describeDateFilter({ date, startDate, endDate }, dateFilter),
        searchedNotes: notes.length,
        totalMatchingSegments: segments.length,
        segments,
      });
    },
  );
}
