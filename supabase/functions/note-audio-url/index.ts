import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { authorizeMicrosoftGraphToken } from '../_shared/msGraphAllowlist.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-ms-access-token',
};

const SIGNED_URL_SECONDS = 60 * 60;

interface RequestBody {
  noteId?: unknown;
}

interface NoteRow {
  id: string;
  user_id: string;
  audio_file: string | null;
  audio_file_id: string | null;
  shared_users: unknown;
}

interface FileRow {
  bucket: string | null;
  storage_path: string | null;
}

interface FileLookupRow extends FileRow {
  id: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function verifyAppJwt(token: string, secret: string): Promise<{ userId: string | null; error?: string }> {
  const parts = token.split('.');
  if (parts.length !== 3) return { userId: null, error: 'Invalid JWT format.' };
  const [encodedHeader, encodedPayload, signature] = parts;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  if (!timingSafeEqual(base64Url(new Uint8Array(expectedSignature)), signature)) {
    return { userId: null, error: 'Invalid JWT signature.' };
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload))) as Record<string, unknown>;
  } catch {
    return { userId: null, error: 'Invalid JWT payload.' };
  }
  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  if (exp && exp < Math.floor(Date.now() / 1000)) {
    return { userId: null, error: 'JWT is expired.' };
  }
  const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  return sub ? { userId: sub } : { userId: null, error: 'JWT did not include a user id.' };
}

/**
 * Sign a private audio object ONLY when storage itself confirms the note owner
 * owns it (R01). storage.objects.owner_id is set by Supabase to the uploader's
 * JWT sub at upload time and is not client-writable, unlike note.audio_file_id /
 * note.audio_file / the public.file row, all of which the client can point at an
 * arbitrary object. Returns the signed URL, or null when the object is not owned
 * by `ownerId` (caller then falls through to the next candidate). Throws if the
 * ownership RPC is unavailable, so the function fails CLOSED (never signs an
 * unverified object); the backing migration must be applied before deploy.
 */
async function signIfOwned(
  adminClient: SupabaseClient,
  bucket: string,
  storagePath: string,
  ownerId: string,
): Promise<string | null> {
  const { data: owner, error: ownerError } = await adminClient.rpc('storage_object_owner', {
    p_bucket: bucket,
    p_name: storagePath,
  });
  if (ownerError) throw ownerError;
  if (typeof owner !== 'string' || owner !== ownerId) return null;
  const { data: signedData, error: signedError } = await adminClient.storage
    .from(bucket)
    .createSignedUrl(storagePath, SIGNED_URL_SECONDS);
  if (signedError || !signedData?.signedUrl) {
    throw signedError ?? new Error('Could not create signed audio URL.');
  }
  return signedData.signedUrl;
}

function normalizeSharedUsers(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()));
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      return normalizeSharedUsers(JSON.parse(trimmed) as unknown);
    } catch {
      return trimmed.split(',').map((id) => id.trim()).filter(Boolean);
    }
  }
  return [];
}

