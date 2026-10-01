import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorResult, jsonResult, truncateText } from '../lib/formatters.js';
import { fetchNote, getDataContext, getNoteSummary, getNoteTitle, getNoteTranscriptText, getScopedUserId, NOTE_TRANSCRIPT_SELECT } from '../lib/supabase.js';

// OpenAI company-knowledge / deep-research compatibility tools. ChatGPT only treats an MCP
// server as a knowledge source when it exposes `search` and `fetch` with exactly these input
// shapes ({ query } / { id }) and returns one JSON text item: { results: [{ id, title, url }] }
// for search, { id, title, text, url, metadata } for fetch. The richer search_notes / get_note_*
// tools stay the primary tools for Claude; these are thin adapters over the same queries.

const MAX_FETCH_TEXT_CHARACTERS = 100_000;
const SEARCH_RESULT_LIMIT = 10;

function getAppBaseUrl(): string {
  return (process.env.MEETING_NOTE_APP_URL?.trim() || 'https://meetingnote.tecace.com').replace(/\/$/, '');
}

// ChatGPT only creates a citation when url is non-empty. The app has no per-note route yet, so
// this lands on the history page; the note param is reserved for a future deep link.
export function buildNoteUrl(noteId: string | number): string {
  return `${getAppBaseUrl()}/history?note=${encodeURIComponent(String(noteId))}`;
}

export function buildFetchText(summary: string, transcript: string): string {
  const sections = [
    summary ? `Summary:\n${summary}` : '',
    transcript ? `Transcript:\n${transcript}` : '',
  ].filter(Boolean);
  return truncateText(sections.join('\n\n') || 'No summary or transcript for this note.', MAX_FETCH_TEXT_CHARACTERS);
}

export function registerKnowledgeTools(server: McpServer): void {
  server.registerTool(
    'search',
    {
      title: 'Search Meeting Notes',
      description: 'Search the meeting notes the signed-in user can access (own and shared) by title, summary, transcript, people, topics and companies. Returns note ids to pass to fetch.',
      inputSchema: { query: z.string().min(1) },
    },
    async ({ query }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      if (!userId) return errorResult('No user in scope for search.');
      const { data, error } = await supabase.rpc('search_notes', {
        p_user_id: userId,
        p_query: query,
        p_limit: SEARCH_RESULT_LIMIT,
        p_project_id: null,
        p_start: null,
        p_end: null,
      });
      if (error) return errorResult(error.message);
      const rows = (data as { note_id: string; name: string | null }[] | null) ?? [];
      return jsonResult({
        results: rows.map((row) => ({
          id: String(row.note_id),
          title: row.name?.trim() || 'Untitled note',
          url: buildNoteUrl(row.note_id),
        })),
      });
    },
  );

  server.registerTool(
    'fetch',
    {
      title: 'Fetch Meeting Note',
      description: 'Fetch the full summary and transcript of one meeting note by the id returned from search.',
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      const note = await fetchNote(id, NOTE_TRANSCRIPT_SELECT);
      if (!note) return errorResult(`Note not found: ${id}`);
      return jsonResult({
        id: String(note.id),
        title: getNoteTitle(note),
        text: buildFetchText(getNoteSummary(note), getNoteTranscriptText(note)),
        url: buildNoteUrl(note.id),
        metadata: {
          meetingAt: note.meeting_at ?? null,
          createdAt: note.created_at ?? null,
          owner: note.user_name?.trim() || null,
        },
      });
    },
  );
}
