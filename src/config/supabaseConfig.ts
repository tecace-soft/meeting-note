import { createClient } from '@supabase/supabase-js';

const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const hasViteEnv = Boolean((import.meta as unknown as { env?: Record<string, string | undefined> }).env);
const nodeEnv =
  typeof process !== 'undefined'
    ? (process.env as Record<string, string | undefined>)
    : {};
const supabaseUrl = viteEnv.VITE_SUPABASE_URL ?? nodeEnv.VITE_SUPABASE_URL;
const supabaseAnonKey = viteEnv.VITE_SUPABASE_ANON_KEY ?? nodeEnv.VITE_SUPABASE_ANON_KEY;
const debugSupabaseAuth = viteEnv.VITE_DEBUG_SUPABASE_AUTH === 'true';

if (hasViteEnv && (!supabaseUrl || !supabaseAnonKey)) {
  console.warn('Supabase credentials not configured');
}

export const SUPABASE_URL = supabaseUrl || '';
export const SUPABASE_ANON_KEY = supabaseAnonKey || '';

let supabaseAccessTokenProvider: (() => Promise<string | null>) | null = null;
const providerWaiters = new Set<() => void>();

export function setSupabaseAccessTokenProvider(provider: (() => Promise<string | null>) | null): void {
  supabaseAccessTokenProvider = provider;
  if (debugSupabaseAuth) {
    console.info(`Supabase access token provider ${provider ? 'registered' : 'cleared'}.`);
  }
  providerWaiters.forEach((resolve) => resolve());
  providerWaiters.clear();
}

async function waitForSupabaseAccessTokenProvider(): Promise<(() => Promise<string | null>) | null> {
  if (supabaseAccessTokenProvider) return supabaseAccessTokenProvider;
  if (debugSupabaseAuth) {
    console.info('Waiting for Supabase access token provider...');
  }
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(() => {
      providerWaiters.delete(resolve);
      if (debugSupabaseAuth) {
        console.warn('Timed out waiting for Supabase access token provider; request will use anon key.');
      }
      resolve();
    }, 5000);
    providerWaiters.add(() => {
      window.clearTimeout(timeout);
      resolve();
    });
  });
  return supabaseAccessTokenProvider;
}

export async function getSupabaseAccessTokenForRequest(): Promise<string | null> {
  const provider = await waitForSupabaseAccessTokenProvider();
  return provider?.() ?? null;
}

export const supabase = createClient(
  SUPABASE_URL || 'https://placeholder.supabase.co',
  SUPABASE_ANON_KEY || 'missing-anon-key',
  {
    accessToken: async () => {
      const token = await getSupabaseAccessTokenForRequest();
      if (debugSupabaseAuth) {
        console.info(`Supabase access token ${token ? 'resolved' : 'missing'} for request.`);
      }
      return token;
    },
  }
);

export const AUDIO_BUCKET = 'meeting-recordings';
export const NOTE_IMAGE_BUCKET = 'meeting-note-images';
export const RECORDING_DRAFT_BUCKET = 'recording-drafts';

