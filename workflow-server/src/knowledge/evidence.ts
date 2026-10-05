import { sha256Text } from './contract.js';
import { rawSpans, MEETING_EVENT_MAX_BYTES } from './delivery.js';
import { checkMeetingSourceAccess, evaluateMeetingSourceAccess, type MeetingSourceAccessRecord } from './source-access.js';
import { isMeetingEvidenceFetchRequest, MEETING_EVIDENCE_MAX_RESPONSE_BYTES,
  type MeetingEvidenceFetchRequest, type MeetingEvidenceFetchResponse } from './evidence-contract.js';
import type { MeetingLiveAccessRequest } from './access-contract.js';

export interface MeetingCurrentEvidence { record: MeetingSourceAccessRecord; plaintext: string }
export interface MeetingEvidenceStore {
  loadCurrentSource(tenantId: string, sourceId: string): Promise<MeetingSourceAccessRecord | null>;
  /** The authoritative RPC checks the complete binding and audience before reading plaintext. */
  loadCurrentEvidence(request: MeetingLiveAccessRequest): Promise<MeetingCurrentEvidence | null>;
}

/** Never accepts arbitrary offsets, inferred identities, titles, URLs or model text. */
export async function fetchMeetingEvidence(request: MeetingEvidenceFetchRequest, store: MeetingEvidenceStore): Promise<MeetingEvidenceFetchResponse | null> {
  if (!isMeetingEvidenceFetchRequest(request)) return null;
  const { spanIds, ...binding } = request;
  try {
    if (!(await checkMeetingSourceAccess(binding, store.loadCurrentSource.bind(store))).allowed) return null;
    const snapshot = await store.loadCurrentEvidence(binding);
    if (!snapshot || typeof snapshot.plaintext !== 'string' || snapshot.plaintext.length === 0
      || Buffer.byteLength(snapshot.plaintext, 'utf8') > MEETING_EVENT_MAX_BYTES
      || sha256Text(snapshot.plaintext) !== binding.sourceHash
      || !Object.entries(binding).filter(([key]) => key !== 'objectId').every(([key, value]) =>
        snapshot.record[key as keyof MeetingSourceAccessRecord] === value)
      || !evaluateMeetingSourceAccess({ tenantId: binding.tenantId, objectId: binding.objectId }, snapshot.record).allowed) return null;
    const spans = new Map(rawSpans(binding.sourceId, binding.contentRevision, snapshot.plaintext).map(span => [span.spanId, span]));
    if (spanIds.some(id => !spans.has(id))) return null;
    const response = { ...binding, spans: spanIds.map(id => {
      const span = spans.get(id)!;
      return { ...span, text: snapshot.plaintext.slice(span.start, span.end) };
    }) };
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MEETING_EVIDENCE_MAX_RESPONSE_BYTES) return null;
    // Revocation/edit while loading or constructing the snippets invalidates the entire result.
    if (!(await checkMeetingSourceAccess(binding, store.loadCurrentSource.bind(store))).allowed) return null;
    return response;
  } catch { return null; }
}
