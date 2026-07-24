import { NOTE_IMAGE_BUCKET, supabase } from '../config/supabaseConfig';

export const NOTE_IMAGE_SIGNED_URL_SECONDS = 60 * 60;
export const MAX_NOTE_IMAGE_SIZE_BYTES = 50 * 1024 * 1024;
export const NOTE_IMAGE_ACCEPT = [
  'text/html',
  'text/css',
  'text/plain',
  'text/xml',
  'text/csv',
  'text/rtf',
  'text/javascript',
  'application/json',
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/bmp',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/avi',
  'video/x-flv',
  'video/mpg',
  'video/webm',
  'video/wmv',
  'video/3gpp',
  'audio/wav',
  'audio/mp3',
  'audio/mpeg',
  'audio/aiff',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
].join(',');
const NOTE_IMAGE_CACHE_MS = 55 * 60 * 1000;

const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/heic', 'image/heif']);
const SUPPORTED_ATTACHMENT_TYPES = new Set([
  'text/html',
  'text/css',
  'text/plain',
  'text/xml',
  'text/csv',
  'text/rtf',
  'text/javascript',
  'application/json',
  'application/pdf',
  ...SUPPORTED_IMAGE_TYPES,
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/avi',
  'video/x-flv',
  'video/mpg',
  'video/webm',
  'video/wmv',
  'video/3gpp',
  'audio/wav',
  'audio/mp3',
  'audio/mpeg',
  'audio/aiff',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
]);
const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set([
  'html',
  'htm',
  'css',
  'txt',
  'xml',
  'csv',
  'rtf',
  'js',
  'mjs',
  'json',
  'pdf',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'bmp',
  'heic',
  'heif',
  'mp4',
  'mpeg',
  'mov',
  'avi',
  'flv',
  'mpg',
  'webm',
  'wmv',
  '3gp',
  'wav',
  'mp3',
  'aiff',
  'aif',
  'aac',
  'ogg',
  'flac',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  txt: 'text/plain',
  xml: 'text/xml',
  csv: 'text/csv',
  rtf: 'text/rtf',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  mov: 'video/quicktime',
  avi: 'video/avi',
  flv: 'video/x-flv',
  mpg: 'video/mpg',
  webm: 'video/webm',
  wmv: 'video/wmv',
  '3gp': 'video/3gpp',
  wav: 'audio/wav',
  mp3: 'audio/mp3',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};

export function getAttachmentExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
}

export function normalizeAttachmentMimeType(file: Pick<File, 'name' | 'type'>): string {
  const extension = getAttachmentExtension(file.name);
  return MIME_BY_EXTENSION[extension] || file.type || 'application/octet-stream';
}
const noteImageCache = new Map<string, { expiresAt: number; images: NoteImage[] }>();

export interface NoteImage {
  id: string;
  note_id: string;
  user_id: string;
  bucket: string;
  storage_path: string;
  thumbnail_storage_path?: string | null;
  thumbnail_mime_type?: string | null;
  thumbnail_size_bytes?: number | null;
  thumbnail_width?: number | null;
  thumbnail_height?: number | null;
  name: string;
  mime_type: string;
  size_bytes: number;
  width?: number | null;
  height?: number | null;
  created_at?: string | null;
  signedUrl?: string;
  thumbnailSignedUrl?: string;
}

export interface PendingNoteImage {
  id: string;
  file: File;
  previewUrl: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  status: 'pending' | 'uploading' | 'uploaded' | 'error';
  error?: string | null;
  storagePath?: string;
  noteImage?: NoteImage;
}

export function validateNoteImageFile(file: File): string | null {
  const extension = getAttachmentExtension(file.name);
  const mimeType = normalizeAttachmentMimeType(file);
  if (!SUPPORTED_ATTACHMENT_TYPES.has(mimeType) && !SUPPORTED_ATTACHMENT_EXTENSIONS.has(extension)) {
    return 'Use a Gemini-supported attachment: PDF, text, JSON, CSV, RTF, HTML/CSS/JS, image, audio, or video.';
  }
  if (file.size > MAX_NOTE_IMAGE_SIZE_BYTES) {
    return 'Attachments must be 50 MB or smaller.';
  }
  return null;
}

export function getImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  if (typeof Image === 'undefined' || typeof URL === 'undefined') return Promise.resolve(null);

  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

export function getNoteImageStoragePath(userId: string, noteId: string, imageId: string, fileName: string): string {
  const ext = getAttachmentExtension(fileName) || 'bin';
  return `${userId}/${noteId}/${imageId}.${ext}`;
}

