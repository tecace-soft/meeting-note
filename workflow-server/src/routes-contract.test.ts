import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { workflowFixture, USER, OTHER, ADMIN, summarizeBody, regenerateBody } from './test-support/workflow.js';

const chatBody = { project_id: 'fixture-project', message: 'What happened?' };
const issueBody = { title: 'Fixture issue', description: 'Fixture description' };
const issueKey = 'FB-20261022-AAAAAAAA';

test('T1-0a authenticated route contracts use offline Graph, Supabase and AI boundaries', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const f = await workflowFixture();
  t.after(() => f.close());
  const check = (name: string, run: () => Promise<void>) => t.test(name, async () => { f.reset(); await run(); });
  await check('summarize-audio success preserves result and persists note', async () => {
    const r = await f.request('/summarize-audio', { body: summarizeBody });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.summary, 'Fixture summary');
    assert.deepEqual(Object.keys(r.body).sort(), ['transcript', 'summary', 'summaryTranslations', 'transcriptionLanguage', 'transcriptionTranslations', 'diarizationTranslations', 'title', 'tags', 'audioDurationSeconds', 'meetingStartAt'].sort());
    assert.ok(f.state.calls.some((c) => c.url.pathname === '/rest/v1/note' && c.method === 'POST'));
    assert.ok(!f.state.calls.some((c) => c.url.hostname === 'api.assemblyai.com'), 'checkpoint reuses transcription');
  });
  await check('summary and job submissions reject a caller/body mismatch before pipeline', async () => {
    for (const path of ['/summarize-audio', '/summarize-audio/jobs']) {
      const r = await f.request(path, { body: { ...summarizeBody, userId: OTHER } });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /does not match request userId/);
    }
    assert.ok(f.state.calls.every((c) => c.url.hostname === 'graph.microsoft.com'));
  });
  await check('summary fails on a mandatory AI dependency failure', async () => {
    f.state.aiFailure = true;
    const r = await f.request('/summarize-audio', { body: summarizeBody });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /Fixture AI failure/);
  });
  await check('job submission deduplicates and GET returns current job contract', async () => {
    const r = await f.request('/summarize-audio/jobs', { body: summarizeBody });
    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { jobId: 'fixture-job', status: 'processing', stage: 'processing', progress: 25, deduplicated: true });
    assert.deepEqual((await f.request('/summarize-audio/jobs/fixture-job?fixture=1', { method: 'GET' })).body, { jobId: 'fixture-job', noteId: 'fixture-note', status: 'processing', stage: 'processing', progress: 25, result: null, error: null });
    f.state.caller = OTHER;
    assert.equal((await f.request('/summarize-audio/jobs/fixture-job', { method: 'GET' })).status, 400);
  });
  await check('job routes expose DB failures and do not claim success', async () => {
    f.state.dbFailure = true;
    assert.equal((await f.request('/summarize-audio/jobs', { body: summarizeBody })).status, 500);
    assert.equal((await f.request('/summarize-audio/jobs/fixture-job', { method: 'GET' })).status, 500);
  });
  await check('regenerate-summary success, denied access and DB failure', async () => {
    const success = await f.request('/regenerate-summary', { body: regenerateBody });
    assert.equal(success.status, 200, success.text);
    f.state.noteOwner = OTHER;
    assert.equal((await f.request('/regenerate-summary', { body: regenerateBody })).status, 403);
    f.state.dbFailure = true;
    assert.equal((await f.request('/regenerate-summary', { body: regenerateBody })).status, 500);
  });
  await check('refresh-note-insight success, denied access and failed extraction', async () => {
    const options = { body: { noteId: 'fixture-note' } };
    assert.deepEqual((await f.request('/refresh-note-insight', options)).body, { ok: true, noteId: 'fixture-note' });
    f.state.noteOwner = OTHER;
    assert.equal((await f.request('/refresh-note-insight', options)).status, 403);
    f.state.noteOwner = USER;
    f.state.aiFailure = true;
    assert.equal((await f.request('/refresh-note-insight', options)).status, 502);
  });
  await check('meeting-briefing success, rejected Graph token and DB failure', async () => {
    assert.equal((await f.request('/meeting-briefing', { method: 'GET' })).status, 200);
    f.state.graphStatus = 401;
    assert.equal((await f.request('/meeting-briefing', { method: 'GET' })).status, 401);
    f.state.graphStatus = 200;
    f.state.dbFailure = true;
    assert.equal((await f.request('/meeting-briefing', { method: 'GET' })).status, 500);
  });
  await check('product-docs index/detail require org membership and preserve JSON contract', async () => {
    for (const path of ['/product-docs', '/product-docs/architecture']) {
      const r = await f.request(path, { method: 'GET' });
      assert.equal(r.status, 200, r.text);
      assert.ok(r.body && typeof r.body === 'object');
      // A different token avoids the existing intentional identity cache.
      f.state.caller = OTHER;
      f.state.tenant = OTHER;
      assert.equal((await f.request(path, { method: 'GET' })).status, 403);
      f.reset();
    }
    f.state.caller = OTHER;
    f.state.graphStatus = 503;
    assert.equal((await f.request('/product-docs', { method: 'GET' })).status, 401);
  });
  await check('issue-resolution enforces triage rights and handles AI failure', async () => {
    assert.equal((await f.request('/issue-resolution', { body: issueBody })).status, 403);
    f.state.caller = ADMIN;
    const r = await f.request('/issue-resolution', { body: issueBody });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.resolution.summary, 'Fixture summary');
    f.state.aiFailure = true;
    assert.equal((await f.request('/issue-resolution', { body: issueBody })).status, 500);
  });
  await check('issue-notify succeeds without sending mail and rejects non-admin notifications', async () => {
    const options = { body: { issueKey, kind: 'assigned' } };
    assert.equal((await f.request('/issue-notify', options)).status, 403);
    f.state.caller = ADMIN;
    assert.deepEqual((await f.request('/issue-notify', options)).body, { ok: true, notifiedEmails: [] });
    f.state.dbFailure = true;
    assert.equal((await f.request('/issue-notify', options)).status, 500);
    assert.ok(!f.state.calls.some((c) => c.url.hostname === 'api.resend.com'));
  });
  for (const path of ['/project-chat', '/project-chat/stream']) await check(`${path} success, note visibility, denied access and dependency failures`, async () => {
    const r = await f.request(path, { body: chatBody });
    assert.equal(r.status, 200, r.text);
    assert.ok(f.state.calls.some((c) => c.url.pathname === '/rest/v1/note' && c.url.searchParams.has('or')), 'service-role note read keeps per-note access filter');
    if (path.endsWith('/stream')) {
      assert.equal(r.headers.get('content-type'), 'text/event-stream');
      assert.equal(r.headers.get('cache-control'), 'no-cache, no-transform');
      assert.equal(r.headers.get('x-accel-buffering'), 'no');
      assert.equal(r.text, 'data: {"delta":""}\n\ndata: {"delta":"Fixture answer"}\n\ndata: {"done":true}\n\n');
    } else assert.equal(typeof r.body.response, 'string');
    f.state.projectOwner = OTHER;
    assert.equal((await f.request(path, { body: chatBody })).status, 403);
    f.state.projectOwner = USER;
    f.state.dbFailure = true;
    assert.equal((await f.request(path, { body: chatBody })).status, 500);
    f.state.dbFailure = false;
    f.state.aiFailure = true;
    assert.equal((await f.request(path, { body: chatBody })).status, 500);
  });
  await check('empty project SSE sends fallback delta, done and closes', async () => {
    f.state.emptyNotes = true;
    const r = await f.request('/project-chat/stream', { body: chatBody });
    assert.equal(r.status, 200);
    assert.match(r.text, /cannot find the answer/);
    assert.ok(r.text.endsWith('data: {"done":true}\n\n'));
    assert.ok(!f.state.calls.some((c) => c.url.hostname === 'generativelanguage.googleapis.com'));
  });
  await check('backfill route falls through MCP, enforces admin and propagates DB failure', async () => {
    assert.equal((await f.request('/admin/backfill-insight', { body: {} })).status, 403);
    f.state.caller = ADMIN;
    assert.deepEqual((await f.request('/admin/backfill-insight', { body: {} })).body, { processed: 0, written: 0, failed: 0, sampleFailures: [] });
    f.state.dbFailure = true;
    assert.equal((await f.request('/admin/backfill-insight', { body: {} })).status, 500);
  });
  await check('transcription-test keeps its special-user gate and AssemblyAI response shape', async () => {
    const body = { fileName: 'fixture.ogg', dataBase64: 'T2dnUw==', mimeType: 'audio/ogg', model: 'assembly_universal2_codeswitch' };
    assert.equal((await f.request('/transcription-test', { body })).status, 403);
    // Reuse the existing gate without duplicating an operational id in the fixture.
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    f.state.caller = source.match(/const TRANSCRIPTION_MODEL_TEST_USER_ID = '([^']+)'/)![1]!;
    const r = await f.request('/transcription-test', { body });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.model, body.model);
    assert.equal(r.body.fileName, body.fileName);
    f.state.aiFailure = true;
    assert.equal((await f.request('/transcription-test', { body })).status, 500);
  });
  await check('Android upload accepts multipart audio and creates a queued job', async () => {
    const boundary = 'meeting-note-test-boundary';
    const form = `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="fixture.ogg"\r\nContent-Type: audio/ogg\r\n\r\nfixture-audio\r\n--${boundary}--\r\n`;
    const token = `fixture.${Buffer.from(JSON.stringify({ oid: USER, tid: f.state.tenant })).toString('base64url')}.fixture`;
    const r = await fetch(f.base + '/android/recordings/jobs', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, body: form });
    const body = await r.json() as Record<string, unknown>;
    assert.equal(r.status, 202, JSON.stringify(body));
    assert.equal(body.jobId, 'fixture-job');
    assert.equal(body.status, 'queued');
    assert.equal(typeof body.noteId, 'string');
    assert.equal(typeof body.fileId, 'string');
    // Let the real runner finish against fake dependencies before resetting them.
    for (let attempt = 0; attempt < 100 && f.state.jobStatus !== 'completed'; attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(f.state.jobStatus, 'completed');
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.state.dbFailure = true;
    const failure = await fetch(f.base + '/android/recordings/jobs', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, body: form });
    assert.equal(failure.status, 500);
    await failure.text();
  });
  await check('Android upload validates multipart input after auth', async () => {
    const r = await f.request('/android/recordings/jobs', { body: {} });
    assert.equal(r.status, 400, r.text);
    assert.match(r.body.error, /multipart/);
    f.state.graphStatus = 403;
    assert.equal((await f.request('/android/recordings/jobs', { body: {} })).status, 401);
  });
});
