import type { IncomingMessage, ServerResponse } from 'node:http';
import { env } from '../config/env.js';
import { readBody, sendJson, getBearerToken } from '../http/shared.js';
import { getMicrosoftUserId } from '../http/identity.js';
import { callGeminiWithFallback, delay } from '../ai/geminiFallback.js';
import { uploadGeminiFile } from '../gemini.js';
import { STANDARD_FALLBACK_CHAIN } from '../gemini-models.js';
import { formatTranscriptText, parseDiarizedSegmentsWithRecovery, type TranscriptSegment } from '../parsers.js';
import { buildTranscriptRepairPrompt } from '../prompts.js';

interface TranscriptionTestRequest {
  fileName?: unknown;
  mimeType?: unknown;
  dataBase64?: unknown;
  model?: unknown;
}

type TranscriptionTestModel =
  | 'assembly_universal2_codeswitch'
  | 'assembly_universal3pro_auto'
  | 'gemini'
  | 'openai';

const ASSEMBLYAI_CODE_SWITCHING_MODELS = ['universal-2'] as const;

export const ASSEMBLYAI_CODE_SWITCHING_MODEL_LABEL = ASSEMBLYAI_CODE_SWITCHING_MODELS.join('+');

const TRANSCRIPTION_MODEL_TEST_USER_ID = 'd9eb0f3d-819e-4b45-8df6-e9f229de2447';

const OPENAI_MULTILINGUAL_TRANSCRIPTION_PROMPT = [
  'Transcribe the audio exactly as spoken in the original language or languages.',
  'Preserve code-switching and mixed-language speech instead of translating everything into one language.',
  'Use the native script for each spoken language when appropriate, but keep English words in English.',
  'Do not infer, summarize, or normalize the conversation beyond transcription.',
].join(' ');

export function parseTranscriptionTestInput(body: TranscriptionTestRequest): {
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
    fallbackModels: [...STANDARD_FALLBACK_CHAIN],
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
        fallbackModels: [...STANDARD_FALLBACK_CHAIN],
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

export async function handleTranscriptionTestRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'POST' || req.url !== '/transcription-test') return false;
  await runTranscriptionTest(req, res);
  return true;
}
