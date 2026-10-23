import './config/loadEnv.js';
import { handleProjectChatRequest } from './routes/projectChat.js';
import { handleTranscriptionTestRequest, ASSEMBLYAI_CODE_SWITCHING_MODEL_LABEL } from './routes/transcriptionTest.js';
import { callGeminiWithFallback, delay, type GeminiWorkflowCallResult } from './ai/geminiFallback.js';
import { recordGeminiUsage, recordAssemblyUsage } from './pipeline/usage.js';
import { getPersonalMemoryContext } from './pipeline/memoryContext.js';
import { buildSpeakerContextFromSegments } from './pipeline/speakerContext.js';
import { HttpError, sendJson, sendNoContent, readBody, getHttpStatus, errorMessage, requiredString, getBearerToken } from './http/shared.js';
import { getMicrosoftUserId, getMicrosoftProfile } from './http/identity.js';
import { supabase } from './db/supabaseClient.js';
import { env, ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODELS, ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL, TRANSLATION_ENABLED } from './config/env.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createWriteStream, realpathSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Busboy from 'busboy';
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { PROJECT_CHAT_MODEL, STANDARD_FALLBACK_CHAIN, ISSUE_RESOLUTION_MODEL, ISSUE_RESOLUTION_FALLBACK_CHAIN, KNOWLEDGE_EXTRACTION_MODEL, liteModelFromEnv } from './gemini-models.js';
import { CREATED_MAIL_LIMIT_PER_HOUR, ISSUE_KEY_PATTERN, ISSUE_RESOLUTION_SCHEMA, ISSUE_RESOLUTION_SYSTEM_PROMPT, buildIssueMail, buildResolutionUserText, canIssue, decideNotify, firstFrontendOrigin, imageAttachmentPaths, parseNotifyKind, parseResolutionRequest, resolveNotifyEmails, validateResolution, type IssueRow, type NotifyKind, type RecipientsRead } from './issues.js';
import { callGemini, uploadGeminiFile } from './gemini.js';
import { buildNoteName, formatMeetingDateForPrompt, parseSummary, stripJsonCodeFences, formatTranscriptText, normalizeTranscriptSegment, parseDiarizedSegmentsWithRecovery, type TranscriptSegment } from './parsers.js';
import { buildRegenerateSummaryPrompt, buildSummaryPrompt, buildTranscriptTranslationPrompt } from './prompts.js';
import { extractAndStoreInsight, foldNoteIntoMemory, renderMemoryItemsForBriefing, type BriefingMemoryItem } from './memory.js';
import { sendWorkflowAlert, sendEmail, alertRecipients, formatError as formatAlertError, sanitizeContext as sanitizeAlertContext, type WorkflowAlertInput } from './alerts.js';
import { incidentFingerprint, matchOpsTicket, bumpOccurrence, makeOpsIssueKey, opsSeverityToPriority, buildOpsIncidentDetail, buildOpsTicketDescription, type OpsSuggestionMeta } from './opsAgent.js';
import { handleMcpRequest } from './mcp/transports/http.js';

import { loadProductDoc, loadProductDocsIndex } from './productDocs.js';
import { clientGateMode, resolveMicrosoftCaller, tenantGateMode } from './microsoftIdentity.js';
import { createMeetingKnowledgeHttpHandler } from './knowledge/http.js';
import { createMeetingKnowledgeStore } from './knowledge/store.js';
import { createMeetingOutboxStore } from './knowledge/outbox.js';
import { startMeetingKnowledgeDelivery } from './knowledge/delivery.js';
import { createMeetingModelPolicyClient } from './knowledge/model-policy-client.js';
import { createGeminiMeetingGenerator } from './knowledge/extraction-provider.js';
import { createMeetingExtractionStore } from './knowledge/extraction-store.js';
import { startMeetingExtractionWorker } from './knowledge/extraction-worker.js';


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

interface RegenerateSummaryRequest {
  noteId?: unknown;
  diarization?: unknown;
  previousSummary?: unknown;
  speakerProfiles?: unknown;
  instructions?: unknown;
  promptId?: unknown;
}

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

// Thrown when transcription succeeds but the audio held no detectable speech
// (a recording left running in a silent room, or an interrupted capture whose
// recovered audio is only ambient noise). This is a normal user outcome, not a
// system failure: it must surface a clear, localized message and must NOT raise
// an ops incident. 422 = the request was well-formed but the audio is
// unprocessable, for the direct (non-job) summarize endpoint.
class NoSpeechDetectedError extends HttpError {
  constructor(message: string) {
    super(422, message);
    this.name = 'NoSpeechDetectedError';
  }
}

// User-facing message for a no-speech recording, in the selected summary
// language. Shown verbatim to the user (mobile processing screen, web job
// poll), so it must read as guidance, never as an internal error string.
function noSpeechMessage(language: 'en' | 'ko'): string {
  return language === 'ko'
    ? '녹음에서 음성을 찾지 못했어요. 말소리가 담긴 녹음으로 다시 시도해 주세요.'
    : 'No speech was found in this recording. Please try again with audio that contains speech.';
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
// Keep in sync with src/constants/defaultSummaryPrompt.ts (the web copy that seeds a user's
// "Default" summary_prompt row). This backend copy is the FALLBACK when no DB row exists
// (android-default + resolveRegenerateSummaryRules last resort).
const DEFAULT_SUMMARY_PROMPT = `You are an Insightful Meeting Notes Writer and Transcript extractor. From a meeting voice file (and meta info), transcribe and produce actionable, structured notes.
미팅 내용은 TecAce의 업무에 관련된 미팅이다.
TecAce is a technology consulting and software development company specializing in AI solutions, cloud infrastructure/operation, and device optimization. Founded over 25 years ago and headquartered in Bellevue, Washington, it operates globally with additional offices in Korea, offering full-stack development and enterprise-grade tech services.
Organize content by topics (never by speaker). Use speaker attributions only within each topic.
Clearly summarize all schedule/timeline ("일정") discussions in a dedicated "일정 정리 (Schedule Summary)" section if relevant.
The summary output must be in markdown format for clear and easy reading and should include tables where necessary. It should also be in the meeting's original language (default: Korean).
전체를 읽고 이해한 후 미팅 목적에 맞춰 요약을 작성.

Output Structure
회의 요약: 날짜, 참석자, 목적 (2~3문장으로 간결히)
논의 항목/주제별 요약: 주제별로 핵심 내용과 중요 논의를 충분히 구체적으로 서술. 구체 사례, 수치, 우선순위, 담당 부서/사람 등 세부는 반드시 유지하고(생략하지 말 것), 근거(누가·무엇을·왜)를 함께 담을 것. 불필요한 반복만 제거하고, 간결함보다 정확성과 구체성을 우선.
결정 사항 (Decisions): 이 회의에서 확정된 결정만 별도 항목으로 명확히 나열 (각 결정에 배경/근거 한 줄). 결정이 없으면 이 섹션 생략.
일정 정리 (Schedule Summary): 일정/타임라인 관련 내용 모아 정리 (적용 시)
실행 항목/다음 단계 (Action Items): 반드시 마크다운 표로 작성. 표 헤더는 | 할 일 | 담당자 | 기한 | 상태 |. 담당자·기한은 트랜스크립트에 명시되거나 강하게 암시된 경우에만 채우고, 없으면 "미정"으로 표기. 담당자를 추측해 지어내지 말 것.
인사이트: 경영자 판단에 도움이 되는 시사점 (필요 시)

Notes
- 논의 내용은 항상 항목/주제별로 정리 (발언자별 X).
- 일정 내용은 별도 "일정 정리" 섹션에 모두 모으기.
- 알려진 팀원·제품·회사명은 GLOBAL SUMMARY CONTEXT의 표기를 그대로 따를 것.
- No hallucinations. 반드시 Transcript 기반으로만 작성. 트랜스크립트에 없는 사실·담당자·결정은 추가 금지.
- 원문 언어 준수 (한국어 회의는 한국어 출력, 영어 회의는 영어 출력).
Reminder: 요약으로 시작, 주제별 정리(세부 구체성 유지), 결정은 "결정 사항"에, 일정은 "일정 정리"에, 실행 항목은 표로. 각 섹션은 필요한 만큼 구체적으로 쓰되 중복은 피할 것.`;
// PROJECT_CHAT_MODEL is imported from gemini-models.ts (the central registry).

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

// Short-lived identity cache for the click-heavy docs path, so browsing N docs does not make
// N+1 Graph /me calls (and risk 429). Keyed by a hash of the token (never the raw token); small
// TTL so a revoked token stops resolving quickly. Only successful MEMBER lookups are cached;
// non-members are re-checked every time. Bounded size (Power of Ten rule 8).
const PRODUCT_DOCS_IDENTITY_TTL_MS = 60_000;
const PRODUCT_DOCS_IDENTITY_CACHE_MAX = 256;
const productDocsIdentityCache = new Map<string, { id: string; expiresAt: number }>();

// TecAce org gate for product docs. These are internal specs served identically to every
// caller, so a valid Microsoft token is not enough: the token's tenant must be allowlisted.
// The mail / UPN domain is NOT used (an outside tenant admin can set mail to x@tecace.com).
// requireOrg: an unconfigured tenant allowlist refuses docs instead of serving everyone.
// Throws 401 (bad token) or 403 (outside tenant / gate unconfigured).
async function assertProductDocsMember(req: IncomingMessage): Promise<string> {
  const token = getBearerToken(req);
  const key = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  const cached = productDocsIdentityCache.get(key);
  if (cached && cached.expiresAt > now) return cached.id;

  const caller = await resolveMicrosoftCaller(token, { requireOrg: true, surface: 'product-docs' });
  // Simple bound: clear when full rather than tracking LRU (the set is tiny and TTL-bounded).
  if (productDocsIdentityCache.size >= PRODUCT_DOCS_IDENTITY_CACHE_MAX) productDocsIdentityCache.clear();
  productDocsIdentityCache.set(key, { id: caller.id, expiresAt: now + PRODUCT_DOCS_IDENTITY_TTL_MS });
  return caller.id;
}

async function getProductDocsIndexRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await assertProductDocsMember(req);
  const index = await loadProductDocsIndex();
  sendJson(res, 200, index);
}

