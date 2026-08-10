import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createWriteStream } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Busboy from 'busboy';
import { createClient } from '@supabase/supabase-js';
import { config as loadDotenv } from 'dotenv';
import { Agent, setGlobalDispatcher } from 'undici';
import { calculateGeminiUsageCost } from './costs.js';
import { callGemini, GeminiApiError, uploadGeminiFile, type GeminiUsageMetadata } from './gemini.js';
import { buildNoteName, formatMeetingDateForPrompt, parseDiarizedSegments, parseSummary, stripJsonCodeFences, formatTranscriptText, type TranscriptSegment } from './parsers.js';
import { buildRegenerateSummaryPrompt, buildSummaryPrompt, buildTranscriptRepairPrompt, buildTranscriptTranslationPrompt } from './prompts.js';
import { extractAndStoreInsight, foldNoteIntoMemory } from './memory.js';
import { sendWorkflowAlert } from './alerts.js';

const workflowDir = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv({ path: join(workflowDir, '.env') });

interface SummarizeAudioRequest {
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

interface TranscriptionTestRequest {
  fileName?: unknown;
  mimeType?: unknown;
  dataBase64?: unknown;
  model?: unknown;
}

interface RegenerateSummaryRequest {
  noteId?: unknown;
  diarization?: unknown;
  previousSummary?: unknown;
  speakerProfiles?: unknown;
  instructions?: unknown;
  promptId?: unknown;
}

interface ProjectChatRequest {
  message?: unknown;
  project_id?: unknown;
}

type TranscriptionTestModel =
  | 'assembly_universal2_codeswitch'
  | 'assembly_universal3pro_auto'
  | 'gemini'
  | 'openai';

interface SummaryAttachmentInput {
  name: string;
  mimeType: string;
  dataBase64: string;
}

interface AndroidUploadFile {
  fieldName: string;
  originalName: string;
  mimeType: string;
  tempPath: string;
  sizeBytes: number;
}

interface AndroidRecordingUpload {
  file: AndroidUploadFile;
  fields: Record<string, string>;
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const AUDIO_BUCKET = 'meeting-recordings';
const ANDROID_AUDIO_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_SUMMARY_PROMPT_NAME = 'Default';
const ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS = [
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
const ASSEMBLYAI_AUDIO_EXTENSION_RE = new RegExp(
  `\\.(${ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS.join('|')})$`,
  'i'
);
const DEFAULT_SUMMARY_PROMPT = `You are an Insightful Meeting Notes Writer and Transcript extractor. From a meeting voice file (and meta info), transcribe and produce actionable, structured notes.
This meeting is generally related to TecAce business unless the transcript clearly indicates otherwise.
TecAce is a technology consulting and software development company specializing in AI solutions, cloud infrastructure/operation, and device optimization.
Organize content by topics, never by speaker. Use speaker attributions only within each topic when helpful.
Clearly summarize all schedule/timeline discussions in a dedicated Schedule Summary section if relevant.
The summary output must be in markdown format and include tables where useful.
Use the requested output language.
Focus on meeting purpose, key topics, decisions, risks/issues, responsibilities, action items, timelines, and management-level insights when useful.
Do not hallucinate. Base the notes on the transcript and provided context.`;
const PROJECT_CHAT_MODEL = 'gemini-3.1-flash-lite';

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

interface CustomSpellingRule {
  from: string[];
  to: string;
}

interface TranscriptionSettings {
  speechModel: string;
  keytermsPrompt: string[];
  customSpelling: CustomSpellingRule[];
  summaryContext: string;
}

const env = {
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  geminiApiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '',
  assemblyAiApiKey: process.env.ASSEMBLYAI_API_KEY ?? '',
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  summaryModel: process.env.GEMINI_SUMMARY_MODEL ?? 'gemini-2.5-flash-lite',
  regenerateSummaryModel: process.env.GEMINI_REGENERATE_SUMMARY_MODEL ?? 'gemini-3.1-flash-lite',
  transcriptionTestGeminiModel: process.env.GEMINI_TRANSCRIPTION_TEST_MODEL ?? 'gemini-2.5-flash',
  transcriptionTestOpenAiModel: process.env.OPENAI_TRANSCRIPTION_TEST_MODEL ?? 'gpt-4o-transcribe',
  assemblyAiSpeechModel: process.env.ASSEMBLYAI_SPEECH_MODEL ?? 'universal-3-pro',
  assemblyAiPricePerHourUsd: Number(process.env.ASSEMBLYAI_TRANSCRIPTION_PRICE_PER_HOUR_USD ?? '0.21'),
  frontendOrigin: process.env.APP_FRONTEND_ORIGIN ?? '*',
  port: Number(process.env.PORT ?? '8787'),
  fetchHeadersTimeoutMs: Number(process.env.WORKFLOW_FETCH_HEADERS_TIMEOUT_MS ?? '1200000'),
  fetchBodyTimeoutMs: Number(process.env.WORKFLOW_FETCH_BODY_TIMEOUT_MS ?? '1200000'),
};

const ASSEMBLYAI_CODE_SWITCHING_MODELS = ['universal-2'] as const;
const ASSEMBLYAI_CODE_SWITCHING_MODEL_LABEL = ASSEMBLYAI_CODE_SWITCHING_MODELS.join('+');
const ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODELS = ['universal-2'] as const;
const ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL = ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODELS.join('+');
const TRANSCRIPTION_MODEL_TEST_USER_ID = 'd9eb0f3d-819e-4b45-8df6-e9f229de2447';
const OPENAI_MULTILINGUAL_TRANSCRIPTION_PROMPT = [
  'Transcribe the audio exactly as spoken in the original language or languages.',
  'Preserve code-switching and mixed-language speech instead of translating everything into one language.',
  'Use the native script for each spoken language when appropriate, but keep English words in English.',
  'Do not infer, summarize, or normalize the conversation beyond transcription.',
].join(' ');

// Translation features are temporarily disabled to shorten processing time:
// when false, AssemblyAI skips per-utterance translation and only one summary
// (in the selected language) is generated. Flip to true to restore them.
const TRANSLATION_ENABLED = false;

setGlobalDispatcher(new Agent({
  headersTimeout: env.fetchHeadersTimeoutMs,
  bodyTimeout: env.fetchBodyTimeoutMs,
}));

const supabase = createClient(env.supabaseUrl || 'https://placeholder.supabase.co', env.serviceRoleKey || 'missing-service-role-key', {
  auth: { persistSession: false, autoRefreshToken: false },
});

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

function corsHeaders(): Record<string, string> {
  const allowedOrigin = env.frontendOrigin === '*'
    ? '*'
    : env.frontendOrigin
        .split(',')
        .map(normalizeOrigin)
        .filter(Boolean)[0] ?? '*';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, corsHeaders());
  res.end(JSON.stringify(body));
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, corsHeaders());
  res.end();
}

function readBody(req: IncomingMessage, maxBytes = 2_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).byteLength > maxBytes) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function getHttpStatus(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  const message = errorMessage(error);
  if (message.includes('Missing bearer token') || message.includes('Microsoft Graph /me rejected')) return 401;
  if (message.includes('too large') || message.includes('exceeds')) return 413;
  if (message.includes('required') || message.includes('must be') || message.includes('Unsupported') || message.includes('token') || message.includes('userId')) return 400;
  return 500;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['message', 'error', 'details', 'hint', 'code']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function sanitizeUploadFileName(value: string, fallback: string): string {
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

function parseOptionalDate(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isSupportedAndroidAudio(file: AndroidUploadFile): boolean {
  const mimeType = file.mimeType.toLowerCase();
  const name = file.originalName.toLowerCase();
  return mimeType.startsWith('audio/') || ASSEMBLYAI_AUDIO_EXTENSION_RE.test(name);
}

function parseAndroidMultipartUpload(req: IncomingMessage): Promise<AndroidRecordingUpload> {
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

function requiredString(body: object, key: string): string {
  const value = (body as Record<string, unknown>)[key];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (value == null || (typeof value === 'string' && !value.trim())) {
    throw new Error(`${String(key)} is required. Received fields: ${Object.keys(body).sort().join(', ') || 'none'}.`);
  }
  throw new Error(`${String(key)} must be a string or number. Received ${typeof value}.`);
}

function parseSummaryAttachments(value: unknown): SummaryAttachmentInput[] {
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

function parseTranscriptionTestInput(body: TranscriptionTestRequest): {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  model: TranscriptionTestModel;
} {
  const fileName = typeof body.fileName === 'string' && body.fileName.trim()
    ? body.fileName.trim().slice(0, 240)
    : 'audio-test';
  const mimeType = typeof body.mimeType === 'string' && body.mimeType.trim()
    ? body.mimeType.trim()
    : 'application/octet-stream';
  const dataBase64 = typeof body.dataBase64 === 'string' ? body.dataBase64.trim() : '';
  if (!dataBase64 || !/^[A-Za-z0-9+/=]+$/.test(dataBase64)) {
    throw new Error('dataBase64 is required.');
  }
  const model = body.model === 'assembly_universal2_codeswitch' ||
    body.model === 'assembly_universal3pro_auto' ||
    body.model === 'gemini' ||
    body.model === 'openai'
    ? body.model
    : null;
  if (!model) throw new Error('model is required.');
  const bytes = Uint8Array.from(Buffer.from(dataBase64, 'base64'));
  if (bytes.byteLength === 0) throw new Error('Audio file is empty.');
  if (bytes.byteLength > 75 * 1024 * 1024) {
    throw new Error('Test audio must be 75 MB or smaller for this page.');
  }
  return { fileName, mimeType, bytes, model };
}

function parseRegenerateSummaryInput(body: RegenerateSummaryRequest): {
  noteId: string;
  segments: TranscriptSegment[];
  previousSummary: string;
  speakerProfiles: unknown;
  instructions: string;
  promptId?: string;
} {
  const noteId = typeof body.noteId === 'string' && body.noteId.trim() ? body.noteId.trim() : '';
  if (!noteId) throw new Error('noteId is required.');

  const rawSegments = Array.isArray(body.diarization) ? body.diarization : [];
  const segments = rawSegments
    .filter((segment): segment is Record<string, unknown> => Boolean(segment) && typeof segment === 'object' && !Array.isArray(segment))
    .map(normalizeTranscriptSegment)
    .filter((segment): segment is TranscriptSegment => Boolean(segment));
  if (segments.length === 0) throw new Error('diarization must include at least one transcript segment.');

  const promptIdRaw =
    typeof body.promptId === 'string'
      ? body.promptId.trim()
      : typeof body.promptId === 'number'
        ? String(body.promptId)
        : '';

  return {
    noteId,
    segments,
    previousSummary: typeof body.previousSummary === 'string' ? body.previousSummary.trim() : '',
    speakerProfiles: body.speakerProfiles ?? [],
    instructions: typeof body.instructions === 'string' ? body.instructions : '',
    promptId: promptIdRaw || undefined,
  };
}

function parseSummarizeInput(body: SummarizeAudioRequest): SummarizeAudioInput {
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

function inferMeetingStartAt(recordingEndedAt: string | null, durationSeconds: number | null): string | null {
  if (!recordingEndedAt) return null;
  const end = new Date(recordingEndedAt);
  if (Number.isNaN(end.getTime())) return null;
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return end.toISOString();
  }
  return new Date(end.getTime() - Math.round(durationSeconds * 1000)).toISOString();
}

function getBearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new Error('Missing bearer token.');
  return header.slice('Bearer '.length).trim();
}

async function getMicrosoftUserId(accessToken: string): Promise<string> {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Microsoft Graph /me rejected the token (${response.status}).`);
  }
  const data = (await response.json()) as { id?: unknown };
  if (typeof data.id !== 'string' || !data.id.trim()) {
    throw new Error('Microsoft Graph /me did not return a user id.');
  }
  return data.id.trim();
}

function fetchErrorMessage(stage: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && 'cause' in error ? (error as Error & { cause?: unknown }).cause : null;
  const causeMessage = cause instanceof Error ? ` Cause: ${cause.message}` : cause ? ` Cause: ${String(cause)}` : '';
  return `${stage} failed: ${message}.${causeMessage}`;
}

function normalizeDetectedTranscriptLanguage(value: unknown): 'en' | 'ko' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace('_', '-');
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  if (normalized === 'ko' || normalized.startsWith('ko-')) return 'ko';
  return null;
}

function getOppositeTranscriptLanguage(language: 'en' | 'ko' | null): 'en' | 'ko' | null {
  if (language === 'en') return 'ko';
  if (language === 'ko') return 'en';
  return null;
}

interface GeminiWorkflowCallResult {
  text: string;
  model: string;
  usageMetadata: GeminiUsageMetadata;
  latencyMs: number;
}

interface SummarizeAudioInput {
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

interface SummarizeAudioResult {
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

interface WorkflowJobRow {
  id: string;
  user_id: string;
  note_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  stage: string | null;
  progress: number | null;
  result: unknown;
  error: string | null;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Transient Gemini failures (429/5xx/network) get a few backoff retries on the
// SAME model before falling back, so a rate-limit blip mid-demo does not kill
// the whole summarize job.
const MAX_GEMINI_TRANSIENT_RETRIES = 3;

async function callGeminiWithFallback(input: {
  stage: string;
  model: string;
  fallbackModels: string[];
  parts: Parameters<typeof callGemini>[0]['parts'];
  responseMimeType?: 'application/json' | 'text/plain';
  maxOutputTokens?: number;
}): Promise<GeminiWorkflowCallResult> {
  const models = [input.model, ...input.fallbackModels].filter((model, index, all) => model && all.indexOf(model) === index);
  let lastError: unknown = null;
  for (const model of models) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        console.log(`${input.stage}: calling Gemini model ${model}${attempt > 0 ? ` (retry ${attempt})` : ''}`);
        const startedAt = performance.now();
        const result = await callGemini({
          apiKey: env.geminiApiKey,
          model,
          parts: input.parts,
          responseMimeType: input.responseMimeType,
          maxOutputTokens: input.maxOutputTokens,
        });
        return {
          text: result.text,
          model,
          usageMetadata: result.usageMetadata,
          latencyMs: Math.round(performance.now() - startedAt),
        };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const isMissingModel = message.includes('404') || message.includes('not found') || message.includes('not supported');
        if (isMissingModel) {
          console.warn(`${input.stage}: Gemini model ${model} unavailable, trying fallback if configured. ${message}`);
          break; // move on to the next fallback model
        }
        const retryable = error instanceof GeminiApiError && error.retryable;
        if (retryable && attempt < MAX_GEMINI_TRANSIENT_RETRIES) {
          const backoffMs = Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 500);
          console.warn(`${input.stage}: Gemini model ${model} transient error (attempt ${attempt + 1}/${MAX_GEMINI_TRANSIENT_RETRIES + 1}), retrying in ${backoffMs}ms. ${message}`);
          await delay(backoffMs);
          continue; // retry the same model
        }
        throw new Error(`${input.stage}: ${message}`);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Gemini request failed.'));
}

async function loadSummaryPrompt(promptId: string, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from('summary_prompt')
    .select('prompt')
    .eq('id', promptId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  const prompt = (data as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Selected summary prompt was not found for this user.');
  }
  return prompt.trim();
}

async function resolveSummaryPromptForAndroid(input: { promptId?: string; userId: string }): Promise<{
  promptId: string;
  summaryRulesOverride?: string;
}> {
  if (input.promptId?.trim()) {
    await loadSummaryPrompt(input.promptId.trim(), input.userId);
    return { promptId: input.promptId.trim() };
  }
  return {
    promptId: 'android-default',
    summaryRulesOverride: DEFAULT_SUMMARY_PROMPT,
  };
}

/**
 * Summary rules to use when regenerating a note. Prefers the prompt the user
 * currently has selected (promptId), then the user's "Default" prompt, then the
 * earliest prompt, and finally the built-in default. Regenerate previously used
 * a hardcoded structure and ignored the user's custom prompt entirely.
 */
async function resolveRegenerateSummaryRules(promptId: string | undefined, userId: string): Promise<string> {
  if (promptId) {
    try {
      return await loadSummaryPrompt(promptId, userId);
    } catch (error) {
      console.warn(`Regenerate: selected prompt ${promptId} not usable for user, falling back to default. ${(error as Error).message}`);
    }
  }

  const { data, error } = await supabase
    .from('summary_prompt')
    .select('name, prompt, created_at')
    .eq('user_id', userId);
  if (error) {
    console.warn(`Regenerate: failed to load user summary prompts, using built-in default. ${error.message}`);
    return DEFAULT_SUMMARY_PROMPT;
  }

  const rows = ((data as Array<{ name?: unknown; prompt?: unknown; created_at?: unknown }>) ?? [])
    .filter((row): row is { name: string; prompt: string; created_at: string | null } =>
      typeof row.prompt === 'string' && row.prompt.trim().length > 0)
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));

  const defaultRow = rows.find((row) => (row.name ?? '').trim().toLowerCase() === DEFAULT_SUMMARY_PROMPT_NAME.toLowerCase());
  const chosen = defaultRow ?? rows[0];
  return chosen ? chosen.prompt.trim() : DEFAULT_SUMMARY_PROMPT;
}

async function createAudioSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(AUDIO_BUCKET)
    .createSignedUrl(storagePath, 60 * 60 * 6);
  if (error || !data?.signedUrl) {
    throw error ?? new Error('Could not create a signed audio URL.');
  }
  return data.signedUrl;
}

async function uploadAndroidAudioToStorage(input: {
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

async function createAndroidAudioFileRecord(input: {
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

function normalizeKeytermsPrompt(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const term = item.trim();
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    terms.push(term);
  }
  return terms.slice(0, 250);
}

function normalizeCustomSpelling(value: unknown): CustomSpellingRule[] {
  if (!Array.isArray(value)) return [];
  const rules: CustomSpellingRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const to = typeof record.to === 'string' ? record.to.trim() : '';
    const from = Array.isArray(record.from)
      ? record.from.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
      : [];
    const uniqueFrom = [...new Set(from)];
    if (!to || uniqueFrom.length === 0) continue;
    rules.push({ from: uniqueFrom.slice(0, 25), to });
  }
  return rules.slice(0, 100);
}

async function loadTranscriptionSettings(): Promise<TranscriptionSettings> {
  const fallback: TranscriptionSettings = {
    speechModel: env.assemblyAiSpeechModel,
    keytermsPrompt: [],
    customSpelling: [],
    summaryContext: '',
  };
  const { data, error } = await supabase
    .from('workflow_transcription_settings')
    .select('speech_model, keyterms_prompt, custom_spelling, summary_context')
    .eq('id', 'global')
    .maybeSingle();
  if (error) {
    console.warn(`Could not load transcription settings: ${error.message}`);
    return fallback;
  }
  if (!data) return fallback;
  const row = data as {
    speech_model?: unknown;
    keyterms_prompt?: unknown;
    custom_spelling?: unknown;
    summary_context?: unknown;
  };
  const speechModel = typeof row.speech_model === 'string' && row.speech_model.trim()
    ? row.speech_model.trim()
    : fallback.speechModel;
  return {
    speechModel,
    keytermsPrompt: normalizeKeytermsPrompt(row.keyterms_prompt),
    customSpelling: normalizeCustomSpelling(row.custom_spelling),
    summaryContext: typeof row.summary_context === 'string' ? row.summary_context.trim() : '',
  };
}

async function buildGeminiAttachmentParts(attachments: SummaryAttachmentInput[]): Promise<Parameters<typeof callGemini>[0]['parts']> {
  if (attachments.length === 0) return [];

  const uploaded: Array<{ name: string; mimeType: string; fileUri: string }> = [];
  for (const attachment of attachments) {
    const bytes = Uint8Array.from(Buffer.from(attachment.dataBase64, 'base64'));
    if (bytes.byteLength === 0) continue;
    const file = await uploadGeminiFile({
      apiKey: env.geminiApiKey,
      displayName: attachment.name,
      mimeType: attachment.mimeType,
      bytes,
    });
    uploaded.push({ name: attachment.name, mimeType: file.mimeType, fileUri: file.fileUri });
  }

  if (uploaded.length === 0) return [];

  return [
    {
      text: `ATTACHED FILE CONTEXT
The user attached ${uploaded.length} file${uploaded.length === 1 ? '' : 's'} from the meeting. You must inspect every attached file and look for information that relates to the diarized transcript.
Attached files:
${uploaded.map((file, index) => `${index + 1}. ${file.name} (${file.mimeType})`).join('\n')}
- Treat the transcript as the primary source of truth, but actively use attached files to clarify meeting topics, names, documents, slide content, screenshots, requirements, numbers, dates, project context, risks, decisions, and action items.
- Extract visible or readable content from attached PDFs, text/CSV/JSON/HTML files, images, audio, and video. Connect that content to the transcript wherever a reasonable relationship exists.
- When attachment content is relevant, incorporate it naturally into the appropriate summary section instead of creating a disconnected file summary.
- The summary must contain a dedicated attached-files section. Do not omit this section.
- Do not invent decisions, dates, participants, or action items from attachments unless they are explicitly visible/readable in a file or supported by the transcript.
- If attachments are provided but no relationship to the meeting can be found, include a short note in the summary stating what the attached file(s) appear to be and that no clear relationship to the meeting transcript was found.
- If an attachment is unreadable, include a short note that the file could not be interpreted rather than silently ignoring it.
`,
    },
    ...uploaded.map((file) => ({
      fileData: {
        mimeType: file.mimeType,
        fileUri: file.fileUri,
      },
    })),
  ];
}

function attachmentSectionHeading(language: 'en' | 'ko'): string {
  return language === 'ko' ? '## 첨부 파일' : '## Attached Files';
}

function summaryHasAttachmentSection(summary: string, language: 'en' | 'ko'): boolean {
  const exactHeading = attachmentSectionHeading(language).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${exactHeading}\\s*$`, 'im').test(summary);
}

function parseAttachmentSection(raw: string, language: 'en' | 'ko'): string {
  const parsed = JSON.parse(stripJsonCodeFences(raw)) as unknown;
  const sectionMarkdown = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { sectionMarkdown?: unknown }).sectionMarkdown
    : null;
  const heading = attachmentSectionHeading(language);
  const section = typeof sectionMarkdown === 'string' ? sectionMarkdown.trim() : '';
  if (!section) throw new Error('Attachment section JSON must include sectionMarkdown.');
  return section.startsWith(heading) ? section : `${heading}\n${section}`;
}

function fallbackAttachmentSection(attachments: SummaryAttachmentInput[], language: 'en' | 'ko'): string {
  const heading = attachmentSectionHeading(language);
  const fileLines = attachments.length > 0
    ? attachments.map((attachment) => `- ${attachment.name} (${attachment.mimeType}): ${language === 'ko'
      ? '첨부 파일이 제공되었지만 이 실행에서 회의 기록과의 관계 분석을 완료하지 못했습니다.'
      : 'This file was attached, but its relationship to the transcript could not be analyzed in this run.'}`)
    : [`- ${language === 'ko'
      ? '첨부 파일이 제공되었지만 이 실행에서 파일 정보를 확인하지 못했습니다.'
      : 'Attachments were provided, but file details could not be confirmed in this run.'}`];
  return `${heading}\n${fileLines.join('\n')}`;
}

async function generateAttachmentSummarySection(input: {
  attachmentParts: Parameters<typeof callGemini>[0]['parts'];
  attachments: SummaryAttachmentInput[];
  transcriptText: string;
  existingSummary: string;
  language: 'en' | 'ko';
}): Promise<GeminiWorkflowCallResult> {
  const heading = attachmentSectionHeading(input.language);
  const outputLanguageName = input.language === 'ko' ? 'Korean' : 'English';

  return callGeminiWithFallback({
    stage: 'Attachment section generation',
    model: env.summaryModel,
    fallbackModels: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'],
    responseMimeType: 'application/json',
    maxOutputTokens: 4096,
    parts: [
      {
        text: `Generate the required attached-files section for a meeting summary.

OUTPUT LANGUAGE
- Write the section in ${outputLanguageName}.

REQUIRED OUTPUT
Return valid JSON only:
{
  "sectionMarkdown": "${heading}\\n- ..."
}

SECTION RULES
- The sectionMarkdown value MUST start with this exact heading: ${heading}
- Inspect every attached file provided in the fileData parts.
- Compare the attached file content against the transcript and existing summary.
- Briefly describe each attached file and explain how it relates to the meeting transcript using specific examples.
- For each relevant file, include concrete visible/readable details from the file, such as terms, headings, slide titles, document sections, filenames, numbers, dates, requirements, screenshots, labels, or other exact content.
- For each concrete file detail, name the meeting topic, transcript discussion, decision, risk, or action item that it supports or clarifies.
- Avoid vague statements like "the file provides context" unless followed by the specific file detail and the specific meeting topic it relates to.
- If a file has no clear relationship to the transcript, say that explicitly.
- If a file cannot be interpreted, say that explicitly.
- Do not invent facts. Use only visible/readable file content and the transcript.

ATTACHED FILES
${input.attachments.map((attachment, index) => `${index + 1}. ${attachment.name} (${attachment.mimeType})`).join('\n')}

TRANSCRIPT
'''
${input.transcriptText}
'''

CURRENT SUMMARY
'''
${input.existingSummary}
'''`,
      },
      ...input.attachmentParts,
    ],
  });
}

async function recordGeminiUsage(input: {
  noteId: string;
  userId: string;
  stage: string;
  model: string;
  inputType: 'audio' | 'text';
  usageMetadata: GeminiUsageMetadata;
  latencyMs: number;
}): Promise<void> {
  const usage = calculateGeminiUsageCost({
    model: input.model,
    inputType: input.inputType,
    usageMetadata: input.usageMetadata,
  });
  const { error } = await supabase.from('workflow_usage').insert({
    note_id: input.noteId,
    user_id: input.userId,
    stage: input.stage,
    provider: 'google-gemini',
    model: input.model,
    input_type: input.inputType,
    prompt_tokens: usage.promptTokens,
    candidates_tokens: usage.candidatesTokens,
    total_tokens: usage.totalTokens,
    cached_content_tokens: usage.cachedContentTokens,
    thoughts_tokens: usage.thoughtsTokens,
    latency_ms: input.latencyMs,
    estimated_cost_usd: usage.estimatedCostUsd,
    usage_metadata: input.usageMetadata,
  });
  if (error) {
    console.warn(`Could not record Gemini usage for ${input.stage}: ${error.message}`);
  }
}

async function recordAssemblyUsage(input: {
  noteId: string;
  userId: string;
  model: string;
  latencyMs: number;
  transcriptId: string;
  audioDurationSeconds: number;
}): Promise<void> {
  const durationHours = Math.max(0, input.audioDurationSeconds) / 3600;
  const estimatedCostUsd = Number.isFinite(env.assemblyAiPricePerHourUsd)
    ? durationHours * env.assemblyAiPricePerHourUsd
    : 0;
  const { error } = await supabase.from('workflow_usage').insert({
    note_id: input.noteId,
    user_id: input.userId,
    stage: 'transcription',
    provider: 'assemblyai',
    model: input.model,
    input_type: 'audio',
    latency_ms: input.latencyMs,
    estimated_cost_usd: Number(estimatedCostUsd.toFixed(6)),
    usage_metadata: {
      transcriptId: input.transcriptId,
      audioDurationSeconds: input.audioDurationSeconds,
      pricePerHourUsd: env.assemblyAiPricePerHourUsd,
    },
  });
  if (error) {
    console.warn(`Could not record AssemblyAI usage for transcription: ${error.message}`);
  }
}

async function insertNote(input: {
  noteId: string;
  userId: string;
  userName: string;
  downloadUrl: string;
  transcriptText: string;
  transcriptionLanguage: 'en' | 'ko' | null;
  transcriptionTranslations: Partial<Record<'en' | 'ko', string>>;
  summary: string;
  summaryTranslations: Record<'en' | 'ko', string>;
  title: string;
  tags: string[];
  segments: TranscriptSegment[];
  diarizationTranslations: Partial<Record<'en' | 'ko', TranscriptSegment[]>>;
  meetingAt: string | null;
  fileId: string | null;
  audioDurationSeconds: number | null;
}): Promise<void> {
  const notePayload = {
    transcription: input.transcriptText,
    transcription_language: input.transcriptionLanguage,
    transcription_translations: input.transcriptionTranslations,
    summary: input.summary,
    summary_translations: input.summaryTranslations,
    user_id: input.userId,
    user_name: input.userName,
    id: input.noteId,
    audio_file: input.downloadUrl,
    name: input.title,
    tags: input.tags,
    diarization: input.segments,
    diarization_translations: input.diarizationTranslations,
    meeting_at: input.meetingAt,
    audio_file_id: input.fileId,
    duration_seconds: input.audioDurationSeconds,
  };
  const { error } = await supabase.from('note').insert(notePayload);
  if (
    error?.code === 'PGRST204' &&
    (
      error.message.includes("'transcription_language'") ||
      error.message.includes("'transcription_translations'") ||
      error.message.includes("'diarization_translations'")
    )
  ) {
    const {
      transcription_language: _transcriptionLanguage,
      transcription_translations: _transcriptionTranslations,
      diarization_translations: _diarizationTranslations,
      ...payloadWithoutTranslations
    } = notePayload;
    const { error: retryError } = await supabase.from('note').insert(payloadWithoutTranslations);
    if (retryError) throw retryError;
    console.warn('Inserted note without transcript translation columns because the PostgREST schema cache is missing them.');
    return;
  }
  if (error?.code === 'PGRST204' && error.message.includes("'duration_seconds'")) {
    const { duration_seconds: _durationSeconds, ...payloadWithoutDuration } = notePayload;
    const { error: retryError } = await supabase.from('note').insert(payloadWithoutDuration);
    if (retryError) throw retryError;
    console.warn('Inserted note without duration_seconds because the column is missing from the PostgREST schema cache.');
    return;
  }
  if (error) throw error;
}

async function transcribeWithAssembly(input: {
  downloadUrl: string;
  noteId: string;
  userId: string;
  settings: TranscriptionSettings;
}): Promise<{ segments: TranscriptSegment[]; latencyMs: number; audioDurationSeconds: number | null; detectedLanguage: 'en' | 'ko' | null }> {
  if (!env.assemblyAiApiKey) throw new Error('ASSEMBLYAI_API_KEY is missing.');
  const startedAt = performance.now();
  const submitBody: Record<string, unknown> = {
    audio_url: input.downloadUrl,
    speaker_labels: true,
    speech_models: [...ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODELS],
  };
  if (input.settings.keytermsPrompt.length > 0) {
    submitBody.keyterms_prompt = input.settings.keytermsPrompt;
  }
  if (input.settings.customSpelling.length > 0) {
    submitBody.custom_spelling = input.settings.customSpelling;
  }
  console.log('AssemblyAI transcript submit config:', JSON.stringify({
    speech_models: submitBody.speech_models,
    languageSettings: 'none',
    selectedLanguageAffectsTranscription: false,
    translationTargets: [],
    translationMatchOriginalUtterance: false,
    hasKeytermsPrompt: Array.isArray(submitBody.keyterms_prompt) && submitBody.keyterms_prompt.length > 0,
    customSpellingCount: Array.isArray(submitBody.custom_spelling) ? submitBody.custom_spelling.length : 0,
  }));
  const createResponse = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      Authorization: env.assemblyAiApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(submitBody),
  });
  const createRaw = await createResponse.text();
  if (!createResponse.ok) {
    throw new Error(`AssemblyAI transcript submit failed (${createResponse.status}): ${createRaw.slice(0, 800)}`);
  }
  const created = JSON.parse(createRaw) as { id?: unknown };
  if (typeof created.id !== 'string' || !created.id.trim()) {
    throw new Error('AssemblyAI did not return a transcript id.');
  }

  let transcript: Record<string, unknown> | null = null;
  const timeoutMs = 30 * 60 * 1000;
  // A single failed poll (network blip, 5xx, rate limit, truncated body) must
  // not kill an otherwise-healthy transcription. Tolerate a bounded run of
  // consecutive transient failures and keep polling; a fatal response (4xx, or
  // an explicit 'error' status from AssemblyAI) still aborts immediately.
  const maxConsecutivePollFailures = 5;
  let consecutivePollFailures = 0;
  while (performance.now() - startedAt < timeoutMs) {
    await delay(3000);
    let pollResponse: Response;
    let pollRaw: string;
    try {
      pollResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(created.id)}`, {
        headers: { Authorization: env.assemblyAiApiKey },
      });
      pollRaw = await pollResponse.text();
    } catch (error) {
      consecutivePollFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (consecutivePollFailures > maxConsecutivePollFailures) {
        throw new Error(`AssemblyAI transcript poll failed after ${consecutivePollFailures} consecutive network errors: ${message}`);
      }
      console.warn(`AssemblyAI transcript poll network error (${consecutivePollFailures}/${maxConsecutivePollFailures}), retrying. ${message}`);
      continue;
    }
    if (!pollResponse.ok) {
      const isTransient = pollResponse.status >= 500 || pollResponse.status === 429;
      if (!isTransient) {
        throw new Error(`AssemblyAI transcript poll failed (${pollResponse.status}): ${pollRaw.slice(0, 800)}`);
      }
      consecutivePollFailures += 1;
      if (consecutivePollFailures > maxConsecutivePollFailures) {
        throw new Error(`AssemblyAI transcript poll failed after ${consecutivePollFailures} consecutive transient errors (last ${pollResponse.status}): ${pollRaw.slice(0, 800)}`);
      }
      console.warn(`AssemblyAI transcript poll transient ${pollResponse.status} (${consecutivePollFailures}/${maxConsecutivePollFailures}), retrying.`);
      continue;
    }
    try {
      transcript = JSON.parse(pollRaw) as Record<string, unknown>;
    } catch {
      consecutivePollFailures += 1;
      if (consecutivePollFailures > maxConsecutivePollFailures) {
        throw new Error(`AssemblyAI transcript poll returned invalid JSON ${consecutivePollFailures} times in a row (${pollResponse.status}): ${pollRaw.slice(0, 500)}`);
      }
      console.warn(`AssemblyAI transcript poll returned invalid JSON (${consecutivePollFailures}/${maxConsecutivePollFailures}), retrying.`);
      continue;
    }
    consecutivePollFailures = 0;
    if (transcript.status === 'completed') break;
    if (transcript.status === 'error') {
      throw new Error(typeof transcript.error === 'string' ? transcript.error : 'AssemblyAI transcription failed.');
    }
  }
  if (!transcript || transcript.status !== 'completed') {
    throw new Error('AssemblyAI transcription timed out.');
  }
  console.log('AssemblyAI transcript completed:', JSON.stringify({
    transcriptId: created.id,
    speechModelUsed: transcript.speech_model_used ?? null,
    languageCode: transcript.language_code ?? null,
    languageDetectionResults: transcript.language_detection_results ?? null,
  }));

  const utterances = Array.isArray(transcript.utterances) ? transcript.utterances : [];
  const utteranceDurationSeconds = utterances.reduce((maxEnd, utterance) => {
    const record = utterance && typeof utterance === 'object' && !Array.isArray(utterance)
      ? utterance as Record<string, unknown>
      : {};
    return typeof record.end === 'number' && Number.isFinite(record.end)
      ? Math.max(maxEnd, record.end / 1000)
      : maxEnd;
  }, 0);
  const rawAudioDurationSeconds = typeof transcript.audio_duration === 'number'
    ? transcript.audio_duration
    : typeof transcript.audio_duration_seconds === 'number'
      ? transcript.audio_duration_seconds
      : utteranceDurationSeconds;
  const audioDurationSeconds = Number.isFinite(rawAudioDurationSeconds) && rawAudioDurationSeconds > 0
    ? rawAudioDurationSeconds
    : null;
  const segments = utterances.length > 0
    ? utterances.map((utterance) => {
        const record = utterance && typeof utterance === 'object' && !Array.isArray(utterance)
          ? utterance as Record<string, unknown>
          : {};
        const label = typeof record.speaker === 'string' || typeof record.speaker === 'number'
          ? String(record.speaker)
          : '?';
        const translatedTexts = record.translated_texts && typeof record.translated_texts === 'object' && !Array.isArray(record.translated_texts)
          ? record.translated_texts as Record<string, unknown>
          : {};
        const translations = Object.fromEntries(
          Object.entries(translatedTexts)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim()))
            .map(([language, text]) => [language, text.trim()])
        );
        return {
          speaker: `Speaker ${label}`,
          text: typeof record.text === 'string' ? record.text.trim() : '',
          start: typeof record.start === 'number' ? record.start / 1000 : undefined,
          end: typeof record.end === 'number' ? record.end / 1000 : undefined,
          ...(Object.keys(translations).length > 0 ? { translations } : {}),
        };
      }).filter((segment) => segment.text)
    : [{
        speaker: 'Unknown Speaker',
        text: typeof transcript.text === 'string' ? transcript.text.trim() : '',
      }].filter((segment) => segment.text);

  const latencyMs = Math.round(performance.now() - startedAt);
  await recordAssemblyUsage({
    noteId: input.noteId,
    userId: input.userId,
    model: ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL,
    latencyMs,
    transcriptId: created.id.trim(),
    audioDurationSeconds: audioDurationSeconds ?? 0,
  });
  return { segments, latencyMs, audioDurationSeconds, detectedLanguage: normalizeDetectedTranscriptLanguage(transcript.language_code) };
}

async function uploadAssemblyAudio(bytes: Uint8Array): Promise<string> {
  const response = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: { Authorization: env.assemblyAiApiKey },
    body: bytes as unknown as BodyInit,
  });
  const raw = await response.text();
  let parsed: { upload_url?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error(`AssemblyAI upload returned invalid JSON (${response.status}): ${raw.slice(0, 500)}`);
  }
  if (!response.ok || typeof parsed.upload_url !== 'string') {
    throw new Error(`AssemblyAI upload failed (${response.status}): ${raw.slice(0, 800)}`);
  }
  return parsed.upload_url;
}

async function transcribeAssemblyForTest(input: {
  bytes: Uint8Array;
  model: Extract<TranscriptionTestModel, 'assembly_universal2_codeswitch' | 'assembly_universal3pro_auto'>;
}): Promise<{ text: string; segments: TranscriptSegment[]; raw: unknown; config: Record<string, unknown>; latencyMs: number }> {
  if (!env.assemblyAiApiKey) throw new Error('ASSEMBLYAI_API_KEY is missing.');
  const startedAt = performance.now();
  const audioUrl = await uploadAssemblyAudio(input.bytes);
  const config = input.model === 'assembly_universal2_codeswitch'
    ? {
        audio_url: audioUrl,
        speaker_labels: true,
        speech_models: ['universal-2'],
      }
    : {
        audio_url: audioUrl,
        speaker_labels: true,
        speech_models: ['universal-3-pro'],
      };

  const createResponse = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      Authorization: env.assemblyAiApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(config),
  });
  const createRaw = await createResponse.text();
  let created: { id?: unknown };
  try {
    created = JSON.parse(createRaw) as typeof created;
  } catch {
    throw new Error(`AssemblyAI transcript submit returned invalid JSON (${createResponse.status}): ${createRaw.slice(0, 500)}`);
  }
  if (!createResponse.ok || typeof created.id !== 'string') {
    throw new Error(`AssemblyAI transcript submit failed (${createResponse.status}): ${createRaw.slice(0, 800)}`);
  }

  let transcript: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await delay(2500);
    const pollResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(created.id)}`, {
      headers: { Authorization: env.assemblyAiApiKey },
    });
    const pollRaw = await pollResponse.text();
    if (!pollResponse.ok) throw new Error(`AssemblyAI transcript poll failed (${pollResponse.status}): ${pollRaw.slice(0, 800)}`);
    transcript = JSON.parse(pollRaw) as Record<string, unknown>;
    if (transcript.status === 'completed') break;
    if (transcript.status === 'error') throw new Error(typeof transcript.error === 'string' ? transcript.error : 'AssemblyAI transcription failed.');
  }
  if (transcript.status !== 'completed') throw new Error('AssemblyAI transcription timed out.');

  const utterances = Array.isArray(transcript.utterances) ? transcript.utterances : [];
  const segments = utterances.length > 0
    ? utterances.map((utterance) => {
        const record = utterance && typeof utterance === 'object' && !Array.isArray(utterance) ? utterance as Record<string, unknown> : {};
        const label = typeof record.speaker === 'string' || typeof record.speaker === 'number' ? String(record.speaker) : '?';
        return {
          speaker: `Speaker ${label}`,
          text: typeof record.text === 'string' ? record.text.trim() : '',
          start: typeof record.start === 'number' ? record.start / 1000 : undefined,
          end: typeof record.end === 'number' ? record.end / 1000 : undefined,
        };
      }).filter((segment) => segment.text)
    : [{
        speaker: 'Unknown Speaker',
        text: typeof transcript.text === 'string' ? transcript.text.trim() : '',
      }].filter((segment) => segment.text);

  return {
    text: typeof transcript.text === 'string' ? transcript.text.trim() : formatTranscriptText(segments),
    segments,
    raw: transcript,
    config: {
      ...config,
      audio_url: '<assemblyai-upload-url>',
      detected_language: transcript.language_code ?? null,
    },
    latencyMs: Math.round(performance.now() - startedAt),
  };
}

