// T1-11 router contract: pins the HTTP dispatch that index.ts owned before the move to
// http/router.ts (method and path matching, query strings, dispatch order and fall-through,
// CORS, error-to-status mapping, body limits, /health and /version, the MCP and knowledge
// mounts) and the startup side effects that stay in startServer. Every request goes to the
// real server on 127.0.0.1 with the offline fixture boundaries from test-support/workflow.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { getGlobalDispatcher } from 'undici';

const TEST_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const NOT_FOUND = { error: 'Not found' };
const WORKFLOW_CORS = {
  'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type', vary: 'Origin', 'content-type': 'application/json',
};

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

function corsOf(headers: Headers): Record<string, string | null> {
  return Object.fromEntries(Object.keys(WORKFLOW_CORS).map((key) => [key, headers.get(key)]));
}

// The router reads RENDER_GIT_* once, when the module that builds VERSION_INFO loads.
const SHA = '0123456789abcdef0123456789abcdef01234567';
const fixtureEnv = {
  SUPABASE_URL: 'https://supabase.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role',
  GEMINI_API_KEY: 'synthetic-gemini', ASSEMBLYAI_API_KEY: 'synthetic-assembly',
  ALLOWED_MS_TENANT_IDS: '33333333-3333-4333-8333-333333333333',
};

test('importing the server module is inert: no listen, interval or process listener', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  Object.assign(process.env, fixtureEnv, { RENDER_GIT_COMMIT: SHA, RENDER_GIT_BRANCH: 'fixture-branch' });
  const intervals = t.mock.method(globalThis, 'setInterval');
  const before = { rejection: process.listenerCount('unhandledRejection'), exception: process.listenerCount('uncaughtException') };
  const dispatcher = getGlobalDispatcher();
  const { server } = await bounded(import('./index.js'), 'index import');
  const intervalCalls = intervals.mock.callCount();
  intervals.mock.restore();
  delete process.env.RENDER_GIT_COMMIT;
  delete process.env.RENDER_GIT_BRANCH;
  assert.equal(server.listening, false, 'import must not listen');
  assert.equal(intervalCalls, 0, 'import must not schedule the orphan sweep');
  assert.equal(process.listenerCount('unhandledRejection'), before.rejection, 'import must not add an unhandledRejection listener');
  assert.equal(process.listenerCount('uncaughtException'), before.exception, 'import must not add an uncaughtException listener');
  assert.equal(getGlobalDispatcher(), dispatcher, 'import must not replace the global dispatcher');
});

