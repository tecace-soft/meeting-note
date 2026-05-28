import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-ms-access-token',
};

type Action = 'list' | 'create' | 'revoke';

interface RequestBody {
  action?: Action;
  name?: string;
  tokenId?: string;
}

interface TokenRow {
  id: string;
  name: string;
  token_prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const value = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `mn_live_${value}`;
}

async function hashToken(token: string, pepper: string): Promise<string> {
  const input = new TextEncoder().encode(`${pepper}:${token}`);
  return toHex(await crypto.subtle.digest('SHA-256', input));
}

function publicToken(row: TokenRow) {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? Deno.env.get('MEETING_NOTE_SUPABASE_URL') ?? '';
  const serviceRoleKey =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('MEETING_NOTE_SERVICE_ROLE_KEY') ?? '';
  const tokenPepper = Deno.env.get('MCP_TOKEN_PEPPER') ?? serviceRoleKey;
  if (!supabaseUrl || !serviceRoleKey || !tokenPepper) {
    return jsonResponse({ error: 'MCP token function is not configured.' }, 500);
  }

  const bearerToken = req.headers.get('x-ms-access-token')?.trim() ?? '';
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const authResult = bearerToken
      ? await getMicrosoftUserId(bearerToken)
      : { userId: null, error: 'Missing Microsoft bearer token.' };
    const userId = authResult.userId;
    if (!userId) {
      return jsonResponse({ error: authResult.error ?? 'Unauthorized' }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const action: Action = body.action ?? 'list';

    if (action === 'list') {
      const { data, error } = await adminClient
        .from('mcp_token')
        .select('id, name, token_prefix, last_used_at, revoked_at, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return jsonResponse({ tokens: ((data ?? []) as TokenRow[]).map(publicToken) });
    }

    if (action === 'create') {
      const token = randomToken();
      const tokenHash = await hashToken(token, tokenPepper);
      const name = body.name?.trim() || 'Claude Desktop';
      const tokenPrefix = `${token.slice(0, 12)}...${token.slice(-4)}`;

      const { data, error } = await adminClient
        .from('mcp_token')
        .insert({
          user_id: userId,
          name,
          token_hash: tokenHash,
          token_prefix: tokenPrefix,
        })
        .select('id, name, token_prefix, last_used_at, revoked_at, created_at')
        .single();
      if (error) throw error;

      return jsonResponse({ token, tokenRecord: publicToken(data as TokenRow) });
    }

    if (action === 'revoke') {
      if (!body.tokenId) return jsonResponse({ error: 'tokenId is required.' }, 400);
      const { error } = await adminClient
        .from('mcp_token')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', body.tokenId)
        .eq('user_id', userId)
        .is('revoked_at', null);
      if (error) throw error;
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: 'Unknown action.' }, 400);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
