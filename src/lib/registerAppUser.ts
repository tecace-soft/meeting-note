import { supabase } from '../config/supabaseConfig';

export async function registerAppUser(user: {
  id: string;
  displayName: string;
  email: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from('app_user').upsert(
    {
      microsoft_id: user.id,
      display_name: user.displayName,
      email: user.email,
      last_seen_at: now,
      updated_at: now,
    },
    { onConflict: 'microsoft_id' }
  );

  if (error) throw error;
}
