// Single source of truth for every Gemini model-name string used by the
// workflow-server. This project calls Gemini over raw fetch (there is NO
// @google/generative-ai or @google/genai SDK dependency), so model-name
// strings are the only API drift surface. A past gemini-2.0-* retirement
// returned 404 in prod and had to be hunted across many files; centralizing
// the strings here plus an offline drift test (gemini-models.test.ts) stops
// a dead id from being re-introduced and forces new ids to be registered
// consciously.
//
// Edge functions under supabase/functions are Deno and intentionally do NOT
// import this file (the Deno/Node boundary). They are covered only by the
// string scan in the drift test, which already passes because they use live
// models.

// Canonical live model ids. These two literals are the ONLY place the raw
// strings are written; every role default and chain below composes from them.
// DEC-0005 (cost rule): production may use ONLY lite-tier models. Do not add a
// non-lite id here; the drift test fails any registry entry that is not flash-lite.
export const GEMINI_2_5_FLASH_LITE = 'gemini-2.5-flash-lite';
export const GEMINI_3_1_FLASH_LITE = 'gemini-3.1-flash-lite';

// The models actually in use across the scanned surface (workflow-server/src
// and supabase/functions). The drift test validates every scanned literal
// against this set.
export const LIVE_MODELS = [
  GEMINI_3_1_FLASH_LITE,
  GEMINI_2_5_FLASH_LITE,
] as const;

export type LiveModel = (typeof LIVE_MODELS)[number];

// Fast membership set, used by the drift test and by assertLiveModel.
export const KNOWN_MODELS: ReadonlySet<string> = new Set(LIVE_MODELS);

// Known-dead ids. The gemini-2.0 family was retired and returns 404 (verified
// 2026-08-18). The explicit list is for documentation; isRetiredModel is the
// authoritative check and catches the WHOLE gemini-2.0 family, not just these.
export const RETIRED_MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.0-pro',
] as const;

// Returns true for any gemini-2.0* id. Fails safe (returns false) on non-string
// input so callers can test raw values without a guard.
export function isRetiredModel(id: string): boolean {
  if (typeof id !== 'string') return false;
  return id.trim().toLowerCase().startsWith('gemini-2.0');
}

// Role defaults with the current value from the code. Env-var overrides live at
// the call sites (e.g. process.env.GEMINI_SUMMARY_MODEL || SUMMARY_MODEL); these
// are the hardcoded defaults those overrides fall through to.
export const SUMMARY_MODEL = GEMINI_2_5_FLASH_LITE;
export const REGENERATE_SUMMARY_MODEL = GEMINI_3_1_FLASH_LITE;
export const MEMORY_MODEL = GEMINI_2_5_FLASH_LITE;
export const PROJECT_CHAT_MODEL = GEMINI_3_1_FLASH_LITE;
export const TRANSCRIPTION_TEST_MODEL = GEMINI_3_1_FLASH_LITE;
export const KNOWLEDGE_EXTRACTION_MODEL = GEMINI_3_1_FLASH_LITE;

// Failover chains (DEC-0005: lite-only, each ends in a live lite model). Order is
// load-bearing: it IS the runtime failover order. The call site passes the primary
// model separately and the chain is deduplicated against it.
export const STANDARD_FALLBACK_CHAIN = [
  GEMINI_3_1_FLASH_LITE,
  GEMINI_2_5_FLASH_LITE,
] as const;

// F2 issue resolution (workflow-server/src/issues.ts). Lite-only per the cost policy in
// docs/API_LESSONS.md; the model name lives here, in one place (spec section 7.4).
export const ISSUE_RESOLUTION_MODEL = GEMINI_2_5_FLASH_LITE;
export const ISSUE_RESOLUTION_FALLBACK_CHAIN = [
  GEMINI_3_1_FLASH_LITE,
] as const;

export const MEMORY_FALLBACK_CHAIN = [
  GEMINI_3_1_FLASH_LITE,
] as const;

// DEC-0005 env guard. Every env-driven model setting goes through this helper so a
// stale or wrong value on the host can never route production to a non-lite model.
// Never throws (a startup crash would take prod down): unset/blank silently uses the
// role default; a value that is not a live lite model in the registry logs ONE warning
// naming the env var and the rejected id, then uses the lite default.
const LITE_MODEL_PATTERN = /^gemini-\d[\d.]*-flash-lite$/;

export function isLiteModel(id: string): boolean {
  return typeof id === 'string' && LITE_MODEL_PATTERN.test(id) && KNOWN_MODELS.has(id);
}

export function liteModelFromEnv(
  envName: string,
  raw: string | undefined,
  fallback: string,
  warn: (message: string) => void = console.warn,
): string {
  const value = (raw ?? '').trim();
  if (value === '') return fallback;
  if (isLiteModel(value)) return value;
  warn(`${envName}: "${value}" is not a live lite model in the registry (DEC-0005); using the default "${fallback}".`);
  return fallback;
}

// Fail loud: throw on a retired or unknown model id so a bad value cannot
// silently reach the API. Returns the trimmed id for convenient inline use.
export function assertLiveModel(id: string): string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`assertLiveModel: expected a non-empty model id, got ${JSON.stringify(id)}`);
  }
  const normalized = id.trim();
  if (isRetiredModel(normalized)) {
    throw new Error(`assertLiveModel: model "${normalized}" is retired (the gemini-2.0 family returns 404)`);
  }
  if (!KNOWN_MODELS.has(normalized)) {
    throw new Error(`assertLiveModel: model "${normalized}" is not in the registry (LIVE_MODELS); add it to gemini-models.ts if it is a real, live model`);
  }
  return normalized;
}