function normalizeTranscriptSegment(segment: Record<string, unknown>): TranscriptSegment | null {
  const text = typeof segment.text === 'string' ? segment.text.trim() : '';
  if (!text) return null;
  const speaker = typeof segment.speaker === 'string' && segment.speaker.trim()
    ? segment.speaker.trim()
    : 'Unknown Speaker';
  const start = typeof segment.start === 'number' && Number.isFinite(segment.start) ? segment.start : undefined;
  const end = typeof segment.end === 'number' && Number.isFinite(segment.end) ? segment.end : undefined;
  return {
    speaker,
    text,
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
  };
}

function recoverCompleteDiarizedSegments(raw: string): TranscriptSegment[] {
  const stripped = stripJsonCodeFences(raw);
  const segmentsKeyIndex = stripped.indexOf('"segments"');
  const arrayStart = stripped.indexOf('[', segmentsKeyIndex >= 0 ? segmentsKeyIndex : 0);
  if (arrayStart < 0) return [];

  const recovered: TranscriptSegment[] = [];
  let objectStart = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = arrayStart + 1; index < stripped.length; index += 1) {
    const char = stripped[index];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }

    if (char === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        const objectText = stripped.slice(objectStart, index + 1);
        try {
          const parsed = JSON.parse(objectText) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const segment = normalizeTranscriptSegment(parsed as Record<string, unknown>);
            if (segment) recovered.push(segment);
          }
        } catch {
          // Ignore malformed objects and keep scanning for the next complete one.
        }
        objectStart = -1;
      }
    }
  }

  return recovered;
}