test('T1-11 router contract', { timeout: TEST_TIMEOUT_MS * 4 }, async (t) => {
  const logged = t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'warn', () => undefined);
  const { workflowFixture, summarizeBody, regenerateBody } = await import('./test-support/workflow.js');
  const { env, ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL } = await import('./config/env.js');
  const { ASSEMBLYAI_CODE_SWITCHING_MODEL_LABEL } = await import('./routes/transcriptionTest.js');
  const { PROJECT_CHAT_MODEL } = await import('./gemini-models.js');
  const f = await bounded(workflowFixture(), 'fixture start');
  t.after(() => f.close());
  const request = (path: string, options: Parameters<typeof f.request>[1] = {}) => bounded(f.request(path, options), `${options.method ?? 'POST'} ${path}`);
  const token = () => `fixture.${Buffer.from(JSON.stringify({ oid: f.state.caller, tid: f.state.tenant })).toString('base64url')}.fixture`;
  // Raw body variant for invalid JSON and byte-exact size limits.
  const raw = async (path: string, body: string, authenticated = true) => {
    const response = await bounded(fetch(f.base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token()}` } : {}) },
      body,
    }), `raw POST ${path}`);
    const text = await bounded(response.text(), `raw body ${path}`);
    return { status: response.status, headers: response.headers, body: JSON.parse(text || 'null') };
  };
  const check = (name: string, run: () => Promise<void>) => t.test(name, { timeout: TEST_TIMEOUT_MS }, async () => { f.reset(); await run(); });

  await check('method and path matching per route, including near misses', async () => {
    const cases: Array<[string, string, number, unknown?]> = [
      ['GET', '/summarize-audio', 404, NOT_FOUND], ['PUT', '/regenerate-summary', 404, NOT_FOUND],
      ['GET', '/regenerate-summary', 404, NOT_FOUND], ['GET', '/refresh-note-insight', 404, NOT_FOUND],
      ['GET', '/transcription-test', 404, NOT_FOUND], ['GET', '/admin/backfill-insight', 404, NOT_FOUND],
      ['GET', '/summarize-audio/jobs', 404, NOT_FOUND], ['POST', '/summarize-audio/jobs/fixture-job', 404, NOT_FOUND],
      ['GET', '/summarize-audio/jobs/a/b', 404, NOT_FOUND], ['GET', '/summarize-audio/', 404, NOT_FOUND],
      ['GET', '/android/recordings/jobs', 404, NOT_FOUND], ['POST', '/meeting-briefing', 404, NOT_FOUND],
      ['GET', '/meeting-briefing/', 404, NOT_FOUND], ['POST', '/product-docs', 404, NOT_FOUND],
      ['GET', '/product-docs/', 404, NOT_FOUND], ['GET', '/product-docs/Architecture', 404, NOT_FOUND],
      ['GET', '/issue-notify', 404, NOT_FOUND], ['GET', '/project-chat/stream', 404, NOT_FOUND],
      ['POST', '/health', 404, NOT_FOUND], ['GET', '/health/', 404, NOT_FOUND], ['GET', '/Health', 404, NOT_FOUND],
      ['DELETE', '/version', 404, NOT_FOUND], ['POST', '/', 404, NOT_FOUND], ['PATCH', '/unknown', 404, NOT_FOUND],
      ['PUT', '/issue-resolution', 405, { error: 'POST 요청만 받습니다.' }],
      ['DELETE', '/issue-resolution', 405, { error: 'POST 요청만 받습니다.' }],
      ['HEAD', '/health', 404], ['HEAD', '/issue-resolution', 405],
      // new URL('//health', base) parses as a protocol-relative URL whose pathname is '/'.
      ['GET', '//health', 200],
      ['POST', '/summarize-audio/jobs', 202, { jobId: 'fixture-job', status: 'processing', stage: 'processing', progress: 25, deduplicated: true }],
      ['POST', '/refresh-note-insight', 200, { ok: true, noteId: 'fixture-note' }],
      ['POST', '/issue-notify', 400, { error: 'kind 와 issueKey 가 필요합니다.' }],
      ['POST', '/issue-resolution', 403, { error: '해결책 생성은 관리자 권한이 필요합니다.' }],
      ['POST', '/transcription-test', 403, { error: 'Transcription model testing is not available for this user.' }],
      ['POST', '/admin/backfill-insight', 403, { error: 'Insight backfill is not available for this user.' }],
      ['GET', '/product-docs', 200], ['GET', '/product-docs/architecture', 200], ['GET', '/meeting-briefing', 200],
    ];
    const bodies: Record<string, unknown> = { '/summarize-audio/jobs': summarizeBody, '/refresh-note-insight': { noteId: 'fixture-note' } };
    for (const [method, path, status, body] of cases) {
      f.reset();
      const r = await request(path, { method, ...(method === 'GET' || method === 'HEAD' ? {} : { body: bodies[path] ?? {} }) });
      assert.equal(r.status, status, `${method} ${path} status`);
      if (body !== undefined) assert.deepEqual(r.body, body, `${method} ${path} body`);
    }
    const sse = await request('/project-chat/stream', { body: { project_id: 'fixture-project', message: 'What happened?' } });
    assert.equal(sse.status, 200, 'project chat stream status');
    assert.match(sse.headers.get('content-type') ?? '', /^text\/event-stream/, 'stream route keeps its SSE content type');
    assert.match(sse.text, /data: \{"done":true\}/, 'stream route ends with the done event');
  });

  await check('query strings: pathname routes accept them, exact req.url routes do not', async () => {
    const health = await request('/health', { method: 'GET' });
    const deep = await request('/health?deep=1', { method: 'GET' });
    assert.equal(deep.status, 200, '/health?deep=1 status (MCP dashboard probe)');
    assert.deepEqual(deep.body, health.body, '/health?deep=1 answers the same body as /health');
    assert.deepEqual((await request('/?deep=1', { method: 'GET' })).body, health.body, '/ is an alias of /health');
    assert.deepEqual((await request('/version?x=1', { method: 'GET' })).body, (await request('/version', { method: 'GET' })).body, '/version ignores the query');
    assert.equal((await request('/summarize-audio/jobs/fixture-job?x=1', { method: 'GET' })).status, 200, 'job status uses pathname');
    assert.equal((await request('/product-docs?x=1', { method: 'GET' })).status, 200, 'product docs use pathname');
    assert.equal((await request('/meeting-briefing?x=1', { method: 'GET' })).status, 200, 'briefing uses pathname');
    assert.equal((await request('/issue-resolution?x=1', { body: {} })).status, 403, 'issue-resolution uses pathname');
    for (const [path, body] of [['/summarize-audio/jobs', summarizeBody], ['/regenerate-summary', regenerateBody], ['/refresh-note-insight', { noteId: 'fixture-note' }], ['/issue-notify', {}], ['/project-chat', {}], ['/admin/backfill-insight', {}], ['/transcription-test', {}]] as const) {
      const r = await request(`${path}?x=1`, { body });
      assert.equal(r.status, 404, `${path}?x=1 must not match the exact req.url route`);
      assert.deepEqual(r.body, NOT_FOUND, `${path}?x=1 body`);
    }
    assert.equal((await request('/mcp?x=1', { authenticated: false })).status, 401, 'MCP matches by pathname');
  });

  await check('/health and /version bodies', async () => {
    const version = (await request('/version', { method: 'GET' })).body;
    assert.deepEqual(Object.keys(version), ['service', 'sha', 'shortSha', 'branch', 'deployedAt'], 'version key order');
    assert.equal(version.service, 'meeting-note-workflow-server', 'version service');
    assert.equal(version.sha, SHA, 'sha comes from RENDER_GIT_COMMIT at module load');
    assert.equal(version.shortSha, SHA.slice(0, 7), 'shortSha is the first seven characters');
    assert.equal(version.branch, 'fixture-branch', 'branch comes from RENDER_GIT_BRANCH at module load');
    assert.ok(Date.parse(version.deployedAt) <= Date.now(), 'deployedAt is the module load time');
    const health = await request('/health', { method: 'GET' });
    assert.deepEqual(corsOf(health.headers), WORKFLOW_CORS, 'health uses the workflow CORS headers');
    assert.deepEqual(health.body, {
      ok: true, service: 'meeting-note-workflow-server', version,
      transcriptionProvider: 'assemblyai', transcriptionModel: ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL,
      transcriptionLanguageMode: 'no explicit AssemblyAI language settings', selectedLanguageAffectsTranscription: false,
      codeSwitchingModel: ASSEMBLYAI_CODE_SWITCHING_MODEL_LABEL, summaryModel: env.summaryModel,
      regenerateSummaryModel: env.regenerateSummaryModel, projectChatModel: PROJECT_CHAT_MODEL,
      msTenantGate: 'enforced', msClientGate: 'log-only',
    }, 'health body');
    assert.deepEqual(Object.keys(health.body), ['ok', 'service', 'version', 'transcriptionProvider', 'transcriptionModel', 'transcriptionLanguageMode', 'selectedLanguageAffectsTranscription', 'codeSwitchingModel', 'summaryModel', 'regenerateSummaryModel', 'projectChatModel', 'msTenantGate', 'msClientGate'], 'health key order');
    assert.equal((await request('/version', { method: 'GET' })).body.deployedAt, version.deployedAt, 'deployedAt is stable across requests');
  });

  await check('dispatch order: knowledge, then OPTIONS, then MCP, then host routes', async () => {
    // Knowledge owns its paths before the generic OPTIONS answer, even while disabled.
    for (const path of ['/knowledge/v1/access-check', '/knowledge/v1/evidence-fetch', '/knowledge/v1/source-access', '/knowledge/v1/access-check?x=1']) {
      const r = await request(path, { method: 'OPTIONS' });
      assert.equal(r.status, 404, `OPTIONS ${path} is answered by knowledge`);
      assert.deepEqual(r.body, { error: 'NOT_FOUND' }, `OPTIONS ${path} knowledge body`);
      assert.equal(r.headers.get('access-control-allow-origin'), null, `OPTIONS ${path} has no workflow CORS`);
    }
    process.env.MEETING_KNOWLEDGE_ACCESS_ENABLED = 'true';
    process.env.MEETING_KNOWLEDGE_MANAGEMENT_ENABLED = 'true';
    try {
      // The handler reads process.env per request, so enabling it here reaches the mounted handler.
      for (const [method, path, status, error] of [
        ['OPTIONS', '/knowledge/v1/access-check', 405, 'METHOD_NOT_ALLOWED'], ['GET', '/knowledge/v1/evidence-fetch', 405, 'METHOD_NOT_ALLOWED'],
        ['OPTIONS', '/knowledge/v1/source-access', 403, 'ORIGIN_DENIED'], ['POST', '/knowledge/v1/access-check', 503, 'KNOWLEDGE_CONFIG_UNAVAILABLE'],
        ['GET', '/knowledge/v1/access-check?x=1', 400, 'INVALID_REQUEST'],
      ] as const) {
        const r = await request(path, { method, ...(method === 'POST' ? { body: {} } : {}) });
        assert.equal(r.status, status, `${method} ${path} enabled status`);
        assert.deepEqual(r.body, { error }, `${method} ${path} enabled body`);
      }
    } finally {
      delete process.env.MEETING_KNOWLEDGE_ACCESS_ENABLED;
      delete process.env.MEETING_KNOWLEDGE_MANAGEMENT_ENABLED;
    }
    // OPTIONS precedes MCP: MCP-owned paths get the generic 204 preflight.
    for (const path of ['/mcp', '/mcp-chatgpt', '/admin', '/admin/health', '/oauth/token', '/.well-known/oauth-protected-resource', '/unknown', '/health']) {
      const r = await request(path, { method: 'OPTIONS' });
      assert.equal(r.status, 204, `OPTIONS ${path} status`);
      assert.equal(r.text, '', `OPTIONS ${path} has no body`);
      assert.deepEqual(corsOf(r.headers), WORKFLOW_CORS, `OPTIONS ${path} CORS`);
    }
    // MCP owns its paths before the host routes and answers in its own shapes.
    const mcp = await request('/mcp', { authenticated: false });
    assert.equal(mcp.status, 401, 'POST /mcp unauthenticated');
    assert.deepEqual(mcp.body, { error: 'Unauthorized' }, 'MCP 401 body');
    assert.match(mcp.headers.get('www-authenticate') ?? '', /^Bearer resource_metadata="https:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"$/, 'MCP challenge header');
    assert.equal(mcp.headers.get('access-control-allow-origin'), null, 'MCP responses carry no workflow CORS');
    const chatgpt = await request('/mcp-chatgpt', { authenticated: false });
    assert.equal(chatgpt.status, 401, 'POST /mcp-chatgpt unauthenticated');
    assert.match(chatgpt.body.error, /MEETING_NOTE_USER_ID is required/, 'mcp-chatgpt 401 body');
    const resource = await request('/.well-known/oauth-protected-resource', { method: 'GET' });
    assert.equal(resource.status, 200, 'protected resource metadata status');
    assert.match(resource.body.resource, /\/mcp-chatgpt$/, 'protected resource metadata body');
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource/mcp-chatgpt']) {
      assert.equal((await request(path, { method: 'GET' })).status, 200, `${path} status`);
    }
    const discovery = await request('/.well-known/openid-configuration', { method: 'GET' });
    assert.equal(discovery.status, 404, 'unconfigured OAuth discovery is MCP-owned');
    assert.deepEqual(discovery.body, { error: 'not_found' }, 'MCP 404 shape differs from the host 404');
    const oauth = await request('/oauth/token', { body: {} });
    assert.equal(oauth.status, 503, 'unconfigured OAuth proxy status');
    assert.equal(oauth.body.error, 'temporarily_unavailable', 'unconfigured OAuth proxy body');
    const dashboard = await request('/admin', { method: 'GET' });
    assert.equal(dashboard.status, 200, 'MCP dashboard page');
    assert.match(dashboard.headers.get('content-type') ?? '', /^text\/html/, 'dashboard is HTML');
    assert.equal(dashboard.headers.get('cache-control'), 'no-store', 'dashboard cache header');
    const adminHealth = await request('/admin/health', { method: 'GET' });
    assert.equal(adminHealth.status, 401, '/admin/health is the MCP dashboard route, not /health');
    assert.deepEqual(adminHealth.body, { error: 'Microsoft sign-in is required for the MCP dashboard.' }, '/admin/health body');
    // MCP falls through for /admin/backfill-insight, /health and /version.
    const backfill = await request('/admin/backfill-insight', { body: {}, authenticated: false });
    assert.equal(backfill.status, 401, '/admin/backfill-insight falls through MCP to the host route');
    assert.deepEqual(backfill.body, { error: 'Missing bearer token.' }, 'host 401 body');
    assert.deepEqual(corsOf(backfill.headers), WORKFLOW_CORS, 'host error CORS');
    assert.equal((await request('/health', { method: 'GET' })).body.service, 'meeting-note-workflow-server', '/health is host-owned');
  });

  await check('CORS follows the first configured origin on every host response', async () => {
    const original = env.frontendOrigin;
    env.frontendOrigin = 'https://app.invalid/, https://other.invalid';
    try {
      for (const [method, path, status] of [['GET', '/unknown', 404], ['OPTIONS', '/x', 204], ['GET', '/health', 200], ['POST', '/regenerate-summary', 401]] as const) {
        const r = await request(path, { method, authenticated: false, ...(method === 'POST' ? { body: regenerateBody } : {}) });
        assert.equal(r.status, status, `${method} ${path} status`);
        assert.deepEqual(corsOf(r.headers), { ...WORKFLOW_CORS, 'access-control-allow-origin': 'https://app.invalid' }, `${method} ${path} CORS`);
      }
    } finally { env.frontendOrigin = original; }
  });

  await check('errors map to statuses with a bare { error } body and one log line each', async () => {
    const expectError = async (label: string, run: () => Promise<{ status: number; body: unknown; headers: Headers }>, status: number, error: string) => {
      f.reset();
      logged.mock.resetCalls();
      const r = await run();
      assert.equal(r.status, status, `${label} status`);
      assert.deepEqual(r.body, { error }, `${label} body`);
      assert.deepEqual(corsOf(r.headers), WORKFLOW_CORS, `${label} CORS`);
      const lines = logged.mock.calls.filter((call) => call.arguments[0] === 'Workflow request failed:');
      assert.equal(lines.length, 1, `${label} logs the failure exactly once`);
    };
    await expectError('missing token', () => request('/regenerate-summary', { body: regenerateBody, authenticated: false }), 401, 'Missing bearer token.');
    await expectError('Graph rejection', () => { f.state.graphStatus = 401; return request('/meeting-briefing', { method: 'GET' }); }, 401, 'Microsoft Graph /me rejected the token (401).');
    await expectError('invalid JSON', () => raw('/regenerate-summary', '{'), 400, 'Request body must be valid JSON.');
    await expectError('required field', () => request('/project-chat', { body: {} }), 400, 'message is required. Received fields: none.');
    await expectError('caller mismatch', () => request('/summarize-audio/jobs', { body: { ...summarizeBody, userId: '22222222-2222-4222-8222-222222222222' } }), 400,
      'Authenticated user does not match request userId.');
    await expectError('DB failure', () => { f.state.dbFailure = true; return request('/summarize-audio/jobs/fixture-job', { method: 'GET' }); }, 500, 'Fixture DB failure');
    await expectError('AI failure', () => { f.state.aiFailure = true; return request('/project-chat', { body: { project_id: 'fixture-project', message: 'What happened?' } }); }, 500, 'Project chat: Gemini API error (400): Fixture AI failure');
    // Responses a handler writes itself are not router failures and are not logged.
    logged.mock.resetCalls();
    assert.equal((await request('/transcription-test', { body: {} })).status, 403, 'handler-written 403');
    assert.equal((await request('/unknown', { method: 'GET' })).status, 404, 'router 404');
    assert.equal(logged.mock.calls.filter((call) => call.arguments[0] === 'Workflow request failed:').length, 0, 'handler-written responses and 404 are not logged as failures');
  });

  await check('route body limits are enforced before parsing and the server keeps serving', async () => {
    // /refresh-note-insight reads at most 1,000,000 bytes; ASCII whitespace (one byte each) parses to {}.
    const atLimit = await raw('/refresh-note-insight', ' '.repeat(1_000_000));
    assert.equal(atLimit.status, 400, 'a body at the limit is parsed');
    assert.deepEqual(atLimit.body, { error: 'noteId is required.' }, 'at-limit body reaches the handler');
    logged.mock.resetCalls();
    // Over the limit readBody destroys the socket before the router can answer 413.
    await assert.rejects(raw('/refresh-note-insight', ' '.repeat(1_000_001)), 'an over-limit body gets no response');
    await until(() => logged.mock.calls.some((call) => call.arguments[0] === 'Workflow request failed:'), 'over-limit failure log');
    const failure = logged.mock.calls.find((call) => call.arguments[0] === 'Workflow request failed:');
    assert.equal((failure?.arguments[1] as Error | undefined)?.message, 'Request body is too large.', 'the router saw the too-large error');
    assert.equal((await request('/health', { method: 'GET' })).status, 200, 'the server keeps serving after a destroyed request');
  });
});

test('startServer owns the boot sweep, the sweep interval and process listeners exactly once', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  const { workflowFixture } = await import('./test-support/workflow.js');
  const { ORPHANED_JOB_SWEEP_INTERVAL_MS } = await import('./jobs/store.js');
  const f = await bounded(workflowFixture(), 'fixture start');
  await bounded(new Promise<void>((resolve) => f.server.close(() => resolve())), 'fixture listener close');
  t.after(() => f.close());
  const { server, startServer } = await import('./index.js');
  const scans = () => f.state.calls.filter((call) => call.url.pathname === '/rest/v1/workflow_job' && call.url.searchParams.has('or')).length;
  const before = { rejection: process.listenerCount('unhandledRejection'), exception: process.listenerCount('uncaughtException') };
  const dispatcher = getGlobalDispatcher();
  const intervals = t.mock.method(globalThis, 'setInterval');
  const clears = t.mock.method(globalThis, 'clearInterval');
  const stop = startServer({ port: 0, host: '127.0.0.1', dispatcher });
  let stopped = false;
  t.after(async () => { if (!stopped) await stop(); });
  await bounded(once(server, 'listening'), 'listening');
  await until(() => scans() === 1, 'boot sweep');
  const sweepTimers = intervals.mock.calls.filter((call) => call.arguments[1] === ORPHANED_JOB_SWEEP_INTERVAL_MS);
  const listeners = { rejection: process.listenerCount('unhandledRejection'), exception: process.listenerCount('uncaughtException') };
  const intervalsBeforeSecondStart = intervals.mock.callCount();
  assert.throws(() => startServer({ port: 0, host: '127.0.0.1', dispatcher }), { message: 'Workflow server is already listening.' });
  const afterSecondStart = { intervals: intervals.mock.callCount(), rejection: process.listenerCount('unhandledRejection') };
  // The scheduled callback runs the same sweep.
  (sweepTimers[0]?.arguments[0] as (() => void) | undefined)?.();
  await until(() => scans() === 2, 'interval sweep');
  await bounded(stop(), 'stop');
  stopped = true;
  const cleared = clears.mock.calls.map((call) => call.arguments[0]);
  intervals.mock.restore();
  clears.mock.restore();
  assert.equal(sweepTimers.length, 1, 'exactly one orphan sweep interval');
  assert.equal(listeners.rejection, before.rejection + 1, 'one unhandledRejection listener while running');
  assert.equal(listeners.exception, before.exception + 1, 'one uncaughtException listener while running');
  assert.equal(afterSecondStart.intervals, intervalsBeforeSecondStart, 'a rejected second start schedules nothing');
  assert.equal(afterSecondStart.rejection, listeners.rejection, 'a rejected second start adds no listener');
  assert.ok(cleared.includes(sweepTimers[0]?.result), 'stop clears the sweep interval');
  assert.equal(process.listenerCount('unhandledRejection'), before.rejection, 'stop removes the unhandledRejection listener');
  assert.equal(process.listenerCount('uncaughtException'), before.exception, 'stop removes the uncaughtException listener');
  assert.equal(getGlobalDispatcher(), dispatcher, 'stop restores the global dispatcher');
  assert.equal(server.listening, false, 'stop closes the server');
  assert.ok(!f.state.calls.some((call) => /outbox_claim|extraction_claim/.test(call.url.pathname)), 'knowledge workers stay off without their flags');
});

test('http/router exports a request listener that index mounts on the one server', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const { createServer } = await import('node:http');
  const router = await import('./http/router.js');
  const { server } = await import('./index.js');
  assert.ok(!('server' in router), 'the router module creates no server of its own');
  assert.deepEqual(server.listeners('request'), [router.handleWorkflowRequest], 'index mounts exactly the router listener');
  // Mounted on a different server, the listener answers the same dispatch.
  const other = createServer(router.handleWorkflowRequest);
  other.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve) => other.close(() => resolve())));
  await bounded(once(other, 'listening'), 'other listening');
  const address = other.address();
  assert.ok(address && typeof address !== 'string', 'other server has a port');
  const base = `http://127.0.0.1:${address.port}`;
  const version = await bounded(fetch(`${base}/version`), 'GET /version');
  assert.equal(version.status, 200, '/version on the mounted listener');
  assert.equal((await bounded(version.json(), 'version body') as { sha: string }).sha, SHA, 'the same VERSION_INFO');
  const missing = await bounded(fetch(`${base}/unknown`), 'GET /unknown');
  assert.equal(missing.status, 404, 'unknown path on the mounted listener');
  assert.deepEqual(await bounded(missing.json(), 'missing body'), NOT_FOUND, 'host 404 body');
});
