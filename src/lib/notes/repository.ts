import { supabase } from '../../config/supabaseConfig';

export async function updateOwnedNote(input: {
  noteId: string;
  userId: string | null | undefined;
  patch: { summary_edit?: string; name?: string };
}): Promise<void> {
  const { error } = await supabase
    .from('note')
    .update(input.patch)
    .eq('id', input.noteId);
  if (error) throw error;
}
