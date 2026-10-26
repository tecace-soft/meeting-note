import { requiredString } from '../http/shared.js';
import type { SummarizeAudioRequest, SummaryAttachmentInput, SummarizeAudioInput } from './types.js';

const SUPPORTED_GEMINI_ATTACHMENT_MIME_TYPES = new Set([
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
]);

export function parseSummaryAttachments(value: unknown): SummaryAttachmentInput[] {
  if (!Array.isArray(value)) return [];
  const attachments: SummaryAttachmentInput[] = [];
  let totalBytes = 0;

  for (const item of value.slice(0, 10)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim().slice(0, 240) : 'attachment';
    const mimeType = typeof record.mimeType === 'string' && record.mimeType.trim()
      ? record.mimeType.trim()
      : 'application/octet-stream';
    if (!SUPPORTED_GEMINI_ATTACHMENT_MIME_TYPES.has(mimeType)) continue;
    const dataBase64 = typeof record.dataBase64 === 'string' ? record.dataBase64.trim() : '';
    if (!dataBase64 || !/^[A-Za-z0-9+/=]+$/.test(dataBase64)) continue;
    const estimatedBytes = Math.floor((dataBase64.length * 3) / 4);
    totalBytes += estimatedBytes;
    if (estimatedBytes > 25 * 1024 * 1024 || totalBytes > 50 * 1024 * 1024) break;
    attachments.push({ name, mimeType, dataBase64 });
  }

  return attachments;
}

export function parseSummarizeInput(body: SummarizeAudioRequest): SummarizeAudioInput {
  const meetingAt = typeof body.meetingAt === 'string' && body.meetingAt.trim()
    ? new Date(body.meetingAt)
    : null;
  const userTimeZone = typeof body.userTimeZone === 'string' && body.userTimeZone.trim()
    ? body.userTimeZone.trim()
    : null;
  return {
    downloadUrl: requiredString(body, 'downloadUrl'),
    fileName: requiredString(body, 'fileName'),
    promptId: requiredString(body, 'promptId'),
    summaryRulesOverride:
      typeof body.summaryRulesOverride === 'string'
        ? body.summaryRulesOverride
        : undefined,
    userId: requiredString(body, 'userId'),
    userName: typeof body.userName === 'string' ? body.userName.trim() : '',
    noteId: requiredString(body, 'noteId'),
    meetingAt: meetingAt && !Number.isNaN(meetingAt.getTime()) ? meetingAt.toISOString() : null,
    userTimeZone,
    fileId: typeof body.fileId === 'string' && body.fileId.trim() ? body.fileId.trim() : null,
    instructions: typeof body.instructions === 'string' ? body.instructions : '',
    speakerContext: typeof body.speakerContext === 'string' ? body.speakerContext : '',
    attachments: parseSummaryAttachments(body.attachments),
    language: body.language === 'ko' ? 'ko' : 'en',
  };
}
