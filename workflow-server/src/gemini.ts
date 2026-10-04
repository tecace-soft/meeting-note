interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  fileData?: {
    mimeType: string;
    fileUri: string;
  };
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  [key: string]: unknown;
}

export interface GeminiCallResult {
  text: string;
  usageMetadata: GeminiUsageMetadata;
  /** Provider metadata is optional and is not an authenticated model identity. */
  finishReason?: string;
  modelVersion?: string;
}

// HTTP statuses worth retrying: rate limiting and transient server/gateway
// errors. Everything else (400/401/403/404, blocked prompt) is a permanent
// failure that a retry would only repeat.
const TRANSIENT_GEMINI_STATUSES = new Set([429, 500, 502, 503, 504]);

export class GeminiApiError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'GeminiApiError';
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

interface GeminiGenerateContentResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GeminiUsageMetadata;
  error?: { message?: string; code?: number };
  modelVersion?: string;
}

function extractGeminiText(data: GeminiGenerateContentResponse): string {
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim() ?? '';
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal, onDiscard?: (value: T) => void): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) { void operation.then(value => { onDiscard?.(value); }, () => {}); return Promise.reject(new DOMException('Aborted', 'AbortError')); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(value => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) { onDiscard?.(value); reject(new DOMException('Aborted', 'AbortError')); } else resolve(value);
    }, error => {
      signal.removeEventListener('abort', onAbort); reject(error);
    });
  });
}

/** Optional bounded transport for sensitive callers; ordinary callers retain response.text(). */
async function readGeminiResponseText(response: Response, maximum?: number, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) { void response.body?.cancel().catch(() => {}); throw new DOMException('Aborted', 'AbortError'); }
  if (maximum === undefined) return abortable(response.text(), signal);
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > maximum) {
    void response.body?.cancel().catch(() => {}); throw new GeminiApiError('Gemini response exceeded its byte limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const text: string[] = []; let bytes = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) throw new GeminiApiError('Gemini response exceeded its byte limit');
      text.push(decoder.decode(next.value, { stream: true }));
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    text.push(decoder.decode());
    return text.join('');
  } catch (error) { cancel(); throw error; }
  finally { signal?.removeEventListener('abort', cancel); try { reader.releaseLock(); } catch { /* Cancellation can settle a pending read asynchronously. */ } }
}

