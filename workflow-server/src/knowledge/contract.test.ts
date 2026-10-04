import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  canonicalJson, hashPayload, sha256Text, validateMeetingKnowledgeEvent,
  type MeetingKnowledgeEvent, type SourceUpsertEvent,
} from './contract.js';

const fixtures = JSON.parse(readFileSync(new URL('./synthetic-fixtures.json', import.meta.url), 'utf8')) as {
  events: Record<string, unknown>[];
};
type EventKind = MeetingKnowledgeEvent['eventType'];
function fixture<K extends EventKind>(kind: K): Extract<MeetingKnowledgeEvent, { eventType: K }> {
  const result = validateMeetingKnowledgeEvent(fixtures.events.find(event => event.eventType === kind));
  assert.ok(result.valid, `invalid synthetic ${kind} fixture`);
  assert.equal(result.event.eventType, kind);
  return structuredClone(result.event) as Extract<MeetingKnowledgeEvent, { eventType: K }>;
}
function rehash<T extends MeetingKnowledgeEvent>(event: T): T {
  event.payloadHash = hashPayload(event.payload);
  return event;
}
function rejects(event: unknown, context?: SourceUpsertEvent): void {
  const result = validateMeetingKnowledgeEvent(event, context);
  assert.equal(result.valid, false);
  assert.ok('errorCode' in result);
  assert.deepEqual(Object.keys(result).sort(), ['errorCode', 'valid']);
}
const otherTenant = '99999999-9999-4999-8999-999999999999';
const zeroHash = '0'.repeat(64);

for (const kind of ['source.upsert', 'access.changed', 'units.upsert', 'source.deleted', 'integration.disabled'] as const) {
  test(`accepts synthetic ${kind} without changing the input`, () => {
    const event = fixture(kind);
    const original = structuredClone(event);
    assert.ok(validateMeetingKnowledgeEvent(event).valid);
    assert.deepEqual(event, original);
  });
}