function isUsableFallbackUrl(value: string | null): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseSupabaseStorageUrl(value: string | null): { bucket: string; storagePath: string } | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const markerMatch = parsed.pathname.match(/\/storage\/v1\/object\/(?:sign|public|authenticated)\/([^/]+)\/(.+)$/);
  if (!markerMatch?.[1] || !markerMatch?.[2]) return null;
  try {
    return {
      bucket: decodeURIComponent(markerMatch[1]),
      storagePath: decodeURIComponent(markerMatch[2]),
    };
  } catch {
    return {
      bucket: markerMatch[1],
      storagePath: markerMatch[2],
    };
  }
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
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: 'Note audio function is not configured.' }, 500);
  }

  const jwtSecret = Deno.env.get('SUPABASE_JWT_SECRET') ?? Deno.env.get('JWT_SECRET') ?? '';
  const authHeader = req.headers.get('authorization')?.trim() ?? '';
  const appToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  const microsoftToken = req.headers.get('x-ms-access-token')?.trim() ?? '';
  let authResult: { userId: string | null; error?: string; status?: number } = appToken && jwtSecret
    ? await verifyAppJwt(appToken, jwtSecret)
    : { userId: null, error: 'Missing app bearer token.' };
  // Graph fallback now enforces the org tenant/domain allowlist (shared helper),
  // so a bare Graph token from any tenant can no longer reach the signer.
  if (!authResult.userId && microsoftToken) {
    authResult = await authorizeMicrosoftGraphToken(microsoftToken);
  }
  if (!authResult.userId && !appToken && !microsoftToken) {
    authResult = { userId: null, error: 'Missing bearer token.' };
  }
  if (!authResult.userId) {
    return jsonResponse({ error: authResult.error ?? 'Unauthorized' }, authResult.status ?? 401);
  }

  const body = (await req.json().catch(() => ({}))) as RequestBody;
  const noteId = typeof body.noteId === 'string' ? body.noteId.trim() : '';
  if (!noteId) {
    return jsonResponse({ error: 'noteId is required.' }, 400);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { data: noteData, error: noteError } = await adminClient
      .from('note')
      .select('id, user_id, audio_file, audio_file_id, shared_users')
      .eq('id', noteId)
      .maybeSingle();
    if (noteError) throw noteError;
    const note = noteData as NoteRow | null;
    if (!note) return jsonResponse({ error: 'Note not found.' }, 404);

    const canAccess = note.user_id === authResult.userId || normalizeSharedUsers(note.shared_users).includes(authResult.userId);
    if (!canAccess) return jsonResponse({ error: 'Forbidden' }, 403);

    if (note.audio_file_id) {
      const { data: fileData, error: fileError } = await adminClient
        .from('file')
        .select('bucket, storage_path')
        .eq('id', note.audio_file_id)
        .maybeSingle();
      if (fileError) throw fileError;
      const file = fileData as FileRow | null;
      if (file?.storage_path) {
        const bucket = file.bucket || 'meeting-recordings';
        const signedUrl = await signIfOwned(adminClient, bucket, file.storage_path, note.user_id);
        if (signedUrl) {
          return jsonResponse({ url: signedUrl, expiresIn: SIGNED_URL_SECONDS });
        }
      }
    }

    const parsedStorageUrl = parseSupabaseStorageUrl(note.audio_file);
    if (parsedStorageUrl) {
      const signedUrl = await signIfOwned(
        adminClient,
        parsedStorageUrl.bucket,
        parsedStorageUrl.storagePath,
        note.user_id,
      );
      if (signedUrl) {
        return jsonResponse({ url: signedUrl, expiresIn: SIGNED_URL_SECONDS, legacy: true });
      }
    }

    if (note.audio_file) {
      const fileName = (() => {
        try {
          const parsed = new URL(note.audio_file);
          return decodeURIComponent(parsed.pathname.split('/').pop() ?? '').trim();
        } catch {
          return '';
        }
      })();
      if (fileName) {
        const { data: candidates, error: candidatesError } = await adminClient
          .from('file')
          .select('id, bucket, storage_path')
          .eq('user_id', note.user_id)
          .ilike('storage_path', `%${fileName}`)
          .order('created_at', { ascending: false })
          .limit(1);
        if (candidatesError) throw candidatesError;
        const candidate = Array.isArray(candidates) ? candidates[0] as FileLookupRow | undefined : undefined;
        if (candidate?.storage_path) {
          const bucket = candidate.bucket || 'meeting-recordings';
          const signedUrl = await signIfOwned(adminClient, bucket, candidate.storage_path, note.user_id);
          if (signedUrl) {
            return jsonResponse({
              url: signedUrl,
              expiresIn: SIGNED_URL_SECONDS,
              legacy: true,
              matchedFileId: candidate.id,
            });
          }
        }
      }
    }

    if (isUsableFallbackUrl(note.audio_file)) {
      return jsonResponse({
        url: note.audio_file,
        expiresIn: null,
        legacy: true,
        warning: 'Legacy audio URL could not be refreshed from storage path.',
      });
    }

    return jsonResponse({ error: 'Audio file is not available for this note.' }, 404);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