function parseDiarizedSegmentsWithRecovery(raw: string): { segments: TranscriptSegment[]; recovered: boolean } {
  try {
    return { segments: parseDiarizedSegments(raw), recovered: false };
  } catch (error) {
    const recovered = recoverCompleteDiarizedSegments(raw);
    if (recovered.length > 0) return { segments: recovered, recovered: true };
    throw error;
  }
}

async function translateTranscriptSegments(input: {
  segments: TranscriptSegment[];
  targetLanguage: 'en' | 'ko';
  noteId: string;
  userId: string;
}): Promise<TranscriptSegment[]> {
  const result = await callGeminiWithFallback({
    stage: `Transcript translation (${input.targetLanguage})`,
    model: env.summaryModel,
    fallbackModels: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'],
    responseMimeType: 'application/json',
    maxOutputTokens: 32768,
    parts: [{
      text: buildTranscriptTranslationPrompt({
        targetLanguage: input.targetLanguage,
        segments: input.segments.map((segment) => ({
          speaker: segment.speaker,
          text: segment.text,
          ...(segment.start !== undefined ? { start: segment.start } : {}),
          ...(segment.end !== undefined ? { end: segment.end } : {}),
        })),
      }),
    }],
  });
  const parsed = parseDiarizedSegmentsWithRecovery(result.text);
  await recordGeminiUsage({
    noteId: input.noteId,
    userId: input.userId,
    stage: `transcript-translation-${input.targetLanguage}`,
    model: result.model,
    inputType: 'text',
    usageMetadata: result.usageMetadata,
    latencyMs: result.latencyMs,
  });
  return parsed.segments;
}

