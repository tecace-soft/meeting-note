/**
 * Shared event boundary. Validation proves shape and supplied-content integrity,
 * never authorization, issuer authenticity, classification, or lifecycle ordering.
 * Authenticating transports and stores own those additional boundaries.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type eventSchema from './event.schema.json';

// Node16's ESM compiler cannot emit JSON import attributes. A type import keeps
// the asset in the build; createRequire loads it in both native Node and tests.
const schema = createRequire(import.meta.url)('./event.schema.json') as typeof eventSchema;

export interface MicrosoftIdentity { tenantId: string; objectId: string }
export interface SourceSpan { spanId: string; start: number; end: number; textHash: string }
export interface SourcePayload {
  contentRevision: number;
  speakerRevision: number;
  sourceHash: string;
  title: string;
  sourceUrl: string;
  meetingAt: string | null;
  timezone: string;
  plaintext: string;
  spans: SourceSpan[];
}
export interface AccessGrant {
  identity: MicrosoftIdentity;
  kind: 'participant' | 'direct-share' | 'project-share';
  verification: { authority: 'meeting-note-server'; evidenceRef: string };
}
export interface AccessPayload {
  accessRevision: number;
  grants: AccessGrant[];
  denies: MicrosoftIdentity[];
  /** A reference only; AXKH must resolve an approved classification policy. */
  classificationPolicyRef?: string;
}
export interface EvidenceRef extends SourceSpan {
  sourceId: string;
  contentRevision: number;
  sourceHash: string;
}
export interface KnowledgeUnit {
  unitId: string;
  text: string;
  factType?: 'definition' | 'condition' | 'status' | 'proposal' | 'decision' | 'task' | 'outcome' | 'open-question' | 'unclassified';
  speechAct?: 'statement' | 'proposal' | 'request' | 'acceptance' | 'decision' | 'correction' | 'question' | 'unclassified';
  epistemic?: 'reported' | 'verified' | 'hypothesis' | 'uncertain' | 'unclassified';
  lifecycle?: 'candidate' | 'confirmed' | 'superseded' | 'withdrawn' | 'unclassified';
  evidence: EvidenceRef[];
}
export interface UnitsPayload {
  contentRevision: number;
  speakerRevision: number;
  sourceHash: string;
  extractorRun: { runId: string; model: string; promptVersion: string };
  units: KnowledgeUnit[];
}
interface Envelope<T extends string, P> {
  schemaVersion: 1;
  eventId: string;
  eventSeq: number;
  integrationGeneration: number;
  sourceApp: 'meeting-note';
  sourceId: string;
  tenantId: string;
  payloadHash: string;
  eventType: T;
  payload: P;
}
export type SourceUpsertEvent = Envelope<'source.upsert', SourcePayload>;
export type AccessChangedEvent = Envelope<'access.changed', AccessPayload>;
export type UnitsUpsertEvent = Envelope<'units.upsert', UnitsPayload>;
export type SourceDeletedEvent = Envelope<'source.deleted', {
  lifecycleRevision: number; reason: 'source-deleted' | 'retention-expired';
}>;
export type IntegrationDisabledEvent = Envelope<'integration.disabled', {
  lifecycleRevision: number; reason: 'user-disabled' | 'policy-disabled';
}>;
export type MeetingKnowledgeEvent = SourceUpsertEvent | AccessChangedEvent | UnitsUpsertEvent | SourceDeletedEvent | IntegrationDisabledEvent;
export type ValidationErrorCode = 'INVALID_JSON' | 'SCHEMA_INVALID' | 'PAYLOAD_HASH_MISMATCH'
  | 'SOURCE_HASH_MISMATCH' | 'INVALID_SOURCE_TEXT' | 'INVALID_SOURCE_URL' | 'INVALID_TIMEZONE'
  | 'INVALID_SPAN_COVERAGE' | 'DUPLICATE_SPAN_ID' | 'SPAN_HASH_MISMATCH'
  | 'IDENTITY_TENANT_MISMATCH' | 'DUPLICATE_GRANT' | 'DUPLICATE_DENY'
  | 'DUPLICATE_UNIT_ID' | 'EVIDENCE_VERSION_MISMATCH' | 'INVALID_EVIDENCE_RANGE'
  | 'INVALID_SOURCE_CONTEXT' | 'SOURCE_CONTEXT_MISMATCH' | 'EVIDENCE_SPAN_MISMATCH';
export type ValidationResult = { valid: true; event: MeetingKnowledgeEvent }
  | { valid: false; errorCode: ValidationErrorCode };

