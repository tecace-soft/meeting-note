import { createClient } from '@supabase/supabase-js';

const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const hasViteEnv = Boolean((import.meta as unknown as { env?: Record<string, string | undefined> }).env);
const nodeEnv =
  typeof process !== 'undefined'
    ? (process.env as Record<string, string | undefined>)
    : {};
const supabaseUrl = viteEnv.VITE_SUPABASE_URL ?? nodeEnv.VITE_SUPABASE_URL;
const supabaseAnonKey = viteEnv.VITE_SUPABASE_ANON_KEY ?? nodeEnv.VITE_SUPABASE_ANON_KEY;

if (hasViteEnv && (!supabaseUrl || !supabaseAnonKey)) {
  console.warn('Supabase credentials not configured');
}

export const SUPABASE_URL = supabaseUrl || '';
export const SUPABASE_ANON_KEY = supabaseAnonKey || '';

export const supabase = createClient(
  SUPABASE_URL || 'https://placeholder.supabase.co',
  SUPABASE_ANON_KEY || 'missing-anon-key'
);

export const AUDIO_BUCKET = 'meeting-recordings';

