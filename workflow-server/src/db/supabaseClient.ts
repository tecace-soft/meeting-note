import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

export const supabase = createClient(env.supabaseUrl || 'https://placeholder.supabase.co', env.serviceRoleKey || 'missing-service-role-key', {
  auth: { persistSession: false, autoRefreshToken: false },
});
