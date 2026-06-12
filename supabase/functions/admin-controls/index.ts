import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-ms-access-token',
};

const ADMIN_MICROSOFT_USER_IDS = new Set([
  'd84c9149-2261-4ced-b14c-01b1a377ba6b',
  'd9eb0f3d-819e-4b45-8df6-e9f229de2447',
]);

const SPEECH_MODELS = new Set(['universal-3-pro', 'universal-2']);

interface CustomSpellingRule {
  from: string[];
  to: string;
}

interface SettingsBody {
  speechModel?: unknown;
  keytermsPrompt?: unknown;
  customSpelling?: unknown;
  summaryContext?: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function getMicrosoftUserId(accessToken: string): Promise<{ userId: string | null; error?: string }> {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return {
      userId: null,
      error: `Microsoft Graph /me rejected the token (${response.status}). ${detail.slice(0, 300)}`,
    };
  }
  const data = (await response.json()) as { id?: unknown };
  return {
    userId: typeof data.id === 'string' && data.id.trim() ? data.id.trim() : null,
    error: 'Microsoft Graph /me did not return a user id.',
  };
}

function normalizeKeyterms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const term = item.trim();
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push(term);
  }
  return out.slice(0, 250);
}

function normalizeCustomSpelling(value: unknown): CustomSpellingRule[] {
  if (!Array.isArray(value)) return [];
  const out: CustomSpellingRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const to = typeof record.to === 'string' ? record.to.trim() : '';
    const from = Array.isArray(record.from)
      ? record.from.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
      : [];
    const uniqueFrom = [...new Set(from)];
    if (!to || uniqueFrom.length === 0) continue;
    out.push({ from: uniqueFrom.slice(0, 25), to });
  }
  return out.slice(0, 100);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? Deno.env.get('MEETING_NOTE_SUPABASE_URL') ?? '';
  const serviceRoleKey =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('MEETING_NOTE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: 'Admin controls function is not configured.' }, 500);
  }

  const bearerToken = req.headers.get('x-ms-access-token')?.trim() ?? '';
  const authResult = bearerToken
    ? await getMicrosoftUserId(bearerToken)
    : { userId: null, error: 'Missing Microsoft bearer token.' };
  if (!authResult.userId) {
    return jsonResponse({ error: authResult.error ?? 'Unauthorized' }, 401);
  }
  if (!ADMIN_MICROSOFT_USER_IDS.has(authResult.userId)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as SettingsBody;
      const speechModel = typeof body.speechModel === 'string' && SPEECH_MODELS.has(body.speechModel)
        ? body.speechModel
        : 'universal-3-pro';
      const keytermsPrompt = normalizeKeyterms(body.keytermsPrompt);
      const customSpelling = normalizeCustomSpelling(body.customSpelling);
      const summaryContext = typeof body.summaryContext === 'string' ? body.summaryContext.trim().slice(0, 20000) : '';
      const { error } = await adminClient.from('workflow_transcription_settings').upsert({
        id: 'global',
        speech_model: speechModel,
        keyterms_prompt: keytermsPrompt,
        custom_spelling: customSpelling,
        summary_context: summaryContext,
        updated_by: authResult.userId,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
      if (error) throw error;
    }

    const { data, error } = await adminClient
      .from('workflow_transcription_settings')
      .select('speech_model, keyterms_prompt, custom_spelling, summary_context, updated_by, updated_at')
      .eq('id', 'global')
      .maybeSingle();
    if (error) throw error;

    return jsonResponse({
      speechModel: data?.speech_model ?? 'universal-3-pro',
      keytermsPrompt: Array.isArray(data?.keyterms_prompt) ? data.keyterms_prompt : [],
      customSpelling: Array.isArray(data?.custom_spelling) ? data.custom_spelling : [],
      summaryContext: typeof data?.summary_context === 'string' ? data.summary_context : '',
      updatedBy: data?.updated_by ?? null,
      updatedAt: data?.updated_at ?? null,
    });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