async function transcribeGeminiForTest(input: {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}): Promise<{ text: string; segments: TranscriptSegment[]; raw: unknown; config: Record<string, unknown>; latencyMs: number }> {
  if (!env.geminiApiKey) throw new Error('Gemini API key is missing.');
  const startedAt = performance.now();
  const file = await uploadGeminiFile({
    apiKey: env.geminiApiKey,
    displayName: input.fileName,
    mimeType: input.mimeType,
    bytes: input.bytes,
  });
  const result = await callGeminiWithFallback({
    stage: 'Transcription test',
    model: env.transcriptionTestGeminiModel,
    fallbackModels: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    responseMimeType: 'application/json',
    maxOutputTokens: 16384,
    parts: [
      {
        text: `Transcribe this meeting audio for language capability testing.
Preserve the original spoken language exactly, including code-switching between Korean and English.
Identify speakers if possible. If speaker identity is uncertain, use Speaker 1, Speaker 2, etc.
Return only JSON:
{
  "segments": [
    {
      "speaker": "Speaker 1",
      "text": "verbatim transcript text",
      "start": 0,
      "end": 1.2
    }
  ]
}`,
      },
      {
        fileData: {
          mimeType: file.mimeType,
          fileUri: file.fileUri,
        },
      },
    ],
  });
  let segments: TranscriptSegment[];
  let repairedText: string | null = null;
  let parseMode = 'strict-json';
  try {
    const parsed = parseDiarizedSegmentsWithRecovery(result.text);
    segments = parsed.segments;
    parseMode = parsed.recovered ? 'recovered-original-json' : 'strict-json';
  } catch (originalParseError) {
    try {
      const repair = await callGeminiWithFallback({
        stage: 'Transcription test JSON repair',
        model: env.transcriptionTestGeminiModel,
        fallbackModels: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'],
        responseMimeType: 'application/json',
        maxOutputTokens: 16384,
        parts: [{ text: buildTranscriptRepairPrompt(result.text) }],
      });
      repairedText = repair.text;
      const parsedRepair = parseDiarizedSegmentsWithRecovery(repair.text);
      segments = parsedRepair.segments;
      parseMode = parsedRepair.recovered ? 'recovered-repair-json' : 'repaired-json';
    } catch (repairParseError) {
      const originalMessage = originalParseError instanceof Error ? originalParseError.message : String(originalParseError);
      const repairMessage = repairParseError instanceof Error ? repairParseError.message : String(repairParseError);
      throw new Error(`Gemini returned malformed transcript JSON and recovery failed. Original parse: ${originalMessage}. Repair parse: ${repairMessage}`);
    }
  }
  return {
    text: formatTranscriptText(segments),
    segments,
    raw: { text: result.text, repairedText, parseMode, usageMetadata: result.usageMetadata },
    config: { model: result.model, mimeType: file.mimeType, parseMode },
    latencyMs: Math.round(performance.now() - startedAt),
  };
}