/**
 * v1 canonical JSON: sort object keys by JS UTF-16 lexical order; use JSON.stringify
 * for finite numbers and string escaping; preserve array order. This is not JCS.
 * Reject non-JSON data instead of silently removing values or calling toJSON.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(input: unknown): string {
    if (input === null) return 'null';
    if (typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
    if (typeof input !== 'object' || input === null || ancestors.has(input)) throw new TypeError('INVALID_JSON');
    if (Object.getOwnPropertySymbols(input).length > 0) throw new TypeError('INVALID_JSON');
    const prototype = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) throw new TypeError('INVALID_JSON');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.keys(input).length !== input.length || Object.getOwnPropertyNames(input).length !== input.length + 1) throw new TypeError('INVALID_JSON');
        const values: string[] = [];
        for (let index = 0; index < input.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('INVALID_JSON');
          values.push(encode(descriptor.value));
        }
        return `[${values.join(',')}]`;
      }
      const values: string[] = [];
      for (const key of Object.getOwnPropertyNames(input).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('INVALID_JSON');
        values.push(`${JSON.stringify(key)}:${encode(descriptor.value)}`);
      }
      return `{${values.join(',')}}`;
    } finally { ancestors.delete(input); }
  }
  return encode(value);
}

/** SHA-256 of unchanged UTF-8 text; do not normalize newlines or whitespace. */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
export function hashPayload(payload: unknown): string { return sha256Text(canonicalJson(payload)); }
const validateShape = new AjvJsonSchemaValidator().getValidator<MeetingKnowledgeEvent>(schema);
const fail = (errorCode: ValidationErrorCode): ValidationResult => ({ valid: false, errorCode });
const identityKey = (identity: MicrosoftIdentity): string => `${identity.tenantId}:${identity.objectId}`;
function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
function validUnicode(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/**
 * Context-free unit validation proves only self-consistency, not source existence.
 * Supply the authenticated, current source revision to bind unit evidence to spans.
 * Caller identity, approved policy, live access, and tombstones are separate gates.
 * Error codes never include titles, identities, text, payloads, or AJV diagnostics.
 */
export function validateMeetingKnowledgeEvent(input: unknown, sourceContext?: SourceUpsertEvent): ValidationResult {
  try { canonicalJson(input); } catch { return fail('INVALID_JSON'); }
  const result = validateShape(input);
  if (!result.valid) return fail('SCHEMA_INVALID');
  const event = result.data;
  if (hashPayload(event.payload) !== event.payloadHash) return fail('PAYLOAD_HASH_MISMATCH');
  if (event.eventType === 'source.upsert') {
    const source = event.payload;
    if (!validUnicode(source.plaintext)) return fail('INVALID_SOURCE_TEXT');
    if (sha256Text(source.plaintext) !== source.sourceHash) return fail('SOURCE_HASH_MISMATCH');
    try {
      const url = new URL(source.sourceUrl);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return fail('INVALID_SOURCE_URL');
    } catch { return fail('INVALID_SOURCE_URL'); }
    try { new Intl.DateTimeFormat('en-US', { timeZone: source.timezone }); } catch { return fail('INVALID_TIMEZONE'); }
    let offset = 0;
    const ids = new Set<string>();
    for (const span of source.spans) {
      if (ids.has(span.spanId)) return fail('DUPLICATE_SPAN_ID');
      ids.add(span.spanId);
      if (span.start !== offset || span.end <= span.start || span.end > source.plaintext.length
        || splitsSurrogate(source.plaintext, span.start) || splitsSurrogate(source.plaintext, span.end)) return fail('INVALID_SPAN_COVERAGE');
      if (sha256Text(source.plaintext.slice(span.start, span.end)) !== span.textHash) return fail('SPAN_HASH_MISMATCH');
      offset = span.end;
    }
    if (offset !== source.plaintext.length) return fail('INVALID_SPAN_COVERAGE');
  } else if (event.eventType === 'access.changed') {
    const grants = new Set<string>();
    const denies = new Set<string>();
    for (const grant of event.payload.grants) {
      if (grant.identity.tenantId !== event.tenantId) return fail('IDENTITY_TENANT_MISMATCH');
      const key = `${identityKey(grant.identity)}:${grant.kind}`;
      if (grants.has(key)) return fail('DUPLICATE_GRANT');
      grants.add(key);
    }
    for (const identity of event.payload.denies) {
      if (identity.tenantId !== event.tenantId) return fail('IDENTITY_TENANT_MISMATCH');
      const key = identityKey(identity);
      if (denies.has(key)) return fail('DUPLICATE_DENY');
      denies.add(key);
    }
    // A deny can coexist with a grant: consumer deny precedence is mandatory.
  } else if (event.eventType === 'units.upsert') {
    let spans: Map<string, SourceSpan> | undefined;
    if (sourceContext !== undefined) {
      const contextResult = validateMeetingKnowledgeEvent(sourceContext);
      if (!contextResult.valid || contextResult.event.eventType !== 'source.upsert') return fail('INVALID_SOURCE_CONTEXT');
      const source = contextResult.event;
      if (source.tenantId !== event.tenantId || source.sourceId !== event.sourceId
        || source.integrationGeneration !== event.integrationGeneration
        || source.payload.contentRevision !== event.payload.contentRevision
        || source.payload.speakerRevision !== event.payload.speakerRevision
        || source.payload.sourceHash !== event.payload.sourceHash) return fail('SOURCE_CONTEXT_MISMATCH');
      spans = new Map(source.payload.spans.map(span => [span.spanId, span]));
    }
    const ids = new Set<string>();
    for (const unit of event.payload.units) {
      if (ids.has(unit.unitId)) return fail('DUPLICATE_UNIT_ID');
      ids.add(unit.unitId);
      for (const evidence of unit.evidence) {
        if (evidence.sourceId !== event.sourceId || evidence.contentRevision !== event.payload.contentRevision
          || evidence.sourceHash !== event.payload.sourceHash) return fail('EVIDENCE_VERSION_MISMATCH');
        if (evidence.end <= evidence.start) return fail('INVALID_EVIDENCE_RANGE');
        if (spans) {
          const span = spans.get(evidence.spanId);
          if (!span || span.start !== evidence.start || span.end !== evidence.end || span.textHash !== evidence.textHash) return fail('EVIDENCE_SPAN_MISMATCH');
        }
      }
    }
  }
  return { valid: true, event };
}
