// Android recording upload helpers: multipart parsing, audio type checks, filename
// sanitizing and the storage/file-row writes. The route itself lives in index.ts.
import type { IncomingMessage } from 'node:http';
import { createWriteStream } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Busboy from 'busboy';
import { HttpError } from '../http/shared.js';
import { supabase } from '../db/supabaseClient.js';

export interface AndroidUploadFile {
  fieldName: string;
  originalName: string;
  mimeType: string;
  tempPath: string;
  sizeBytes: number;
}

export interface AndroidRecordingUpload {
  file: AndroidUploadFile;
  fields: Record<string, string>;
}

export const AUDIO_BUCKET = 'meeting-recordings';

export const ANDROID_AUDIO_MAX_BYTES = 100 * 1024 * 1024;

export const ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS = [
  '3ga',
  '8svx',
  'aac',
  'ac3',
  'aif',
  'aiff',
  'alac',
  'amr',
  'ape',
  'au',
  'dss',
  'flac',
  'flv',
  'm4a',
  'm4b',
  'm4p',
  'm4r',
  'mp3',
  'mp4',
  'mpeg',
  'mpg',
  'oga',
  'ogg',
  'opus',
  'qcp',
  'ra',
  'ram',
  'sln',
  'spx',
  'wav',
  'webm',
  'wma',
] as const;

export const ASSEMBLYAI_AUDIO_EXTENSION_RE = new RegExp(
  `\\.(${ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS.join('|')})$`,
  'i'
);

export function sanitizeUploadFileName(value: string, fallback: string): string {
  const base = value.split(/[\\/]/).pop() || fallback;
  const ascii = Array.from(base)
    .filter((char) => char.charCodeAt(0) <= 0x7f)
    .join('');
  const cleaned = ascii
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .replace(/_+/g, '_')
    .slice(0, 180);
  return cleaned || fallback;
}

export function parseOptionalDate(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function isSupportedAndroidAudio(file: AndroidUploadFile): boolean {
  const mimeType = file.mimeType.toLowerCase();
  const name = file.originalName.toLowerCase();
  return mimeType.startsWith('audio/') || ASSEMBLYAI_AUDIO_EXTENSION_RE.test(name);
}

export function parseAndroidMultipartUpload(req: IncomingMessage): Promise<AndroidRecordingUpload> {
  const contentType = req.headers['content-type'];
  if (!contentType?.toLowerCase().includes('multipart/form-data')) {
    return Promise.reject(new HttpError(400, 'Content-Type must be multipart/form-data.'));
  }

  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    let uploadFile: AndroidUploadFile | null = null;
    let pendingWrites = 0;
    let finished = false;
    let failed = false;

    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      reject(error);
    };

    const maybeResolve = () => {
      if (!finished || pendingWrites > 0 || failed) return;
      if (!uploadFile) {
        fail(new HttpError(400, 'Missing required multipart file field "audio".'));
        return;
      }
      resolve({ file: uploadFile, fields });
    };

    const busboy = Busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fileSize: ANDROID_AUDIO_MAX_BYTES,
        fields: 20,
        fieldSize: 20_000,
      },
    });

    busboy.on('field', (name, value) => {
      if (typeof name === 'string') fields[name] = String(value ?? '').slice(0, 20_000);
    });

    busboy.on('file', (fieldName, file, info) => {
      if (fieldName !== 'audio') {
        file.resume();
        fail(new HttpError(400, 'Only one multipart file field named "audio" is supported.'));
        return;
      }
      if (uploadFile) {
        file.resume();
        fail(new HttpError(400, 'Only one audio file can be uploaded per request.'));
        return;
      }

      const originalName = info.filename?.trim() || 'android-recording.ogg';
      const mimeType = info.mimeType?.trim() || 'application/octet-stream';
      const ext = originalName.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'audio';
      const tempPath = join(tmpdir(), `meeting-note-android-${randomUUID()}.${ext}`);
      const output = createWriteStream(tempPath);
      let sizeBytes = 0;
      let limited = false;

      pendingWrites += 1;
      file.on('data', (chunk: Buffer) => {
        sizeBytes += chunk.byteLength;
      });
      file.on('limit', () => {
        limited = true;
        void unlink(tempPath).catch(() => undefined);
        fail(new HttpError(413, 'Audio file exceeds the 100 MB maximum size.'));
      });
      file.on('error', fail);
      output.on('error', (error) => {
        void unlink(tempPath).catch(() => undefined);
        fail(error);
      });
      output.on('finish', () => {
        pendingWrites -= 1;
        if (!limited && !failed) {
          uploadFile = {
            fieldName,
            originalName,
            mimeType,
            tempPath,
            sizeBytes,
          };
        }
        maybeResolve();
      });
      file.pipe(output);
    });

    busboy.on('filesLimit', () => fail(new HttpError(400, 'Only one audio file can be uploaded per request.')));
    busboy.on('fieldsLimit', () => fail(new HttpError(400, 'Too many multipart fields.')));
    busboy.on('error', fail);
    busboy.on('finish', () => {
      finished = true;
      maybeResolve();
    });

    req.pipe(busboy);
  });
}

export async function createAudioSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(AUDIO_BUCKET)
    .createSignedUrl(storagePath, 60 * 60 * 6);
  if (error || !data?.signedUrl) {
    throw error ?? new Error('Could not create a signed audio URL.');
  }
  return data.signedUrl;
}

export async function uploadAndroidAudioToStorage(input: {
  userId: string;
  noteId: string;
  fileName: string;
  mimeType: string;
  tempPath: string;
}): Promise<{ storagePath: string; signedUrl: string }> {
  const bytes = await readFile(input.tempPath);
  const storagePath = `android/${input.userId}/${input.noteId}/${input.fileName}`;
  const { error } = await supabase.storage
    .from(AUDIO_BUCKET)
    .upload(storagePath, bytes, {
      cacheControl: '3600',
      contentType: input.mimeType || 'audio/ogg',
      upsert: false,
    });
  if (error) throw error;
  return {
    storagePath,
    signedUrl: await createAudioSignedUrl(storagePath),
  };
}

export async function createAndroidAudioFileRecord(input: {
  id: string;
  userId: string;
  fileName: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  recordedAt: string | null;
}): Promise<void> {
  const { error } = await supabase.from('file').insert({
    id: input.id,
    user_id: input.userId,
    name: input.fileName,
    bucket: AUDIO_BUCKET,
    storage_path: input.storagePath,
    public_url: '',
    mime_type: input.mimeType || 'audio/ogg',
    size_bytes: input.sizeBytes,
    source: 'android_recording',
    recorded_at: input.recordedAt,
  });
  if (error) throw error;
}
