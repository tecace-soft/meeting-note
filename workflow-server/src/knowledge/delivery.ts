import { randomUUID } from 'node:crypto';
import { canonicalJson, hashPayload, sha256Text, validateMeetingKnowledgeEvent, type AccessPayload, type MeetingKnowledgeEvent, type SourcePayload, type UnitsPayload } from './contract.js';
import { isCanonicalMicrosoftId, isMeetingSourceBinding } from './access-contract.js';
import type { MeetingSourceAccessRecord } from './source-access.js';
import type { MeetingOutboxClaim, MeetingOutboxStore, MeetingDeliveryErrorCode } from './outbox.js';
import { validateMeetingOutboxSeal } from './outbox.js';

export interface MeetingDeliveryEnvironment {
  MEETING_KNOWLEDGE_DELIVERY_ENABLED?: string;
  MEETING_KNOWLEDGE_AXKH_URL?: string;
  MEETING_KNOWLEDGE_INGEST_KEY?: string;
  MEETING_KNOWLEDGE_ACCESS_KEY?: string;
  MEETING_KNOWLEDGE_TENANT_ID?: string;
  MEETING_KNOWLEDGE_NOTE_BASE_URL?: string;
  MEETING_KNOWLEDGE_TIMEZONE?: string;
}
export interface MeetingDeliveryOptions {
  fetch?: typeof fetch;
  workerId?: string;
  /** Offline loopback injection only; no environment setting bypasses HTTPS. */
  allowHttpLoopbackForTests?: boolean;
}
interface Configuration { endpoint: string; key: string; tenantId: string; noteBase: string; timezone: string }
export class MeetingDeliveryError extends Error {
  constructor(readonly code: MeetingDeliveryErrorCode) { super(code); }
}
export const MEETING_EVENT_MAX_BYTES = 1024 * 1024;
export const MEETING_RAW_SPAN_MAX_UTF16 = 8_000;
const TIMEOUT_MS = 5_000;
/** Pure positional evidence; no topic or speaker identity is inferred. */
export function rawSpans(sourceId: string, contentRevision: number, plaintext: string): SourcePayload['spans'] {
  const spans: SourcePayload['spans'] = [];
  const prefix = `raw-${sha256Text(sourceId).slice(0, 24)}-${contentRevision}`;
  for (let start = 0; start < plaintext.length;) {
    let end = Math.min(start + MEETING_RAW_SPAN_MAX_UTF16, plaintext.length);
    const before = plaintext.charCodeAt(end - 1);
    const after = plaintext.charCodeAt(end);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
    spans.push({ spanId: `${prefix}-${spans.length}`, start, end, textHash: sha256Text(plaintext.slice(start, end)) });
    start = end;
  }
  return spans;
}
function baseUrl(value: string | undefined, allowHttp: boolean): URL {
  if (!value || value !== value.trim()) throw new MeetingDeliveryError('CONFIG_UNAVAILABLE');
  let url: URL;
  try { url = new URL(value); } catch { throw new MeetingDeliveryError('CONFIG_UNAVAILABLE'); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:'
    && !(allowHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new MeetingDeliveryError('CONFIG_UNAVAILABLE');
  return url;
}
function configuration(env: MeetingDeliveryEnvironment, options: MeetingDeliveryOptions): Configuration | null {
  if (env.MEETING_KNOWLEDGE_DELIVERY_ENABLED !== 'true') return null;
  const key = env.MEETING_KNOWLEDGE_INGEST_KEY;
  const tenantId = env.MEETING_KNOWLEDGE_TENANT_ID;
  if (!key || key.length < 32 || key.length > 512 || !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(key)
    || key === env.MEETING_KNOWLEDGE_ACCESS_KEY || !isCanonicalMicrosoftId(tenantId)) throw new MeetingDeliveryError('CONFIG_UNAVAILABLE');
  const endpoint = baseUrl(env.MEETING_KNOWLEDGE_AXKH_URL, options.allowHttpLoopbackForTests === true);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/api/integrations/meeting-note/v1/events`;
  // Source links always use HTTPS, including local receiver probes.
  const noteBase = baseUrl(env.MEETING_KNOWLEDGE_NOTE_BASE_URL, false).toString();
  const timezone = env.MEETING_KNOWLEDGE_TIMEZONE ?? 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { throw new MeetingDeliveryError('CONFIG_UNAVAILABLE'); }
  return { endpoint: endpoint.toString(), key, tenantId, noteBase, timezone };
}
/** Build only from an immutable trusted database snapshot, never browser JSON. */
export function buildMeetingOutboxEvent(claim: MeetingOutboxClaim, noteBase: string, timezone: string): MeetingKnowledgeEvent {
  try {
    claim = JSON.parse(canonicalJson(claim)) as MeetingOutboxClaim;
    const record = claim.snapshot.record as MeetingSourceAccessRecord;
    if (!record || record.sourceId !== claim.sourceId || record.tenantId !== claim.tenantId
      || record.integrationGeneration !== claim.integrationGeneration) throw new Error();
    let payload: SourcePayload | AccessPayload | UnitsPayload | { lifecycleRevision: number; reason: string };
    if (claim.eventType === 'units.upsert') {
      if (!isMeetingSourceBinding(record)) throw new Error();
      payload = claim.snapshot.payload as UnitsPayload;
    } else if (claim.eventType === 'source.upsert' || claim.eventType === 'access.changed') {
      if (!isMeetingSourceBinding(record) || record.active !== true || record.integrationEnabled !== true
        || record.ownerIdentityVerified !== true || record.owner?.tenantId !== claim.tenantId || !isCanonicalMicrosoftId(record.owner.objectId)) throw new Error();
      if (claim.eventType === 'source.upsert') {
        const plaintext = claim.snapshot.plaintext;
        if (typeof plaintext !== 'string' || plaintext.length === 0 || sha256Text(plaintext) !== record.sourceHash) throw new Error();
        const sourceUrl = baseUrl(noteBase, false);
        sourceUrl.pathname = `${sourceUrl.pathname.replace(/\/$/, '')}/summary-history`;
        sourceUrl.searchParams.set('note_id', claim.sourceId);
        const rawDate = claim.snapshot.meetingAt;
        const meetingAt = typeof rawDate === 'string' && Number.isFinite(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null;
        payload = { contentRevision: record.contentRevision, speakerRevision: record.speakerRevision, sourceHash: record.sourceHash,
          title: typeof claim.snapshot.title === 'string' && claim.snapshot.title.length ? claim.snapshot.title : 'Meeting note',
          sourceUrl: sourceUrl.toString(), meetingAt, timezone, plaintext,
          spans: rawSpans(claim.sourceId, record.contentRevision, plaintext) };
      } else {
        const grants = new Map<string, AccessPayload['grants'][number]>();
        const add = (identity: {tenantId: string; objectId: string}, kind: AccessPayload['grants'][number]['kind'], evidenceRef: string) => {
          if (!identity || identity.tenantId !== claim.tenantId || !isCanonicalMicrosoftId(identity.objectId)) throw new Error();
          grants.set(`${identity.objectId}:${kind}`, { identity, kind, verification: { authority: 'meeting-note-server', evidenceRef } });
        };
        for (const participant of record.confirmedParticipants) {
          if (participant.confirmedBy.tenantId !== record.owner.tenantId || participant.confirmedBy.objectId !== record.owner.objectId) throw new Error();
          add(participant.identity, 'participant', participant.verificationRef);
        }
        for (const identity of record.directShares) add(identity, 'direct-share', `note-share:${sha256Text(claim.sourceId)}`);
        for (const project of record.projects) {
          if (project.owner.tenantId !== record.owner.tenantId || project.owner.objectId !== record.owner.objectId
            || !record.noteProjectIds.includes(project.projectId)) throw new Error();
          for (const identity of project.sharedWith) add(identity, 'project-share', `project-share:${sha256Text(project.projectId + ':' + claim.sourceId)}`);
        }
        payload = { accessRevision: record.accessRevision, grants: Array.from(grants.values()).sort((a,b) => `${a.identity.objectId}:${a.kind}`.localeCompare(`${b.identity.objectId}:${b.kind}`)), denies: record.denies };
      }
    } else {
      if (!Number.isSafeInteger(record.accessRevision) || record.accessRevision < 1) throw new Error();
      payload = { lifecycleRevision: record.accessRevision, reason: claim.eventType === 'source.deleted' ? 'source-deleted' : 'user-disabled' };
    }
    const event = { schemaVersion: 1, eventId: claim.eventId, eventSeq: claim.eventSeq, integrationGeneration: claim.integrationGeneration,
      sourceApp: 'meeting-note', sourceId: claim.sourceId, tenantId: claim.tenantId, eventType: claim.eventType, payload, payloadHash: hashPayload(payload) };
    const validated = validateMeetingKnowledgeEvent(event);
    if (!validated.valid) throw new Error();
    if (claim.eventType === 'units.upsert') return validateMeetingOutboxSeal(claim, validated.event);
    return validated.event;
  } catch { throw new MeetingDeliveryError('INVALID_SNAPSHOT'); }
}
async function readAck(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 16_384)) {
    await response.body?.cancel().catch(() => undefined);
    throw new MeetingDeliveryError('DELIVERY_FAILED');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new MeetingDeliveryError('DELIVERY_FAILED');
  const chunks: Uint8Array[] = []; let size = 0;
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (!signal.aborted) {
      if (signal.aborted) throw new Error();
      const chunk = await reader.read();
      if (signal.aborted) throw new Error();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new Error(); }
      chunks.push(chunk.value);
    }
    if (signal.aborted) throw new Error();
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk,offset);offset += chunk.byteLength;}
    return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
  } catch { throw new MeetingDeliveryError('DELIVERY_FAILED'); }
  finally {signal.removeEventListener('abort',onAbort);reader.releaseLock();}
}
export function createMeetingKnowledgeDelivery(store: MeetingOutboxStore, environment: MeetingDeliveryEnvironment, options: MeetingDeliveryOptions = {}) {
  const config = configuration(environment, options);
  const workerId = options.workerId ?? randomUUID();
  if (!isCanonicalMicrosoftId(workerId)) throw new MeetingDeliveryError('CONFIG_UNAVAILABLE');
  let running = false;
  let activeController: AbortController | null = null;
  let stopped = false;
  return {
    enabled: config !== null,
    stop() {stopped = true;activeController?.abort();},
    async runBatch(): Promise<{claimed: number; delivered: number; failed: number; lostLease: number}> {
      const stats = { claimed: 0, delivered: 0, failed: 0, lostLease: 0 };
      if (!config || running || stopped) return stats;
      running = true;
      try {
        const claims = await store.claim(config.tenantId, workerId);
        stats.claimed = claims.length;
        for (const claim of claims) {
          if (stopped) break; // Remaining durable leases are reclaimed after expiry.
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            if (claim.tenantId !== config.tenantId) throw new MeetingDeliveryError('INVALID_SNAPSHOT');
            const candidate = buildMeetingOutboxEvent(claim,config.noteBase,config.timezone);
            if (Buffer.byteLength(JSON.stringify(candidate),'utf8') > MEETING_EVENT_MAX_BYTES) throw new MeetingDeliveryError('PAYLOAD_TOO_LARGE');
            const sealed = await store.prepare(claim,workerId,candidate);
            if (sealed === null) {stats.lostLease++;continue;}
            let event: MeetingKnowledgeEvent;
            try {event = validateMeetingOutboxSeal(claim,sealed);} catch {throw new MeetingDeliveryError('INVALID_SNAPSHOT');}
            const body = JSON.stringify(event);
            if (Buffer.byteLength(body,'utf8') > MEETING_EVENT_MAX_BYTES) throw new MeetingDeliveryError('PAYLOAD_TOO_LARGE');
            if (stopped) break;
            const controller = new AbortController(); activeController = controller;
            timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
            const response = await (options.fetch ?? fetch)(config.endpoint, {method:'POST',headers:{authorization:`Bearer ${config.key}`,'content-type':'application/json',accept:'application/json'},body,cache:'no-store',redirect:'error',credentials:'omit',signal:controller.signal});
            if (response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
              await response.body?.cancel().catch(() => undefined);
              throw new MeetingDeliveryError('IMPORT_REJECTED');
            }
            const ack = await readAck(response, controller.signal) as Record<string,unknown>;
            if (!ack || typeof ack !== 'object' || Object.keys(ack).sort().join(',') !== 'eventId,eventSeq,payloadHash,status'
              || ack.eventId !== event.eventId || ack.eventSeq !== event.eventSeq || ack.payloadHash !== event.payloadHash
              || !['applied','duplicate','ignored'].includes(ack.status as string)) throw new MeetingDeliveryError('DELIVERY_FAILED');
            if (await store.ack(claim,workerId,event.payloadHash)) stats.delivered++; else stats.lostLease++;
          } catch (error) {
            if (stopped) break;
            const code = error instanceof MeetingDeliveryError ? error.code : 'DELIVERY_FAILED';
            try { if (await store.fail(claim,workerId,code)) stats.failed++; else stats.lostLease++; }
            catch {stats.failed++;} // A durable expired lease is the fallback; never discard it.
          } finally { if (timer) clearTimeout(timer);activeController = null; }
        }
        return stats;
      } finally { running = false; }
    },
  };
}

/** In-process polling schedules work; ownership, retry and ACK stay durable in SQL. */
export function startMeetingKnowledgeDelivery(store: MeetingOutboxStore, environment: MeetingDeliveryEnvironment) {
  const worker = createMeetingKnowledgeDelivery(store, environment);
  if (!worker.enabled) return () => worker.stop();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    try {await worker.runBatch();} catch { /* Store failures leave durable state untouched. */ }
    if (!stopped) {timer = setTimeout(() => {void tick();},5_000);timer.unref();}
  };
  void tick();
  return () => {stopped = true;if(timer) clearTimeout(timer);worker.stop();};
}
