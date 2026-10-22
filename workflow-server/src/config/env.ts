import { liteModelFromEnv, SUMMARY_MODEL, REGENERATE_SUMMARY_MODEL, TRANSCRIPTION_TEST_MODEL } from '../gemini-models.js';

export const env = {
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  geminiApiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '',
  assemblyAiApiKey: process.env.ASSEMBLYAI_API_KEY ?? '',
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  // `||` (not `??`) for values with a meaningful default: an env var set to an EMPTY
  // string must fall back to the default, not keep "". `??` only catches null/undefined,
  // so an empty GEMINI_SUMMARY_MODEL="" would 404 the model, and empty numeric vars would
  // become Number("")=0 (port 0, zero timeouts, zero price). API keys/URLs above keep `??`
  // because "" is their intended "not configured" sentinel.
  summaryModel: liteModelFromEnv('GEMINI_SUMMARY_MODEL', process.env.GEMINI_SUMMARY_MODEL, SUMMARY_MODEL),
  regenerateSummaryModel: liteModelFromEnv('GEMINI_REGENERATE_SUMMARY_MODEL', process.env.GEMINI_REGENERATE_SUMMARY_MODEL, REGENERATE_SUMMARY_MODEL),
  transcriptionTestGeminiModel: liteModelFromEnv('GEMINI_TRANSCRIPTION_TEST_MODEL', process.env.GEMINI_TRANSCRIPTION_TEST_MODEL, TRANSCRIPTION_TEST_MODEL),
  transcriptionTestOpenAiModel: process.env.OPENAI_TRANSCRIPTION_TEST_MODEL || 'gpt-4o-transcribe',
  assemblyAiSpeechModel: process.env.ASSEMBLYAI_SPEECH_MODEL || 'universal-3-pro',
  assemblyAiPricePerHourUsd: Number(process.env.ASSEMBLYAI_TRANSCRIPTION_PRICE_PER_HOUR_USD || '0.21'),
  frontendOrigin: process.env.APP_FRONTEND_ORIGIN || '*',
  port: Number(process.env.PORT || '8787'),
  // Render retains its platform host; local startup binds only IPv4 loopback.
  listenHost: process.env.WORKFLOW_HOST || (process.env.RENDER === 'true' ? undefined : '127.0.0.1'),
  fetchHeadersTimeoutMs: Number(process.env.WORKFLOW_FETCH_HEADERS_TIMEOUT_MS || '1200000'),
  fetchBodyTimeoutMs: Number(process.env.WORKFLOW_FETCH_BODY_TIMEOUT_MS || '1200000'),
};

export const ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODELS = ['universal-2'] as const;
export const ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL = ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODELS.join('+');

// Translation features are temporarily disabled to shorten processing time:
// when false, AssemblyAI skips per-utterance translation and only one summary
// (in the selected language) is generated. Flip to true to restore them.
export const TRANSLATION_ENABLED = false;
