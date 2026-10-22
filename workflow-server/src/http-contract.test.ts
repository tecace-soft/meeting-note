import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { env } from './config/env.js';
import { MicrosoftIdentityError } from './microsoftIdentity.js';
import { HttpError, corsHeaders, sendJson, sendNoContent, readBody, getHttpStatus, errorMessage, requiredString, getBearerToken } from './http/shared.js';
import { getMicrosoftUserId, getMicrosoftProfile } from './http/identity.js';
import { supabase } from './db/supabaseClient.js';

function bodyRequest() {
  const stream = new EventEmitter() as EventEmitter & { destroy(): void; destroyed: boolean };
  stream.destroyed = false;
  stream.destroy = () => { stream.destroyed = true; };
  return { stream, req: stream as unknown as IncomingMessage };
}

test('HTTP status preserves explicit errors and case-sensitive message precedence', () => {
  assert.equal(getHttpStatus(new HttpError(409, 'required')), 409);
  assert.equal(getHttpStatus(new MicrosoftIdentityError(403, 'token')), 403);
  for (const [message, status] of [
    ['Missing bearer token.', 401], ['Microsoft Graph /me rejected (500)', 401],
    ['token too large and required', 413], ['exceeds limit', 413],
    ['is required', 400], ['must be valid JSON', 400], ['Unsupported', 400], ['token', 400], ['userId', 400],
    ['unsupported', 500], ['unexpected failure', 500],
  ] as const) assert.equal(getHttpStatus(new Error(message)), status, message);
});

test('errorMessage preserves provider-field precedence, trimming and fallback', () => {
  assert.equal(errorMessage(new Error(' verbatim ')), ' verbatim ');
  assert.equal(errorMessage({ message: ' ', error: ' provider ', details: 'other' }), 'provider');
  assert.equal(errorMessage({ details: 'detail', hint: 'hint', code: 'code' }), 'detail');
  assert.equal(errorMessage({ hint: 'hint', code: 'code' }), 'hint');
  assert.equal(errorMessage({ code: 'code' }), 'code');
  assert.equal(errorMessage({ n: 1 }), '{"n":1}');
  const circular: Record<string, unknown> = {}; circular.self = circular;
  assert.equal(errorMessage(circular), '[object Object]');
  assert.equal(errorMessage(null), 'null');
});

test('CORS and response contracts preserve first-origin normalization and headers', () => {
  const original = env.frontendOrigin;
  try {
    for (const [origin, expected] of [['*', '*'], [' https://first.invalid///, https://second.invalid/ ', 'https://first.invalid'], [' , ', '*']]) {
      env.frontendOrigin = origin;
      assert.deepEqual(corsHeaders(), {
        'Access-Control-Allow-Origin': expected, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type', Vary: 'Origin', 'Content-Type': 'application/json',
      });
    }
    const calls: unknown[][] = [];
    const res = { writeHead: (...args: unknown[]) => calls.push(args), end: (...args: unknown[]) => calls.push(args) } as unknown as ServerResponse;
    sendJson(res, 201, { ok: true });
    assert.equal(calls[0][0], 201); assert.deepEqual(calls[1], ['{"ok":true}']);
    sendNoContent(res); assert.equal(calls[2][0], 204); assert.deepEqual(calls[3], []);
  } finally { env.frontendOrigin = original; }
});

test('readBody retains empty, JSON primitive, Unicode split and exact byte-limit contracts', async (t) => {
  for (const [raw, expected] of [['', {}], [' \n', {}], ['null', null], ['[1]', [1]], ['{"text":"가😀"}', { text: '가😀' }]] as const) {
    await t.test(JSON.stringify(raw), async () => {
      const { stream, req } = bodyRequest(); const bytes = Buffer.from(raw);
      const result = readBody(req, bytes.length);
      for (const byte of bytes) stream.emit('data', Buffer.from([byte]));
      stream.emit('end'); assert.deepEqual(await result, expected); assert.equal(stream.destroyed, false);
    });
  }
  const invalid = bodyRequest(); const parsed = readBody(invalid.req); invalid.stream.emit('data', Buffer.from('{')); invalid.stream.emit('end');
  await assert.rejects(parsed, { message: 'Request body must be valid JSON.' });
  const huge = bodyRequest(); const oversized = readBody(huge.req, 3); huge.stream.emit('data', Buffer.from('"가"'));
  await assert.rejects(oversized, { message: 'Request body is too large.' }); assert.equal(huge.stream.destroyed, true);
  const failed = bodyRequest(); const errored = readBody(failed.req); const error = new Error('stream error'); failed.stream.emit('error', error);
  await assert.rejects(errored, error);
});

