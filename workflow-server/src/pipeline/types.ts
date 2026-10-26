import type { TranscriptSegment } from '../parsers.js';

export interface SummarizeAudioRequest {
  downloadUrl?: unknown;
  fileName?: unknown;
  instructions?: unknown;
  promptId?: unknown;
  summaryRulesOverride?: unknown;
  userId?: unknown;
  userName?: unknown;
  noteId?: unknown;
  meetingAt?: unknown;
  userTimeZone?: unknown;
  fileId?: unknown;
  speakerContext?: unknown;
  attachments?: unknown;
  language?: unknown;
}

export interface SummaryAttachmentInput {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export interface SummarizeAudioInput {
  downloadUrl: string;
  fileName: string;
  instructions: string;
  promptId: string;
  summaryRulesOverride?: string;
  userId: string;
  userName: string;
  noteId: string;
  meetingAt: string | null;
  userTimeZone: string | null;
  fileId: string | null;
  speakerContext: string;
  attachments: SummaryAttachmentInput[];
  language: 'en' | 'ko';
}

export interface SummarizeAudioResult {
  transcript: TranscriptSegment[];
  summary: string;
  summaryTranslations?: Record<'en' | 'ko', string>;
  transcriptionLanguage?: 'en' | 'ko' | null;
  transcriptionTranslations?: Partial<Record<'en' | 'ko', string>>;
  diarizationTranslations?: Partial<Record<'en' | 'ko', TranscriptSegment[]>>;
  title: string;
  tags: string[];
  audioDurationSeconds: number | null;
  meetingStartAt: string | null;
}