async function getProductDocRoute(req: IncomingMessage, res: ServerResponse, slug: string): Promise<void> {
  await assertProductDocsMember(req);
  const doc = await loadProductDoc(slug);
  if (!doc) {
    sendJson(res, 404, { error: 'Unknown product doc.' });
    return;
  }
  sendJson(res, 200, doc);
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
    fallbackModels: [...STANDARD_FALLBACK_CHAIN],
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
  // FIX 1: idempotent on the note primary key. A terminal-status write can fail
  // (DB outage) AFTER this insert succeeds, which later strands the job and
  // triggers a retry. If that retry reuses the same noteId, a bare .insert()
  // would create a DUPLICATE note (and double the Assembly/Gemini spend). Upsert
  // with ON CONFLICT (id) DO NOTHING makes a same-id retry a no-op: the first
  // successful write wins and is never silently overwritten.
  const { error } = await supabase.from('note').upsert(notePayload, { onConflict: 'id', ignoreDuplicates: true });
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
    const { error: retryError } = await supabase.from('note').upsert(payloadWithoutTranslations, { onConflict: 'id', ignoreDuplicates: true });
    if (retryError) throw retryError;
    console.warn('Inserted note without transcript translation columns because the PostgREST schema cache is missing them.');
    return;
  }
  if (error?.code === 'PGRST204' && error.message.includes("'duration_seconds'")) {
    const { duration_seconds: _durationSeconds, ...payloadWithoutDuration } = notePayload;
    const { error: retryError } = await supabase.from('note').upsert(payloadWithoutDuration, { onConflict: 'id', ignoreDuplicates: true });
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
  // Short first poll, then back off to the steady 3s cadence. A brief clip is often
  // transcribed within ~1-2s, so waiting a full 3s before the FIRST status check added
  // a fixed ~3s to every short recording for no benefit; one extra early poll is
  // negligible load and doesn't slow long transcriptions.
  let pollIntervalMs = 1000;
  while (performance.now() - startedAt < timeoutMs) {
    await delay(pollIntervalMs);
    pollIntervalMs = 3000;
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
          // Stable original label — never rewritten by a rename (see TranscriptSegment).
          speakerKey: `Speaker ${label}`,
          text: typeof record.text === 'string' ? record.text.trim() : '',
          start: typeof record.start === 'number' ? record.start / 1000 : undefined,
          end: typeof record.end === 'number' ? record.end / 1000 : undefined,
          ...(Object.keys(translations).length > 0 ? { translations } : {}),
        };
      }).filter((segment) => segment.text)
    : [{
        speaker: 'Unknown Speaker',
        speakerKey: 'Unknown Speaker',
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

async function translateTranscriptSegments(input: {
  segments: TranscriptSegment[];
  targetLanguage: 'en' | 'ko';
  noteId: string;
  userId: string;
}): Promise<TranscriptSegment[]> {
  const result = await callGeminiWithFallback({
    stage: `Transcript translation (${input.targetLanguage})`,
    model: env.summaryModel,
    fallbackModels: [...STANDARD_FALLBACK_CHAIN],
    responseMimeType: 'application/json',
    maxOutputTokens: 32768,
    thinkingBudget: 0,
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

// FIX 2: transcribe -> summarize checkpoint. AssemblyAI transcription is the
// slowest and most expensive step, and until the final note insert its output
// lived only in a local variable. A summary failure or a process restart between
// transcription and insert therefore discarded the already-paid transcript and
// forced a full re-transcription on the next retry. The checkpoint persists the
// diarized segments keyed by noteId AFTER transcription succeeds and BEFORE the
// Gemini summary call, so a retry carrying the same noteId reuses them instead
// of paying AssemblyAI again. Keyed by noteId (not jobId) so it survives across
// job retries -- the mobile client reuses noteId when it retries. This is a
// durable checkpoint on the existing job model, not a redesign of it.
interface TranscriptCheckpoint {
  segments: TranscriptSegment[];
  audioDurationSeconds: number | null;
  detectedLanguage: 'en' | 'ko' | null;
}

async function loadTranscriptCheckpoint(noteId: string, userId: string): Promise<TranscriptCheckpoint | null> {
  const { data, error } = await supabase
    .from('workflow_transcript_checkpoint')
    .select('segments, audio_duration_seconds, detected_language')
    .eq('note_id', noteId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    // Fail-soft: a missing table (migration not applied) or any read error must
    // not break the pipeline. Fall back to a fresh transcription.
    console.warn(`Could not load transcript checkpoint for note ${noteId}: ${error.message}`);
    return null;
  }
  if (!data) return null;
  const row = data as { segments: unknown; audio_duration_seconds: unknown; detected_language: unknown };
  if (!Array.isArray(row.segments) || row.segments.length === 0) return null;
  const detected = row.detected_language;
  return {
    segments: row.segments as TranscriptSegment[],
    audioDurationSeconds: typeof row.audio_duration_seconds === 'number' ? row.audio_duration_seconds : null,
    detectedLanguage: detected === 'en' || detected === 'ko' ? detected : null,
  };
}

async function saveTranscriptCheckpoint(input: { noteId: string; userId: string } & TranscriptCheckpoint): Promise<void> {
  const { error } = await supabase
    .from('workflow_transcript_checkpoint')
    .upsert({
      note_id: input.noteId,
      user_id: input.userId,
      segments: input.segments,
      audio_duration_seconds: input.audioDurationSeconds,
      detected_language: input.detectedLanguage,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'note_id' });
  if (error) {
    // Best-effort: a checkpoint write failure must not fail an otherwise-healthy
    // transcription. Worst case we re-transcribe on a retry (the pre-fix behavior).
    console.warn(`Could not persist transcript checkpoint for note ${input.noteId}: ${error.message}`);
  }
}

async function deleteTranscriptCheckpoint(noteId: string): Promise<void> {
  const { error } = await supabase
    .from('workflow_transcript_checkpoint')
    .delete()
    .eq('note_id', noteId);
  if (error) {
    // Best-effort cleanup; a leftover checkpoint is harmless (it is only read on a
    // retry for the same noteId, which the persisted note already short-circuits).
    console.warn(`Could not delete transcript checkpoint for note ${noteId}: ${error.message}`);
  }
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
  // FIX 2: reuse a persisted transcript if a prior attempt for this noteId already
  // paid AssemblyAI (summary failed, or the process restarted mid-job). Any miss
  // falls through to a fresh transcription, so this is safe with or without the
  // checkpoint table present.
  const checkpoint = await loadTranscriptCheckpoint(input.noteId, input.userId);
  let segments: TranscriptSegment[];
  let audioDurationSeconds: number | null;
  let detectedLanguage: 'en' | 'ko' | null;
  if (checkpoint) {
    console.log(`Reusing persisted transcript checkpoint for note ${input.noteId} (${checkpoint.segments.length} segments); skipping re-transcription.`);
    segments = checkpoint.segments;
    audioDurationSeconds = checkpoint.audioDurationSeconds;
    detectedLanguage = checkpoint.detectedLanguage;
  } else {
    const transcription = await transcribeWithAssembly({
      downloadUrl: input.downloadUrl,
      noteId: input.noteId,
      userId: input.userId,
      settings: transcriptionSettings,
    });
    segments = transcription.segments;
    audioDurationSeconds = transcription.audioDurationSeconds;
    detectedLanguage = transcription.detectedLanguage;
    // A completed transcription with zero segments means the audio contained no
    // detectable speech, not that the pipeline broke. Surface it as a clear,
    // localized user message (and skip the ops incident in the job handler).
    if (segments.length === 0) throw new NoSpeechDetectedError(noSpeechMessage(input.language));
    // Persist the paid transcript BEFORE the Gemini summary so a summary failure
    // or a restart from here on no longer discards it.
    await saveTranscriptCheckpoint({
      noteId: input.noteId,
      userId: input.userId,
      segments,
      audioDurationSeconds,
      detectedLanguage,
    });
  }
  const transcriptText = formatTranscriptText(segments, 'original');
  const translationLanguage = getOppositeTranscriptLanguage(detectedLanguage);
  const diarizationTranslations: Partial<Record<'en' | 'ko', TranscriptSegment[]>> = {};
  const transcriptionTranslations: Partial<Record<'en' | 'ko', string>> = {};
  // Translate the transcript to the opposite language (the bilingual-transcript feature)
  // IN PARALLEL with summary generation. The translation output feeds only insertNote
  // (storage) and is never read by the summary, so running it sequentially ahead of the
  // summary only added a fixed multi-second stall to every note. Best-effort: a
  // translation failure is logged and never fails the note. Awaited before insertNote.
  const translationPromise: Promise<void> = translationLanguage
    ? translateTranscriptSegments({
        segments,
        targetLanguage: translationLanguage,
        noteId: input.noteId,
        userId: input.userId,
      })
        .then((translatedSegments) => {
          if (translatedSegments.length > 0) {
            diarizationTranslations[translationLanguage] = translatedSegments;
            transcriptionTranslations[translationLanguage] = formatTranscriptText(translatedSegments, 'original');
          }
        })
        .catch((translationError) => {
          console.warn(`Transcript translation to ${translationLanguage} failed:`, translationError);
        })
    : Promise.resolve();
  const meetingStartAt = inferMeetingStartAt(input.meetingAt, audioDurationSeconds);
  const meetingDateForPrompt = meetingStartAt
    ? formatMeetingDateForPrompt(new Date(meetingStartAt), input.userTimeZone)
    : null;
  const attachmentParts = await buildGeminiAttachmentParts(input.attachments);
  const hasGeminiAttachments = attachmentParts.some((part) => Boolean(part.fileData));

  // F1' -> summary: inject the user's personal memory as BACKGROUND context so the summary
  // connects this meeting to their ongoing work. Best-effort (never blocks the summary);
  // buildSummaryPrompt's GROUNDING RULES forbid it from adding facts absent from the transcript.
  const personalMemoryContext = await getPersonalMemoryContext(input.userId);
  await updateWorkflowJob(jobId, { stage: 'generating summary', progress: 75 });
  const summaryRaw = await callGeminiWithFallback({
    stage: 'Summarization',
    model: env.summaryModel,
    fallbackModels: [...STANDARD_FALLBACK_CHAIN],
    responseMimeType: 'application/json',
    maxOutputTokens: 16384,
    thinkingBudget: 0,
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
          personalMemoryContext,
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
      fallbackModels: [...STANDARD_FALLBACK_CHAIN],
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
            personalMemoryContext,
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

  // The transcript translation ran in parallel with the summary; make sure it has
  // landed (or failed best-effort) before we persist, since insertNote stores it.
  await translationPromise;
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

  // FIX 2: the note (which embeds the transcript) is now durably persisted, so
  // the transcript checkpoint is no longer needed. Best-effort cleanup keeps the
  // checkpoint table small.
  await deleteTranscriptCheckpoint(input.noteId);

  // Memory fold (F1') + auto speaker-ID (F5.1) used to run here, blocking job
  // completion behind 2-3 more Gemini calls the user never waits to see. They no
  // longer affect the returned summary, so the caller now runs finalizeNoteMemory()
  // AFTER marking the job completed / sending the response (see processSummarizeJob
  // and summarizeAudio). The note itself is already persisted above.
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

// Post-summary enrichment that does NOT change the returned summary: fold the note
// into the owner's personal memory (F1' + note_insight/F4 index) and auto-identify
// speakers (F5.1). Run by the callers AFTER the job is marked completed / the response
// is sent, so the user sees the summary without waiting on these extra Gemini calls.
// Guaranteed non-throwing: each step is best-effort and the whole body is guarded, so a
// caller can await or fire-and-forget it without risk of an unhandled rejection.
async function finalizeNoteMemory(input: SummarizeAudioInput, segments: TranscriptSegment[]): Promise<void> {
  try {
    const transcriptText = formatTranscriptText(segments, 'original');
    // Fold into personal memory + write the note_insight index. Idempotent:
    // foldNoteIntoMemory skips already-folded notes, so a retry never double-counts.
    try {
      const fold = await foldNoteIntoMemory({
        supabase,
        apiKey: env.geminiApiKey,
        userId: input.userId,
        noteId: input.noteId,
        transcript: transcriptText,
        selfName: input.userName ?? null,
        // Same speaker-name hint the summary uses, so action owners resolve to real
        // names instead of "" (transcript labels are generic "Speaker A/B" at this stage).
        speakerContext: input.speakerContext || null,
      });
      console.log(`Memory fold note=${input.noteId} items=${fold.memoryItemCount} insight=${fold.insightWritten} skipped=${fold.skipped}`);
    } catch (memoryError) {
      console.warn(`Memory fold failed for note ${input.noteId}:`, memoryError);
    }

    // F5.1: auto-identify speakers and (high-confidence only) name the diarization +
    // refresh note_insight. Runs AFTER the memory fold so an auto-ID cannot flow into
    // personal memory (conservative scope).
    try {
      await autoIdentifySpeakersAtIngest({
        noteId: input.noteId,
        userId: input.userId,
        selfName: input.userName ?? null,
        segments,
      });
    } catch (identifyError) {
      console.warn(`Auto speaker identify failed for note ${input.noteId}:`, identifyError);
    }
  } catch (finalizeError) {
    console.warn(`finalizeNoteMemory failed for note ${input.noteId}:`, finalizeError);
  }
}

async function summarizeAudio(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const input = parseSummarizeInput((await readBody(req, 110_000_000)) as SummarizeAudioRequest);
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  if (tokenUserId !== input.userId) throw new Error('Authenticated user does not match request userId.');

  const result = await runSummarizeAudio(input);
  sendJson(res, 200, result);
  // Enrich after responding so the web client isn't held behind memory/speaker-ID calls.
  await finalizeNoteMemory(input, result.transcript);
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
  if (error) {
    // FIX 1 (race): two concurrent requests for the same (user_id, note_id) can
    // both pass the idempotency SELECT above and both reach this INSERT. The new
    // partial unique index (NOT applied yet -- see the migration) makes the loser
    // fail with unique_violation instead of starting a duplicate pipeline. Treat
    // that as a dedup hit and return the job the winner created. Harmless when the
    // index is absent (this branch simply never triggers).
    if (error.code === '23505') {
      const raced = await supabase
        .from('workflow_job')
        .select('id, status, stage, progress')
        .eq('user_id', input.userId)
        .eq('note_id', input.noteId)
        .in('status', ['queued', 'processing', 'completed'])
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!raced.error && raced.data) {
        const row = raced.data as { id: string; status: WorkflowJobRow['status']; stage: string | null; progress: number | null };
        sendJson(res, 202, {
          jobId: row.id,
          status: row.status,
          stage: row.stage ?? row.status,
          progress: row.progress ?? 0,
          deduplicated: true,
        });
        return;
      }
    }
    throw error;
  }
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
    const marked = await updateWorkflowJob(jobId, {
      status: 'completed',
      stage: 'completed',
      progress: 100,
      result,
      error: null,
    }, { retries: 4 });
    if (!marked) {
      // FIX 1: the note is already persisted (runSummarizeAudio inserted it), but
      // the terminal 'completed' write failed after all retries, leaving the job
      // at 'processing'. Do not re-run anything: the periodic orphan sweep
      // reconciles this job to 'completed' from the existing note once it goes
      // stale. Surface it so the divergence is observable.
      console.warn(`Workflow job ${jobId} completed but its terminal status write failed; the note is persisted and the orphan sweep will reconcile it.`);
    }
    completedJobResults.set(jobId, result);
    // Post-completion enrichment (memory fold + speaker-ID). Runs after the job is
    // marked completed so the client sees the summary immediately; awaited here so the
    // work still finishes in-process (heartbeat keeps the row fresh). Never throws.
    await finalizeNoteMemory(input, result.transcript);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A no-speech recording is a normal user outcome, not a system failure: mark
    // the job failed so the user sees the guidance message, but do not log it as
    // an error or raise an ops incident (that would be pure noise).
    if (error instanceof NoSpeechDetectedError) {
      console.log(`Workflow job ${jobId} ended with no detectable speech in the audio; surfacing to the user without an incident.`);
    } else {
      console.error(`Workflow job ${jobId} failed:`, error);
      void raiseIncident({
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
    }
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

  // F1' -> regenerate: inject the NOTE OWNER's personal memory (not the requester's) so a
  // regenerated summary keeps the same cross-meeting context a fresh one gets, and a shared
  // user regenerating never leaks their own memory into someone else's note. Best-effort.
  const personalMemoryContext = await getPersonalMemoryContext(
    typeof note.user_id === 'string' ? note.user_id : undefined,
  );

  const result = await callGeminiWithFallback({
    stage: 'Summary regeneration',
    model: env.regenerateSummaryModel,
    fallbackModels: [...STANDARD_FALLBACK_CHAIN],
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
        personalMemoryContext,
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
      // Attribute the fold + note_insight write to the NOTE OWNER, never the
      // requester. A share recipient may regenerate (access check above allows
      // shared_users), but the memory/index must stay the owner's: writing under
      // the requester would fold the owner's content into the recipient's memory
      // and flip note_insight.user_id, costing the owner their own index under RLS.
      userId: typeof note.user_id === 'string' ? note.user_id : '',
      noteId: input.noteId,
      transcript: formatTranscriptText(input.segments, 'original'),
      selfName: null,
      // Speaker ontology profiles double as the owner-attribution hint on regenerate.
      speakerContext: typeof input.speakerProfiles === 'string'
        ? input.speakerProfiles
        : (Array.isArray(input.speakerProfiles) && input.speakerProfiles.length > 0
            ? JSON.stringify(input.speakerProfiles)
            : null),
    });
  } catch (memoryError) {
    console.warn(`Memory fold (regenerate) failed for note ${input.noteId}:`, memoryError);
  }
}

// F5.1: at ingest, auto-name speakers ONLY in the reliable SINGLE-speaker case (a solo
// recording = the owner's own voice, named deterministically below). Multi-speaker self
// auto-apply was REMOVED 2026-08-25: a read-only measurement (eval/self-autoapply-precision.ts)
// found it only ~60% precise at conf>=0.8-0.9 with NO safe note-size bucket, so ~40% of the time
// it stamped a TEAMMATE's label as the owner and corrupted note_insight owner attribution (the
// "wrong-self" error class, root-caused via eval/speaker-diagnose.ts — the one confusion type a
// self-only policy does NOT protect against). Multi-speaker naming is now human-in-the-loop via
// the Suggest sheet (client-side identify, self guess pre-checked for one-tap confirmation).
// Re-extracts note_insight from the named transcript; does NOT re-fold personal memory (the fold
// above kept generic labels, so a misID can't corrupt memory). Best-effort.

async function autoIdentifySpeakersAtIngest(input: {
  noteId: string;
  userId: string;
  selfName: string | null;
  segments: TranscriptSegment[];
}): Promise<void> {
  if (!env.geminiApiKey) return;
  const { noteId, userId, selfName, segments } = input;
  const anonLabels = Array.from(new Set(segments.map((s) => s.speaker).filter((name) => /^speaker\s/i.test(name))));
  if (anonLabels.length === 0) return;

  // Single-speaker note = the owner's own recording, so the one voice IS the self. Name it
  // deterministically instead of asking the model, which abstains on a context-free monologue
  // (no vocatives / self-intro / interaction-role signals to reason from). Skips the Gemini
  // call entirely. Needs the owner's name; without it we leave the label for a manual rename.
  if (anonLabels.length === 1) {
    if (!selfName?.trim()) return;
    await applyNamedSpeakers(noteId, userId, segments, new Map([[anonLabels[0], selfName.trim()]]));
    return;
  }

  // Multi-speaker note: do NOT auto-identify or auto-apply "self" at ingest (see the header
  // comment for the measured rationale — ~60% precision, no safe note-size bucket, ~40%
  // wrong-self corruption). The Suggest sheet handles multi-speaker naming with the user in the
  // loop. This also skips a Gemini identify call whose only ingest purpose was the self apply.
}

// Apply resolved speaker names to a note's diarization and re-extract note_insight from the
// named transcript (so owners/participants resolve to real people). Shared by the ingest
// auto-identify paths (single-speaker self-naming + multi-speaker identification).
async function applyNamedSpeakers(
  noteId: string,
  userId: string,
  segments: TranscriptSegment[],
  nameByLabel: Map<string, string>,
): Promise<void> {
  if (nameByLabel.size === 0) return;
  const namedSegments = segments.map((seg) => {
    const name = nameByLabel.get(seg.speaker);
    return name ? { ...seg, speaker: name } : seg;
  });
  const { error: updateError } = await supabase.from('note').update({ diarization: namedSegments }).eq('id', noteId);
  if (updateError) {
    console.warn(`Diarization update failed for note ${noteId}: ${updateError.message}`);
    return;
  }
  await extractAndStoreInsight({
    supabase,
    apiKey: env.geminiApiKey,
    userId,
    noteId,
    transcript: formatTranscriptText(namedSegments, 'original'),
    speakerContext: buildSpeakerContextFromSegments(namedSegments),
  });
  console.log(`Auto-named ${nameByLabel.size} speaker(s) for note ${noteId}: ${Array.from(nameByLabel.values()).join(', ')}`);
}

// Step-2 (memory value surface): the deterministic MEETING BRIEFING for the records tab.
// Assembles, with NO LLM (cost 0, drift 0), two robust memory-derived views scoped to the
// authenticated user: (1) durable cross-meeting context from user_memory (active items),
// (2) recent MEETING-LEVEL decisions/events from note_insight for the newest notes. It
// deliberately OMITS action items / owner attribution — those depend on speaker-ID, which is
// measured-unreliable, so surfacing "your commitments" here would amplify a weak signal.
const BRIEFING_MEMORY_LIMIT = 8;
const BRIEFING_RECENT_NOTES = 8;
const BRIEFING_MAX_PER_NOTE = 6;

interface BriefingDecision { text: string; rationale: string }
interface BriefingEvent { cause: string; effect: string }
interface BriefingRecentNote {
  noteId: string;
  noteName: string;
  date: string;
  decisions: BriefingDecision[];
  events: BriefingEvent[];
}

function briefingStr(value: unknown, max = 400): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function coerceBriefingDecisions(raw: unknown): BriefingDecision[] {
  if (!Array.isArray(raw)) return [];
  const out: BriefingDecision[] = [];
  for (const d of raw) {
    const o = d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
    const text = briefingStr(o.text);
    if (!text) continue;
    out.push({ text, rationale: briefingStr(o.rationale) });
    if (out.length >= BRIEFING_MAX_PER_NOTE) break;
  }
  return out;
}

function coerceBriefingEvents(raw: unknown): BriefingEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: BriefingEvent[] = [];
  for (const e of raw) {
    const o = e && typeof e === 'object' ? (e as Record<string, unknown>) : {};
    const cause = briefingStr(o.cause);
    const effect = briefingStr(o.effect);
    if (!cause && !effect) continue;
    out.push({ cause, effect });
    if (out.length >= BRIEFING_MAX_PER_NOTE) break;
  }
  return out;
}

async function meetingBriefing(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Auth: derive the user from the Microsoft Graph token; never trust a client-supplied id.
  const userId = await getMicrosoftUserId(getBearerToken(req));

  // (1) durable cross-meeting context (active user_memory items).
  const { data: memRow, error: memError } = await supabase
    .from('user_memory')
    .select('memory')
    .eq('user_id', userId)
    .maybeSingle();
  if (memError) throw memError;
  const memoryItems: BriefingMemoryItem[] = renderMemoryItemsForBriefing(
    (memRow as { memory?: unknown } | null)?.memory ?? null,
    BRIEFING_MEMORY_LIMIT,
  );

  // (2) recent MEETING-LEVEL decisions/events from the user's own newest notes. Owner-free
  // by construction (no actions column read), so speaker-ID accuracy cannot corrupt it.
  const { data: noteRows, error: noteError } = await supabase
    .from('note')
    .select('id, name, meeting_at, created_at')
    .eq('user_id', userId)
    .order('meeting_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(BRIEFING_RECENT_NOTES);
  if (noteError) throw noteError;
  const notes = (noteRows ?? []) as { id: string; name?: unknown; meeting_at?: unknown; created_at?: unknown }[];
  const noteIds = notes.map((n) => n.id).filter((id): id is string => typeof id === 'string' && id.length > 0);

  const insightByNote = new Map<string, { decisions?: unknown; events?: unknown }>();
  if (noteIds.length) {
    const { data: insightRows, error: insightError } = await supabase
      .from('note_insight')
      .select('note_id, decisions, events')
      .in('note_id', noteIds);
    if (insightError) throw insightError;
    for (const row of (insightRows ?? []) as { note_id?: unknown; decisions?: unknown; events?: unknown }[]) {
      if (typeof row.note_id === 'string') insightByNote.set(row.note_id, { decisions: row.decisions, events: row.events });
    }
  }

  const recent: BriefingRecentNote[] = [];
  for (const n of notes) {
    const ins = insightByNote.get(n.id);
    const decisions = coerceBriefingDecisions(ins?.decisions);
    const events = coerceBriefingEvents(ins?.events);
    if (!decisions.length && !events.length) continue; // skip notes with nothing meeting-level to show
    recent.push({
      noteId: n.id,
      noteName: briefingStr(n.name, 200) || 'Untitled',
      date: briefingStr(n.meeting_at, 40) || briefingStr(n.created_at, 40),
      decisions,
      events,
    });
  }

  sendJson(res, 200, { memoryItems, recent, generatedAt: new Date().toISOString() });
}

// F5.0: re-extract note_insight for a note from its NAMED diarization, so action owners
// and participant names resolve to real people after a speaker rename. Insight-only — it
// does NOT re-fold personal memory (that path is idempotent per note and needs a
// supersede design; deferred). Auth mirrors regenerate-summary (Microsoft Graph token,
// owner-or-shared access).
async function refreshNoteInsight(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  const body = (await readBody(req, 1_000_000)) as { noteId?: unknown } | null;
  const noteId = typeof body?.noteId === 'string' ? body.noteId.trim() : '';
  if (!noteId) {
    sendJson(res, 400, { error: 'noteId is required.' });
    return;
  }

  const { data: noteRow, error: noteError } = await supabase
    .from('note')
    .select('id, user_id, shared_users, diarization, transcription')
    .eq('id', noteId)
    .maybeSingle();
  if (noteError) throw noteError;
  if (!noteRow) {
    sendJson(res, 404, { error: 'Note not found.' });
    return;
  }
  const note = noteRow as { user_id?: unknown; shared_users?: unknown; diarization?: unknown; transcription?: unknown };
  const ownerId = typeof note.user_id === 'string' ? note.user_id : '';
  const sharedUsers = Array.isArray(note.shared_users) ? note.shared_users.map((value) => String(value)) : [];
  if (ownerId !== tokenUserId && !sharedUsers.includes(tokenUserId)) {
    sendJson(res, 403, { error: 'You do not have access to this note.' });
    return;
  }
  if (!env.geminiApiKey) throw new Error('Gemini API key is missing.');

  // Prefer the named diarization (real speaker names) over the frozen "Speaker A/B"
  // transcription column — that asymmetry is why owners were unattributed before.
  const segments = Array.isArray(note.diarization)
    ? (note.diarization as unknown[])
        .filter((segment): segment is Record<string, unknown> => Boolean(segment) && typeof segment === 'object' && !Array.isArray(segment))
        .map(normalizeTranscriptSegment)
        .filter((segment): segment is TranscriptSegment => Boolean(segment))
    : [];
  const transcript = segments.length
    ? formatTranscriptText(segments, 'original')
    : (typeof note.transcription === 'string' ? note.transcription : '');
  if (!transcript.trim()) {
    sendJson(res, 422, { error: 'Note has no transcript to index.' });
    return;
  }

  const result = await extractAndStoreInsight({
    supabase,
    apiKey: env.geminiApiKey,
    userId: ownerId,
    noteId,
    transcript,
    speakerContext: buildSpeakerContextFromSegments(segments),
  });
  if (!result.ok) {
    sendJson(res, 502, { error: `Insight extraction failed: ${result.reason ?? 'unknown'}` });
    return;
  }
  sendJson(res, 200, { ok: true, noteId });
}

// ── F2: feedback / issue tracker: AI resolution + server-side notification mail ──────
// Rules (permissions, recipients, templates, schema) live in ./issues.ts; these handlers do
// the I/O. Spec: docs/feedback-issues-porting-prompt.md sections 3.7, 3.9, 7.1, 9.

const ISSUE_ATTACHMENT_BUCKET = 'feedback-attachments';
// Spec 1.4 says 30 days; shortened to 24 hours after the 2026-10-15 security review so a
// forwarded mail does not keep screenshots open for a month. The deep-link button (which
// re-signs on open) is the primary way back to the issue.
const ISSUE_MAIL_URL_TTL_SECONDS = 24 * 60 * 60;

function strArray(v: unknown, cap = 12): string[] {
  return (Array.isArray(v) ? v : []).map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).slice(0, cap);
}

// Lenient parse kept for the F9 ops agent's RCA (system tickets); the human issue path
// uses the strict validateResolution() from ./issues.ts.
function parseIssueResolution(raw: string): {
  summary: string; rootCauses: string[]; checks: string[]; fixPlan: string[]; verification: string[]; confidence: 'low' | 'medium' | 'high';
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonCodeFences(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  if (!summary) return null;
  const conf = typeof o.confidence === 'string' ? o.confidence.toLowerCase() : '';
  const confidence = conf === 'high' || conf === 'medium' ? conf : 'low';
  return {
    summary,
    rootCauses: strArray(o.rootCauses),
    checks: strArray(o.checks),
    fixPlan: strArray(o.fixPlan),
    verification: strArray(o.verification),
    confidence,
  };
}

// AI-4: up to 3 image attachments, read from the private bucket with the service role and
// handed to Gemini inline. The paths come from the issue ROW in the DB (looked up by
// issueKey), never from the request body, and must pass isSafeAttachmentPath, so a caller
// cannot point the service role at another object. The spec's 15-minute signed URL is the
// alternative; inline bytes need no URL at all.
async function issueAttachmentImageParts(issueKey: string): Promise<Array<{ inlineData: { mimeType: string; data: string } }>> {
  const parts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
  if (!ISSUE_KEY_PATTERN.test(issueKey)) return parts;
  const { data: row, error: rowError } = await supabase
    .from('feedback_issues')
    .select('attachments')
    .eq('issue_key', issueKey)
    .is('deleted_at', null)
    .maybeSingle();
  if (rowError) throw rowError;
  const paths = imageAttachmentPaths((row as { attachments?: unknown } | null)?.attachments, 3);
  for (const path of paths) {
    try {
      const { data, error } = await supabase.storage.from(ISSUE_ATTACHMENT_BUCKET).download(path);
      if (error || !data) continue;
      const mimeType = data.type || 'image/png';
      if (!mimeType.startsWith('image/')) continue;
      const buffer = Buffer.from(await data.arrayBuffer());
      if (buffer.length > 8 * 1024 * 1024) continue;
      parts.push({ inlineData: { mimeType, data: buffer.toString('base64') } });
    } catch (error) {
      console.warn(`Issue attachment fetch failed (${path}):`, error);
    }
  }
  return parts;
}

// Section 7.1. Order: method, issues.triage, input, LLM, response. Always JSON.
// The endpoint never writes the DB (AI-3); the browser saves the result with triage rights.
async function issueResolution(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'POST 요청만 받습니다.' });
    return;
  }
  const caller = await getMicrosoftProfile(getBearerToken(req));
  if (!canIssue(caller.id, 'issues.triage')) {
    sendJson(res, 403, { error: '해결책 생성은 관리자 권한이 필요합니다.' });
    return;
  }
  const parsed = parseResolutionRequest(await readBody(req, 200_000));
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }
  if (!env.geminiApiKey) throw new Error('Gemini API key is missing.');
  const request = parsed.value;
  const imageParts = await issueAttachmentImageParts(request.issueKey);
  const result = await callGeminiWithFallback({
    stage: 'Issue resolution',
    model: liteModelFromEnv('ISSUE_RESOLUTION_MODEL', process.env.ISSUE_RESOLUTION_MODEL, ISSUE_RESOLUTION_MODEL),
    fallbackModels: [...ISSUE_RESOLUTION_FALLBACK_CHAIN],
    responseMimeType: 'application/json',
    responseSchema: ISSUE_RESOLUTION_SCHEMA,
    maxOutputTokens: 16000,
    // docs/API_LESSONS.md: thinking tokens eat the output budget and truncate JSON on lite models.
    thinkingBudget: 0,
    parts: [...imageParts, { text: `${ISSUE_RESOLUTION_SYSTEM_PROMPT}\n\n${buildResolutionUserText(request)}` }],
  });
  const resolution = validateResolution(result.text);
  if (!resolution) {
    sendJson(res, 502, { error: '해결책 응답이 지정한 형식과 맞지 않습니다. 다시 생성해 주세요.' });
    return;
  }
  sendJson(res, 200, { resolution, model: result.model });
}

// APP_FRONTEND_ORIGIN may be a comma-separated CORS list: the first origin is the mail link
// base. With '*' or nothing set, links stay relative (they do not open from a mail client).
let warnedRelativeDeepLink = false;
function issueDeepLink(issueKey: string): string {
  const origin = firstFrontendOrigin(process.env.APP_FRONTEND_ORIGIN);
  if (!origin && !warnedRelativeDeepLink) {
    warnedRelativeDeepLink = true;
    console.warn('APP_FRONTEND_ORIGIN is "*" or unset: issue mail deep links are relative and will not open from a mail client.');
  }
  return `${origin}/issues?issue=${encodeURIComponent(issueKey)}`;
}

async function readNotifyRecipients(): Promise<RecipientsRead> {
  const { data, error } = await supabase.from('issue_notify_recipients').select('email');
  if (error) {
    const missing = error.code === '42P01' || error.code === 'PGRST205' || /could not find|does not exist/i.test(error.message ?? '');
    console.warn(`Issue notify recipients unreadable (${missing ? 'missing table' : 'error'}): ${error.message}`);
    return missing ? { status: 'missing_table' } : { status: 'error' };
  }
  const emails = ((data as Array<{ email?: unknown }>) ?? [])
    .map((r) => (typeof r.email === 'string' ? r.email : ''))
    .filter(Boolean);
  return { status: 'ok', emails };
}

/** Issues the author filed in the last hour (soft-deleted ones count too). */
// Counted by author_id (the object id; an email can be shared by several accounts). Rows
// without author_id (filed before 20261015120000) fall back to the email count.
async function countAuthorIssuesLastHour(row: Pick<IssueRow, 'author_id' | 'author_email'>): Promise<number> {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const authorId = row.author_id?.trim().toLowerCase();
  const query = supabase
    .from('feedback_issues')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', hourAgo);
  const pattern = row.author_email.replace(/[\\%_]/g, (c) => `\\${c}`); // exact, case-insensitive match
  const { count, error } = authorId
    ? await query.eq('author_id', authorId)
    : await query.ilike('author_email', pattern);
  if (error) throw error;
  return count ?? 0;
}

async function sendIssueMail(kind: NotifyKind, row: IssueRow, to: string[], actor: { name: string | null; email: string }): Promise<void> {
  try {
    const paths = imageAttachmentPaths(row.attachments);
    let imageUrls: string[] = [];
    if (paths.length > 0 && kind !== 'resolved') {
      const { data } = await supabase.storage.from(ISSUE_ATTACHMENT_BUCKET).createSignedUrls(paths, ISSUE_MAIL_URL_TTL_SECONDS);
      imageUrls = (data ?? []).map((d) => d.signedUrl).filter((u): u is string => Boolean(u));
    }
    const mail = buildIssueMail({ kind, row, actor, imageUrls, deepLink: issueDeepLink(row.issue_key) });
    const sent = await sendEmail({ to, subject: mail.subject, html: mail.html });
    if (!sent) console.warn(`Issue mail (${kind}) for ${row.issue_key} was not sent.`);
  } catch (error) {
    // NOTIFY-4: best effort, log only.
    console.warn(`Issue mail (${kind}) for ${row.issue_key} failed:`, error);
  }
}

// N1 / N2 / N3. The body names an event and an issue key only; recipients and content come
// from the DB row (the old endpoint mailed client-supplied text to client-supplied addresses).
// Mobile still posts { kind: 'created', issueKey, ...legacy fields }; the extra fields are ignored.
async function issueNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const caller = await getMicrosoftProfile(getBearerToken(req));
  const body = (await readBody(req, 200_000)) as Record<string, unknown> | null;
  const kind = parseNotifyKind(body?.kind);
  const issueKey = typeof body?.issueKey === 'string' ? body.issueKey.trim() : '';
  if (!kind || !ISSUE_KEY_PATTERN.test(issueKey)) {
    sendJson(res, 400, { error: 'kind 와 issueKey 가 필요합니다.' });
    return;
  }
  const { data, error } = await supabase
    .from('feedback_issues')
    .select('issue_key, title, description, purpose, area, status, priority, assignee_email, assignee_name, triage_note, resolution, attachments, author_email, author_name, author_id, created_at, deleted_at')
    .eq('issue_key', issueKey)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    sendJson(res, 404, { error: '이슈를 찾을 수 없습니다.' });
    return;
  }
  const row = data as IssueRow;
  const createdRecipients = kind === 'created' ? resolveNotifyEmails(await readNotifyRecipients()) : [];
  const decision = decideNotify({ kind, row, caller: { id: caller.id, email: caller.email }, createdRecipients, now: Date.now() });
  if (!decision.ok) {
    sendJson(res, decision.status, { error: decision.error });
    return;
  }
  if (kind === 'created') {
    const recent = await countAuthorIssuesLastHour(row);
    if (recent > CREATED_MAIL_LIMIT_PER_HOUR) {
      console.warn(`Issue mail (created) for ${row.issue_key} skipped: ${recent} issues by this author in the last hour (limit ${CREATED_MAIL_LIMIT_PER_HOUR}).`);
      sendJson(res, 429, { error: '최근 1시간 동안 등록이 많아 알림 메일을 보내지 않았습니다.' });
      return;
    }
  }
  // CREATE-11: answer with the confirmed recipients first, then send in the background.
  sendJson(res, 200, { ok: true, notifiedEmails: decision.to });
  // The new-issue mail goes out once per issue. NOTE: this dedupe is in-memory, so it resets
  // when the server restarts / redeploys; the 15-minute window and the hourly author cap
  // above bound what a retry can do across restarts.
  if (kind === 'created') {
    if (createdIssueMailSent.has(row.issue_key)) return;
    if (createdIssueMailSent.size >= CREATED_MAIL_DEDUPE_MAX) createdIssueMailSent.clear();
    createdIssueMailSent.add(row.issue_key);
  }
  if (decision.to.length > 0) void sendIssueMail(kind, row, decision.to, { name: caller.name, email: caller.email });
}

// Bounded (Power of Ten rule 8); entries only matter inside the 15-minute created window.
const CREATED_MAIL_DEDUPE_MAX = 1000;
const createdIssueMailSent = new Set<string>();

// ---------------------------------------------------------------------------
// F9 — Autonomous ops agent (v1: detect → RCA draft → F2 ticket, human-gated)
//
// Every workflow alert (job failure, 500, uncaught/unhandled) is also handed to
// this agent, which drafts a root-cause analysis with the SAME structured LLM
// path the human issue-resolution endpoint uses (ISSUE_RESOLUTION_SCHEMA), then
// files an ops-tagged ticket on the existing F2 `feedback_issues` board and
// emails the on-call. It NEVER touches prod code — remediation stays human
// (auto-fix is deferred to F9.2). Repeats of the same failure are de-duped by
// fingerprint so a flapping error updates one ticket instead of flooding the
// board. This function is fully self-contained and MUST NOT reject: it runs off
// the alert path (incl. process.uncaughtException), so a throw here would loop
// back through the same alert handler. All failures are swallowed with a warn.
// ---------------------------------------------------------------------------

const F9_ENABLED = (process.env.F9_OPS_AGENT_ENABLED ?? 'true').toLowerCase() !== 'false';
const OPS_AGENT_AUTHOR_EMAIL = 'ops-agent@tecace.com';
const OPS_AGENT_AUTHOR_NAME = 'Ops Agent (F9)';
const OPS_INCIDENT_THROTTLE_MS = 24 * 60 * 60 * 1000; // one open ticket per signature per 24h
// Storm cap: max NEW ops tickets (= distinct failure classes) filed per rolling hour.
// De-dup already collapses identical failures; this bounds an incident STORM of many
// DIFFERENT classes (e.g. a bad deploy 500-ing every endpoint) so it cannot flood the
// board, the on-call inbox, OR the Gemini bill (each new ticket = one RCA call). Over
// the cap, new classes are dropped with a warn (existing tickets still de-dup/bump).
const OPS_MAX_NEW_TICKETS_PER_HOUR = Number(process.env.F9_MAX_NEW_TICKETS_PER_HOUR || '10');

const OPS_RCA_SYSTEM_PROMPT = `너는 사내 "Meeting Note"(회의 녹음 → AI 전사·요약·메모리·검색 앱) 백엔드를 운영하는 시니어 SRE다.
스택: Node workflow-server(Render)에서 Gemini 호출, DB Supabase(Postgres + RLS + Storage), 전사 AssemblyAI, 인증 Azure MSAL, 프론트 React/Vite, 모바일 Flutter.
운영 중 발생한 장애 알림(에러 + 컨텍스트)을 읽고 담당 엔지니어가 바로 착수할 수 있는 근본원인 분석(RCA)을 작성한다. 규칙:
- 한국어로, 각 배열 원소는 한 문장씩. 실행 가능한 내용만 쓴다.
- rootCauses 는 스택/메시지/컨텍스트를 근거로, 확인되지 않은 가설임을 전제로 가능성이 높은 순서로 쓴다.
- checks 는 담당자가 로그/DB/대시보드에서 실제로 조회하거나 재현해 볼 절차로 쓴다.
- fixPlan 은 손대야 할 위치와 방향을 순서대로 쓴다. 확실하지 않은 파일명을 지어내지 않는다.
- verification 은 수정 후 무엇이 어떻게 보이면 해결로 볼 수 있는지 쓴다.
- 정보가 부족하면 추측을 늘리지 말고 confidence 를 "low"로 두고 checks 에 무엇을 더 확인해야 하는지 적는다.
- confidence 는 정확히 "low" | "medium" | "high" 중 하나.`;

function opsEnvironment(): string {
  return process.env.RENDER_SERVICE_NAME || process.env.NODE_ENV || 'development';
}

/**
 * Find an open (non-DONE/CLOSED, non-deleted) ops ticket for this fingerprint within the
 * throttle window. Matches the fingerprint SERVER-SIDE (`ai_suggestion->>fingerprint`) so
 * de-dup is exact regardless of how many open ops tickets exist — a JS scan of a capped
 * row window could miss a match beyond the cap during a storm and file a duplicate.
 */
async function findOpenOpsTicket(fingerprint: string): Promise<{ id: string; meta: OpsSuggestionMeta } | null> {
  const cutoff = new Date(Date.now() - OPS_INCIDENT_THROTTLE_MS).toISOString();
  const { data, error } = await supabase
    .from('feedback_issues')
    .select('id, ai_suggestion, status, created_at')
    .eq('area', 'ops')
    .like('issue_key', 'OPS-%')
    .is('deleted_at', null)
    .not('status', 'in', '(DONE,CLOSED)')
    .gte('created_at', cutoff)
    .eq('ai_suggestion->>source', 'f9-ops-agent')
    .eq('ai_suggestion->>fingerprint', fingerprint)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw error;
  // matchOpsTicket re-validates source/fingerprint on the (already-filtered) rows — cheap
  // belt-and-suspenders that also narrows unknown[] to the typed meta.
  return matchOpsTicket((data as Array<{ id: string; ai_suggestion: unknown }>) ?? [], fingerprint);
}

/** Count NEW ops tickets filed in the last rolling hour (area='ops' rows are F9's alone). */
async function countRecentOpsTickets(): Promise<number> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('feedback_issues')
    .select('id', { count: 'exact', head: true })
    .eq('area', 'ops')
    .like('issue_key', 'OPS-%')
    .is('deleted_at', null)
    .gte('created_at', oneHourAgo);
  if (error) throw error;
  return count ?? 0;
}

async function generateOpsRca(detail: string): Promise<{ resolution: ReturnType<typeof parseIssueResolution>; model: string } | null> {
  if (!env.geminiApiKey) return null;
  const result = await callGeminiWithFallback({
    stage: 'Ops RCA',
    model: env.summaryModel,
    fallbackModels: [...STANDARD_FALLBACK_CHAIN],
    responseMimeType: 'application/json',
    responseSchema: ISSUE_RESOLUTION_SCHEMA,
    maxOutputTokens: 4096,
    parts: [{ text: `${OPS_RCA_SYSTEM_PROMPT}\n\n장애 알림:\n${detail}\n\n위 장애에 대한 RCA를 지정된 JSON 스키마로만 작성하라.` }],
  });
  return { resolution: parseIssueResolution(result.text), model: result.model };
}

async function fileOpsIncident(input: WorkflowAlertInput): Promise<void> {
  if (!F9_ENABLED) return;
  if (!env.supabaseUrl || !env.serviceRoleKey) return; // no DB → nothing to file
  try {
    const severity: 'error' | 'warning' = input.severity === 'warning' ? 'warning' : 'error';
    const rawErr = formatAlertError(input.error);
    const err = { name: rawErr.name, message: rawErr.message, stack: rawErr.stack };
    const context = sanitizeAlertContext(input.context);
    const fingerprint = incidentFingerprint(input.title, err.name, err.message);
    const nowIso = new Date().toISOString();

    // De-dup: a repeat of the same failure only bumps the existing ticket's counter.
    // Only `ai_suggestion` (display-only agent metadata) is updated — NOT `triage_note`,
    // which is human-authored and must not be clobbered by an automatic recurrence note.
    const existing = await findOpenOpsTicket(fingerprint);
    if (existing) {
      const meta = bumpOccurrence(existing.meta, nowIso);
      const { error: updateError } = await supabase
        .from('feedback_issues')
        .update({ ai_suggestion: meta })
        .eq('id', existing.id);
      if (updateError) throw updateError;
      return;
    }

    // Storm cap: a new failure class, but if too many NEW ops tickets were filed this
    // hour, drop it (warn only) rather than flooding the board/inbox/Gemini bill. Placed
    // AFTER de-dup so recurring known failures still bump their ticket during a storm.
    const recentCount = await countRecentOpsTickets();
    if (recentCount >= OPS_MAX_NEW_TICKETS_PER_HOUR) {
      console.warn(`F9: ops ticket rate cap reached (${recentCount}/${OPS_MAX_NEW_TICKETS_PER_HOUR} this hour) — dropping new incident "${input.title}" (fingerprint ${fingerprint}).`);
      return;
    }

    // New failure class → draft an RCA and open a ticket.
    const contextText = Object.keys(context).length ? JSON.stringify(context, null, 2) : '(없음)';
    const detail = buildOpsIncidentDetail({ title: input.title, severity, environment: opsEnvironment(), err, contextText });

    let resolution: ReturnType<typeof parseIssueResolution> = null;
    let resolutionModel: string | null = null;
    try {
      const rca = await generateOpsRca(detail);
      resolution = rca?.resolution ?? null;
      resolutionModel = rca?.model ?? null;
    } catch (rcaError) {
      console.warn('F9 ops RCA generation failed (filing ticket without RCA):', rcaError);
    }

    const issueKey = makeOpsIssueKey(new Date(), randomBytes(4).toString('hex'));
    const { priority, severity: ticketSeverity } = opsSeverityToPriority(severity);
    const meta: OpsSuggestionMeta = {
      source: 'f9-ops-agent',
      fingerprint,
      occurrences: 1,
      firstSeen: nowIso,
      lastSeen: nowIso,
      environment: opsEnvironment(),
      severity,
    };
    const description = buildOpsTicketDescription({ title: input.title, err, contextText });

    const { error: insertError } = await supabase.from('feedback_issues').insert({
      issue_key: issueKey,
      title: `[운영] ${input.title}`.slice(0, 200),
      description,
      purpose: 'bug',
      area: 'ops',
      status: 'OPEN',
      priority,
      severity: ticketSeverity,
      ai_suggestion: meta,
      resolution: resolution ?? null,
      resolution_generated_at: resolution ? nowIso : null,
      resolution_model: resolutionModel,
      author_email: OPS_AGENT_AUTHOR_EMAIL,
      author_name: OPS_AGENT_AUTHOR_NAME,
    });
    if (insertError) throw insertError;

    // Notify the on-call. Reuses the F2 email renderer so ops tickets read like any issue.
    const { html } = buildIssueMail({
      kind: 'created',
      row: {
        issue_key: issueKey,
        title: `[운영] ${input.title}`,
        description,
        purpose: 'bug',
        area: 'ops',
        status: 'OPEN',
        priority,
        assignee_email: null,
        assignee_name: null,
        triage_note: null,
        resolution,
        attachments: [],
        author_email: OPS_AGENT_AUTHOR_EMAIL,
        author_name: OPS_AGENT_AUTHOR_NAME,
        created_at: nowIso,
      },
      actor: { name: OPS_AGENT_AUTHOR_NAME, email: OPS_AGENT_AUTHOR_EMAIL },
      imageUrls: [],
      deepLink: issueDeepLink(issueKey),
      includeResolution: true,
    });
    await sendEmail({ to: alertRecipients(), subject: `[운영 장애] ${issueKey} ${input.title}`, html });
  } catch (fileError) {
    // Never rethrow — this runs off the alert path (incl. uncaughtException), so a
    // throw would re-enter the alert handler and loop.
    console.warn('F9 fileOpsIncident failed:', fileError);
  }
}

/** Emit an ops alert: the existing email PLUS an F9 RCA ticket. Fire-and-forget, never throws. */
function raiseIncident(input: WorkflowAlertInput): void {
  void sendWorkflowAlert(input);
  void fileOpsIncident(input);
}

// F4 backfill: populate note_insight for existing notes (insight only, no memory
// fold). Admin-gated and batched — call repeatedly until `processed` is 0. Each
// call pulls a batch of notes still lacking a note_insight row (server-side filter
// via notes_needing_insight) and extracts one row each.
// Admins allowed to run maintenance backfills (validated via the Microsoft Graph
// token, same as the other workflow-server endpoints).
const INSIGHT_BACKFILL_ADMIN_IDS = new Set<string>([
  '31d79bfe-2488-47c2-aa45-949375e93bde', // Andrew (andrewyoo@tecace.com)
]);

async function backfillInsight(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  if (!tokenUserId || !INSIGHT_BACKFILL_ADMIN_IDS.has(tokenUserId)) {
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
  const sampleFailures: string[] = [];
  for (const note of notes) {
    try {
      const result = await extractAndStoreInsight({
        supabase,
        apiKey: env.geminiApiKey,
        userId: note.user_id,
        noteId: note.id,
        transcript: note.transcription ?? '',
      });
      if (result.ok) {
        written += 1;
      } else {
        failed += 1;
        if (sampleFailures.length < 5 && result.reason) sampleFailures.push(`${note.id.slice(0, 8)}: ${result.reason}`);
      }
    } catch (backfillError) {
      failed += 1;
      if (sampleFailures.length < 5) sampleFailures.push(`${note.id.slice(0, 8)}: threw ${(backfillError as Error).message.slice(0, 160)}`);
      console.warn(`Backfill insight failed for note ${note.id}:`, backfillError);
    }
  }

  sendJson(res, 200, { processed: notes.length, written, failed, sampleFailures });
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

const handleMeetingKnowledgeRequest = createMeetingKnowledgeHttpHandler(createMeetingKnowledgeStore({
  // Bound each new integration RPC independently of existing long workflow jobs.
  rpc: (name, args) => supabase.rpc(name, args).abortSignal(AbortSignal.timeout(2_000)),
}), process.env);

export const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // New private routes own their CORS, credential checks and content-free errors.
    if (await handleMeetingKnowledgeRequest(req, res, url)) return;
    if (req.method === 'OPTIONS') {
      sendNoContent(res);
      return;
    }
    // MCP server, merged into this process (formerly its own Render web service).
    // Owns /mcp, /mcp-chatgpt, /.well-known/oauth-protected-resource*, and /admin/*
    // dashboard routes; returns false (falls through) for everything else,
    // including /health and /version which this host owns.
    if (await handleMcpRequest(req, res, url)) return;
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
        // 'enforced' = ALLOWED_MS_TENANT_IDS is set (no value is exposed). Post-deploy check.
        msTenantGate: tenantGateMode(),
        // 'log-only' until MS_TOKEN_REQUIRE_KNOWN_CLIENT=true (appid / azp check).
        msClientGate: clientGateMode(),
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
    if (await handleTranscriptionTestRequest(req, res)) return;
    if (req.method === 'POST' && req.url === '/admin/backfill-insight') {
      await backfillInsight(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/regenerate-summary') {
      await regenerateSummary(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/refresh-note-insight') {
      await refreshNoteInsight(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/meeting-briefing') {
      await meetingBriefing(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/product-docs') {
      await getProductDocsIndexRoute(req, res);
      return;
    }
    const productDocMatch = url.pathname.match(/^\/product-docs\/([a-z0-9-]+)$/);
    if (req.method === 'GET' && productDocMatch?.[1]) {
      await getProductDocRoute(req, res, productDocMatch[1]);
      return;
    }
    if (url.pathname === '/issue-resolution') {
      await issueResolution(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/issue-notify') {
      await issueNotify(req, res);
      return;
    }
    if (await handleProjectChatRequest(req, res)) return;
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
      void raiseIncident({
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

// Jobs run in-process via fire-and-forget, so a crash/redeploy leaves their
// rows stuck at 'queued'/'processing' forever and clients poll for the full
// hour. On boot, fail such rows that have gone stale (older than the orphan
// threshold) so clients get a prompt, retryable error. The staleness guard
// (backed by the per-job heartbeat) prevents sweeping a live job owned by an
// overlapping instance during a zero-downtime deploy.
// Cap how many stale jobs one sweep reconciles so a pathological backlog cannot
// unbound the per-note existence query or the per-job recovery updates.
const MAX_ORPHAN_RECONCILE = 200;

// FIX 1 (convergence): rebuild a job result from a note that was already
// persisted. Lets a stranded job be recovered to 'completed' instead of 'failed',
// so the client never retries (and never spawns a duplicate pipeline) for work
// that already finished. Selected with '*' and read defensively so historical
// schema drift (missing translation / duration columns) cannot break recovery.
function reconstructResultFromNote(noteRow: Record<string, unknown>): SummarizeAudioResult {
  const summaryTranslations = (noteRow.summary_translations ?? {}) as Record<'en' | 'ko', string>;
  const transcriptionTranslations = (noteRow.transcription_translations ?? {}) as Partial<Record<'en' | 'ko', string>>;
  const diarizationTranslations = (noteRow.diarization_translations ?? {}) as Partial<Record<'en' | 'ko', TranscriptSegment[]>>;
  const detected = noteRow.transcription_language;
  return {
    transcript: Array.isArray(noteRow.diarization) ? (noteRow.diarization as TranscriptSegment[]) : [],
    summary: typeof noteRow.summary === 'string' ? noteRow.summary : '',
    summaryTranslations,
    transcriptionLanguage: detected === 'en' || detected === 'ko' ? detected : null,
    transcriptionTranslations,
    diarizationTranslations,
    title: typeof noteRow.name === 'string' ? noteRow.name : '',
    tags: Array.isArray(noteRow.tags) ? (noteRow.tags as string[]) : [],
    audioDurationSeconds: typeof noteRow.duration_seconds === 'number' ? noteRow.duration_seconds : null,
    meetingStartAt: typeof noteRow.meeting_at === 'string' ? noteRow.meeting_at : null,
  };
}

async function failOrphanedJobs(): Promise<void> {
  if (!env.supabaseUrl || !env.serviceRoleKey) return;
  const cutoff = new Date(Date.now() - ORPHANED_JOB_THRESHOLD_MS).toISOString();
  const { data, error } = await supabase
    .from('workflow_job')
    .select('id, user_id, note_id')
    .in('status', ['queued', 'processing'])
    .lt('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    .limit(MAX_ORPHAN_RECONCILE);
  if (error) {
    console.warn(`Could not scan for orphaned workflow jobs: ${error.message}`);
    return;
  }
  const rows = (data ?? []) as Array<{ id: string; user_id: string | null; note_id: string | null }>;
  if (rows.length === 0) return;

  // FIX 1 (convergence): a stranded job whose note was already persisted (the
  // 'completed' status write failed after the note insert succeeded) must NOT be
  // marked 'failed' -- that prompts the client to retry and spawn a second full
  // transcribe+summary run, duplicating the note and double-billing. Recover such
  // jobs to 'completed' from the existing note; fail only the rest.
  const noteIds = Array.from(new Set(rows.map((row) => row.note_id).filter((id): id is string => Boolean(id))));
  const notesById = new Map<string, Record<string, unknown>>();
  if (noteIds.length > 0) {
    const { data: noteData, error: noteError } = await supabase
      .from('note')
      .select('*')
      .in('id', noteIds);
    if (noteError) {
      // If the note lookup fails we cannot safely recover; fall back to the
      // original fail-all behavior rather than leaving jobs stranded.
      console.warn(`Could not look up notes while reconciling orphaned jobs: ${noteError.message}`);
    } else {
      for (const note of (noteData ?? []) as Array<Record<string, unknown>>) {
        if (typeof note.id === 'string') notesById.set(note.id, note);
      }
    }
  }

  const recoverable: Array<{ jobId: string; note: Record<string, unknown> }> = [];
  const failedIds: string[] = [];
  for (const row of rows) {
    const note = row.note_id ? notesById.get(row.note_id) : undefined;
    // Only recover when the note belongs to the same user as the job.
    if (note && (typeof note.user_id !== 'string' || note.user_id === row.user_id)) {
      recoverable.push({ jobId: row.id, note });
    } else {
      failedIds.push(row.id);
    }
  }

  for (const { jobId, note } of recoverable) {
    const recovered = await updateWorkflowJob(jobId, {
      status: 'completed',
      stage: 'completed',
      progress: 100,
      result: reconstructResultFromNote(note),
      error: null,
    }, { retries: 2 });
    if (!recovered) {
      // Could not converge to 'completed'; fail it so the client is not left
      // polling forever. The persisted note remains intact either way.
      failedIds.push(jobId);
    }
  }
  if (recoverable.length > 0) {
    console.log(`Recovered ${recoverable.length} orphaned workflow job(s) to completed from an existing note.`);
  }

  if (failedIds.length === 0) return;
  const { error: updateError } = await supabase
    .from('workflow_job')
    .update({
      status: 'failed',
      stage: 'failed',
      error: 'Server restarted while this job was running. Please try again.',
      updated_at: new Date().toISOString(),
    })
    .in('id', failedIds);
  if (updateError) {
    console.warn(`Could not fail ${failedIds.length} orphaned workflow job(s): ${updateError.message}`);
    return;
  }
  console.log(`Marked ${failedIds.length} orphaned workflow job(s) as failed.`);
}

// Importing this module only constructs the handler.
// Production startup stays explicit so tests can own all process resources.
export function startServer(options: { port?: number; host?: string; dispatcher?: Dispatcher } = {}): () => Promise<void> {
  if (server.listening) throw new Error('Workflow server is already listening.');
  const previousDispatcher = getGlobalDispatcher();
  const dispatcher = options.dispatcher ?? new Agent({
    headersTimeout: env.fetchHeadersTimeoutMs,
    bodyTimeout: env.fetchBodyTimeoutMs,
  });
  setGlobalDispatcher(dispatcher);
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  const workerStops: Array<() => void> = [];
  const onRejection = (error: unknown) => {
    console.error('Unhandled workflow rejection:', error);
    void raiseIncident({
      title: 'Unhandled workflow rejection',
      error,
      context: { source: 'process.unhandledRejection' },
    });
  };

  const onException = (error: Error) => {
    console.error('Uncaught workflow exception:', error);
    void raiseIncident({
      title: 'Uncaught workflow exception',
      error,
      context: { source: 'process.uncaughtException' },
    });
  };

  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    server.off('close', cleanup);
    server.off('error', cleanup);
    if (sweepTimer) clearInterval(sweepTimer);
    for (const stopWorker of workerStops.splice(0)) stopWorker();
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
    setGlobalDispatcher(previousDispatcher);
    if (dispatcher !== previousDispatcher) void dispatcher.close();
  };
  server.once('close', cleanup);
  server.once('error', cleanup);
  server.listen(options.port ?? env.port, options.host ?? env.listenHost, () => {
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : options.port ?? env.port;
    console.log(`Meeting Note workflow server listening on :${port}`);
    console.log(`Workflow env: transcription=assemblyai:${ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL}:no-language-settings, summary=${env.summaryModel}, headersTimeout=${env.fetchHeadersTimeoutMs}, bodyTimeout=${env.fetchBodyTimeoutMs}`);
    void failOrphanedJobs();
    sweepTimer = setInterval(() => void failOrphanedJobs(), ORPHANED_JOB_SWEEP_INTERVAL_MS);
    // Existing transcription and MCP startup remain independent of this opt-in.
    if (process.env.MEETING_KNOWLEDGE_DELIVERY_ENABLED === 'true') {
      try {
        if (!env.supabaseUrl || !env.serviceRoleKey) throw new Error('CONFIG_UNAVAILABLE');
        const stopDelivery = startMeetingKnowledgeDelivery(createMeetingOutboxStore({
          rpc: (name, args) => supabase.rpc(name, args).abortSignal(AbortSignal.timeout(5_000)),
        }), {
          MEETING_KNOWLEDGE_DELIVERY_ENABLED: process.env.MEETING_KNOWLEDGE_DELIVERY_ENABLED,
          MEETING_KNOWLEDGE_AXKH_URL: process.env.MEETING_KNOWLEDGE_AXKH_URL,
          MEETING_KNOWLEDGE_INGEST_KEY: process.env.MEETING_KNOWLEDGE_INGEST_KEY,
          MEETING_KNOWLEDGE_ACCESS_KEY: process.env.MEETING_KNOWLEDGE_ACCESS_KEY,
          MEETING_KNOWLEDGE_TENANT_ID: process.env.MEETING_KNOWLEDGE_TENANT_ID,
          MEETING_KNOWLEDGE_NOTE_BASE_URL: process.env.MEETING_KNOWLEDGE_NOTE_BASE_URL,
          MEETING_KNOWLEDGE_TIMEZONE: process.env.MEETING_KNOWLEDGE_TIMEZONE,
        });
        workerStops.push(stopDelivery);
      } catch {
        // Never print endpoint, secret, source data or upstream diagnostics.
        console.warn('Meeting knowledge delivery: CONFIG_UNAVAILABLE');
      }
    }
    if (process.env.MEETING_KNOWLEDGE_EXTRACTION_ENABLED === 'true') {
      try {
        if (!env.supabaseUrl || !env.serviceRoleKey || !env.geminiApiKey
          || process.env.MEETING_KNOWLEDGE_DELIVERY_ENABLED !== 'true') throw new Error('CONFIG_UNAVAILABLE');
        // Unset keeps extraction unconfigured; a set but non-lite value falls back to the lite default (DEC-0005).
        if (!process.env.MEETING_KNOWLEDGE_EXTRACTION_MODEL?.trim()) throw new Error('CONFIG_UNAVAILABLE');
        const model = liteModelFromEnv('MEETING_KNOWLEDGE_EXTRACTION_MODEL', process.env.MEETING_KNOWLEDGE_EXTRACTION_MODEL, KNOWLEDGE_EXTRACTION_MODEL);
        const stopExtraction = startMeetingExtractionWorker(createMeetingExtractionStore({
          rpc: (name, args) => supabase.rpc(name, args).abortSignal(AbortSignal.timeout(5_000)),
        }), {
          MEETING_KNOWLEDGE_EXTRACTION_ENABLED: process.env.MEETING_KNOWLEDGE_EXTRACTION_ENABLED,
          MEETING_KNOWLEDGE_TENANT_ID: process.env.MEETING_KNOWLEDGE_TENANT_ID,
          MEETING_KNOWLEDGE_EXTRACTION_MODEL: model,
          MEETING_KNOWLEDGE_EXTRACTION_MAX_CHUNKS: process.env.MEETING_KNOWLEDGE_EXTRACTION_MAX_CHUNKS,
        }, {
          generate: createGeminiMeetingGenerator({ apiKey: env.geminiApiKey, model }),
          authorizeModel: createMeetingModelPolicyClient({
            MEETING_KNOWLEDGE_EXTRACTION_ENABLED: process.env.MEETING_KNOWLEDGE_EXTRACTION_ENABLED,
            MEETING_KNOWLEDGE_AXKH_URL: process.env.MEETING_KNOWLEDGE_AXKH_URL,
            MEETING_KNOWLEDGE_MODEL_POLICY_KEY: process.env.MEETING_KNOWLEDGE_MODEL_POLICY_KEY,
            MEETING_KNOWLEDGE_INGEST_KEY: process.env.MEETING_KNOWLEDGE_INGEST_KEY,
            MEETING_KNOWLEDGE_ACCESS_KEY: process.env.MEETING_KNOWLEDGE_ACCESS_KEY,
            MEETING_KNOWLEDGE_TENANT_ID: process.env.MEETING_KNOWLEDGE_TENANT_ID,
            MEETING_KNOWLEDGE_EXTRACTION_MODEL: model,
          }),
        });
        workerStops.push(stopExtraction);
      } catch {
        console.warn('Meeting knowledge extraction: CONFIG_UNAVAILABLE');
      }
    }
  });
  return () => new Promise<void>((resolveStop, rejectStop) => {
    server.close((error) => error ? rejectStop(error) : resolveStop());
    server.closeIdleConnections();
  });
}

let isDirectExecution = false;
if (process.argv[1]) {
  try {
    isDirectExecution = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // Missing or inaccessible paths cannot establish direct execution.
    // Keep imports inert rather than failing while resolving an entrypoint.
  }
}
if (isDirectExecution) {
  startServer();
}