test('requiredString and bearer parsing retain coercion and exact errors', () => {
  for (const [value, expected] of [[' x ', 'x'], [0, '0'], [12n, '12'], [false, 'false']] as const) assert.equal(requiredString({ value }, 'value'), expected);
  assert.throws(() => requiredString({ z: true, a: 1 }, 'value'), { message: 'value is required. Received fields: a, z.' });
  assert.throws(() => requiredString({}, 'value'), { message: 'value is required. Received fields: none.' });
  assert.throws(() => requiredString({ value: [] }, 'value'), { message: 'value must be a string or number. Received object.' });
  assert.throws(() => requiredString({ value: NaN }, 'value'), { message: 'value must be a string or number. Received number.' });
  const request = (authorization?: string) => ({ headers: { authorization } }) as IncomingMessage;
  assert.equal(getBearerToken(request('Bearer  abc ')), 'abc');
  assert.equal(getBearerToken(request('Bearer ')), '');
  assert.throws(() => getBearerToken(request('bearer abc')), { message: 'Missing bearer token.' });
});

test('identity wrappers preserve Graph validation and tenant rejection; DB client remains shared', async (t) => {
  const id = '11111111-1111-4111-8111-111111111111'; const tid = '22222222-2222-4222-8222-222222222222';
  const previous = process.env.ALLOWED_MS_TENANT_IDS; process.env.ALLOWED_MS_TENANT_IDS = tid;
  t.after(() => { if (previous === undefined) delete process.env.ALLOWED_MS_TENANT_IDS; else process.env.ALLOWED_MS_TENANT_IDS = previous; });
  const token = (tenant: string) => `fixture.${Buffer.from(JSON.stringify({ oid: id, tid: tenant })).toString('base64url')}.fixture`;
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    assert.match(String(input), /^https:\/\/graph.microsoft.com\/v1.0\/me/);
    return Response.json({ id, displayName: 'Fixture', mail: 'display@example.invalid' }, { status });
  });
  assert.equal((await getMicrosoftProfile(token(tid))).id, id);
  assert.equal(await getMicrosoftUserId(token(tid)), id);
  await assert.rejects(getMicrosoftProfile(token('33333333-3333-4333-8333-333333333333')), (error: unknown) => getHttpStatus(error) === 403);
  status = 401; await assert.rejects(getMicrosoftUserId(token(tid)), (error: unknown) => getHttpStatus(error) === 401);
  assert.equal((await import('./db/supabaseClient.js')).supabase, supabase);
});

test('S13 readBody avoids reassembling every chunk and concatenates only the accepted body', async (t) => {
  const { stream, req } = bodyRequest();
  const concat = t.mock.method(Buffer, 'concat');
  const result = readBody(req);
  const raw = Buffer.from(JSON.stringify({ text: '가😀'.repeat(100) }));
  for (const byte of raw) stream.emit('data', Buffer.from([byte]));
  stream.emit('end');
  assert.deepEqual(await result, { text: '가😀'.repeat(100) });
  assert.equal(concat.mock.callCount(), 1);
  concat.mock.resetCalls();
  const huge = bodyRequest(); const rejected = readBody(huge.req, 1);
  huge.stream.emit('data', Buffer.from('xx'));
  await assert.rejects(rejected, { message: 'Request body is too large.' });
  assert.equal(concat.mock.callCount(), 0);
});
