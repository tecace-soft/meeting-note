import { isMeetingLiveAccessRequest, type MeetingLiveAccessRequest } from './access-contract.js';

/** Version-bound original evidence, authenticated separately from user identity. */
export interface MeetingEvidenceFetchRequest extends MeetingLiveAccessRequest { spanIds: string[] }
export interface MeetingEvidenceSnippet {
  spanId: string;
  start: number;
  end: number;
  textHash: string;
  text: string;
}
export interface MeetingEvidenceFetchResponse extends MeetingLiveAccessRequest { spans: MeetingEvidenceSnippet[] }
export const MEETING_EVIDENCE_MAX_SPANS = 8;
export const MEETING_EVIDENCE_MAX_RESPONSE_BYTES = 256 * 1024;
export function isMeetingEvidenceFetchRequest(value: unknown): value is MeetingEvidenceFetchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { spanIds, ...binding } = value as Record<string, unknown>;
  return isMeetingLiveAccessRequest(binding) && Array.isArray(spanIds)
    && spanIds.length >= 1 && spanIds.length <= MEETING_EVIDENCE_MAX_SPANS
    && spanIds.every(id => typeof id === 'string' && id.length >= 1 && id.length <= 256)
    && new Set(spanIds).size === spanIds.length;
}

/** Hash integrity and equality with the requested span IDs are checked by the consumer. */
export function isMeetingEvidenceFetchResponse(value: unknown): value is MeetingEvidenceFetchResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { spans, ...binding } = value as Record<string, unknown>;
  return isMeetingLiveAccessRequest(binding) && Array.isArray(spans)
    && spans.length >= 1 && spans.length <= MEETING_EVIDENCE_MAX_SPANS
    && new Set(spans.map(span => span?.spanId)).size === spans.length
    && spans.every(span => span && typeof span === 'object' && !Array.isArray(span)
      && Object.keys(span).sort().join(',') === 'end,spanId,start,text,textHash'
      && typeof span.spanId === 'string' && span.spanId.length >= 1 && span.spanId.length <= 256
      && Number.isSafeInteger(span.start) && span.start >= 0
      && Number.isSafeInteger(span.end) && span.end > span.start
      && typeof span.text === 'string' && span.text.length === span.end - span.start && span.text.length <= 8_000
      && typeof span.textHash === 'string' && /^[0-9a-f]{64}$/.test(span.textHash));
}
