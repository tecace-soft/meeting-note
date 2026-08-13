import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { applyMeetingDateFilter, describeDateFilter, resolveDateFilter } from '../lib/dateFilters.js';
import { clampLimit, errorResult, jsonResult, truncateText } from '../lib/formatters.js';
import {
  applyNoteAccessScope,
  fetchNote,
  getDataContext,
  getNoteSummary,
  getNoteTranscriptText,
  getScopedUserId,
  NOTE_SUMMARY_SELECT,
  NOTE_TRANSCRIPT_SELECT,
  summarizeNote,
  toIdValue,
  type NoteRow,
} from '../lib/supabase.js';
import { normalizeTranscript } from '../lib/transcript.js';

interface AttachmentRow {
  id: string;
  note_id?: string | null;
  name?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  storage_path?: string | null;
  thumbnail_storage_path?: string | null;
  created_at?: string | null;
}

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

function optionalBoolean() {
  return z.preprocess((value) => {
    if (value === '') return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }, z.boolean().optional());
}

async function fetchNoteAttachments(noteId: string): Promise<{ attachments: AttachmentRow[]; unavailableReason?: string }> {
  const { supabase } = getDataContext();
  const { data, error } = await supabase
    .from('note_image')
    .select('id, note_id, name, mime_type, size_bytes, storage_path, thumbnail_storage_path, created_at')
    .eq('note_id', noteId)
    .order('created_at', { ascending: true });

  if (error) return { attachments: [], unavailableReason: error.message };
  return { attachments: ((data as AttachmentRow[]) ?? []) };
}

function summarizeAttachment(attachment: AttachmentRow) {
  return {
    id: attachment.id,
    name: attachment.name ?? 'Untitled attachment',
    mimeType: attachment.mime_type ?? null,
    sizeBytes: attachment.size_bytes ?? null,
    storagePath: attachment.storage_path ?? null,
    hasThumbnail: Boolean(attachment.thumbnail_storage_path),
    createdAt: attachment.created_at ?? null,
  };
}

function extractActionItemCandidates(note: NoteRow, maxItemsPerNote: number) {
  const sourceText = getNoteSummary(note) || getNoteTranscriptText(note);
  const lines = sourceText
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*|#\d.]+\s*/, '').trim())
    .filter(Boolean);

  const actionPatterns = [
    /\b(action item|todo|to do|next step|follow up|owner|due|deadline|responsible)\b/i,
    /(해야|진행|담당|일정|마감|후속|액션|다음 단계)/i,
  ];

  const candidates: Array<{ title: string; excerpt: string; confidence: 'high' | 'medium' }> = [];
  for (const line of lines) {
    if (!actionPatterns.some((pattern) => pattern.test(line))) continue;
    const cleaned = line.replace(/\s+/g, ' ').trim();
    candidates.push({
      title: truncateText(cleaned, 180),
      excerpt: cleaned,
      confidence: /\b(action item|todo|to do|next step)\b/i.test(cleaned) || /(액션|다음 단계)/i.test(cleaned) ? 'high' : 'medium',
    });
    if (candidates.length >= maxItemsPerNote) break;
  }
  return candidates;
}