function getNoteImageThumbnailStoragePath(userId: string, noteId: string, imageId: string): string {
  return `${userId}/${noteId}/${imageId}-thumb.jpg`;
}

async function createNoteImageThumbnail(file: File): Promise<{ file: File; width: number; height: number } | null> {
  if (!file.type.startsWith('image/')) return null;

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not create image thumbnail.'));
      img.src = url;
    });

    const maxSide = 640;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.76));
    if (!blob) return null;

    return {
      file: new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'image'}-thumb.jpg`, { type: 'image/jpeg' }),
      width,
      height,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function createNoteImageSignedUrl(image: Pick<NoteImage, 'bucket' | 'storage_path'>): Promise<string> {
  const { data, error } = await supabase.storage
    .from(image.bucket || NOTE_IMAGE_BUCKET)
    .createSignedUrl(image.storage_path, NOTE_IMAGE_SIGNED_URL_SECONDS);

  if (error || !data?.signedUrl) {
    throw error || new Error('Could not create image preview URL.');
  }

  return data.signedUrl;
}

export async function listNoteImages(noteId: string): Promise<NoteImage[]> {
  const cached = noteImageCache.get(noteId);
  if (cached && cached.expiresAt > Date.now()) return cached.images;

  const { data, error } = await supabase
    .from('note_image')
    .select('*')
    .eq('note_id', noteId)
    .order('created_at', { ascending: true });

  if (error) throw error;

  const rows = (data ?? []) as NoteImage[];
  const signedUrlsByKey = new Map<string, string>();
  const pathsByBucket = rows.reduce<Record<string, string[]>>((acc, image) => {
    const bucket = image.bucket || NOTE_IMAGE_BUCKET;
    const displayPath = image.thumbnail_storage_path || image.storage_path;
    acc[bucket] = [
      ...(acc[bucket] ?? []),
      displayPath,
    ];
    return acc;
  }, {});

  await Promise.all(
    Object.entries(pathsByBucket).map(async ([bucket, paths]) => {
      const { data: signedUrls, error: signedUrlError } = await supabase.storage
        .from(bucket)
        .createSignedUrls(paths, NOTE_IMAGE_SIGNED_URL_SECONDS);

      if (signedUrlError) throw signedUrlError;

      (signedUrls ?? []).forEach((item) => {
        if (item.path && item.signedUrl) signedUrlsByKey.set(`${bucket}:${item.path}`, item.signedUrl);
      });
    })
  );

  const images = rows.map((image) => ({
    ...image,
    signedUrl: undefined,
    thumbnailSignedUrl: signedUrlsByKey.get(`${image.bucket || NOTE_IMAGE_BUCKET}:${image.thumbnail_storage_path || image.storage_path}`) ?? '',
  }));

  noteImageCache.set(noteId, { expiresAt: Date.now() + NOTE_IMAGE_CACHE_MS, images });
  return images;
}

export async function getNoteImageCounts(noteIds: string[]): Promise<Record<string, number>> {
  const uniqueNoteIds = Array.from(new Set(noteIds.filter(Boolean)));
  if (uniqueNoteIds.length === 0) return {};

  const { data, error } = await supabase
    .from('note_image')
    .select('note_id')
    .in('note_id', uniqueNoteIds);

  if (error) throw error;

  return ((data ?? []) as Array<{ note_id: string }>).reduce<Record<string, number>>((acc, row) => {
    acc[row.note_id] = (acc[row.note_id] ?? 0) + 1;
    return acc;
  }, {});
}

export async function uploadNoteImage(params: {
  file: File;
  noteId: string;
  userId: string;
  name?: string;
  width?: number | null;
  height?: number | null;
}): Promise<NoteImage> {
  const validationError = validateNoteImageFile(params.file);
  if (validationError) throw new Error(validationError);

  const imageId = crypto.randomUUID();
  const storagePath = getNoteImageStoragePath(params.userId, params.noteId, imageId, params.file.name);
  const thumbnail = await createNoteImageThumbnail(params.file).catch(() => null);
  const thumbnailStoragePath = thumbnail
    ? getNoteImageThumbnailStoragePath(params.userId, params.noteId, imageId)
    : null;
  const { error: uploadError } = await supabase.storage
    .from(NOTE_IMAGE_BUCKET)
    .upload(storagePath, params.file, {
      cacheControl: '3600',
        contentType: normalizeAttachmentMimeType(params.file),
      upsert: false,
    });

  if (uploadError) throw uploadError;

  if (thumbnail && thumbnailStoragePath) {
    const { error: thumbnailUploadError } = await supabase.storage
      .from(NOTE_IMAGE_BUCKET)
      .upload(thumbnailStoragePath, thumbnail.file, {
        cacheControl: '86400',
        contentType: thumbnail.file.type,
        upsert: false,
      });

    if (thumbnailUploadError) {
      await supabase.storage.from(NOTE_IMAGE_BUCKET).remove([storagePath]);
      throw thumbnailUploadError;
    }
  }

  const imageRow = {
      id: imageId,
      note_id: params.noteId,
      user_id: params.userId,
      bucket: NOTE_IMAGE_BUCKET,
      storage_path: storagePath,
      thumbnail_storage_path: thumbnailStoragePath,
      thumbnail_mime_type: thumbnail?.file.type ?? null,
      thumbnail_size_bytes: thumbnail?.file.size ?? null,
      thumbnail_width: thumbnail?.width ?? null,
      thumbnail_height: thumbnail?.height ?? null,
      name: params.name || params.file.name,
      mime_type: normalizeAttachmentMimeType(params.file),
      size_bytes: params.file.size,
      width: params.width ?? null,
      height: params.height ?? null,
  };

  const insertImageRow = (row: typeof imageRow | Omit<typeof imageRow, 'thumbnail_storage_path' | 'thumbnail_mime_type' | 'thumbnail_size_bytes' | 'thumbnail_width' | 'thumbnail_height'>) => supabase
    .from('note_image')
    .insert(row)
    .select('*')
    .single();

  let { data, error: insertError } = await insertImageRow(imageRow);

  if (
    insertError &&
    thumbnailStoragePath &&
    /thumbnail_|column .* does not exist/i.test(insertError.message || '')
  ) {
    await supabase.storage.from(NOTE_IMAGE_BUCKET).remove([thumbnailStoragePath]);
    const {
      thumbnail_storage_path: _thumbnailStoragePath,
      thumbnail_mime_type: _thumbnailMimeType,
      thumbnail_size_bytes: _thumbnailSizeBytes,
      thumbnail_width: _thumbnailWidth,
      thumbnail_height: _thumbnailHeight,
      ...legacyImageRow
    } = imageRow;
    const legacyResult = await insertImageRow(legacyImageRow);
    data = legacyResult.data;
    insertError = legacyResult.error;
  }

  if (insertError) {
    await supabase.storage.from(NOTE_IMAGE_BUCKET).remove([storagePath, ...(thumbnailStoragePath ? [thumbnailStoragePath] : [])]);
    throw insertError;
  }

  const image = data as NoteImage;
  const thumbnailSignedUrl = image.thumbnail_storage_path
    ? await createNoteImageSignedUrl({ bucket: image.bucket, storage_path: image.thumbnail_storage_path })
    : await createNoteImageSignedUrl(image);
  const uploadedImage = {
    ...image,
    signedUrl: undefined,
    thumbnailSignedUrl,
  };
  const cached = noteImageCache.get(params.noteId);
  if (cached && cached.expiresAt > Date.now()) {
    noteImageCache.set(params.noteId, {
      expiresAt: Date.now() + NOTE_IMAGE_CACHE_MS,
      images: [...cached.images, uploadedImage],
    });
  }

  return uploadedImage;
}

export async function deleteNoteImage(image: NoteImage): Promise<void> {
  const { error: deleteError } = await supabase
    .from('note_image')
    .delete()
    .eq('id', image.id);

  if (deleteError) throw deleteError;

  noteImageCache.delete(image.note_id);

  await supabase.storage
    .from(image.bucket || NOTE_IMAGE_BUCKET)
    .remove([image.storage_path, ...(image.thumbnail_storage_path ? [image.thumbnail_storage_path] : [])]);
}

export async function removeUploadedNoteImages(images: Array<Pick<NoteImage, 'bucket' | 'storage_path' | 'thumbnail_storage_path'>>): Promise<void> {
  const pathsByBucket = new Map<string, string[]>();
  for (const image of images) {
    const bucket = image.bucket || NOTE_IMAGE_BUCKET;
    pathsByBucket.set(bucket, [
      ...(pathsByBucket.get(bucket) ?? []),
      image.storage_path,
      ...(image.thumbnail_storage_path ? [image.thumbnail_storage_path] : []),
    ]);
  }

  await Promise.all(
    [...pathsByBucket.entries()].map(([bucket, paths]) => supabase.storage.from(bucket).remove(paths))
  );
}