test('canonical hash has a known SHA-256 vector and ignores object insertion order', () => {
  assert.equal(sha256Text('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(canonicalJson({ z: [2, 1], a: { y: true, x: null } }), '{"a":{"x":null,"y":true},"z":[2,1]}');
  assert.equal(hashPayload({ a: 1, b: 2 }), hashPayload({ b: 2, a: 1 }));
  assert.notEqual(hashPayload([1, 2]), hashPayload([2, 1]));
  assert.notEqual(sha256Text('회의\n'), sha256Text('회의'));
});

test('rejects non-JSON values without executing accessors or toJSON', () => {
  let called = false;
  const getter = { get hidden() { called = true; return 'private'; } };
  const custom = { toJSON() { called = true; return {}; } };
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const value of [undefined, NaN, Infinity, new Date(), getter, custom, circular, [undefined], Array(1)]) {
    assert.throws(() => canonicalJson(value), /INVALID_JSON/);
    rejects(value);
  }
  assert.equal(called, false);
});

for (const [field, value] of [
  ['schemaVersion', 2], ['tenantId', 'display-name'], ['sourceApp', 'browser'],
  ['eventSeq', 0], ['eventSeq', 1.5], ['eventSeq', Number.MAX_SAFE_INTEGER + 1],
  ['integrationGeneration', 0], ['eventId', 'not-a-uuid'], ['clearance', 5],
] as const) {
  test(`rejects unsupported envelope ${field}=${value}`, () => {
    const event = fixture('source.upsert');
    Object.assign(event, { [field]: value });
    rejects(event);
  });
}

test('requires tenant identity and rejects altered payload hashes', () => {
  const event = fixture('source.upsert');
  const withoutTenant: Record<string, unknown> = { ...event };
  delete withoutTenant.tenantId;
  rejects(withoutTenant);
  event.payload.title += ' changed';
  rejects(event);
});

test('rejects changed source text even after the transport payload is rehashed', () => {
  const event = fixture('source.upsert');
  event.payload.plaintext += '추가된 발언';
  rejects(rehash(event));
});

for (const problem of ['duplicate', 'gap', 'overlap', 'truncated', 'hash', 'negative', 'empty'] as const) {
  test(`rejects ${problem} spans despite a valid transport hash`, () => {
    const event = fixture('source.upsert');
    const [first, second] = event.payload.spans;
    if (problem === 'duplicate') second.spanId = first.spanId;
    if (problem === 'gap') second.start++;
    if (problem === 'overlap') second.start--;
    if (problem === 'truncated') event.payload.spans.pop();
    if (problem === 'hash') first.textHash = zeroHash;
    if (problem === 'negative') first.start = -1;
    if (problem === 'empty') first.end = first.start;
    rejects(rehash(event));
  });
}

test('span offsets count UTF-16 and cannot split a Korean/emoji transcript', () => {
  const event = fixture('source.upsert');
  const split = event.payload.plaintext.indexOf('🙂') + 1;
  assert.ok(split > 0);
  event.payload.spans = [
    { spanId: 'left', start: 0, end: split, textHash: sha256Text(event.payload.plaintext.slice(0, split)) },
    { spanId: 'right', start: split, end: event.payload.plaintext.length, textHash: sha256Text(event.payload.plaintext.slice(split)) },
  ];
  rejects(rehash(event));
});

test('rejects unpaired Unicode surrogates and permits a truly empty revision', () => {
  const event = fixture('source.upsert');
  event.payload.plaintext = '\ud800';
  event.payload.sourceHash = sha256Text(event.payload.plaintext);
  event.payload.spans = [{ spanId: 'invalid', start: 0, end: 1, textHash: event.payload.sourceHash }];
  rejects(rehash(event));
  event.payload.plaintext = '';
  event.payload.sourceHash = sha256Text('');
  event.payload.spans = [];
  assert.ok(validateMeetingKnowledgeEvent(rehash(event)).valid);
});

for (const [field, value] of [
  ['sourceUrl', 'http://meeting.example.test/private'],
  ['sourceUrl', 'https://user:password@meeting.example.test/private'],
  ['timezone', 'Not/A_Timezone'], ['meetingAt', 'yesterday'], ['contentRevision', 0],
] as const) {
  test(`rejects invalid source ${field}`, () => {
    const event = fixture('source.upsert');
    Object.assign(event.payload, { [field]: value });
    rejects(rehash(event));
  });
}

test('preserves grant plus deny without pretending schema validation authorizes access', () => {
  const event = fixture('access.changed');
  assert.ok(event.payload.grants.some(grant => event.payload.denies.some(deny => deny.objectId === grant.identity.objectId)));
  assert.equal(event.payload.classificationPolicyRef, undefined);
  const result = validateMeetingKnowledgeEvent(event);
  assert.ok(result.valid);
  assert.deepEqual(Object.keys(result).sort(), ['event', 'valid']);
});

for (const problem of ['grant-tenant', 'deny-tenant', 'name', 'clearance', 'verification', 'duplicate-grant', 'duplicate-deny'] as const) {
  test(`rejects ${problem} in an access snapshot`, () => {
    const event = fixture('access.changed');
    if (problem === 'grant-tenant') event.payload.grants[0].identity.tenantId = otherTenant;
    if (problem === 'deny-tenant') event.payload.denies[0].tenantId = otherTenant;
    if (problem === 'name') event.payload.grants[0].identity.objectId = 'Speaker A';
    if (problem === 'clearance') Object.assign(event.payload.grants[0].identity, { clearance: 5 });
    if (problem === 'verification') Object.assign(event.payload.grants[0].verification, { authority: 'diarization-model' });
    if (problem === 'duplicate-grant') event.payload.grants.push(structuredClone(event.payload.grants[0]));
    if (problem === 'duplicate-deny') event.payload.denies.push(structuredClone(event.payload.denies[0]));
    rejects(rehash(event));
  });
}

test('accepts an access-only revision with a policy reference and no source body', () => {
  const event = fixture('access.changed');
  event.payload.accessRevision = 2;
  event.payload.classificationPolicyRef = 'synthetic-policy-reference';
  assert.ok(validateMeetingKnowledgeEvent(rehash(event)).valid);
  assert.ok(!('plaintext' in event.payload));
  assert.ok(!('contentRevision' in event.payload));
});

test('binds synthetic units to current source spans and preserves proposal uncertainty', () => {
  const event = fixture('units.upsert');
  assert.ok(validateMeetingKnowledgeEvent(event, fixture('source.upsert')).valid);
  assert.equal(event.payload.units[0].speechAct, 'proposal');
  assert.equal(event.payload.units[0].lifecycle, 'candidate');
  delete event.payload.units[0].factType;
  delete event.payload.units[0].speechAct;
  delete event.payload.units[0].epistemic;
  delete event.payload.units[0].lifecycle;
  assert.ok(validateMeetingKnowledgeEvent(rehash(event), fixture('source.upsert')).valid);
});

for (const problem of ['acl', 'no-evidence', 'duplicate-unit', 'source', 'revision', 'source-hash', 'empty-range'] as const) {
  test(`rejects ${problem} in extracted units`, () => {
    const event = fixture('units.upsert');
    const unit = event.payload.units[0];
    const evidence = unit.evidence[0];
    if (problem === 'acl') Object.assign(event.payload, { grants: [] });
    if (problem === 'no-evidence') unit.evidence = [];
    if (problem === 'duplicate-unit') event.payload.units.push(structuredClone(unit));
    if (problem === 'source') evidence.sourceId = 'another-note';
    if (problem === 'revision') evidence.contentRevision++;
    if (problem === 'source-hash') evidence.sourceHash = zeroHash;
    if (problem === 'empty-range') evidence.end = evidence.start;
    rejects(rehash(event));
  });
}

for (const problem of ['span-id', 'span-hash', 'span-range'] as const) {
  test(`requires source context to detect nonexistent ${problem}`, () => {
    const event = fixture('units.upsert');
    const evidence = event.payload.units[0].evidence[0];
    if (problem === 'span-id') evidence.spanId = 'never-provided';
    if (problem === 'span-hash') evidence.textHash = zeroHash;
    if (problem === 'span-range') evidence.end++;
    rehash(event);
    assert.ok(validateMeetingKnowledgeEvent(event).valid, 'context-free validation establishes only self-consistency');
    rejects(event, fixture('source.upsert'));
  });
}

for (const problem of ['tenant', 'source', 'generation', 'content-revision', 'speaker-revision'] as const) {
  test(`rejects units for a different current ${problem}`, () => {
    const context = fixture('source.upsert');
    if (problem === 'tenant') context.tenantId = otherTenant;
    if (problem === 'source') context.sourceId = 'another-note';
    if (problem === 'generation') context.integrationGeneration++;
    if (problem === 'content-revision') context.payload.contentRevision++;
    if (problem === 'speaker-revision') context.payload.speakerRevision++;
    rejects(fixture('units.upsert'), rehash(context));
  });
}

test('rejects an invalid source context and detects changed content with reused revisions', () => {
  const context = fixture('source.upsert');
  context.payload.title += ' without rehashing';
  rejects(fixture('units.upsert'), context);
  const changed = fixture('source.upsert');
  changed.payload.plaintext += 'changed';
  changed.payload.sourceHash = sha256Text(changed.payload.plaintext);
  changed.payload.spans = [{ spanId: 'new', start: 0, end: changed.payload.plaintext.length, textHash: changed.payload.sourceHash }];
  rejects(fixture('units.upsert'), rehash(changed));
});

for (const kind of ['source.deleted', 'integration.disabled'] as const) {
  test(`${kind} cannot carry a replicated source body`, () => {
    const event = fixture(kind);
    Object.assign(event.payload, { plaintext: 'private body' });
    rejects(rehash(event));
  });
}

test('safe error codes never expose unknown field values', () => {
  const event = fixture('source.upsert');
  Object.assign(event.payload, { extra: 'SENSITIVE_TEST_MARKER' });
  const result = validateMeetingKnowledgeEvent(rehash(event));
  assert.equal(result.valid, false);
  assert.ok(!JSON.stringify(result).includes('SENSITIVE_TEST_MARKER'));
});
