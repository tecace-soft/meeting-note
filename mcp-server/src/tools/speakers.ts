import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { clampLimit, errorResult, jsonResult, truncateText } from '../lib/formatters.js';
import { fetchSpeakerByIdOrName, getDataContext, getScopedUserId, type SpeakerRow } from '../lib/supabase.js';

function optionalInt(min: number, max: number) {
  return z.preprocess((value) => (value === '' ? undefined : value), z.coerce.number().int().min(min).max(max).optional());
}

export function registerSpeakerTools(server: McpServer): void {
  server.registerTool(
    'list_speakers',
    {
      title: 'List Speakers',
      description: 'List saved speakers and whether each speaker has a saved profile.',
      inputSchema: {
        query: z.string().optional(),
        limit: optionalInt(1, 100),
      },
    },
    async ({ query, limit }) => {
      const { supabase } = getDataContext();
      const userId = getScopedUserId();
      const resolvedLimit = clampLimit(limit, 25, 100);
      let dbQuery = supabase.from('speaker').select('id, user_id, name, profile, created_at').order('name').limit(resolvedLimit);
      if (userId) dbQuery = dbQuery.eq('user_id', userId);
      if (query?.trim()) dbQuery = dbQuery.ilike('name', `%${query.trim()}%`);
      const { data, error } = await dbQuery;
      if (error) return errorResult(error.message);
      return jsonResult({
        speakers: ((data as SpeakerRow[]) ?? []).map((speaker) => ({
          id: speaker.id,
          name: speaker.name,
          hasProfile: Boolean(speaker.profile?.trim()),
          createdAt: speaker.created_at ?? null,
        })),
      });
    },
  );

  server.registerTool(
    'get_speaker_profile',
    {
      title: 'Get Speaker Profile',
      description: 'Fetch a saved speaker profile/ontology by speaker id or exact speaker name.',
      inputSchema: {
        speakerId: z.string().optional(),
        speakerName: z.string().optional(),
        maxCharacters: optionalInt(100, 50000),
      },
    },
    async ({ speakerId, speakerName, maxCharacters }) => {
      if (!speakerId && !speakerName) return errorResult('Provide speakerId or speakerName.');
      const speaker = await fetchSpeakerByIdOrName({ speakerId, speakerName });
      if (!speaker) return errorResult(`Speaker not found: ${speakerId ?? speakerName}`);
      return jsonResult({
        id: speaker.id,
        name: speaker.name,
        profile: truncateText(speaker.profile?.trim() || 'No saved profile for this speaker.', maxCharacters),
      });
    },
  );
}