export function registerContextTools(_server: McpServer): void {
  const server = _server;

  server.registerTool(
    'get_meeting_brief',
    {
      title: 'Get Meeting Brief',
      description: 'Return one compact meeting package with metadata, summary, optional transcript excerpt, speakers, and attachment metadata.',
      inputSchema: {
        noteId: z.string().min(1),
        includeTranscriptExcerpt: optionalBoolean(),
        includeAttachments: optionalBoolean(),
        maxSummaryCharacters: optionalInt(100, 50000),
        maxTranscriptCharacters: optionalInt(100, 100000),
      },
    },
    async ({ noteId, includeTranscriptExcerpt = false, includeAttachments = true, maxSummaryCharacters, maxTranscriptCharacters }) => {
      const note = await fetchNote(noteId, includeTranscriptExcerpt ? NOTE_TRANSCRIPT_SELECT : NOTE_SUMMARY_SELECT);
      if (!note) return errorResult(`Note not found: ${noteId}`);

      const attachments = includeAttachments ? await fetchNoteAttachments(note.id) : { attachments: [] };
      const segments = includeTranscriptExcerpt ? normalizeTranscript(note.diarization) : [];
      const transcript = includeTranscriptExcerpt ? getNoteTranscriptText(note) : '';

      return jsonResult({
        note: summarizeNote(note),
        summary: truncateText(getNoteSummary(note) || 'No summary for this note.', maxSummaryCharacters),
        transcriptExcerpt: includeTranscriptExcerpt ? truncateText(transcript || 'No transcript for this note.', maxTranscriptCharacters) : null,
        speakers: segments.length ? [...new Set(segments.map((segment) => segment.speaker).filter(Boolean))] : undefined,
        attachments: attachments.attachments.map(summarizeAttachment),
        attachmentsUnavailableReason: attachments.unavailableReason,
      });
    },
  );

  server.registerTool(
    'get_attachment_context',
    {
      title: 'Get Attachment Context',
      description: 'Return attachment metadata for a meeting note. This does not download file contents.',
      inputSchema: {
        noteId: z.string().min(1),
      },
    },
    async ({ noteId }) => {
      const note = await fetchNote(noteId, NOTE_SUMMARY_SELECT);
      if (!note) return errorResult(`Note not found: ${noteId}`);
      const attachments = await fetchNoteAttachments(note.id);
      return jsonResult({
        note: summarizeNote(note),
        attachments: attachments.attachments.map(summarizeAttachment),
        unavailableReason: attachments.unavailableReason,
      });
    },
  );

  server.registerTool(
    'get_project_timeline',
    {
      title: 'Get Project Timeline',
      description: 'Return project-related meetings in chronological order with compact summaries.',
      inputSchema: {
        projectId: z.string().min(1),
        limit: optionalInt(1, 100),
        maxCharactersPerSummary: optionalInt(100, 20000),
        ...dateFilterSchema,
      },
    },
    async ({ projectId, limit, maxCharactersPerSummary, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const resolvedLimit = clampLimit(limit, 50, 100);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      let query = supabase
        .from('note')
        .select(NOTE_SUMMARY_SELECT)
        .contains('projects', [toIdValue(projectId)])
        .order('meeting_at', { ascending: true, nullsFirst: true })
        .order('created_at', { ascending: true })
        .limit(resolvedLimit);
      query = applyNoteAccessScope(query, userId);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      return jsonResult({
        projectId,
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        meetings: ((data as NoteRow[]) ?? []).map((note) => ({
          ...summarizeNote(note),
          summary: truncateText(getNoteSummary(note) || 'No summary for this note.', maxCharactersPerSummary),
        })),
      });
    },
  );

  server.registerTool(
    'find_action_items',
    {
      title: 'Find Action Items',
      description: 'Find action items and follow-ups from accessible meetings, with source note evidence. Uses the structured note_insight index (owner/due/status) when available, falling back to a summary-text heuristic for notes not yet indexed.',
      inputSchema: {
        projectId: z.string().optional(),
        limit: optionalInt(1, 100),
        noteLimit: optionalInt(1, 200),
        maxItemsPerNote: optionalInt(1, 20),
        includeTranscriptFallback: optionalBoolean(),
        ...dateFilterSchema,
      },
    },
    async ({ projectId, limit, noteLimit, maxItemsPerNote, includeTranscriptFallback = false, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const resolvedLimit = clampLimit(limit, 50, 100);
      const resolvedNoteLimit = clampLimit(noteLimit, 50, 200);
      const resolvedMaxItemsPerNote = clampLimit(maxItemsPerNote, 8, 20);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      let query = supabase
        .from('note')
        .select((includeTranscriptFallback ? NOTE_TRANSCRIPT_SELECT : NOTE_SUMMARY_SELECT) as string)
        .order('meeting_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(resolvedNoteLimit);
      query = applyNoteAccessScope(query, userId);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const notes = ((data as unknown) as NoteRow[]) ?? [];

      // Prefer the structured note_insight.actions (server-extracted: text/owner/
      // due/status) over the summary-text heuristic. Fetch insight rows for the
      // notes in scope; notes without a row yet (not backfilled) use the heuristic.
      const noteIds = notes.map((note) => note.id).filter(Boolean);
      const actionsByNote = new Map<string, Array<{ text?: unknown; owner?: unknown; due?: unknown; status?: unknown }>>();
      if (noteIds.length > 0) {
        const { data: insightRows } = await supabase.from('note_insight').select('note_id, actions').in('note_id', noteIds);
        for (const row of (insightRows as Array<{ note_id: string; actions: unknown }> | null) ?? []) {
          if (Array.isArray(row.actions) && row.actions.length > 0) {
            actionsByNote.set(row.note_id, row.actions as Array<{ text?: unknown }>);
          }
        }
      }

      const items: Array<Record<string, unknown>> = [];
      for (const note of notes) {
        const sourceNote = summarizeNote(note);
        const structured = actionsByNote.get(note.id);
        if (structured) {
          for (const action of structured.slice(0, resolvedMaxItemsPerNote)) {
            const text = typeof action.text === 'string' ? action.text.trim() : '';
            if (!text) continue;
            items.push({
              text,
              owner: typeof action.owner === 'string' && action.owner.trim() ? action.owner.trim() : null,
              due: typeof action.due === 'string' && action.due.trim() ? action.due.trim() : null,
              status: typeof action.status === 'string' && action.status.trim() ? action.status.trim() : 'open',
              source: 'insight',
              sourceNote,
            });
            if (items.length >= resolvedLimit) break;
          }
        } else {
          for (const candidate of extractActionItemCandidates(note, resolvedMaxItemsPerNote)) {
            items.push({ ...candidate, source: 'summary-heuristic', sourceNote });
            if (items.length >= resolvedLimit) break;
          }
        }
        if (items.length >= resolvedLimit) break;
      }

      return jsonResult({
        projectId: projectId ?? null,
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        searchedNotes: notes.length,
        actionItems: items,
      });
    },
  );

  server.registerTool(
    'find_events',
    {
      title: 'Find Events (cause → effect)',
      description: 'Find cause→effect events (what happened / was done and what it led to) across accessible meetings, with source note evidence. Best for reverse "what did I do / what happened and why" questions. Reads the structured note_insight.events index; notes not yet indexed have no events.',
      inputSchema: {
        projectId: z.string().optional(),
        limit: optionalInt(1, 100),
        noteLimit: optionalInt(1, 200),
        maxItemsPerNote: optionalInt(1, 20),
        ...dateFilterSchema,
      },
    },
    async ({ projectId, limit, noteLimit, maxItemsPerNote, date, startDate, endDate }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const resolvedLimit = clampLimit(limit, 50, 100);
      const resolvedNoteLimit = clampLimit(noteLimit, 50, 200);
      const resolvedMaxItemsPerNote = clampLimit(maxItemsPerNote, 8, 20);
      const dateFilter = resolveDateFilter({ date, startDate, endDate });
      let query = supabase
        .from('note')
        .select(NOTE_SUMMARY_SELECT as string)
        .order('meeting_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(resolvedNoteLimit);
      query = applyNoteAccessScope(query, userId);
      if (projectId) query = query.contains('projects', [toIdValue(projectId)]);
      query = applyMeetingDateFilter(query, dateFilter);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      const notes = ((data as unknown) as NoteRow[]) ?? [];

      // Events live only in the structured note_insight index (no summary-text heuristic
      // fallback — a cause→effect pair is not recoverable from free text reliably). Notes
      // without an insight row yet simply contribute no events.
      const noteIds = notes.map((note) => note.id).filter(Boolean);
      const eventsByNote = new Map<string, Array<{ cause?: unknown; effect?: unknown }>>();
      if (noteIds.length > 0) {
        const { data: insightRows } = await supabase.from('note_insight').select('note_id, events').in('note_id', noteIds);
        for (const row of (insightRows as Array<{ note_id: string; events: unknown }> | null) ?? []) {
          if (Array.isArray(row.events) && row.events.length > 0) {
            eventsByNote.set(row.note_id, row.events as Array<{ cause?: unknown; effect?: unknown }>);
          }
        }
      }

      const items: Array<Record<string, unknown>> = [];
      for (const note of notes) {
        const structured = eventsByNote.get(note.id);
        if (!structured) continue;
        const sourceNote = summarizeNote(note);
        for (const ev of structured.slice(0, resolvedMaxItemsPerNote)) {
          const cause = typeof ev.cause === 'string' ? ev.cause.trim() : '';
          const effect = typeof ev.effect === 'string' ? ev.effect.trim() : '';
          if (!cause || !effect) continue;
          items.push({ cause, effect, source: 'insight', sourceNote });
          if (items.length >= resolvedLimit) break;
        }
        if (items.length >= resolvedLimit) break;
      }

      return jsonResult({
        projectId: projectId ?? null,
        dateFilter: describeDateFilter({ date, startDate, endDate }, dateFilter),
        searchedNotes: notes.length,
        events: items,
      });
    },
  );
}