async function transcribeOpenAiForTest(input: {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}): Promise<{ text: string; segments: TranscriptSegment[]; raw: unknown; config: Record<string, unknown>; latencyMs: number }> {
  if (!env.openAiApiKey) throw new Error('OPENAI_API_KEY is missing.');
  const startedAt = performance.now();
  const form = new FormData();
  form.append('model', env.transcriptionTestOpenAiModel);
  const fileBytes = new Uint8Array(input.bytes);
  form.append('file', new Blob([fileBytes.buffer], { type: input.mimeType }), input.fileName);
  form.append('response_format', 'json');
  const supportsPrompt = !env.transcriptionTestOpenAiModel.includes('diarize');
  if (supportsPrompt) {
    form.append('prompt', OPENAI_MULTILINGUAL_TRANSCRIPTION_PROMPT);
  }
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.openAiApiKey}` },
    body: form,
  });
  const rawText = await response.text();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    throw new Error(`OpenAI transcription returned invalid JSON (${response.status}): ${rawText.slice(0, 500)}`);
  }
  if (!response.ok) {
    const errorMessage = raw.error && typeof raw.error === 'object' && !Array.isArray(raw.error)
      ? (raw.error as { message?: unknown }).message
      : null;
    throw new Error(`OpenAI transcription failed (${response.status}): ${typeof errorMessage === 'string' ? errorMessage : rawText.slice(0, 800)}`);
  }
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  const segments = text ? [{ speaker: 'Transcript', text }] : [];
  return {
    text,
    segments,
    raw,
    config: {
      model: env.transcriptionTestOpenAiModel,
      response_format: 'json',
      language_mode: 'auto multilingual/code-switching',
      prompt: supportsPrompt ? OPENAI_MULTILINGUAL_TRANSCRIPTION_PROMPT : 'not sent; diarization model does not support prompts',
    },
    latencyMs: Math.round(performance.now() - startedAt),
  };
}

// While a job is running, bump its updated_at on this cadence so the boot-time
// orphan sweep (failOrphanedJobs) can distinguish a live job on another
// instance from one stranded by a crashed/redeployed process.
const JOB_HEARTBEAT_INTERVAL_MS = 60_000;
// A queued/processing job whose updated_at is older than this is considered
// orphaned. Must exceed the heartbeat interval by a safe margin so a genuinely
// live job (heartbeating every minute) is never swept.
const ORPHANED_JOB_THRESHOLD_MS = 5 * 60_000;
// How often to re-scan for orphans. A boot-only scan would miss a job orphaned
// moments before boot (not yet past the staleness threshold), stranding it
// forever; a periodic scan cleans it once it crosses the threshold.
const ORPHANED_JOB_SWEEP_INTERVAL_MS = 2 * 60_000;

async function updateWorkflowJob(jobId: string | null, patch: {
  status?: WorkflowJobRow['status'];
  stage?: string;
  progress?: number;
  result?: unknown;
  error?: string | null;
}, options?: { retries?: number }): Promise<boolean> {
  if (!jobId) return false;
  const retries = Math.max(0, options?.retries ?? 0);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const { error } = await supabase.from('workflow_job').update({
      ...patch,
      updated_at: new Date().toISOString(),
    }).eq('id', jobId);
    if (!error) return true;
    if (attempt < retries) {
      await delay(Math.min(1000 * 2 ** attempt, 8000));
      continue;
    }
    console.warn(`Could not update workflow job ${jobId}: ${error.message}`);
  }
  return false;
}

async function runSummarizeAudio(input: SummarizeAudioInput, jobId: string | null = null): Promise<SummarizeAudioResult> {
  if (!env.supabaseUrl || !env.serviceRoleKey) throw new Error('Supabase service configuration is missing.');
  if (!env.geminiApiKey) throw new Error('Gemini API key is missing.');
  if (!env.assemblyAiApiKey) throw new Error('AssemblyAI API key is missing.');

  await updateWorkflowJob(jobId, { status: 'processing', stage: 'loading inputs', progress: 10 });
  const summaryRules = input.summaryRulesOverride?.trim() || await loadSummaryPrompt(input.promptId, input.userId);
  const transcriptionSettings = await loadTranscriptionSettings();
  console.log(`Processing audio ${input.fileName} with AssemblyAI ${ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL} and no explicit language settings. Selected summary language: ${input.language}`);

  await updateWorkflowJob(jobId, { stage: 'transcribing audio', progress: 25 });
  const { segments, audioDurationSeconds, detectedLanguage } = await transcribeWithAssembly({
    downloadUrl: input.downloadUrl,
    noteId: input.noteId,
    userId: input.userId,
    settings: transcriptionSettings,
  });
  if (segments.length === 0) throw new Error('AssemblyAI returned no diarized transcript segments.');
  const transcriptText = formatTranscriptText(segments, 'original');
  const translationLanguage = getOppositeTranscriptLanguage(detectedLanguage);
  const diarizationTranslations: Partial<Record<'en' | 'ko', TranscriptSegment[]>> = {};
  const transcriptionTranslations: Partial<Record<'en' | 'ko', string>> = {};
  if (translationLanguage) {
    await updateWorkflowJob(jobId, {
      stage: `translating transcript to ${translationLanguage === 'ko' ? 'Korean' : 'English'}`,
      progress: 58,
    });
    try {
      const translatedSegments = await translateTranscriptSegments({
        segments,
        targetLanguage: translationLanguage,
        noteId: input.noteId,
        userId: input.userId,
      });
      if (translatedSegments.length > 0) {
        diarizationTranslations[translationLanguage] = translatedSegments;
        transcriptionTranslations[translationLanguage] = formatTranscriptText(translatedSegments, 'original');
      }
    } catch (translationError) {
      console.warn(`Transcript translation to ${translationLanguage} failed:`, translationError);
    }
  }
  const meetingStartAt = inferMeetingStartAt(input.meetingAt, audioDurationSeconds);
  const meetingDateForPrompt = meetingStartAt
    ? formatMeetingDateForPrompt(new Date(meetingStartAt), input.userTimeZone)
    : null;
  const attachmentParts = await buildGeminiAttachmentParts(input.attachments);
  const hasGeminiAttachments = attachmentParts.some((part) => Boolean(part.fileData));

  await updateWorkflowJob(jobId, { stage: 'generating summary', progress: 75 });
  const summaryRaw = await callGeminiWithFallback({
    stage: 'Summarization',
    model: env.summaryModel,
    fallbackModels: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'],
    responseMimeType: 'application/json',
    maxOutputTokens: 16384,
    parts: [
      {
        text: buildSummaryPrompt({
          now: new Date().toISOString(),
          meetingDate: meetingDateForPrompt,
          instructions: input.instructions,
          summaryRules,
          fileName: input.fileName,
          transcript: transcriptText,
          speakerContext: input.speakerContext,
          globalSummaryContext: transcriptionSettings.summaryContext,
          outputLanguage: input.language,
          hasAttachments: hasGeminiAttachments,
        }),
      },
      ...attachmentParts,
    ],
  });
  await recordGeminiUsage({
    noteId: input.noteId,
    userId: input.userId,
    stage: 'summarization',
    model: summaryRaw.model,
    inputType: 'text',
    usageMetadata: summaryRaw.usageMetadata,
    latencyMs: summaryRaw.latencyMs,
  });
  const parsedSummary = parseSummary(summaryRaw.text);
  if (hasGeminiAttachments && !summaryHasAttachmentSection(parsedSummary.summary, input.language)) {
    await updateWorkflowJob(jobId, { stage: 'generating attachment summary', progress: 82 });
    try {
      const attachmentSectionRaw = await generateAttachmentSummarySection({
        attachmentParts,
        attachments: input.attachments,
        transcriptText,
        existingSummary: parsedSummary.summary,
        language: input.language,
      });
      await recordGeminiUsage({
        noteId: input.noteId,
        userId: input.userId,
        stage: 'attachment-summary-section',
        model: attachmentSectionRaw.model,
        inputType: 'text',
        usageMetadata: attachmentSectionRaw.usageMetadata,
        latencyMs: attachmentSectionRaw.latencyMs,
      });
      parsedSummary.summary = `${parsedSummary.summary.trim()}\n\n${parseAttachmentSection(attachmentSectionRaw.text, input.language)}`;
    } catch (attachmentSectionError) {
      console.warn('Attachment summary section generation failed:', attachmentSectionError);
      parsedSummary.summary = `${parsedSummary.summary.trim()}\n\n${fallbackAttachmentSection(input.attachments, input.language)}`;
    }
  }
  const summaryTranslations: Record<'en' | 'ko', string> = {
    en: input.language === 'en' ? parsedSummary.summary : '',
    ko: input.language === 'ko' ? parsedSummary.summary : '',
  };

  // Alternate-language summary is temporarily disabled (see TRANSLATION_ENABLED) to
  // shorten processing time; only the selected-language summary above is generated.
  if (TRANSLATION_ENABLED) {
    const alternateLanguage: 'en' | 'ko' = input.language === 'ko' ? 'en' : 'ko';
    const alternateTranscriptText = formatTranscriptText(segments, alternateLanguage);
    await updateWorkflowJob(jobId, { stage: `generating ${alternateLanguage === 'ko' ? 'Korean' : 'English'} summary`, progress: 84 });
    const alternateSummaryRaw = await callGeminiWithFallback({
      stage: `Summarization (${alternateLanguage})`,
      model: env.summaryModel,
      fallbackModels: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'],
      responseMimeType: 'application/json',
      maxOutputTokens: 16384,
      parts: [
        {
          text: buildSummaryPrompt({
            now: new Date().toISOString(),
            meetingDate: meetingDateForPrompt,
            instructions: input.instructions,
            summaryRules,
            fileName: input.fileName,
            transcript: alternateTranscriptText,
            speakerContext: input.speakerContext,
            globalSummaryContext: transcriptionSettings.summaryContext,
            outputLanguage: alternateLanguage,
            hasAttachments: hasGeminiAttachments,
          }),
        },
        ...attachmentParts,
      ],
    });
    await recordGeminiUsage({
      noteId: input.noteId,
      userId: input.userId,
      stage: `summarization-${alternateLanguage}`,
      model: alternateSummaryRaw.model,
      inputType: 'text',
      usageMetadata: alternateSummaryRaw.usageMetadata,
      latencyMs: alternateSummaryRaw.latencyMs,
    });
    const parsedAlternateSummary = parseSummary(alternateSummaryRaw.text);
    summaryTranslations[alternateLanguage] = parsedAlternateSummary.summary;
  }

  await updateWorkflowJob(jobId, { stage: 'saving note', progress: 92 });
  const noteName = buildNoteName({
    title: parsedSummary.title,
    tags: parsedSummary.tags,
    summary: parsedSummary.summary,
    createdAt: meetingStartAt ? new Date(meetingStartAt) : undefined,
    timeZone: input.userTimeZone,
  });
  await insertNote({
    noteId: input.noteId,
    userId: input.userId,
    userName: input.userName,
    downloadUrl: input.downloadUrl,
    transcriptText,
    transcriptionLanguage: detectedLanguage,
    transcriptionTranslations,
    summary: parsedSummary.summary,
    summaryTranslations,
    title: noteName,
    tags: parsedSummary.tags,
    segments,
    diarizationTranslations,
    meetingAt: meetingStartAt,
    fileId: input.fileId,
    audioDurationSeconds,
  });

  // Fold this note into the owner's personal memory (F1') and write its
  // note_insight index (F4). Done server-side so it runs for EVERY note regardless
  // of client — the web client used to do this, which left mobile-created notes and
  // their owners' memory empty. Best-effort: never fail the summary job over a
  // memory/insight hiccup. Idempotent: foldNoteIntoMemory skips already-folded notes.
  await updateWorkflowJob(jobId, { stage: 'updating memory', progress: 96 });
  try {
    const fold = await foldNoteIntoMemory({
      supabase,
      apiKey: env.geminiApiKey,
      userId: input.userId,
      noteId: input.noteId,
      transcript: transcriptText,
      selfName: input.userName ?? null,
    });
    console.log(`Memory fold note=${input.noteId} items=${fold.memoryItemCount} insight=${fold.insightWritten} skipped=${fold.skipped}`);
  } catch (memoryError) {
    console.warn(`Memory fold failed for note ${input.noteId}:`, memoryError);
  }

  return {
    transcript: segments,
    summary: parsedSummary.summary,
    summaryTranslations,
    transcriptionLanguage: detectedLanguage,
    transcriptionTranslations,
    diarizationTranslations,
    title: noteName,
    tags: parsedSummary.tags,
    audioDurationSeconds,
    meetingStartAt,
  };
}

async function summarizeAudio(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const input = parseSummarizeInput((await readBody(req, 110_000_000)) as SummarizeAudioRequest);
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  if (tokenUserId !== input.userId) throw new Error('Authenticated user does not match request userId.');

  const result = await runSummarizeAudio(input);
  sendJson(res, 200, result);
}

async function createSummarizeJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const input = parseSummarizeInput((await readBody(req, 110_000_000)) as SummarizeAudioRequest);
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  if (tokenUserId !== input.userId) throw new Error('Authenticated user does not match request userId.');

  // Idempotency: the mobile client generates noteId once per recording and
  // reuses it when it retries createNote (e.g. after a lost HTTP response or a
  // cold restart). Return the existing in-flight or completed job for this
  // (user_id, note_id) instead of starting a second transcription+summary run,
  // which would duplicate the note and double the Assembly/Gemini cost. A
  // 'failed' job is intentionally excluded so the user can retry after a
  // genuine failure.
  const existing = await supabase
    .from('workflow_job')
    .select('id, status, stage, progress')
    .eq('user_id', input.userId)
    .eq('note_id', input.noteId)
    .in('status', ['queued', 'processing', 'completed'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) {
    const row = existing.data as { id: string; status: WorkflowJobRow['status']; stage: string | null; progress: number | null };
    sendJson(res, 202, {
      jobId: row.id,
      status: row.status,
      stage: row.stage ?? row.status,
      progress: row.progress ?? 0,
      deduplicated: true,
    });
    return;
  }

  const { data, error } = await supabase.from('workflow_job').insert({
    user_id: input.userId,
    note_id: input.noteId,
    type: 'summarize_audio',
    status: 'queued',
    stage: 'queued',
    progress: 0,
    request: input,
    updated_at: new Date().toISOString(),
  }).select('id').single();
  if (error) throw error;
  const jobId = (data as { id?: unknown }).id;
  if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Could not create workflow job.');

  void processSummarizeJob(jobId.trim(), input);
  sendJson(res, 202, { jobId, status: 'queued', stage: 'queued', progress: 0 });
}

async function createAndroidRecordingJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
    const upload = await parseAndroidMultipartUpload(req);

  try {
    if (!isSupportedAndroidAudio(upload.file)) {
      throw new HttpError(400, `Unsupported audio file. Upload an audio file supported by AssemblyAI: ${ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS.join(', ')}.`);
    }
    if (upload.file.sizeBytes <= 0) {
      throw new HttpError(400, 'Uploaded audio file is empty.');
    }
    if (upload.file.sizeBytes > ANDROID_AUDIO_MAX_BYTES) {
      throw new HttpError(413, 'Audio file exceeds the 100 MB maximum size.');
    }

    const noteId = randomUUID();
    const fileId = randomUUID();
    const submittedFileName = upload.fields.fileName?.trim() || upload.file.originalName || 'android-recording.ogg';
    const submittedHasSupportedExt = ASSEMBLYAI_AUDIO_EXTENSION_RE.test(submittedFileName);
    const originalExt = upload.file.originalName.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    const fallbackExt = originalExt && ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS.includes(originalExt as typeof ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS[number])
      ? originalExt
      : 'ogg';
    const safeFileName = sanitizeUploadFileName(
      submittedHasSupportedExt ? submittedFileName : `${submittedFileName}.${fallbackExt}`,
      `android-recording.${fallbackExt}`
    );
    const recordedAt = parseOptionalDate(upload.fields.recordingEndedAt);
    const summaryPrompt = await resolveSummaryPromptForAndroid({
      promptId: upload.fields.promptId,
      userId: tokenUserId,
    });
    const { storagePath, signedUrl } = await uploadAndroidAudioToStorage({
      userId: tokenUserId,
      noteId,
      fileName: safeFileName,
      mimeType: upload.file.mimeType || 'audio/ogg',
      tempPath: upload.file.tempPath,
    });
    await createAndroidAudioFileRecord({
      id: fileId,
      userId: tokenUserId,
      fileName: safeFileName,
      storagePath,
      mimeType: upload.file.mimeType || 'audio/ogg',
      sizeBytes: upload.file.sizeBytes,
      recordedAt,
    });

    const input: SummarizeAudioInput = {
      downloadUrl: signedUrl,
      fileName: safeFileName,
      promptId: summaryPrompt.promptId,
      summaryRulesOverride: summaryPrompt.summaryRulesOverride,
      userId: tokenUserId,
      userName: '',
      noteId,
      meetingAt: recordedAt,
      userTimeZone: upload.fields.userTimeZone?.trim() || null,
      fileId,
      instructions: upload.fields.instructions ?? '',
      speakerContext: '',
      attachments: [],
      language: upload.fields.language === 'ko' ? 'ko' : 'en',
    };
    const { data, error } = await supabase.from('workflow_job').insert({
      user_id: tokenUserId,
      note_id: noteId,
      type: 'summarize_audio',
      status: 'queued',
      stage: 'queued',
      progress: 0,
      request: {
        ...input,
        source: 'android_recording',
        storagePath,
        originalFileName: upload.file.originalName,
        mimeType: upload.file.mimeType,
        sizeBytes: upload.file.sizeBytes,
      },
      updated_at: new Date().toISOString(),
    }).select('id').single();
    if (error) throw error;
    const jobId = (data as { id?: unknown }).id;
    if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Could not create workflow job.');

    void processSummarizeJob(jobId.trim(), input);
    sendJson(res, 202, {
      jobId,
      noteId,
      fileId,
      status: 'queued',
      stage: 'queued',
      progress: 0,
    });
  } finally {
    await unlink(upload.file.tempPath).catch(() => undefined);
  }
}

async function processSummarizeJob(jobId: string, input: SummarizeAudioInput): Promise<void> {
  // Keep updated_at fresh across long silent stages (e.g. the multi-minute
  // AssemblyAI poll) so a concurrent boot sweep never mistakes this live job
  // for an orphan.
  const heartbeat = setInterval(() => {
    void updateWorkflowJob(jobId, {});
  }, JOB_HEARTBEAT_INTERVAL_MS);
  try {
    const result = await runSummarizeAudio(input, jobId);
    // Terminal writes retry: a transient DB blip here would otherwise strand the
    // job at 'processing' forever and the client would poll until it times out.
    await updateWorkflowJob(jobId, {
      status: 'completed',
      stage: 'completed',
      progress: 100,
      result,
      error: null,
    }, { retries: 4 });
    completedJobResults.set(jobId, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Workflow job ${jobId} failed:`, error);
    void sendWorkflowAlert({
      title: 'Summarize audio job failed',
      error,
      context: {
        jobId,
        noteId: input.noteId,
        userId: input.userId,
        fileName: input.fileName,
        promptId: input.promptId,
        meetingAt: input.meetingAt,
      },
    });
    await updateWorkflowJob(jobId, {
      status: 'failed',
      stage: 'failed',
      progress: 100,
      error: message,
    }, { retries: 4 });
  } finally {
    clearInterval(heartbeat);
  }
}

