/** Explicit factory only; importing/creating it performs no network request. */
import { callGemini } from '../gemini.js';
import type { ExtractionRequest, ExtractionResponse } from './extraction.js';

export interface GeminiMeetingGeneratorOptions {
  apiKey: string;
  /** A single approved plain Gemini model ID; there is no fallback or retry. */
  model: string;
  fetch?: typeof globalThis.fetch;
}
const MAX_RESPONSE_BYTES = 256 * 1024;
const MODEL = /^gemini-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function createGeminiMeetingGenerator(options: GeminiMeetingGeneratorOptions): (request: ExtractionRequest) => Promise<ExtractionResponse> {
  if (!options || typeof options.apiKey !== 'string' || !options.apiKey.trim() || options.apiKey.length > 4096
    || /[\r\n]/.test(options.apiKey) || typeof options.model !== 'string' || !MODEL.test(options.model)
    || (options.fetch !== undefined && typeof options.fetch !== 'function')) {
    throw new TypeError('INVALID_EXTRACTION_PROVIDER_CONFIG');
  }
  const { apiKey, model, fetch: fetchImplementation } = options;
  return async request => {
    try {
      if (!request || typeof request.system !== 'string' || request.system.length < 1 || request.system.length > 16384
        || typeof request.input !== 'string' || request.input.length < 1 || request.input.length > 524288
        || !(request.signal instanceof AbortSignal) || request.signal.aborted) throw new Error('MODEL_FAILED');
      const result = await callGemini({ apiKey, model, parts: [{ text: request.input }],
        systemInstruction: request.system, responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 8192,
        signal: request.signal, ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
        maxResponseBytes: MAX_RESPONSE_BYTES, redirect: 'error', allowIncompleteOutput: true });
      const usage: NonNullable<ExtractionResponse['usage']> = {};
      const mapping = [['promptTokenCount', 'inputTokens'], ['candidatesTokenCount', 'outputTokens'], ['totalTokenCount', 'totalTokens']] as const;
      for (const [native, normalized] of mapping) {
        const count = result.usageMetadata[native];
        if (count !== undefined) {
          if (!Number.isSafeInteger(count) || count < 0) throw new Error('MODEL_FAILED');
          usage[normalized] = count;
        }
      }
      return { text: result.text, model,
        // The core accepts only stop; every other native finish reason is incomplete.
        finishReason: result.finishReason === 'STOP' ? 'stop' : 'incomplete',
        ...(Object.keys(usage).length > 0 ? { usage } : {}) };
    } catch {
      // Provider diagnostics may contain request data, credentials or raw transcript.
      // Core uses its own cancellation signal and safe model-failure coverage code.
      throw new Error('MODEL_FAILED');
    }
  };
}
