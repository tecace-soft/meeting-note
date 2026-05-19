import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { clampLimit, errorResult, jsonResult, truncateText } from '../lib/formatters.js';
import {
  fetchNote,
  getDataContext,
  getNoteSummary,
  getNoteTranscriptText,
  summarizeNote,
  toIdValue,
  type NoteRow,
} from '../lib/supabase.js';
import { formatTranscript, normalizeTranscript } from '../lib/transcript.js';

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

export function registerNoteTools(server: McpServer): void {
  server.registerTool(
    'list_recent_notes',
    {
      title: 'List Recent Notes',
      description: 'List recent meeting notes with metadata, tags, projects, and speaker availability.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional(),
        projectId: z.string().optional(),
      },
    },
    async ({ limit, projectId }) => {
      const { supabase, userId } = getDataContext();
      const resolvedLimit = clampLimit(limit, 10, 50);
      let query = supabase.from('note').select('*').order('created_at', { ascending: false }).limit(resolvedLimit);
      if (userId) query = query.eq('user_id', userId);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      return jsonResult({ notes: ((data as NoteRow[]) ?? []).map(summarizeNote) });
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
      },
    },
    async ({ query, projectId, limit }) => {
      const { supabase, userId } = getDataContext();
      const resolvedLimit = clampLimit(limit, 10, 50);
      let dbQuery = supabase.from('note').select('*').order('created_at', { ascending: false }).limit(200);
      if (userId) dbQuery = dbQuery.eq('user_id', userId);
      if (projectId) dbQuery = dbQuery.contains('projects', [toIdValue(projectId)]);
      const { data, error } = await dbQuery;
      if (error) return errorResult(error.message);
      const notes = ((data as NoteRow[]) ?? []).filter((note) => noteMatchesQuery(note, query)).slice(0, resolvedLimit);
      return jsonResult({ query, notes: notes.map(summarizeNote) });
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
