import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { getGlobalDispatcher } from 'undici';

test('startup owns both knowledge worker schedules and cleanup stops further RPC polling', async (t) => {
  Object.assign(process.env, {
    SUPABASE_URL: 'https://supabase.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role', GEMINI_API_KEY: 'synthetic-gemini',
    MEETING_KNOWLEDGE_DELIVERY_ENABLED: 'true', MEETING_KNOWLEDGE_EXTRACTION_ENABLED: 'true',
    MEETING_KNOWLEDGE_AXKH_URL: 'https://axkh.invalid', MEETING_KNOWLEDGE_NOTE_BASE_URL: 'https://notes.invalid',
    MEETING_KNOWLEDGE_INGEST_KEY: 'synthetic-ingest-key-00000000000000000000',
    MEETING_KNOWLEDGE_ACCESS_KEY: 'synthetic-access-key-00000000000000000000',
    MEETING_KNOWLEDGE_MODEL_POLICY_KEY: 'synthetic-policy-key-00000000000000000000',
    MEETING_KNOWLEDGE_TENANT_ID: '33333333-3333-4333-8333-333333333333',
    MEETING_KNOWLEDGE_EXTRACTION_MODEL: 'gemini-2.5-flash-lite',
  });
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    const url = String(input);
    assert.match(url, /^https:\/\/supabase\.invalid\//);
    calls.push(url);
    return new Response('[]', { headers: { 'content-type': 'application/json' } });
  });
  const { server, startServer } = await import('./index.js');
  const timeout = t.mock.method(globalThis, 'setTimeout');
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const stop = startServer({ port: 0, host: '127.0.0.1', dispatcher: getGlobalDispatcher() });
  let stopped = false;
  t.after(async () => { if (!stopped) await stop(); });
  await once(server, 'listening');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(calls.some((url) => url.includes('outbox_claim')));
  assert.ok(calls.some((url) => url.includes('extraction_claim')));
  const scheduled = timeout.mock.calls.filter((call) => call.arguments[1] === 5_000).map((call) => call.result).filter((timer) => !(timer as unknown as { _destroyed: boolean })._destroyed);
  assert.equal(scheduled.length, 2, 'delivery and extraction schedules');
  await stop();
  stopped = true;
  for (const timer of scheduled) assert.ok(clear.mock.calls.some((call) => call.arguments[0] === timer));
  const count = calls.length;
  // Invoking even an already-queued scheduler callback cannot restart work.
  for (const call of timeout.mock.calls.filter((call) => call.arguments[1] === 5_000)) {
    (call.arguments[0] as () => void)();
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, count);
});
