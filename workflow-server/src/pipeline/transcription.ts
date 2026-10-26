// AssemblyAI transcription stage of the summarize pipeline: global transcription
// settings (keyterms, custom spelling), submit + poll + result parsing, detected
// language helpers and the best-effort transcript translation. Imports only shared
// config, db, AI and parser modules (never index.ts or routes).
import { env, ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODELS, ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL } from '../config/env.js';
import { supabase } from '../db/supabaseClient.js';
import { callGeminiWithFallback, delay } from '../ai/geminiFallback.js';
import { STANDARD_FALLBACK_CHAIN } from '../gemini-models.js';
import { parseDiarizedSegmentsWithRecovery, type TranscriptSegment } from '../parsers.js';
import { buildTranscriptTranslationPrompt } from '../prompts.js';
import { recordAssemblyUsage, recordGeminiUsage } from './usage.js';

export interface CustomSpellingRule {
  from: string[];
  to: string;
}

export interface TranscriptionSettings {
  speechModel: string;
  keytermsPrompt: string[];
  customSpelling: CustomSpellingRule[];
  summaryContext: string;
}

export function normalizeDetectedTranscriptLanguage(value: unknown): 'en' | 'ko' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace('_', '-');
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  if (normalized === 'ko' || normalized.startsWith('ko-')) return 'ko';
  return null;
}

export function getOppositeTranscriptLanguage(language: 'en' | 'ko' | null): 'en' | 'ko' | null {
  if (language === 'en') return 'ko';
  if (language === 'ko') return 'en';
  return null;
}

export function normalizeKeytermsPrompt(value: unknown): string[] {
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

export function normalizeCustomSpelling(value: unknown): CustomSpellingRule[] {
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

export async function loadTranscriptionSettings(): Promise<TranscriptionSettings> {
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

export async function transcribeWithAssembly(input: {
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

export async function translateTranscriptSegments(input: {
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
