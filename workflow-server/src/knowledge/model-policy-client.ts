/** Server-to-server processing approval. No transcript, audience or user identity is sent. */
import { canonicalJson, validateMeetingKnowledgeEvent, type SourceUpsertEvent } from './contract.js';
import { isCanonicalMicrosoftId } from './access-contract.js';

export interface MeetingModelPolicyEnvironment {
  MEETING_KNOWLEDGE_EXTRACTION_ENABLED?: string;
  MEETING_KNOWLEDGE_AXKH_URL?: string;
  MEETING_KNOWLEDGE_MODEL_POLICY_KEY?: string;
  MEETING_KNOWLEDGE_INGEST_KEY?: string;
  MEETING_KNOWLEDGE_ACCESS_KEY?: string;
  MEETING_KNOWLEDGE_TENANT_ID?: string;
  MEETING_KNOWLEDGE_EXTRACTION_MODEL?: string;
}
export interface MeetingModelPolicyRequest {
  tenantId: string; sourceId: string; integrationGeneration: number;
  contentRevision: number; speakerRevision: number; sourceHash: string;
  provider: 'gemini'; model: string; region: 'global'; retention: 'provider-default';
}
export class MeetingModelPolicyError extends Error {
  constructor() { super('MODEL_POLICY_UNAVAILABLE'); }
}
const MAX_BYTES = 16_384;
const TIMEOUT_MS = 2_500;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

async function readReply(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw new MeetingModelPolicyError();
  }
  if (!response.body || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel().catch(() => undefined);
    throw new MeetingModelPolicyError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (size <= MAX_BYTES) {
      if (signal.aborted) throw new MeetingModelPolicyError();
      const { done, value } = await reader.read();
      if (signal.aborted) throw new MeetingModelPolicyError();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel().catch(() => undefined); throw new MeetingModelPolicyError(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

/** Disabled factory is side-effect free. Configured policies accept Google's global/default retention explicitly. */
export function createMeetingModelPolicyClient(
  env: MeetingModelPolicyEnvironment,
  options: { fetch?: typeof fetch } = {},
): (source: SourceUpsertEvent) => Promise<boolean> {
  if (env.MEETING_KNOWLEDGE_EXTRACTION_ENABLED !== 'true') return async () => false;
  const key = env.MEETING_KNOWLEDGE_MODEL_POLICY_KEY;
  const tenantId = env.MEETING_KNOWLEDGE_TENANT_ID;
  const model = env.MEETING_KNOWLEDGE_EXTRACTION_MODEL;
  let url: URL;
  try {
    url = new URL(env.MEETING_KNOWLEDGE_AXKH_URL ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !key || key.length < 32 || key.length > 512 || !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(key)
      || key === env.MEETING_KNOWLEDGE_INGEST_KEY || key === env.MEETING_KNOWLEDGE_ACCESS_KEY
      || !isCanonicalMicrosoftId(tenantId) || !model || !MODEL.test(model)) throw new MeetingModelPolicyError();
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/integrations/meeting-note/v1/model-policy`;
  } catch { throw new MeetingModelPolicyError(); }
  const endpoint = url.toString();
  const send = options.fetch ?? fetch;
  return async source => {
    let request: MeetingModelPolicyRequest;
    try {
      const detached = validateMeetingKnowledgeEvent(JSON.parse(canonicalJson(source)));
      if (!detached.valid || detached.event.eventType !== 'source.upsert' || detached.event.tenantId !== tenantId) throw new MeetingModelPolicyError();
      const event = detached.event;
      request = { tenantId: event.tenantId, sourceId: event.sourceId, integrationGeneration: event.integrationGeneration,
        contentRevision: event.payload.contentRevision, speakerRevision: event.payload.speakerRevision,
        sourceHash: event.payload.sourceHash, provider: 'gemini', model, region: 'global', retention: 'provider-default' };
    } catch { throw new MeetingModelPolicyError(); }
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const interrupted = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new MeetingModelPolicyError()); }, TIMEOUT_MS);
      });
      const exchange = async () => {
        const response = await send(endpoint, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: canonicalJson(request), signal: controller.signal, redirect: 'error', cache: 'no-store', credentials: 'omit' });
        if (controller.signal.aborted || response.status !== 200) {
          await response.body?.cancel().catch(() => undefined); throw new MeetingModelPolicyError();
        }
        const reply = await readReply(response, controller.signal);
        if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new MeetingModelPolicyError();
        const fields = reply as Record<string, unknown>;
        if (Object.keys(fields).length !== 12 || Object.keys(fields).some(name => ![...Object.keys(request), 'allowed', 'policyRef'].includes(name))
          || Object.entries(request).some(([name, value]) => fields[name] !== value) || typeof fields.allowed !== 'boolean'
          || (fields.allowed ? typeof fields.policyRef !== 'string' || !fields.policyRef.trim() || fields.policyRef.length > 256
            || Array.from(fields.policyRef).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) : fields.policyRef !== null)) throw new MeetingModelPolicyError();
        return fields.allowed;
      };
      return await Promise.race([exchange(), interrupted]);
    } catch { throw new MeetingModelPolicyError(); }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
  };
}
