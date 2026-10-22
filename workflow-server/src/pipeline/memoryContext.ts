import { env } from '../config/env.js';
import { supabase } from '../db/supabaseClient.js';
import { renderMemoryForContext } from '../memory.js';

/**
 * The logged-in user's personal memory as a bounded BACKGROUND context block for the
 * summary prompt. Best-effort and guaranteed non-throwing: a memory read must never block
 * or fail a summary. Returns '' when there is no memory, no DB configured, or on any error.
 */
export async function getPersonalMemoryContext(userId: string | undefined): Promise<string> {
  if (!userId || !env.supabaseUrl || !env.serviceRoleKey) return '';
  try {
    const { data, error } = await supabase.from('user_memory').select('memory').eq('user_id', userId).maybeSingle();
    if (error || !data) return '';
    return renderMemoryForContext((data as { memory?: unknown }).memory ?? null);
  } catch (memoryError) {
    console.warn(`Personal memory context read failed for user ${userId}:`, memoryError);
    return '';
  }
}
