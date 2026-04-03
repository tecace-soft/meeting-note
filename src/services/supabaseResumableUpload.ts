import { Upload } from 'tus-js-client';
import { AUDIO_BUCKET } from '../config/supabaseConfig';

/** Supabase Storage TUS uses fixed 6MB chunks; use resumable uploads at this size and above. */
export const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 6 * 1024 * 1024;

function getResumableEndpoint(projectUrl: string): string {
  const trimmed = projectUrl.replace(/\/$/, '');
  const match = trimmed.match(/^https:\/\/([a-z0-9-]+)\.supabase\.co$/i);
  if (!match) {
    throw new Error(
      'Resumable upload needs VITE_SUPABASE_URL like https://<project-ref>.supabase.co'
    );
  }
  return `https://${match[1]}.storage.supabase.co/storage/v1/upload/resumable`;
}

export function shouldUseResumableUpload(fileSize: number): boolean {
  return fileSize >= RESUMABLE_UPLOAD_THRESHOLD_BYTES;
}

/**
 * Chunked TUS upload (recommended by Supabase for files ≥6MB).
 * Uses the anon key like the standard JS client for unauthenticated buckets.
 */
export function uploadWithTus(
  objectPath: string,
  file: File,
  projectUrl: string,
  anonKey: string,
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void
): Promise<void> {
  if (!projectUrl || !anonKey) {
    return Promise.reject(new Error('Supabase URL or key not configured'));
  }

  const endpoint = getResumableEndpoint(projectUrl);

  return new Promise((resolve, reject) => {
    const upload = new Upload(file, {
      endpoint,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${anonKey}`,
        apikey: anonKey,
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName: AUDIO_BUCKET,
        objectName: objectPath,
        contentType: file.type || 'application/octet-stream',
        cacheControl: '3600',
      },
      chunkSize: 6 * 1024 * 1024,
      onError: (err) => reject(err instanceof Error ? err : new Error(String(err))),
      onProgress: (bytesUploaded, bytesTotal) => onProgress?.(bytesUploaded, bytesTotal),
      onSuccess: () => resolve(),
    });

    upload
      .findPreviousUploads()
      .then((previous) => {
        if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      })
      .catch(reject);
  });
}
