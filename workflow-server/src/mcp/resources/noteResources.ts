import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonResource } from '../lib/formatters.js';
import { fetchNote, getNoteSummary, NOTE_SUMMARY_SELECT, summarizeNote } from '../lib/supabase.js';

function variableToString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export function registerNoteResources(server: McpServer): void {
  server.registerResource(
    'note',
    new ResourceTemplate('note://{noteId}', { list: undefined }),
    {
      title: 'Meeting Note',
      description: 'Meeting note metadata, summary, and transcript availability.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const noteId = variableToString(variables.noteId);
      const note = await fetchNote(noteId, NOTE_SUMMARY_SELECT);
      return jsonResource(
        uri.href,
        note
          ? {
              ...summarizeNote(note),
              summary: getNoteSummary(note),
              transcriptResource: `note://${note.id}/transcript`,
            }
          : { error: `Note not found: ${noteId}` },
      );
    },
  );
}
