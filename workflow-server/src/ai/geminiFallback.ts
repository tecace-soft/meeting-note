import { env } from '../config/env.js';
import { callGemini, dedupeModels, isRetryableGeminiError, type GeminiUsageMetadata } from '../gemini.js';

export interface GeminiWorkflowCallResult {
  text: string;
  model: string;
  usageMetadata: GeminiUsageMetadata;
  latencyMs: number;
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Transient Gemini failures (429/5xx/network) get a few backoff retries on the
// SAME model before falling back, so a rate-limit blip mid-demo does not kill
// the whole summarize job.
export const MAX_GEMINI_TRANSIENT_RETRIES = 3;

export async function callGeminiWithFallback(input: {
  stage: string;
  model: string;
  fallbackModels: string[];
  parts: Parameters<typeof callGemini>[0]['parts'];
  responseMimeType?: 'application/json' | 'text/plain';
  responseSchema?: unknown;
  maxOutputTokens?: number;
  // When set (e.g. 0), disables model "thinking" so latency isn't spent on
  // reasoning tokens. The summary/translation calls emit plain JSON and gain
  // nothing from thinking, so we pass 0 to cut a fixed per-call latency floor.
  thinkingBudget?: number;
}): Promise<GeminiWorkflowCallResult> {
  const models = dedupeModels([input.model, ...input.fallbackModels]);
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
          responseSchema: input.responseSchema,
          maxOutputTokens: input.maxOutputTokens,
          thinkingBudget: input.thinkingBudget,
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
        const retryable = isRetryableGeminiError(error);
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
