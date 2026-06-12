import { supabase } from '../config/supabaseConfig';

function splitStoragePath(path: string): { folder: string; name: string } {
  const normalized = path.replace(/^\/+/, '');
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) return { folder: '', name: normalized };
  return {
    folder: normalized.slice(0, slash),
    name: normalized.slice(slash + 1),
  };
}

async function storageObjectExists(bucket: string, storagePath: string): Promise<boolean> {
  const { folder, name } = splitStoragePath(storagePath);
  if (!name) return false;

  const { data, error } = await supabase.storage.from(bucket).list(folder, {
    limit: 100,
    search: name,
  });
  if (error) return false;
  return (data ?? []).some((item) => item.name === name);
}

/**
 * After upload, Storage metadata can briefly lag. Poll object metadata before
 * saving the file record so private-bucket signed URLs can be created reliably.
 */
export async function ensureStorageObjectReady(
  bucket: string,
  storagePath: string
): Promise<void> {
  const maxAttempts = 12;
  let delayMs = 80;

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(Math.round(delayMs * 1.6), 2500);
    }

    if (await storageObjectExists(bucket, storagePath)) return;
  }

  throw new Error('Upload finished, but the audio file is not visible in storage yet. Please try uploading again.');
}
