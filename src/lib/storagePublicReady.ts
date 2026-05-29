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

async function publicUrlIsReadable(publicUrl: string): Promise<boolean> {
  try {
    const res = await fetch(publicUrl, { method: 'HEAD', mode: 'cors', cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * After upload, public CDN URLs can briefly 404 until the object is visible.
 * Poll both Storage metadata and the public URL. If the object still is not
 * readable, fail the upload instead of saving a broken public_url record.
 */
export async function ensureStorageObjectReady(
  bucket: string,
  storagePath: string,
  publicUrl: string
): Promise<void> {
  const maxAttempts = 12;
  let delayMs = 80;
  let sawObject = false;

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(Math.round(delayMs * 1.6), 2500);
    }

    sawObject = sawObject || (await storageObjectExists(bucket, storagePath));
    if (sawObject && (await publicUrlIsReadable(publicUrl))) return;
  }

  throw new Error('Upload finished, but the audio file is not readable from storage yet. Please try uploading again.');
}

export async function ensurePublicStorageUrlReady(publicUrl: string): Promise<void> {
  const maxAttempts = 12;
  let delayMs = 80;

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(Math.round(delayMs * 1.6), 2500);
    }

    if (await publicUrlIsReadable(publicUrl)) return;
  }

  throw new Error('The uploaded file URL is not readable yet. Please try again.');
}
