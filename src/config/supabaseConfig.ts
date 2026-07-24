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
// True once auth has resolved with NO signed-in user (legitimately anonymous).
// Distinguishes "auth still initializing" (wait for a token) from "logged out"
// (proceed with the anon key). Without this the client used to race a fixed 5s
// timer and silently fall back to the anon key mid-init, so an authenticated
// user's first queries ran anonymously and returned empty result sets under RLS.
let authResolvedWithoutUser = false;
const providerWaiters = new Set<() => void>();

function resolveProviderWaiters(): void {
  providerWaiters.forEach((resolve) => resolve());
  providerWaiters.clear();
}

export function setSupabaseAccessTokenProvider(provider: (() => Promise<string | null>) | null): void {
  supabaseAccessTokenProvider = provider;
  if (provider) authResolvedWithoutUser = false;
  if (debugSupabaseAuth) {
    console.info(`Supabase access token provider ${provider ? 'registered' : 'cleared'}.`);
  }
  resolveProviderWaiters();
}

/**
 * Signals that auth has settled without a signed-in user, so pending queries may
 * proceed with the anon key instead of waiting for a token that will never come.
 */
export function setSupabaseAuthResolvedWithoutUser(resolved: boolean): void {
  authResolvedWithoutUser = resolved;
  if (resolved) resolveProviderWaiters();
}

async function waitForSupabaseAccessTokenProvider(): Promise<(() => Promise<string | null>) | null> {
  if (supabaseAccessTokenProvider) return supabaseAccessTokenProvider;
  // Auth already settled logged-out: anon is legitimate, don't stall.
  if (authResolvedWithoutUser) return null;
  if (debugSupabaseAuth) {
    console.info('Waiting for Supabase auth to settle...');
  }
  // Wait for the provider to register or for auth to settle logged-out. A long
  // safety cap prevents an indefinite hang if the auth layer never signals.
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(() => {
      providerWaiters.delete(waiter);
      console.warn('Timed out waiting for Supabase auth to settle; proceeding without a token.');
      resolve();
    }, 15000);
    const waiter = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    providerWaiters.add(waiter);
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