const completedJobResults = new Map<string, SummarizeAudioResult>();

async function getSummarizeJob(req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  const { data, error } = await supabase
    .from('workflow_job')
    .select('id, user_id, note_id, status, stage, progress, result, error')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    sendJson(res, 404, { error: 'Workflow job not found.' });
    return;
  }
  const row = data as WorkflowJobRow;
  if (row.user_id !== tokenUserId) throw new Error('Authenticated user does not match workflow job userId.');

  sendJson(res, 200, {
    jobId: row.id,
    noteId: row.note_id,
    status: row.status,
    stage: row.stage ?? row.status,
    progress: row.progress ?? 0,
    result: row.status === 'completed' ? completedJobResults.get(jobId) ?? row.result : null,
    error: row.error,
  });
  if (row.status === 'completed') completedJobResults.delete(jobId);
}

function parseProjectChatInput(body: ProjectChatRequest): { message: string; projectId: string; projectIdFilterValue: string | number } {
  const message = requiredString(body, 'message');
  const rawProjectId = body.project_id;
  const projectId =
    typeof rawProjectId === 'string' || typeof rawProjectId === 'number'
      ? String(rawProjectId).trim()
      : '';
  if (!projectId) throw new HttpError(400, 'project_id is required.');
  const asNumber = Number(projectId);
  return {
    message,
    projectId,
    projectIdFilterValue: Number.isNaN(asNumber) ? projectId : asNumber,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function noteText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value.trim() : '';
}

function projectChatContext(notes: Array<Record<string, unknown>>): string {
  return notes.map((note, index) => {
    const n = index + 1;
    const transcription = noteText(note, 'transcription');
    const summary = noteText(note, 'summary');
    return `transcription${n}:\n${transcription}\n\nsummary${n}:\n${summary}\n\n`;
  }).join('\n\n');
}

function buildProjectChatPrompt(context: string, message: string): string {
  return `You are an internal AI assistant for TecAce Software, Ltd. Your primary role is to answer user questions accurately, concisely, and professionally, based EXCLUSIVELY on the provided company meeting transcriptions and the summaries of those transcriptions.

### CORE DIRECTIVES
1. **Strict Grounding:** You must base your answers ONLY on the context provided in the prompt (the transcripts, summaries, and associated metadata). Under no circumstances should you use outside knowledge, speculate, guess, or hallucinate information. First check the summaries for your answers. If unable to generate a response based on summary information alone start digging deeper into the transcription itself to see if more information can be found there.
2. **Handling Missing Information:** If the provided context does not contain the answer to the user's question, you must clearly state: "I cannot find the answer to that in the provided meeting documents." Do not attempt to infer an answer if the data is missing.
3. **Cite Sources:** Whenever possible, reference the specific meeting date, title, or speaker associated with the information to build trust (e.g., "During the Q3 All-Hands on October 12th, Jane Doe stated...").
4. **Maintain Objectivity:** Present the information exactly as it was discussed. Do not inject personal opinions, bias, or commentary on the meeting's contents.

### RESPONSE GUIDELINES
- **Clarity & Brevity:** Keep your answers direct and easy to read. Use bullet points when summarizing multiple topics, listing action items, or detailing decisions.
- **Direct Quotes:** If a user asks exactly what a specific person said, or if the exact phrasing is highly important, provide a brief direct quote from the transcript enclosed in quotation marks.
- **Action Items & Decisions:** If asked about next steps or outcomes, clearly identify what was decided, who is responsible, and any stated deadlines—provided that information exists in the text.
- **Ambiguity:** If the meeting text is ambiguous, speakers are unclear, or multiple meetings have conflicting information, point out this discrepancy to the user rather than guessing the "correct" interpretation.

### TRANSCRIPTION AND SUMMARIES
${context}

### USER QUESTION
${message}`;
}

async function projectChatPromptFromRequest(req: IncomingMessage): Promise<string> {
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  const input = parseProjectChatInput((await readBody(req)) as ProjectChatRequest);

  let { data: projectRow, error: projectError } = await supabase
    .from('project')
    .select('id,user_id,shared_users')
    .eq('id', input.projectId)
    .maybeSingle();
  if (!projectRow && !projectError && input.projectIdFilterValue !== input.projectId) {
    const fallback = await supabase
      .from('project')
      .select('id,user_id,shared_users')
      .eq('id', input.projectIdFilterValue)
      .maybeSingle();
    projectRow = fallback.data;
    projectError = fallback.error;
  }
  if (projectError) throw projectError;
  if (!projectRow) {
    throw new HttpError(404, 'Project not found.');
  }

  const project = projectRow as Record<string, unknown>;
  const sharedUsers = stringArray(project.shared_users);
  const hasProjectAccess = project.user_id === tokenUserId || sharedUsers.includes(tokenUserId);
  if (!hasProjectAccess) {
    throw new HttpError(403, 'You do not have access to this project.');
  }

  const { data: noteRows, error: noteError } = await supabase
    .from('note')
    .select('transcription,summary')
    .contains('projects', [input.projectIdFilterValue]);
  if (noteError) throw noteError;
  const notes = (noteRows ?? []) as Array<Record<string, unknown>>;
  if (notes.length === 0) {
    return 'I cannot find the answer to that in the provided meeting documents.';
  }
  return buildProjectChatPrompt(projectChatContext(notes), input.message);
}

async function projectChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!env.geminiApiKey) throw new Error('Gemini API key is missing.');
  const prompt = await projectChatPromptFromRequest(req);
  if (prompt === 'I cannot find the answer to that in the provided meeting documents.') {
    sendJson(res, 200, { response: prompt });
    return;
  }
  const result = await callGeminiWithFallback({
    stage: 'Project chat',
    model: PROJECT_CHAT_MODEL,
    fallbackModels: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'],
    responseMimeType: 'text/plain',
    maxOutputTokens: 4096,
    parts: [{ text: prompt }],
  });
  sendJson(res, 200, { response: result.text.trim() });
}

