import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { applyMeetingDateFilter, describeDateFilter, resolveDateFilter } from '../lib/dateFilters.js';
import { applyLimitWindow, clampLimit, errorResult, jsonResult, truncateText } from '../lib/formatters.js';
import {
  fetchNote,
  getDataContext,
  getNoteSummary,
  getNoteTranscriptText,
  getScopedUserId,
  applyNoteAccessScope,
  noteAccessFilter,
  NOTE_SPEAKER_SCAN_SELECT,
  NOTE_SUMMARY_SELECT,
  NOTE_TRANSCRIPT_SELECT,
  summarizeNote,
  toIdValue,
  type NoteRow,
} from '../lib/supabase.js';
import { formatTranscript, normalizeTranscript } from '../lib/transcript.js';

const dateFilterSchema = {
  date: optionalString().pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD format.').optional()),
  startDate: optionalString(),
  endDate: optionalString(),
};

function optionalString() {
  return z.preprocess((value) => (value === '' ? undefined : value), z.string().optional());
}

function optionalInt(min: number, max: number) {
  return z.preprocess((value) => (value === '' ? undefined : value), z.coerce.number().int().min(min).max(max).optional());
}

// Row shape returned by the search_notes SQL RPC (F4 hybrid search).
interface SearchNoteRow {
  note_id: string;
  name: string | null;
  summary: string | null;
  created_at: string | null;
  meeting_at: string | null;
  score: number;
  matched_people: string[] | null;
  matched_topics: string[] | null;
  matched_companies: string[] | null;
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

export function registerNoteTools(server: McpServer): void {
  server.registerTool(
    'list_recent_notes',
    {
      title: 'List Recent Notes',
      description: 'List recent meeting notes with metadata, tags, and projects. Transcript/speaker availability is not checked in this list view (fields are null/unknown); use get_note or the transcript tools to confirm a specific note.',
      inputSchema: {
        limit: optionalInt(1, 50),
        projectId: z.string().optional(),
        ...dateFilterSchema,
      },
    },
    async ({ limit, projectId, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const resolvedLimit = clampLimit(limit, 10, 50);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      let query = supabase.from('note').select(NOTE_SUMMARY_SELECT).order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(resolvedLimit + 1);
      query = applyNoteAccessScope(query, await noteAccessFilter(userId));
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const { shown, hasMore } = applyLimitWindow(((data as NoteRow[]) ?? []), resolvedLimit);
      return jsonResult({ dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter), hasMore, notes: shown.map(summarizeNote) });
    },
  );

  server.registerTool(
    'list_personal_notes',
    {
      title: 'List Personal Notes',
      description: 'List notes owned by the current user only, excluding notes shared by others.',
      inputSchema: {
        limit: optionalInt(1, 50),
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
      let query = supabase.from('note').select(NOTE_SUMMARY_SELECT).eq('user_id', userId).order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(resolvedLimit + 1);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const { shown, hasMore } = applyLimitWindow(((data as NoteRow[]) ?? []), resolvedLimit);
      return jsonResult({
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        hasMore,
        notes: shown.map(summarizeNote),
      });
    },
  );

  server.registerTool(
    'list_shared_notes',
    {
      title: 'List Shared Notes',
      description: 'List notes shared with the current user by other note owners.',
      inputSchema: {
        limit: optionalInt(1, 50),
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
        .select(NOTE_SUMMARY_SELECT)
        .contains('shared_users', [userId])
        .neq('user_id', userId)
        .order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
        .limit(resolvedLimit + 1);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const { shown, hasMore } = applyLimitWindow(((data as NoteRow[]) ?? []), resolvedLimit);
      return jsonResult({
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        hasMore,
        notes: shown.map((note) => ({
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
        limit: optionalInt(1, 50),
        projectId: z.string().optional(),
        maxCharactersPerSummary: optionalInt(100, 50000),
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
        .select(NOTE_SUMMARY_SELECT)
        .contains('shared_users', [userId])
        .neq('user_id', userId)
        .order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
        .limit(200);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const fetched = ((data as NoteRow[]) ?? []);
      // Owner match is fuzzy, so it runs in JS AFTER a hardcoded 200-newest DB fetch. If
      // that horizon was hit, older notes from this owner may exist but were not scanned.
      const reachedScanHorizon = fetched.length >= 200;
      const matched = fetched.filter((note) => ownerNameMatches(note.user_name, ownerName));
      const notes = matched.slice(0, resolvedLimit);
      return jsonResult({
        ownerName,
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        hasMore: matched.length > resolvedLimit,
        reachedScanHorizon,
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
      description: 'Search accessible notes by title, summary, transcript, and structured index (people, topics, companies). Ranked, index-backed (covers all notes, not a capped scan). Returns matched people/topics/companies per hit.',
      inputSchema: {
        query: z.string().min(1),
        projectId: z.string().optional(),
        limit: optionalInt(1, 50),
        ...dateFilterSchema,
      },
    },
    async ({ query, projectId, limit, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      if (!userId) return errorResult('No user in scope for search.');
      const resolvedLimit = clampLimit(limit, 10, 50);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      // Index-backed hybrid search: keyword (pg_trgm) over note text + structured
      // matching over note_insight, access-scoped (owner + shared) in SQL. Replaces
      // the old fetch-200-then-filter-in-JS scan.
      const { data, error } = await supabase.rpc('search_notes', {
        p_user_id: userId,
        p_query: query,
        p_limit: resolvedLimit + 1, // fetch one extra to detect more-results-exist
        p_project_id: projectId ?? null,
        p_start: dateFilter.startIso ?? null,
        p_end: dateFilter.endIso ?? null,
      });
      if (error) return errorResult(error.message);
      const { shown: rows, hasMore } = applyLimitWindow((data as SearchNoteRow[] | null) ?? [], resolvedLimit);
      return jsonResult({
        query,
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        hasMore,
        notes: rows.map((row) => ({
          noteId: row.note_id,
          name: row.name,
          summary: row.summary,
          createdAt: row.created_at,
          meetingAt: row.meeting_at,
          score: row.score,
          matchedPeople: row.matched_people ?? [],
          matchedTopics: row.matched_topics ?? [],
          matchedCompanies: row.matched_companies ?? [],
        })),
      });
    },
  );

  server.registerTool(
    'get_notes_by_date',
    {
      title: 'Get Notes By Date',
      description: 'Retrieve note metadata for notes created on a single date or within a date range.',
      inputSchema: {
        limit: optionalInt(1, 100),
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
      let query = supabase.from('note').select(NOTE_SUMMARY_SELECT).order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(resolvedLimit + 1);
      query = applyNoteAccessScope(query, await noteAccessFilter(userId));
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const { shown, hasMore } = applyLimitWindow(((data as NoteRow[]) ?? []), resolvedLimit);
      return jsonResult({ dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter), hasMore, notes: shown.map(summarizeNote) });
    },
  );

  server.registerTool(
    'get_summaries_by_date',
    {
      title: 'Get Summaries By Date',
      description: 'Retrieve note summaries for notes created on a single date or within a date range.',
      inputSchema: {
        limit: optionalInt(1, 100),
        projectId: z.string().optional(),
        maxCharactersPerSummary: optionalInt(100, 50000),
        ...dateFilterSchema,
      },
    },
    async ({ limit, projectId, maxCharactersPerSummary, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const resolvedLimit = clampLimit(limit, 25, 100);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      if (!dateFilter.startIso && !dateFilter.endIso) return errorResult('Provide date, startDate, or endDate.');
      let query = supabase.from('note').select(NOTE_SUMMARY_SELECT).order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(resolvedLimit + 1);
      query = applyNoteAccessScope(query, await noteAccessFilter(userId));
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const { shown, hasMore } = applyLimitWindow(((data as NoteRow[]) ?? []), resolvedLimit);
      return jsonResult({
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        hasMore,
        summaries: shown.map((note) => ({
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
        limit: optionalInt(1, 100),
        projectId: z.string().optional(),
        format: z.enum(['plain', 'diarized']).optional(),
        maxCharactersPerTranscript: optionalInt(100, 100000),
        maxSegmentsPerTranscript: optionalInt(1, 1000),
        ...dateFilterSchema,
      },
    },
    async ({ limit, projectId, format = 'plain', maxCharactersPerTranscript, maxSegmentsPerTranscript, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const resolvedLimit = clampLimit(limit, 25, 100);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      if (!dateFilter.startIso && !dateFilter.endIso) return errorResult('Provide date, startDate, or endDate.');
      let query = supabase.from('note').select(NOTE_TRANSCRIPT_SELECT).order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(resolvedLimit + 1);
      query = applyNoteAccessScope(query, await noteAccessFilter(userId));
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const { shown, hasMore } = applyLimitWindow(((data as NoteRow[]) ?? []), resolvedLimit);
      return jsonResult({
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        hasMore,
        transcripts: shown.map((note) => {
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
      // Fetch the transcript columns (cheap for a single note) so the availability
      // flags this tool exists to report are real, not "unknown". summarizeNote
      // returns flags/speaker names only, never the full transcript text.
      const note = await fetchNote(noteId, NOTE_TRANSCRIPT_SELECT);
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
        maxCharacters: optionalInt(100, 50000),
      },
    },
    async ({ noteId, maxCharacters }) => {
      const note = await fetchNote(noteId, NOTE_SUMMARY_SELECT);
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
        maxCharacters: optionalInt(100, 100000),
        maxSegments: optionalInt(1, 1000),
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
      description: 'Return diarized transcript segments for one or more speakers in a single note.',
      inputSchema: {
        noteId: z.string().min(1),
        speakers: z.array(z.string().min(1)).min(1),
        maxSegments: optionalInt(1, 1000),
      },
    },
    async ({ noteId, speakers, maxSegments }) => {
      const note = await fetchNote(noteId);
      if (!note) return errorResult(`Note not found: ${noteId}`);
      const segments = normalizeTranscript(note.diarization).filter((segment) =>
        speakers.some((speaker) => speakerNameMatches(segment.speaker, speaker)),
      );
      return jsonResult({
        noteId,
        speakers,
        segments: maxSegments ? segments.slice(0, maxSegments) : segments,
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
        noteLimit: optionalInt(1, 500),
        maxSegments: optionalInt(1, 2000),
        ...dateFilterSchema,
      },
    },
    async ({ speakerName, noteId, noteScope = 'all', projectId, noteLimit, maxSegments, date, startDate, endDate }) => {
      const userId = getScopedUserId();
      const resolvedNoteLimit = clampLimit(noteLimit, 100, 500);
      const resolvedSegmentLimit = clampLimit(maxSegments, 250, 2000);

      let notes: NoteRow[];
      let dateFilter = resolveDateFilter({ date, startDate, endDate });

      if (noteId) {
        const note = await fetchNote(noteId);
        if (!note) return errorResult(`Note not found: ${noteId}`);
        notes = [note];
        dateFilter = resolveDateFilter({});
      } else {
        const { supabase } = getDataContext();
        // Scan for the speaker over diarization only (NOTE_SPEAKER_SCAN_SELECT drops the
        // heavy plain `transcription` + summary columns we don't use here).
        let query = supabase.from('note').select(NOTE_SPEAKER_SCAN_SELECT).order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(resolvedNoteLimit);
        if (noteScope === 'personal') {
          if (!userId) return errorResult('A scoped user id is required to search personal notes.');
          query = query.eq('user_id', userId);
        } else if (noteScope === 'shared') {
          if (!userId) return errorResult('A scoped user id is required to search shared notes.');
          query = query.contains('shared_users', [userId]).neq('user_id', userId);
        } else {
          query = applyNoteAccessScope(query, await noteAccessFilter(userId));
        }
        if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
        query = applyMeetingDateFilter(query, dateFilter);
        const { data, error } = await query;
        if (error) return errorResult(error.message);
        notes = ((data as NoteRow[]) ?? []);
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

      // Honest incompleteness signals: the multi-note scan is capped at resolvedNoteLimit
      // newest notes (older ones are NOT searched), and segments are capped too. Without
      // these flags a truncated answer looks exhaustive. For full coverage the caller
      // should narrow by date/project or pass a specific noteId.
      const reachedNoteCap = !noteId && notes.length >= resolvedNoteLimit;
      const segmentsTruncated = segments.length >= resolvedSegmentLimit;
      return jsonResult({
        speakerName,
        noteId: noteId ?? null,
        noteScope: noteId ? 'single-note' : noteScope,
        dateFilter: noteId ? null : describeDateFilter({ date, startDate, endDate }, dateFilter),
        searchedNotes: notes.length,
        reachedNoteCap,
        noteCap: noteId ? null : resolvedNoteLimit,
        totalMatchingSegments: segments.length,
        segmentsTruncated,
        segments,
      });
    },
  );
}
