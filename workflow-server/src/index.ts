import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { config as loadDotenv } from 'dotenv';
import { Agent, setGlobalDispatcher } from 'undici';
import { calculateGeminiUsageCost } from './costs.js';
import { callGemini, type GeminiUsageMetadata } from './gemini.js';
import { buildNoteName, formatMeetingDateForPrompt, parseSummary, formatTranscriptText, type TranscriptSegment } from './parsers.js';
import { buildSummaryPrompt } from './prompts.js';
import { sendWorkflowAlert } from './alerts.js';

const workflowDir = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv({ path: join(workflowDir, '.env') });

interface SummarizeAudioRequest {
  downloadUrl?: unknown;
  fileName?: unknown;
  instructions?: unknown;
  promptId?: unknown;
  userId?: unknown;
  userName?: unknown;
  noteId?: unknown;
  meetingAt?: unknown;
  userTimeZone?: unknown;
  fileId?: unknown;
  speakerContext?: unknown;
  language?: unknown;
}

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
  summaryModel: process.env.GEMINI_SUMMARY_MODEL ?? 'gemini-2.5-flash-lite',
  assemblyAiSpeechModel: process.env.ASSEMBLYAI_SPEECH_MODEL ?? 'universal-3-pro',
  assemblyAiPricePerHourUsd: Number(process.env.ASSEMBLYAI_TRANSCRIPTION_PRICE_PER_HOUR_USD ?? '0.21'),
  frontendOrigin: process.env.APP_FRONTEND_ORIGIN ?? '*',
  port: Number(process.env.PORT ?? '8787'),
  fetchHeadersTimeoutMs: Number(process.env.WORKFLOW_FETCH_HEADERS_TIMEOUT_MS ?? '1200000'),
  fetchBodyTimeoutMs: Number(process.env.WORKFLOW_FETCH_BODY_TIMEOUT_MS ?? '1200000'),
};

const ASSEMBLYAI_CODE_SWITCHING_MODELS = ['universal-2'] as const;
const ASSEMBLYAI_CODE_SWITCHING_MODEL_LABEL = ASSEMBLYAI_CODE_SWITCHING_MODELS.join('+');
const ASSEMBLYAI_CODE_SWITCHING_LANGUAGE_CODES = ['en', 'ko'] as const;

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

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).byteLength > 2_000_000) {
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

function requiredString(body: SummarizeAudioRequest, key: keyof SummarizeAudioRequest): string {
  const value = body[key];
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
    userId: requiredString(body, 'userId'),
    userName: typeof body.userName === 'string' ? body.userName.trim() : '',
    noteId: requiredString(body, 'noteId'),
    meetingAt: meetingAt && !Number.isNaN(meetingAt.getTime()) ? meetingAt.toISOString() : null,
    userTimeZone,
    fileId: typeof body.fileId === 'string' && body.fileId.trim() ? body.fileId.trim() : null,
    instructions: typeof body.instructions === 'string' ? body.instructions : '',
    speakerContext: typeof body.speakerContext === 'string' ? body.speakerContext : '',
    language: body.language === 'ko' ? 'ko' : 'en',
  };
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
  userId: string;
  userName: string;
  noteId: string;
  meetingAt: string | null;
  userTimeZone: string | null;
  fileId: string | null;
  speakerContext: string;
  language: 'en' | 'ko';
}

interface SummarizeAudioResult {
  transcript: TranscriptSegment[];
  summary: string;
  summaryTranslations?: Record<'en' | 'ko', string>;
  title: string;
  tags: string[];
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
    try {
      console.log(`${input.stage}: calling Gemini model ${model}`);
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
      if (!isMissingModel) {
        throw new Error(`${input.stage}: ${message}`);
      }
      console.warn(`${input.stage}: Gemini model ${model} unavailable, trying fallback if configured. ${message}`);
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
  summary: string;
  summaryTranslations: Record<'en' | 'ko', string>;
  title: string;
  tags: string[];
  segments: TranscriptSegment[];
  meetingAt: string | null;
  fileId: string | null;
}): Promise<void> {
  const { error } = await supabase.from('note').insert({
    transcription: input.transcriptText,
    summary: input.summary,
    summary_translations: input.summaryTranslations,
    user_id: input.userId,
    user_name: input.userName,
    id: input.noteId,
    audio_file: input.downloadUrl,
    name: input.title,
    tags: input.tags,
    diarization: input.segments,
    meeting_at: input.meetingAt,
    audio_file_id: input.fileId,
  });
  if (error) throw error;
}