function projectChatDelta(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const candidates = (data as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return '';
  return candidates
    .flatMap((candidate) => {
      const parts = (candidate as { content?: { parts?: unknown } }).content?.parts;
      return Array.isArray(parts) ? parts : [];
    })
    .map((part) => (part as { text?: unknown }).text)
    .filter((text): text is string => typeof text === 'string')
    .join('');
}

async function streamProjectChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!env.geminiApiKey) throw new Error('Gemini API key is missing.');
  const prompt = await projectChatPromptFromRequest(req);
  const openStream = () => {
    res.writeHead(200, {
      ...corsHeaders(),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
  };
  const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (prompt === 'I cannot find the answer to that in the provided meeting documents.') {
    openStream();
    send({ delta: prompt });
    send({ done: true });
    res.end();
    return;
  }

  const models = [PROJECT_CHAT_MODEL, 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'];
  let response: Response | null = null;
  let lastError = '';
  for (const model of models) {
    const candidate = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.geminiApiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 4096,
            responseMimeType: 'text/plain',
          },
        }),
      },
    );
    if (candidate.ok && candidate.body) {
      response = candidate;
      break;
    }
    lastError = `Gemini stream failed (${candidate.status}): ${(await candidate.text()).slice(0, 500)}`;
  }
  if (!response || !response.body) {
    throw new Error(lastError || 'Gemini stream failed.');
  }

  openStream();
  send({ delta: '' });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice('data:'.length).trim();
        if (!raw || raw === '[DONE]') continue;
        const delta = projectChatDelta(JSON.parse(raw));
        if (delta) send({ delta });
      }
    }
  }
  send({ done: true });
  res.end();
}

