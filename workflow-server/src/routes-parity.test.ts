import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowFixture, summarizeBody, regenerateBody } from './test-support/workflow.js';

// Each row executes the real if-chain with a valid-shaped request and no token.
const routes: Array<[string, string, unknown, number]> = [
  ['GET', '/', undefined, 200], ['GET', '/health', undefined, 200], ['GET', '/version', undefined, 200],
  ['POST', '/summarize-audio', summarizeBody, 401], ['POST', '/transcription-test', {}, 401],
  ['POST', '/admin/backfill-insight', {}, 401], ['POST', '/regenerate-summary', regenerateBody, 401],
  ['POST', '/refresh-note-insight', { noteId: 'fixture-note' }, 401], ['GET', '/meeting-briefing', undefined, 401],
  ['GET', '/product-docs', undefined, 401], ['GET', '/product-docs/architecture', undefined, 401],
  ['POST', '/issue-resolution', {}, 401], ['POST', '/issue-notify', {}, 401],
  ['POST', '/project-chat', {}, 401], ['POST', '/project-chat/stream', {}, 401],
  ['POST', '/summarize-audio/jobs', summarizeBody, 401], ['POST', '/android/recordings/jobs', undefined, 401],
  ['GET', '/summarize-audio/jobs/fixture-job', undefined, 401],
];

test('T1-0a route parity and dispatch ownership', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const f = await workflowFixture();
  t.after(() => f.close());
  for (const [method, path, body, status] of routes) await t.test(`${method} ${path}: unauthenticated ${status}`, async () => {
    assert.equal((await f.request(path, { method, body, authenticated: false })).status, status);
  });
  await t.test('exact req.url POST routes reject query strings', async () => {
    for (const [method, path, body] of routes.filter(([method, path]) => method === 'POST' && path !== '/issue-resolution')) {
      assert.equal((await f.request(path + '?fixture=1', { method, body, authenticated: false })).status, 404, path);
    }
    assert.equal((await f.request('/issue-resolution?fixture=1', { body: {}, authenticated: false })).status, 401);
  });
  await t.test('pathname routes accept query strings and wrong methods retain existing semantics', async () => {
    assert.equal((await f.request('/meeting-briefing?fixture=1', { method: 'GET', authenticated: false })).status, 401);
    assert.equal((await f.request('/issue-resolution', { method: 'GET' })).status, 405);
    assert.equal((await f.request('/project-chat', { method: 'GET' })).status, 404);
    assert.equal((await f.request('/unknown', { method: 'GET' })).status, 404);
  });
  await t.test('OPTIONS precedes MCP, knowledge owns its own preflight', async () => {
    for (const path of ['/unknown', '/mcp', '/mcp-chatgpt', '/admin/backfill-insight']) {
      const r = await f.request(path, { method: 'OPTIONS' });
      assert.equal(r.status, 204);
      assert.equal(r.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    }
    for (const path of ['/knowledge/v1/access-check', '/knowledge/v1/evidence-fetch', '/knowledge/v1/source-access']) {
      const r = await f.request(path, { method: 'OPTIONS' });
      assert.equal(r.status, 404);
      assert.deepEqual(r.body, { error: 'NOT_FOUND' });
    }
    for (const path of ['/mcp', '/mcp-chatgpt']) {
      assert.equal((await f.request(path, { method: 'POST', authenticated: false })).status, 401);
    }
  });
  await t.test('health keys and version shape', async () => {
    const r = await f.request('/health', { method: 'GET' });
    assert.deepEqual(Object.keys(r.body).sort(), ['ok', 'service', 'version', 'transcriptionProvider', 'transcriptionModel', 'transcriptionLanguageMode', 'selectedLanguageAffectsTranscription', 'codeSwitchingModel', 'summaryModel', 'regenerateSummaryModel', 'projectChatModel', 'msTenantGate', 'msClientGate'].sort());
    const version = (await f.request('/version?fixture=1', { method: 'GET' })).body;
    assert.deepEqual(Object.keys(version).sort(), ['service', 'sha', 'shortSha', 'branch', 'deployedAt'].sort());
    assert.ok(Number.isFinite(Date.parse(version.deployedAt)));
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(r.headers.get('vary'), 'Origin');
  });
});
