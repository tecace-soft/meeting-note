import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { clampLimit, errorResult, jsonResult } from '../lib/formatters.js';
import { getDataContext, getScopedUserId } from '../lib/supabase.js';

// F1' personal memory as an MCP tool. This is the PERSON-level counterpart to the
// note_insight-backed tools (find_action_items / search_notes / get_notes_by_date),
// which answer per-meeting or specific-person questions. Personal memory is the caller's
// OWN synthesized, cross-meeting understanding of their work, so it is strictly scoped to
// getScopedUserId() and never shared. The tool description is the routing contract: it
// tells the calling model when to reach for this vs the note tools.

interface MemoryItemRow {
  text?: unknown;
  entities?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  sourceNoteIds?: unknown;
}

interface RenderedMemoryItem {
  text: string;
  entities: string[];
  updatedAt: string | null;
  sourceNoteCount: number;
}

function toStr(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Active v2 items, most-recently-updated first. Empty for absent/empty/legacy-v1 memory. */
function renderActiveItems(memory: unknown, limit: number): RenderedMemoryItem[] {
  const obj = memory && typeof memory === 'object' && !Array.isArray(memory) ? (memory as Record<string, unknown>) : {};
  if (obj.version !== 2 || !Array.isArray(obj.items)) return [];
  const items: RenderedMemoryItem[] = [];
  for (const raw of obj.items) {
    const it = (raw && typeof raw === 'object' ? raw : {}) as MemoryItemRow;
    if (it.status === 'archived') continue;
    const text = toStr(it.text);
    if (!text) continue;
    const entities = Array.isArray(it.entities) ? it.entities.map(toStr).filter(Boolean).slice(0, 12) : [];
    const sourceNoteCount = Array.isArray(it.sourceNoteIds) ? it.sourceNoteIds.length : 0;
    items.push({ text, entities, updatedAt: toStr(it.updatedAt) || null, sourceNoteCount });
  }
  items.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return items.slice(0, limit);
}

export function registerMemoryTools(server: McpServer): void {
  server.registerTool(
    'recall_personal_context',
    {
      title: 'Recall Personal Context',
      description:
        "Return the logged-in user's durable PERSONAL MEMORY: a synthesized, cross-meeting understanding of THEIR OWN work, accumulated across all of their meetings (ongoing projects, recurring collaborators, the user's own open commitments, and the reasons behind past decisions). " +
        "Use this for PERSON-level questions about the caller THEMSELVES that span many meetings, e.g. 'what have I been working on lately?', 'what are my open commitments?', 'who do I work with most?', 'why did we decide X?'. " +
        'This is the caller\'s OWN memory only: it CANNOT answer what a specific other person did (use find_action_items or search_notes for owner-attributed facts), nor per-meeting details (use get_meeting_brief / get_notes_by_date). ' +
        'Returns the current standing memory items, most-recently-updated first; each item is one self-contained fact with the entities it mentions.',
      inputSchema: {
        limit: z.preprocess(
          (value) => (value === '' ? undefined : value),
          z.coerce.number().int().min(1).max(200).optional(),
        ),
      },
    },
    async ({ limit }) => {
      const userId = getScopedUserId();
      // Personal memory has no sharing model; without a caller identity there is nobody to
      // scope to, so fail closed rather than returning another user's row.
      if (!userId) return errorResult('No caller identity available; personal memory is strictly per-user.');
      const resolvedLimit = clampLimit(limit, 100, 200);
      const { supabase } = getDataContext();
      const { data, error } = await supabase
        .from('user_memory')
        .select('memory, updated_at')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) return errorResult(error.message);
      if (!data) {
        return jsonResult({ items: [], count: 0, hasMemory: false, note: 'No personal memory has been accumulated yet.' });
      }
      const row = data as { memory?: unknown; updated_at?: string | null };
      const items = renderActiveItems(row.memory ?? null, resolvedLimit);
      const isLegacy = items.length === 0 && Boolean(row.memory) && (row.memory as { version?: unknown })?.version !== 2;
      return jsonResult({
        items,
        count: items.length,
        hasMemory: true,
        updatedAt: row.updated_at ?? null,
        ...(isLegacy ? { note: 'Memory exists in a legacy pre-narrative format and will populate after the next meeting is processed.' } : {}),
      });
    },
  );
}