export async function callGemini(input: {
  apiKey: string;
  model: string;
  parts: GeminiPart[];
  responseMimeType?: 'application/json' | 'text/plain';
  maxOutputTokens?: number;
  temperature?: number;
  // When set (e.g. 0), disables "thinking" on 2.5 models so the whole output
  // budget goes to the JSON. Thinking tokens can otherwise consume maxOutputTokens
  // and truncate structured JSON mid-object, which then fails to parse.
  thinkingBudget?: number;
  // Gemini responseSchema (OpenAPI-subset). With responseMimeType application/json
  // this forces structurally-valid JSON of the given shape, eliminating the malformed
  // / runaway JSON that otherwise fails to parse. Caller still validates semantics.
  responseSchema?: unknown;
  // Additive opt-ins for callers that need cancellation, safe transport budgets,
  // isolated instructions or offline testing. Existing callers keep their defaults.
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  maxResponseBytes?: number;
  redirect?: RequestRedirect;
  systemInstruction?: string;
  // Let strict structured-output callers inspect native incomplete/blocked results.
  allowIncompleteOutput?: boolean;
}): Promise<GeminiCallResult> {
  if (input.maxResponseBytes !== undefined && (!Number.isSafeInteger(input.maxResponseBytes) || input.maxResponseBytes < 1 || input.maxResponseBytes > 1048576)) {
    throw new GeminiApiError('Invalid Gemini response byte limit');
  }
  if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  let response: Response;
  try {
    response = await abortable((input.fetch ?? globalThis.fetch)(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
      {
        method: 'POST',
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.redirect ? { redirect: input.redirect } : {}),
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': input.apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: input.parts }],
          ...(input.systemInstruction !== undefined ? { systemInstruction: { parts: [{ text: input.systemInstruction }] } } : {}),
          generationConfig: {
            temperature: input.temperature ?? 0.2,
            maxOutputTokens: input.maxOutputTokens ?? 8192,
            responseMimeType: input.responseMimeType ?? 'application/json',
            ...(input.responseSchema !== undefined ? { responseSchema: input.responseSchema } : {}),
            ...(input.thinkingBudget !== undefined
              ? { thinkingConfig: { thinkingBudget: input.thinkingBudget } }
              : {}),
          },
        }),
      },
    ), input.signal, discarded => { void discarded.body?.cancel().catch(() => {}); });
  } catch (error) {
    // Network-level failure (DNS, reset, timeout): transient, safe to retry.
    throw new GeminiApiError(fetchErrorMessage(`Gemini generateContent fetch for ${input.model}`, error), {
      retryable: true,
    });
  }

  const text = await readGeminiResponseText(response, input.maxResponseBytes, input.signal);
  let data: GeminiGenerateContentResponse;
  try {
    data = JSON.parse(text) as GeminiGenerateContentResponse;
  } catch {
    throw new GeminiApiError(`Gemini API error (${response.status}): ${text.slice(0, 500)}`, {
      status: response.status,
      retryable: TRANSIENT_GEMINI_STATUSES.has(response.status),
    });
  }

  if (!response.ok) {
    throw new GeminiApiError(`Gemini API error (${response.status}): ${data.error?.message ?? text.slice(0, 500)}`, {
      status: response.status,
      retryable: TRANSIENT_GEMINI_STATUSES.has(response.status),
    });
  }
  if (data.error?.message) throw new Error(`Gemini API error: ${data.error.message}`);
  if (data.promptFeedback?.blockReason && !input.allowIncompleteOutput) throw new Error(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`);

  const output = extractGeminiText(data);
  if (!output && !input.allowIncompleteOutput) {
    const finishReason = data.candidates?.[0]?.finishReason;
    throw new Error(`Gemini returned empty output${finishReason ? ` (${finishReason})` : ''}.`);
  }
  return {
    text: output,
    usageMetadata: data.usageMetadata ?? {},
    ...(data.promptFeedback?.blockReason && input.allowIncompleteOutput ? { finishReason: 'PROMPT_BLOCKED' }
      : typeof data.candidates?.[0]?.finishReason === 'string' ? { finishReason: data.candidates[0].finishReason } : {}),
    ...(typeof data.modelVersion === 'string' ? { modelVersion: data.modelVersion } : {}),
  };
}

function fetchErrorMessage(stage: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && 'cause' in error ? (error as Error & { cause?: unknown }).cause : null;
  const causeMessage = cause instanceof Error ? ` Cause: ${cause.message}` : cause ? ` Cause: ${String(cause)}` : '';
  return `${stage} failed: ${message}.${causeMessage}`;
}

export async function uploadGeminiFile(input: {
  apiKey: string;
  displayName: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<{ fileUri: string; mimeType: string }> {
  let startResponse: Response;
  try {
    startResponse = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': input.apiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(input.bytes.byteLength),
        'X-Goog-Upload-Header-Content-Type': input.mimeType,
      },
      body: JSON.stringify({ file: { display_name: input.displayName } }),
    });
  } catch (error) {
    throw new Error(fetchErrorMessage('Gemini file upload start', error));
  }

  const uploadUrl = startResponse.headers.get('x-goog-upload-url');
  if (!startResponse.ok || !uploadUrl) {
    const detail = await startResponse.text().catch(() => '');
    throw new Error(`Gemini file upload start failed (${startResponse.status}): ${detail.slice(0, 500)}`);
  }

  let uploadResponse: Response;
  try {
    uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: Buffer.from(input.bytes),
    });
  } catch (error) {
    throw new Error(fetchErrorMessage('Gemini file upload finalize', error));
  }

  return parseGeminiFileUploadResponse(uploadResponse, input.mimeType);
}

export async function uploadGeminiFileStream(input: {
  apiKey: string;
  displayName: string;
  mimeType: string;
  contentLength: number;
  stream: ReadableStream<Uint8Array>;
}): Promise<{ fileUri: string; mimeType: string }> {
  let startResponse: Response;
  try {
    startResponse = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': input.apiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(input.contentLength),
        'X-Goog-Upload-Header-Content-Type': input.mimeType,
      },
      body: JSON.stringify({ file: { display_name: input.displayName } }),
    });
  } catch (error) {
    throw new Error(fetchErrorMessage('Gemini file upload stream start', error));
  }

  const uploadUrl = startResponse.headers.get('x-goog-upload-url');
  if (!startResponse.ok || !uploadUrl) {
    const detail = await startResponse.text().catch(() => '');
    throw new Error(`Gemini file upload stream start failed (${startResponse.status}): ${detail.slice(0, 500)}`);
  }

  let uploadResponse: Response;
  try {
    uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: input.stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  } catch (error) {
    throw new Error(fetchErrorMessage('Gemini file upload stream finalize', error));
  }

  return parseGeminiFileUploadResponse(uploadResponse, input.mimeType);
}

async function parseGeminiFileUploadResponse(uploadResponse: Response, inputMimeType: string): Promise<{ fileUri: string; mimeType: string }> {
  const uploadText = await uploadResponse.text();
  if (!uploadResponse.ok) {
    throw new Error(`Gemini file upload finalize failed (${uploadResponse.status}): ${uploadText.slice(0, 500)}`);
  }

  let parsed: { file?: { uri?: unknown; mimeType?: unknown; mime_type?: unknown } };
  try {
    parsed = JSON.parse(uploadText) as typeof parsed;
  } catch {
    throw new Error(`Gemini file upload returned invalid JSON: ${uploadText.slice(0, 500)}`);
  }

  const fileUri = parsed.file?.uri;
  if (typeof fileUri !== 'string' || !fileUri.trim()) {
    throw new Error('Gemini file upload did not return a file URI.');
  }
  const mimeType = typeof parsed.file?.mimeType === 'string'
    ? parsed.file.mimeType
    : typeof parsed.file?.mime_type === 'string'
      ? parsed.file.mime_type
      : inputMimeType;
  return { fileUri: fileUri.trim(), mimeType };
}
