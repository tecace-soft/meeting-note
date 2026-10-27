// T1-11 router incident threshold: a request that fails with status >= 500 raises an ops
// incident, a 4xx failure does not. Observed at the incident sink's database boundary
// (fileOpsIncident's feedback_issues reads and insert), following the ops-incidents
// contract test: F9 is enabled for this process only, mail stays disabled by the preload,
// and every request goes to the offline fixture on 127.0.0.1.
import assert from 'node:assert/strict';
import test from 'node:test';

const TEST_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

function bounded<T>(promise: Promise<T>, label: string, ms = REQUEST_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function until(condition: () => boolean, label: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${label} did not happen within ${ms}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test('the router raises an incident for 5xx failures only', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  // Read once when ops/incidents.ts loads, so it must be set before the first import below.
  process.env.F9_OPS_AGENT_ENABLED = 'true';
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'warn', () => undefined);
  const { workflowFixture, regenerateBody } = await import('./test-support/workflow.js');
  const f = await bounded(workflowFixture(), 'fixture start');
  t.after(() => f.close());
  // Incident sink boundary: dedupe lookup (GET), storm-cap count (HEAD) and ticket insert (POST).
  const lookups: URL[] = [];
  const inserts: Array<Record<string, unknown>> = [];
  const previous = globalThis.fetch;
  const sink = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'supabase.invalid' && url.pathname === '/rest/v1/feedback_issues' && url.searchParams.has('ai_suggestion->>fingerprint')) {
      lookups.push(url);
      return Response.json([]);
    }
    if (url.hostname === 'supabase.invalid' && url.pathname === '/rest/v1/feedback_issues' && init?.method === 'HEAD') {
      return new Response(null, { headers: { 'content-range': '0-0/0' } });
    }
    if (url.hostname === 'supabase.invalid' && url.pathname === '/rest/v1/feedback_issues' && init?.method === 'POST') {
      inserts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json(null, { status: 201 });
    }
    return previous(input, init);
  });
  t.after(() => sink.mock.restore());
  const request = (path: string, options: Parameters<typeof f.request>[1] = {}) => bounded(f.request(path, options), `${options.method ?? 'POST'} ${path}`);
  const raw = async (path: string, body: string) => {
    const token = `fixture.${Buffer.from(JSON.stringify({ oid: f.state.caller, tid: f.state.tenant })).toString('base64url')}.fixture`;
    const response = await bounded(fetch(f.base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body }), `raw POST ${path}`);
    await bounded(response.text(), `raw body ${path}`);
    return response.status;
  };

  // 4xx failures thrown through the router: 401 missing token, 401 Graph rejection, 400 invalid JSON, 400 required field.
  f.reset();
  assert.equal((await request('/regenerate-summary', { body: regenerateBody, authenticated: false })).status, 401, 'missing token is a 401');
  f.state.graphStatus = 401;
  assert.equal((await request('/meeting-briefing', { method: 'GET' })).status, 401, 'Graph rejection is a 401');
  f.reset();
  assert.equal(await raw('/regenerate-summary', '{'), 400, 'invalid JSON is a 400');
  assert.equal((await request('/project-chat', { body: {} })).status, 400, 'missing field is a 400');

  // A 500 thrown through the router; its incident is also the ordering barrier for the 4xx above.
  f.reset();
  f.state.dbFailure = true;
  assert.equal((await request('/summarize-audio/jobs/fixture-job', { method: 'GET' })).status, 500, 'DB failure is a 500');
  f.reset();
  await until(() => inserts.length >= 1, 'incident ticket for the 500');
  assert.equal(lookups.length, 1, 'only the 500 looked up an incident; 400 and 401 raised none');
  assert.equal(inserts[0]?.title, '[운영] Workflow request failed', 'the router incident title');
  assert.match(String(inserts[0]?.description), /"status": 500/, 'the incident context carries the status');
  assert.match(String(inserts[0]?.description), /\/summarize-audio\/jobs\/fixture-job/, 'the incident context carries the request url');

  // A 502 the insight handler writes itself is not a router failure and raises nothing;
  // the next thrown 500 (a failed project chat) is its ordering barrier.
  f.state.aiFailure = true;
  assert.equal((await request('/refresh-note-insight', { body: { noteId: 'fixture-note' } })).status, 502, 'handler-written 502');
  assert.equal((await request('/project-chat', { body: { project_id: 'fixture-project', message: 'What happened?' } })).status, 500, 'AI failure is a thrown 500');
  await until(() => inserts.length >= 2, 'incident ticket for the second 500');
  assert.match(String(inserts[1]?.description), /\/project-chat/, 'the second incident is the project chat failure');
  assert.equal(lookups.length, 2, 'one incident per thrown 500 and none for the handler-written 502');
});
