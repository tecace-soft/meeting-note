import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../../config/supabaseConfig';

export interface GeneratedHistoryProfile {
  speakerId: string | null;
  speakerName: string;
  draft: string;
  isNew: boolean;
  saving: boolean;
  saved: boolean;
  saveError: string | null;
}

export async function invokeGenerateProfile(
  body: {
    speakerName: string;
    speakerId: string;
    transcriptText: string;
    existingProfile: string | null;
  },
  auth: { appToken: string | null; msToken: string | null }
): Promise<{ profile?: string; error?: string }> {
  const response = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/generate-profile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${auth.appToken ?? SUPABASE_ANON_KEY}`,
      ...(auth.msToken ? { 'x-ms-access-token': auth.msToken } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed: { profile?: string; error?: string };
  try {
    parsed = raw ? JSON.parse(raw) as { profile?: string; error?: string } : {};
  } catch {
    parsed = { error: raw || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    throw new Error(parsed.error || raw || `HTTP ${response.status}`);
  }
  return parsed;
}