async function transcribeWithAssembly(input: {
  downloadUrl: string;
  noteId: string;
  userId: string;
  settings: TranscriptionSettings;
  language: 'en' | 'ko';
}): Promise<{ segments: TranscriptSegment[]; latencyMs: number }> {
  if (!env.assemblyAiApiKey) throw new Error('ASSEMBLYAI_API_KEY is missing.');
  const startedAt = performance.now();
  const submitBody: Record<string, unknown> = {
    audio_url: input.downloadUrl,
    speaker_labels: true,
    speech_models: [...ASSEMBLYAI_CODE_SWITCHING_MODELS],
    language_codes: [...ASSEMBLYAI_CODE_SWITCHING_LANGUAGE_CODES],
    speech_understanding: {
      request: {
        translation: {
          target_languages: [input.language],
          match_original_utterance: true,
        },
      },
    },
  };
  if (input.settings.keytermsPrompt.length > 0) {
    submitBody.keyterms_prompt = input.settings.keytermsPrompt;
  }
  if (input.settings.customSpelling.length > 0) {
    submitBody.custom_spelling = input.settings.customSpelling;
  }
  console.log('AssemblyAI transcript submit config:', JSON.stringify({
    speech_models: submitBody.speech_models,
    language_codes: submitBody.language_codes,
    language_detection: submitBody.language_detection,
    language_detection_options: submitBody.language_detection_options,
    translationTargets: [input.language],
    translationMatchOriginalUtterance: true,
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
  while (performance.now() - startedAt < timeoutMs) {
    await delay(3000);
    const pollResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(created.id)}`, {
      headers: { Authorization: env.assemblyAiApiKey },
    });
    const pollRaw = await pollResponse.text();
    if (!pollResponse.ok) {
      throw new Error(`AssemblyAI transcript poll failed (${pollResponse.status}): ${pollRaw.slice(0, 800)}`);
    }
    transcript = JSON.parse(pollRaw) as Record<string, unknown>;
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
  const audioDurationSeconds = typeof transcript.audio_duration === 'number'
    ? transcript.audio_duration
    : typeof transcript.audio_duration_seconds === 'number'
      ? transcript.audio_duration_seconds
      : utteranceDurationSeconds;
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
    model: ASSEMBLYAI_CODE_SWITCHING_MODEL_LABEL,
    latencyMs,
    transcriptId: created.id.trim(),
    audioDurationSeconds,
  });
  return { segments, latencyMs };
}

async function updateWorkflowJob(jobId: string | null, patch: {
  status?: WorkflowJobRow['status'];
  stage?: string;
  progress?: number;
  result?: unknown;
  error?: string | null;
}): Promise<void> {
  if (!jobId) return;
  const { error } = await supabase.from('workflow_job').update({
    ...patch,
    updated_at: new Date().toISOString(),
  }).eq('id', jobId);
  if (error) console.warn(`Could not update workflow job ${jobId}: ${error.message}`);
}

async function runSummarizeAudio(input: SummarizeAudioInput, jobId: string | null = null): Promise<SummarizeAudioResult> {
  if (!env.supabaseUrl || !env.serviceRoleKey) throw new Error('Supabase service configuration is missing.');
  if (!env.geminiApiKey) throw new Error('Gemini API key is missing.');
  if (!env.assemblyAiApiKey) throw new Error('AssemblyAI API key is missing.');

  await updateWorkflowJob(jobId, { status: 'processing', stage: 'loading inputs', progress: 10 });
  const summaryRules = await loadSummaryPrompt(input.promptId, input.userId);
  const transcriptionSettings = await loadTranscriptionSettings();
  console.log(`Processing audio ${input.fileName} with AssemblyAI Korean-English code switching models ${ASSEMBLYAI_CODE_SWITCHING_MODEL_LABEL}`);

  await updateWorkflowJob(jobId, { stage: 'transcribing audio', progress: 25 });
  const { segments } = await transcribeWithAssembly({
    downloadUrl: input.downloadUrl,
    noteId: input.noteId,
    userId: input.userId,
    settings: transcriptionSettings,
    language: input.language,
  });
  if (segments.length === 0) throw new Error('AssemblyAI returned no diarized transcript segments.');
  const transcriptText = formatTranscriptText(segments, input.language);
  const alternateLanguage: 'en' | 'ko' = input.language === 'ko' ? 'en' : 'ko';
  const alternateTranscriptText = formatTranscriptText(segments, alternateLanguage);
  const meetingDateForPrompt = input.meetingAt
    ? formatMeetingDateForPrompt(new Date(input.meetingAt), input.userTimeZone)
    : null;

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
        }),
      },
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
  const summaryTranslations: Record<'en' | 'ko', string> = {
    en: input.language === 'en' ? parsedSummary.summary : '',
    ko: input.language === 'ko' ? parsedSummary.summary : '',
  };

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
        }),
      },
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

  await updateWorkflowJob(jobId, { stage: 'saving note', progress: 92 });
  const noteName = buildNoteName({
    title: parsedSummary.title,
    tags: parsedSummary.tags,
    summary: parsedSummary.summary,
    createdAt: input.meetingAt ? new Date(input.meetingAt) : undefined,
    timeZone: input.userTimeZone,
  });
  await insertNote({
    noteId: input.noteId,
    userId: input.userId,
    userName: input.userName,
    downloadUrl: input.downloadUrl,
    transcriptText,
    summary: parsedSummary.summary,
    summaryTranslations,
    title: noteName,
    tags: parsedSummary.tags,
    segments,
    meetingAt: input.meetingAt,
    fileId: input.fileId,
  });

  return { transcript: segments, summary: parsedSummary.summary, summaryTranslations, title: noteName, tags: parsedSummary.tags };
}

async function summarizeAudio(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const input = parseSummarizeInput((await readBody(req)) as SummarizeAudioRequest);
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  if (tokenUserId !== input.userId) throw new Error('Authenticated user does not match request userId.');

  const result = await runSummarizeAudio(input);
  sendJson(res, 200, result);
}

async function createSummarizeJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const input = parseSummarizeInput((await readBody(req)) as SummarizeAudioRequest);
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  if (tokenUserId !== input.userId) throw new Error('Authenticated user does not match request userId.');

  const { data, error } = await supabase.from('workflow_job').insert({
    user_id: input.userId,
    note_id: input.noteId,
    type: 'summarize_audio',
    status: 'queued',
    stage: 'queued',
    progress: 0,
    request: input,
  }).select('id').single();
  if (error) throw error;
  const jobId = (data as { id?: unknown }).id;
  if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Could not create workflow job.');

  void processSummarizeJob(jobId.trim(), input);
  sendJson(res, 202, { jobId, status: 'queued', stage: 'queued', progress: 0 });
}

async function processSummarizeJob(jobId: string, input: SummarizeAudioInput): Promise<void> {
  try {
    const result = await runSummarizeAudio(input, jobId);
    await updateWorkflowJob(jobId, {
      status: 'completed',
      stage: 'completed',
      progress: 100,
      result,
      error: null,
    });
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
    });
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
        transcriptionProvider: 'assemblyai',
        transcriptionModel: ASSEMBLYAI_CODE_SWITCHING_MODEL_LABEL,
        transcriptionLanguageMode: 'ko-en-code-switching',
        summaryModel: env.summaryModel,
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/summarize-audio') {
      await summarizeAudio(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/summarize-audio/jobs') {
      await createSummarizeJob(req, res);
      return;
    }
    const jobMatch = url.pathname.match(/^\/summarize-audio\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch?.[1]) {
      await getSummarizeJob(req, res, decodeURIComponent(jobMatch[1]));
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Workflow request failed:', error);
    void sendWorkflowAlert({
      title: 'Workflow request failed',
      error,
      context: {
        method: req.method,
        url: req.url,
        status: message.includes('required') || message.includes('token') || message.includes('userId') ? 400 : 500,
      },
    });
    sendJson(res, message.includes('required') || message.includes('token') || message.includes('userId') ? 400 : 500, { error: message });
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

server.listen(env.port, () => {
  console.log(`Meeting Note workflow server listening on :${env.port}`);
  console.log(`Workflow env: transcription=assemblyai:${ASSEMBLYAI_CODE_SWITCHING_MODEL_LABEL}:ko-en-code-switching, summary=${env.summaryModel}, headersTimeout=${env.fetchHeadersTimeoutMs}, bodyTimeout=${env.fetchBodyTimeoutMs}`);
});
