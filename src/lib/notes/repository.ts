import { supabase } from '../../config/supabaseConfig';

// Reads retain their existing RLS visibility; this method only owns owner writes.
export async function updateOwnedNote(input: {
  noteId: string;
  userId: string | null | undefined;
  patch: { summary_edit?: string; name?: string };
}): Promise<void> {
  if (!input.userId?.trim()) throw new Error('인증 정보를 확인한 뒤 다시 시도해 주세요.');
  const { data, error } = await supabase
    .from('note')
    .update(input.patch)
    .eq('id', input.noteId)
    .eq('user_id', input.userId)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.id !== input.noteId) {
    throw new Error('노트를 변경하지 못했습니다. 권한이 없을 수 있습니다. 새로고침 후 다시 시도해 주세요.');
  }
}