async function regenerateSummary(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  const input = parseRegenerateSummaryInput((await readBody(req, 12_000_000)) as RegenerateSummaryRequest);

  const { data: noteRow, error: noteError } = await supabase
    .from('note')
    .select('id, user_id, shared_users')
    .eq('id', input.noteId)
    .maybeSingle();
  if (noteError) throw noteError;
  if (!noteRow) {
    sendJson(res, 404, { error: 'Note not found.' });
    return;
  }
  const note = noteRow as { user_id?: unknown; shared_users?: unknown };
  const sharedUsers = Array.isArray(note.shared_users)
    ? note.shared_users.map((value) => String(value))
    : [];
  if (note.user_id !== tokenUserId && !sharedUsers.includes(tokenUserId)) {
    sendJson(res, 403, { error: 'You do not have access to regenerate this note.' });
    return;
  }

  if (!env.geminiApiKey) throw new Error('Gemini API key is missing.');

  // Regenerate with the requester's selected summary prompt (custom prompts now
  // apply here too, not just on fresh summaries).
  const summaryRules = await resolveRegenerateSummaryRules(input.promptId, tokenUserId);

  const result = await callGeminiWithFallback({
    stage: 'Summary regeneration',
    model: env.regenerateSummaryModel,
    fallbackModels: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'],
    responseMimeType: 'application/json',
    maxOutputTokens: 16384,
    parts: [{
      text: buildRegenerateSummaryPrompt({
        now: new Date().toISOString(),
        instructions: input.instructions,
        summaryRules,
        diarizedTranscript: formatTranscriptText(input.segments, 'original'),
        previousSummary: input.previousSummary,
        speakerProfiles: input.speakerProfiles,
      }),
    }],
  });
  const parsedSummary = parseSummary(result.text);

  await recordGeminiUsage({
    noteId: input.noteId,
    userId: tokenUserId,
    stage: 'summary-regeneration',
    model: result.model,
    inputType: 'text',
    usageMetadata: result.usageMetadata,
    latencyMs: result.latencyMs,
  });

  const { error: updateError } = await supabase
    .from('note')
    .update({ summary_edit: parsedSummary.summary })
    .eq('id', input.noteId);
  if (updateError) throw updateError;

  sendJson(res, 200, parsedSummary);

  // After responding (so the user is not blocked), fold this note into the owner's
  // memory + refresh its note_insight, best-effort. foldNoteIntoMemory is idempotent:
  // an already-folded note is skipped, so this mainly backfills notes that predate
  // server-side folding (e.g. earlier mobile notes) when they are regenerated.
  try {
    await foldNoteIntoMemory({
      supabase,
      apiKey: env.geminiApiKey,
      userId: tokenUserId,
      noteId: input.noteId,
      transcript: formatTranscriptText(input.segments, 'original'),
      selfName: null,
    });
  } catch (memoryError) {
    console.warn(`Memory fold (regenerate) failed for note ${input.noteId}:`, memoryError);
  }
}

// F4 backfill: populate note_insight for existing notes (insight only, no memory
// fold). Admin-gated and batched — call repeatedly until `processed` is 0. Each
// call pulls a batch of notes still lacking a note_insight row (server-side filter
// via notes_needing_insight) and extracts one row each.
async function backfillInsight(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  if (tokenUserId !== TRANSCRIPTION_MODEL_TEST_USER_ID) {
    sendJson(res, 403, { error: 'Insight backfill is not available for this user.' });
    return;
  }
  if (!env.geminiApiKey) throw new Error('Gemini API key is missing.');

  const body = (await readBody(req, 1_000_000)) as { limit?: unknown } | null;
  const limit = Math.max(1, Math.min(Math.floor(Number(body?.limit) || 25), 50));

  const { data, error } = await supabase.rpc('notes_needing_insight', { p_limit: limit });
  if (error) throw error;
  const notes = (data as Array<{ id: string; user_id: string; transcription: string }>) ?? [];

  let written = 0;
  let failed = 0;
  for (const note of notes) {
    try {
      const ok = await extractAndStoreInsight({
        supabase,
        apiKey: env.geminiApiKey,
        userId: note.user_id,
        noteId: note.id,
        transcript: note.transcription ?? '',
      });
      if (ok) written += 1;
      else failed += 1;
    } catch (backfillError) {
      failed += 1;
      console.warn(`Backfill insight failed for note ${note.id}:`, backfillError);
    }
  }

  sendJson(res, 200, { processed: notes.length, written, failed });
}

async function runTranscriptionTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  if (tokenUserId !== TRANSCRIPTION_MODEL_TEST_USER_ID) {
    sendJson(res, 403, { error: 'Transcription model testing is not available for this user.' });
    return;
  }
  const input = parseTranscriptionTestInput((await readBody(req, 110_000_000)) as TranscriptionTestRequest);
  const result = input.model === 'assembly_universal2_codeswitch' || input.model === 'assembly_universal3pro_auto'
    ? await transcribeAssemblyForTest({ bytes: input.bytes, model: input.model })
    : input.model === 'gemini'
      ? await transcribeGeminiForTest({ bytes: input.bytes, fileName: input.fileName, mimeType: input.mimeType })
      : await transcribeOpenAiForTest({ bytes: input.bytes, fileName: input.fileName, mimeType: input.mimeType });

  sendJson(res, 200, {
    model: input.model,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.byteLength,
    ...result,
  });
}

// Git-derived build identity. Render injects RENDER_GIT_COMMIT / RENDER_GIT_BRANCH
// at build + runtime; locally they are unset so we report 'dev'/'local'. This is a
// per-service traceability stamp (which commit is live right now), NOT a shared
// version number across the web/mobile/mcp apps — each deployable reports its own.
const VERSION_INFO = {
  service: 'meeting-note-workflow-server',
  sha: process.env.RENDER_GIT_COMMIT ?? 'dev',
  shortSha: (process.env.RENDER_GIT_COMMIT ?? 'dev').slice(0, 7),
  branch: process.env.RENDER_GIT_BRANCH ?? 'local',
  deployedAt: new Date().toISOString(),
} as const;

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === 'OPTIONS') {
      sendNoContent(res);
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      sendJson(res, 200, {
        ok: true,
        service: 'meeting-note-workflow-server',
        version: VERSION_INFO,
        transcriptionProvider: 'assemblyai',
        transcriptionModel: ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL,
        transcriptionLanguageMode: 'no explicit AssemblyAI language settings',
        selectedLanguageAffectsTranscription: false,
        codeSwitchingModel: ASSEMBLYAI_CODE_SWITCHING_MODEL_LABEL,
        summaryModel: env.summaryModel,
        regenerateSummaryModel: env.regenerateSummaryModel,
        projectChatModel: PROJECT_CHAT_MODEL,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/version') {
      sendJson(res, 200, VERSION_INFO);
      return;
    }
    if (req.method === 'POST' && req.url === '/summarize-audio') {
      await summarizeAudio(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/transcription-test') {
      await runTranscriptionTest(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/admin/backfill-insight') {
      await backfillInsight(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/regenerate-summary') {
      await regenerateSummary(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/project-chat') {
      await projectChat(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/project-chat/stream') {
      await streamProjectChat(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/summarize-audio/jobs') {
      await createSummarizeJob(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/android/recordings/jobs') {
      await createAndroidRecordingJob(req, res);
      return;
    }
    const jobMatch = url.pathname.match(/^\/summarize-audio\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch?.[1]) {
      await getSummarizeJob(req, res, decodeURIComponent(jobMatch[1]));
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  })().catch((error) => {
    const message = errorMessage(error);
    const status = getHttpStatus(error);
    console.error('Workflow request failed:', error);
    if (status >= 500) {
      void sendWorkflowAlert({
        title: 'Workflow request failed',
        error,
        context: {
          method: req.method,
          url: req.url,
          status,
        },
      });
    }
    sendJson(res, status, { error: message });
  });
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled workflow rejection:', error);
  void sendWorkflowAlert({
    title: 'Unhandled workflow rejection',
    error,
    context: { source: 'process.unhandledRejection' },
  });
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught workflow exception:', error);
  void sendWorkflowAlert({
    title: 'Uncaught workflow exception',
    error,
    context: { source: 'process.uncaughtException' },
  });
});

// Jobs run in-process via fire-and-forget, so a crash/redeploy leaves their
// rows stuck at 'queued'/'processing' forever and clients poll for the full
// hour. On boot, fail such rows that have gone stale (older than the orphan
// threshold) so clients get a prompt, retryable error. The staleness guard
// (backed by the per-job heartbeat) prevents sweeping a live job owned by an
// overlapping instance during a zero-downtime deploy.
async function failOrphanedJobs(): Promise<void> {
  if (!env.supabaseUrl || !env.serviceRoleKey) return;
  const cutoff = new Date(Date.now() - ORPHANED_JOB_THRESHOLD_MS).toISOString();
  const { data, error } = await supabase
    .from('workflow_job')
    .select('id')
    .in('status', ['queued', 'processing'])
    .lt('updated_at', cutoff);
  if (error) {
    console.warn(`Could not scan for orphaned workflow jobs: ${error.message}`);
    return;
  }
  const ids = ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
  if (ids.length === 0) return;
  const { error: updateError } = await supabase
    .from('workflow_job')
    .update({
      status: 'failed',
      stage: 'failed',
      error: 'Server restarted while this job was running. Please try again.',
      updated_at: new Date().toISOString(),
    })
    .in('id', ids);
  if (updateError) {
    console.warn(`Could not fail ${ids.length} orphaned workflow job(s): ${updateError.message}`);
    return;
  }
  console.log(`Marked ${ids.length} orphaned workflow job(s) as failed on boot.`);
}

server.listen(env.port, () => {
  console.log(`Meeting Note workflow server listening on :${env.port}`);
  console.log(`Workflow env: transcription=assemblyai:${ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL}:no-language-settings, summary=${env.summaryModel}, headersTimeout=${env.fetchHeadersTimeoutMs}, bodyTimeout=${env.fetchBodyTimeoutMs}`);
  void failOrphanedJobs();
  setInterval(() => void failOrphanedJobs(), ORPHANED_JOB_SWEEP_INTERVAL_MS);
});
