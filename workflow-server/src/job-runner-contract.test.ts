// T1-9b characterization: pins the job routes (sync summarize, job creation with dedup and
// the unique-violation race, Android job creation, job status reads with the in-memory
// result cache), the summarize job runner (status/progress transitions, heartbeat, terminal
// write retries, error mapping, incidents, checkpoint reuse on retry) and the orphan sweep
// (scan criteria, note-based recovery, what it writes) before they leave index.ts.
// Offline only: fetch and supabase.from are faked, nothing reads .env.
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGlobalDispatcher } from 'undici';
// Service config must exist before the server modules read env at import time. F9 is
// enabled so a raised incident is observable as a fake feedback_issues query (alerts stay
// disabled by the preload; no mail is ever sent).
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role';
process.env.GEMINI_API_KEY = 'synthetic-gemini';
process.env.ASSEMBLYAI_API_KEY = 'synthetic-assembly';
process.env.F9_OPS_AGENT_ENABLED = 'true';
const { supabase } = await import('./db/supabaseClient.js');
const { env } = await import('./config/env.js');
const { noSpeechMessage } = await import('./pipeline/errors.js');
const { parseSummarizeInput } = await import('./pipeline/inputs.js');
const { workflowFixture, summarizeBody, USER, OTHER } = await import('./test-support/workflow.js');
const { processSummarizeJob, completedJobResults } = await import('./jobs/runner.js');
const { reconstructResultFromNote, failOrphanedJobs, MAX_ORPHAN_RECONCILE } = await import('./jobs/sweep.js');
const { server, startServer } = await import('./index.js');

type Fixture = Awaited<ReturnType<typeof workflowFixture>>;
type FetchInput = Parameters<typeof fetch>[0];
type Override = (url: URL, method: string, init: RequestInit | undefined, body: any) => Promise<Response | undefined> | Response | undefined;

const parseJson = (body: unknown) => {
  if (typeof body !== 'string') return null;
  try { return JSON.parse(body); } catch { return null; }
};
const toUrl = (input: FetchInput) => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, label: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await sleep(5);
  assert.ok(condition(), `timed out waiting for ${label}`);
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

// Starts the shared offline HTTP fixture and layers per-test fetch overrides on top of it.
async function fixture(t: test.TestContext, override: Override = () => undefined): Promise<Fixture> {
  const f = await workflowFixture();
  const fixtureFetch = globalThis.fetch;
  const intercept = t.mock.method(globalThis, 'fetch', async (input: FetchInput, init?: RequestInit) => {
    const url = toUrl(input);
    const method = init?.method ?? 'GET';
    const body = parseJson(init?.body);
    // Keep the F9 ticket path quiet and fast: no open tickets, no recent ticket count.
    if (isTable(url, 'feedback_issues')) {
      f.state.calls.push({ url, method, body });
      if (method === 'HEAD') return new Response(null, { headers: { 'content-range': '0-0/0' } });
      return Response.json(method === 'GET' ? [] : null);
    }
    const replaced = await override(url, method, init, body);
    if (replaced) {
      f.state.calls.push({ url, method, body });
      return replaced;
    }
    return fixtureFetch(input, init);
  });
  // Restore the override before the fixture so fetch unwinds to the native function.
  t.after(async () => { intercept.mock.restore(); await f.close(); });
  f.state.existingJob = false;
  return f;
}
const isTable = (url: URL, table: string) => url.hostname === 'supabase.invalid' && url.pathname === `/rest/v1/${table}`;
const jobPatches = (f: Fixture, jobId: string) => f.state.calls
  .filter((c) => isTable(c.url, 'workflow_job') && c.method === 'PATCH' && c.url.searchParams.get('id') === `eq.${jobId}`)
  .map((c) => c.body as Record<string, unknown>);
const withoutUpdatedAt = (patch: Record<string, unknown>) => {
  const { updated_at: updatedAt, ...rest } = patch;
  assert.equal(new Date(String(updatedAt)).toISOString(), updatedAt, 'every job write stamps updated_at');
  return rest;
};
const assemblyCalls = (f: Fixture) => f.state.calls.filter((c) => c.url.hostname === 'api.assemblyai.com');
const incidentQueries = (f: Fixture) => f.state.calls.filter((c) => isTable(c.url, 'feedback_issues'));
const noCheckpoint: Override = (url, method) => (isTable(url, 'workflow_transcript_checkpoint') && method === 'GET' ? Response.json(null) : undefined);
const input = () => parseSummarizeInput({ ...summarizeBody });

// ---------------------------------------------------------------------------
// Job creation and status routes
// ---------------------------------------------------------------------------

test('job creation inserts a queued summarize_audio row, answers 202 and starts the runner', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const f = await fixture(t);
  const r = await f.request('/summarize-audio/jobs', { body: { ...summarizeBody, userName: 'Ann' } });
  assert.equal(r.status, 202, r.text);
  assert.deepEqual(r.body, { jobId: 'fixture-job', status: 'queued', stage: 'queued', progress: 0 });
  const dedup = f.state.calls.find((c) => isTable(c.url, 'workflow_job') && c.method === 'GET')!;
  assert.deepEqual(Object.fromEntries(dedup.url.searchParams), {
    select: 'id,status,stage,progress', user_id: `eq.${USER}`, note_id: 'eq.fixture-note',
    status: 'in.(queued,processing,completed)', order: 'updated_at.desc', limit: '1',
  });
  const insert = f.state.calls.find((c) => isTable(c.url, 'workflow_job') && c.method === 'POST')!;
  assert.equal(insert.url.searchParams.get('select'), 'id');
  const { updated_at: updatedAt, ...row } = insert.body;
  assert.equal(new Date(updatedAt).toISOString(), updatedAt);
  assert.deepEqual(row, {
    user_id: USER, note_id: 'fixture-note', type: 'summarize_audio', status: 'queued', stage: 'queued', progress: 0,
    request: JSON.parse(JSON.stringify(parseSummarizeInput({ ...summarizeBody, userName: 'Ann' }))),
  });
  await until(() => f.state.jobStatus === 'completed', 'the started job to complete');
  await sleep(20);
});

test('job creation returns an existing queued, processing or completed job without starting a run', async (t) => {
  for (const [status, stage, progress, expected] of [
    ['processing', 'transcribing audio', 25, { stage: 'transcribing audio', progress: 25 }],
    ['completed', null, null, { stage: 'completed', progress: 0 }],
    ['queued', null, 0, { stage: 'queued', progress: 0 }],
  ] as const) {
    await t.test(status, async (st) => {
      const f = await fixture(st, (url, method) => (isTable(url, 'workflow_job') && method === 'GET'
        ? Response.json({ id: 'existing-job', status, stage, progress }) : undefined));
      const r = await f.request('/summarize-audio/jobs', { body: summarizeBody });
      assert.equal(r.status, 202, r.text);
      assert.deepEqual(r.body, { jobId: 'existing-job', status, ...expected, deduplicated: true });
      await sleep(20);
      assert.ok(!f.state.calls.some((c) => isTable(c.url, 'workflow_job') && c.method !== 'GET'), 'no insert and no job writes');
      assert.equal(assemblyCalls(f).length, 0, 'no transcription for a deduplicated submission');
    });
  }
});

test('a concurrent duplicate insert (23505) converges on the winner job, other insert errors surface', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  let reselect: 'row' | 'empty' | 'error' = 'row';
  let insertError: { code: string; message: string } = { code: '23505', message: 'duplicate key value violates unique constraint "workflow_job_active_note_uniq"' };
  let gets = 0;
  const f = await fixture(t, (url, method) => {
    if (!isTable(url, 'workflow_job')) return undefined;
    if (method === 'POST') return Response.json(insertError, { status: 409 });
    if (method !== 'GET') return undefined;
    gets += 1;
    if (gets === 1) return Response.json(null);
    if (reselect === 'error') return Response.json({ message: 'reselect failed' }, { status: 500 });
    return Response.json(reselect === 'row' ? { id: 'winner-job', status: 'queued', stage: null, progress: null } : null);
  });
  const r = await f.request('/summarize-audio/jobs', { body: summarizeBody });
  assert.equal(r.status, 202, r.text);
  assert.deepEqual(r.body, { jobId: 'winner-job', status: 'queued', stage: 'queued', progress: 0, deduplicated: true });
  const [first, second] = f.state.calls.filter((c) => isTable(c.url, 'workflow_job') && c.method === 'GET');
  assert.deepEqual(Object.fromEntries(second!.url.searchParams), Object.fromEntries(first!.url.searchParams), 'the race re-select repeats the dedup query');
  for (const mode of ['empty', 'error'] as const) {
    f.reset(); f.state.existingJob = false; gets = 0; reselect = mode;
    const raced = await f.request('/summarize-audio/jobs', { body: summarizeBody });
    assert.equal(raced.status, 500, mode);
    assert.equal(raced.body.error, insertError.message, `${mode}: the original insert error is thrown`);
  }
  f.reset(); f.state.existingJob = false; gets = 0; reselect = 'row';
  insertError = { code: '42501', message: 'permission denied for table workflow_job' };
  const denied = await f.request('/summarize-audio/jobs', { body: summarizeBody });
  assert.equal(denied.status, 500);
  assert.equal(denied.body.error, 'permission denied for table workflow_job');
  assert.equal(f.state.calls.filter((c) => isTable(c.url, 'workflow_job') && c.method === 'GET').length, 1, 'no re-select for other errors');
  await sleep(20);
  assert.equal(assemblyCalls(f).length, 0, 'no run starts without a created job');
});

test('job creation requires a non-blank id back; the runner uses the trimmed id, the response the raw id', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'log', () => undefined);
  let inserted: unknown = {};
  const f = await fixture(t, (url, method) => (isTable(url, 'workflow_job') && method === 'POST' ? Response.json(inserted) : undefined));
  for (const row of [{}, { id: '   ' }, { id: 42 }]) {
    inserted = row;
    const r = await f.request('/summarize-audio/jobs', { body: summarizeBody });
    assert.equal(r.status, 500, JSON.stringify(row));
    assert.equal(r.body.error, 'Could not create workflow job.');
  }
  inserted = { id: ' padded-job ' };
  const r = await f.request('/summarize-audio/jobs', { body: summarizeBody });
  assert.equal(r.status, 202, r.text);
  assert.equal(r.body.jobId, ' padded-job ');
  await until(() => jobPatches(f, 'padded-job').some((p) => p.status === 'completed'), 'the trimmed job id to complete');
  await sleep(20);
});

test('summarize routes parse the body before authenticating the caller', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const f = await fixture(t);
  for (const path of ['/summarize-audio', '/summarize-audio/jobs']) {
    const r = await f.request(path, { body: { ...summarizeBody, noteId: '' }, authenticated: false });
    assert.equal(r.status, 400, path);
    assert.match(r.body.error, /^noteId is required\./);
  }
  assert.ok(!f.state.calls.some((c) => c.url.hostname === 'graph.microsoft.com' || c.url.hostname === 'api.assemblyai.com' || isTable(c.url, 'workflow_job')),
    'no Graph, job or provider call for an invalid body');
});

test('job status read: owner check, defaults, cached result preference and one-shot cache eviction', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  let row: Record<string, unknown> | null = null;
  const f = await fixture(t, (url, method) => (isTable(url, 'workflow_job') && method === 'GET' ? Response.json(row) : undefined));
  const get = (id: string) => f.request(`/summarize-audio/jobs/${id}`, { method: 'GET' });
  const base = { id: 'job-1', user_id: USER, note_id: 'note-1', result: { stored: true }, error: null };

  row = null;
  const missing = await get('job-1');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'Workflow job not found.' });
  const query = f.state.calls.find((c) => isTable(c.url, 'workflow_job'))!;
  assert.deepEqual(Object.fromEntries(query.url.searchParams), { select: 'id,user_id,note_id,status,stage,progress,result,error', id: 'eq.job-1' });

  row = { ...base, status: 'processing', stage: null, progress: null };
  completedJobResults.set('job-1', { cached: true } as never);
  assert.deepEqual((await get('job-1')).body, { jobId: 'job-1', noteId: 'note-1', status: 'processing', stage: 'processing', progress: 0, result: null, error: null });
  assert.ok(completedJobResults.has('job-1'), 'a non-completed read keeps the cache');

  row = { ...base, status: 'completed', stage: 'completed', progress: 100 };
  assert.deepEqual((await get('job-1')).body.result, { cached: true }, 'the in-memory result wins over the stored row');
  assert.ok(!completedJobResults.has('job-1'), 'a completed read evicts the cache entry');
  assert.deepEqual((await get('job-1')).body.result, { stored: true }, 'later reads fall back to the stored row');

  row = { ...base, status: 'failed', stage: 'failed', progress: 100, error: 'Boom' };
  assert.deepEqual((await get('job-1')).body, { jobId: 'job-1', noteId: 'note-1', status: 'failed', stage: 'failed', progress: 100, result: null, error: 'Boom' });

  f.state.calls.length = 0;
  row = { ...base, id: 'a b', status: 'queued', stage: 'queued', progress: 0 };
  assert.equal((await get('a%20b')).status, 200);
  assert.equal(f.state.calls.find((c) => isTable(c.url, 'workflow_job'))!.url.searchParams.get('id'), 'eq.a b', 'the path id is URI-decoded');

  row = { ...base, user_id: OTHER, status: 'completed', stage: 'completed', progress: 100 };
  completedJobResults.set('job-1', { cached: true } as never);
  const foreign = await get('job-1');
  assert.equal(foreign.status, 400);
  assert.equal(foreign.body.error, 'Authenticated user does not match workflow job userId.');
  assert.ok(completedJobResults.has('job-1'), 'a foreign read never evicts the owner result');
  completedJobResults.delete('job-1');
});

test('synchronous summarize maps no-speech to 422 and never writes a job row', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  const f = await fixture(t, (url, method, init) => {
    const checkpoint = noCheckpoint(url, method, init, null);
    if (checkpoint) return checkpoint;
    if (url.hostname === 'api.assemblyai.com' && !url.pathname.includes('/upload')) return Response.json({ id: 'fixture-transcript', status: 'completed', text: '', utterances: [] });
    return undefined;
  });
  const r = await f.request('/summarize-audio', { body: { ...summarizeBody, language: 'ko' } });
  assert.equal(r.status, 422, r.text);
  assert.deepEqual(r.body, { error: noSpeechMessage('ko') });
  assert.ok(!f.state.calls.some((c) => isTable(c.url, 'workflow_job')), 'the synchronous route has no job row');
  await sleep(20);
});

test('Android job creation runs the plain summarize input and always removes the temp upload', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'warn', () => undefined);
  const scratch = await mkdtemp(join(tmpdir(), 'job-runner-contract-'));
  const saved = { TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { TMP: scratch, TEMP: scratch, TMPDIR: scratch });
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(scratch, { recursive: true, force: true });
  });
  assert.equal(tmpdir(), scratch, 'uploads land in the private scratch directory');
  const f = await fixture(t, noCheckpoint);
  const boundary = 'job-runner-contract-boundary';
  const form = `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="fixture.ogg"\r\nContent-Type: audio/ogg\r\n\r\nfixture-audio\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\nStandup\r\n--${boundary}--\r\n`;
  const token = `fixture.${Buffer.from(JSON.stringify({ oid: USER, tid: f.state.tenant })).toString('base64url')}.fixture`;
  const send = async () => {
    const r = await fetch(f.base + '/android/recordings/jobs', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, body: form });
    return { status: r.status, body: await r.json() as Record<string, any> };
  };

  const r = await send();
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.deepEqual(await readdir(scratch), [], 'the temp upload is removed after a successful submission');
  await until(() => f.state.jobStatus === 'completed', 'the Android job to complete');
  await sleep(20);
  const job = f.state.calls.find((c) => isTable(c.url, 'workflow_job') && c.method === 'POST')!.body;
  assert.equal(job.request.source, 'android_recording', 'the stored request keeps the Android extras');
  const submit = assemblyCalls(f).find((c) => c.method === 'POST' && c.url.pathname === '/v2/transcript')!;
  assert.equal(submit.body.audio_url, job.request.downloadUrl, 'the runner transcribes the signed upload URL');
  const note = f.state.calls.find((c) => isTable(c.url, 'note') && c.method === 'POST')!.body;
  const saved0 = Array.isArray(note) ? note[0] : note;
  assert.deepEqual([saved0.id, saved0.user_id], [r.body.noteId, USER]);
  assert.ok(!('source' in saved0) && !('storagePath' in saved0), 'request extras never reach the note');

  f.reset();
  f.state.existingJob = false;
  f.state.dbFailure = true;
  const failed = await send();
  assert.equal(failed.status, 500);
  assert.deepEqual(await readdir(scratch), [], 'the temp upload is removed after a failed submission');
});

// ---------------------------------------------------------------------------
// Runner: processSummarizeJob
// ---------------------------------------------------------------------------

test('runner success: stage writes, completed result, cache, then post-completion enrichment', async (t) => {
  const trace: string[] = [];
  t.mock.method(console, 'log', (message: unknown) => { if (String(message).startsWith('Memory fold')) trace.push('finalize'); });
  const f = await fixture(t, (url, method, init, body) => {
    if (isTable(url, 'workflow_job') && method === 'PATCH') trace.push(`job:${body.status ?? body.stage ?? 'heartbeat'}`);
    return noCheckpoint(url, method, init, body);
  });
  completedJobResults.delete('job-ok');
  await processSummarizeJob('job-ok', input());
  const patches = jobPatches(f, 'job-ok').map(withoutUpdatedAt);
  const done = patches.at(-1)!;
  assert.deepEqual(patches.slice(0, -1), [
    { status: 'processing', stage: 'loading inputs', progress: 10 },
    { stage: 'transcribing audio', progress: 25 },
    { stage: 'generating summary', progress: 75 },
    { stage: 'saving note', progress: 92 },
  ]);
  assert.deepEqual(Object.keys(done).sort(), ['error', 'progress', 'result', 'stage', 'status']);
  assert.deepEqual([done.status, done.stage, done.progress, done.error], ['completed', 'completed', 100, null]);
  assert.deepEqual(completedJobResults.get('job-ok'), done.result, 'the same result is cached for the next status read');
  assert.equal(trace.indexOf('job:completed') + 1, trace.indexOf('finalize'), 'enrichment starts only after the completed write');
  assert.equal(incidentQueries(f).length, 0);
  completedJobResults.delete('job-ok');
});

test('runner heartbeat bumps updated_at every minute until enrichment ends, even after completion', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const assembly = deferred();
  const enrichment = deferred();
  let completedSeen = false;
  let transcribing = false;
  const f = await fixture(t, async (url, method, init, body) => {
    if (isTable(url, 'workflow_job') && method === 'PATCH' && body.status === 'completed') completedSeen = true;
    else if (completedSeen && url.hostname === 'supabase.invalid' && url.pathname.startsWith('/rest/v1/') && !isTable(url, 'workflow_job')) await enrichment.promise;
    if (url.hostname === 'api.assemblyai.com') { transcribing = true; await assembly.promise; }
    return noCheckpoint(url, method, init, body);
  });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const heartbeats = () => jobPatches(f, 'job-hb').filter((p) => Object.keys(p).length === 1 && 'updated_at' in p).length;
  const run = processSummarizeJob('job-hb', input());
  await until(() => transcribing, 'the transcription to start');
  t.mock.timers.tick(59_999); await turn();
  const before = heartbeats();
  t.mock.timers.tick(1); await sleep(10);
  const first = heartbeats();
  t.mock.timers.tick(60_000); await sleep(10);
  const second = heartbeats();
  assembly.release();
  await until(() => completedSeen, 'the completed write');
  await sleep(10);
  t.mock.timers.tick(60_000); await sleep(10);
  const afterCompleted = heartbeats();
  enrichment.release();
  await run;
  t.mock.timers.tick(180_000); await sleep(10);
  const afterEnd = heartbeats();
  t.mock.timers.reset();
  assert.deepEqual([before, first, second], [0, 1, 2], 'one empty patch per minute while transcribing');
  assert.equal(afterCompleted, 3, 'the heartbeat keeps running while post-completion enrichment runs');
  assert.equal(afterEnd, 3, 'the heartbeat stops once the runner returns');
  assert.equal(f.state.jobStatus, 'completed', 'heartbeats never change the status');
  completedJobResults.delete('job-hb');
});

test('runner failure: failed write with the message, error log and an ops incident', async (t) => {
  const error = t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'warn', () => undefined);
  const f = await fixture(t, (url, method, init, body) => {
    if (url.hostname === 'generativelanguage.googleapis.com' && url.pathname.endsWith(':generateContent')) return Response.json({ error: { message: 'Fixture summary outage' } }, { status: 400 });
    return noCheckpoint(url, method, init, body);
  });
  completedJobResults.delete('job-fail');
  await processSummarizeJob('job-fail', input());
  const failed = jobPatches(f, 'job-fail').map(withoutUpdatedAt).at(-1)!;
  assert.deepEqual(Object.keys(failed).sort(), ['error', 'progress', 'stage', 'status']);
  assert.deepEqual([failed.status, failed.stage, failed.progress], ['failed', 'failed', 100]);
  assert.match(String(failed.error), /Fixture summary outage/);
  assert.ok(!completedJobResults.has('job-fail'), 'nothing is cached for a failed job');
  assert.ok(error.mock.calls.some((c) => c.arguments[0] === 'Workflow job job-fail failed:'));
  await until(() => incidentQueries(f).length > 0, 'the incident to be filed');
});

test('runner no-speech: failed with the localized guidance, no error log and no incident', async (t) => {
  const log = t.mock.method(console, 'log', () => undefined);
  const error = t.mock.method(console, 'error', () => undefined);
  const f = await fixture(t, (url, method, init, body) => {
    if (url.hostname === 'api.assemblyai.com' && !url.pathname.includes('/upload')) return Response.json({ id: 'fixture-transcript', status: 'completed', text: '', utterances: [] });
    return noCheckpoint(url, method, init, body);
  });
  await processSummarizeJob('job-silent', parseSummarizeInput({ ...summarizeBody, language: 'ko' }));
  const failed = jobPatches(f, 'job-silent').map(withoutUpdatedAt).at(-1)!;
  assert.deepEqual(failed, { status: 'failed', stage: 'failed', progress: 100, error: noSpeechMessage('ko') });
  assert.ok(log.mock.calls.some((c) => c.arguments[0] === 'Workflow job job-silent ended with no detectable speech in the audio; surfacing to the user without an incident.'));
  assert.equal(error.mock.callCount(), 0, 'no error log');
  await sleep(30);
  assert.equal(incidentQueries(f).length, 0, 'no ops incident for a silent recording');
});

test('runner terminal writes retry four times; a lost completed write still caches and enriches', async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const log = t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  let completedAttempts = 0;
  const firstCompleted = deferred();
  const f = await fixture(t, (url, method, init, body) => {
    if (isTable(url, 'workflow_job') && method === 'PATCH' && body.status === 'completed') {
      completedAttempts += 1;
      // Fake only the backoff sleeps that follow the failed terminal write.
      if (completedAttempts === 1) { t.mock.timers.enable({ apis: ['setTimeout'] }); firstCompleted.release(); }
      return Response.json({ message: 'terminal write blip' }, { status: 503 });
    }
    return noCheckpoint(url, method, init, body);
  });
  completedJobResults.delete('job-lost');
  const run = processSummarizeJob('job-lost', input());
  await firstCompleted.promise;
  for (let i = 0; i < 400 && completedAttempts < 5; i++) { await turn(); t.mock.timers.tick(8_000); }
  for (let i = 0; i < 20; i++) await turn();
  t.mock.timers.reset();
  await run;
  assert.equal(completedAttempts, 5, 'one write plus four retries');
  assert.ok(warn.mock.calls.some((c) => c.arguments[0] === 'Could not update workflow job job-lost: terminal write blip'));
  assert.ok(warn.mock.calls.some((c) => c.arguments[0] === 'Workflow job job-lost completed but its terminal status write failed; the note is persisted and the orphan sweep will reconcile it.'));
  assert.ok(!jobPatches(f, 'job-lost').some((p) => p.status === 'failed'), 'a persisted note is never marked failed');
  assert.ok(completedJobResults.has('job-lost'), 'the result is still cached');
  assert.ok(log.mock.calls.some((c) => String(c.arguments[0]).startsWith('Memory fold note=fixture-note')), 'enrichment still runs');
  completedJobResults.delete('job-lost');
});

test('a retried job for the same note reuses the transcript checkpoint instead of paying AssemblyAI again', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'warn', () => undefined);
  let checkpoint: Record<string, unknown> | null = null;
  let summaryDown = true;
  const f = await fixture(t, (url, method, _init, body) => {
    if (isTable(url, 'workflow_transcript_checkpoint')) {
      if (method === 'GET') return Response.json(checkpoint);
      if (method === 'POST') { checkpoint = body; return Response.json(null, { status: 201 }); }
      if (method === 'DELETE') { checkpoint = null; return new Response(null, { status: 204 }); }
    }
    if (summaryDown && url.hostname === 'generativelanguage.googleapis.com' && url.pathname.endsWith(':generateContent')) {
      return Response.json({ error: { message: 'Fixture summary outage' } }, { status: 400 });
    }
    return undefined;
  });
  assert.equal((await f.request('/summarize-audio/jobs', { body: summarizeBody })).status, 202);
  await until(() => f.state.jobStatus === 'failed', 'the first attempt to fail');
  await sleep(20);
  const paid = assemblyCalls(f).length;
  assert.ok(paid > 0, 'the first attempt transcribes');
  assert.ok(checkpoint, 'the paid transcript survives the summary failure');
  assert.equal((checkpoint as Record<string, unknown>).note_id, 'fixture-note');

  summaryDown = false;
  f.state.calls.length = 0;
  f.state.jobStatus = 'queued';
  assert.equal((await f.request('/summarize-audio/jobs', { body: summarizeBody })).status, 202);
  await until(() => f.state.jobStatus === 'completed', 'the retry to complete');
  await sleep(20);
  assert.equal(assemblyCalls(f).length, 0, 'the retry does not transcribe again');
  assert.equal(checkpoint, null, 'the checkpoint is cleared once the note is saved');
});

// ---------------------------------------------------------------------------
// Orphan sweep: failOrphanedJobs and reconstructResultFromNote
// ---------------------------------------------------------------------------

type DbError = { message: string };
type DbCall = { table: string; op: string; columns?: string; payload?: unknown; filters: unknown[][] };
function fakeDb(t: test.TestContext, handler: (call: DbCall) => { data?: unknown; error?: DbError | null } | undefined) {
  const calls: DbCall[] = [];
  t.mock.method(supabase, 'from', (table: string) => {
    const call: DbCall = { table, op: '', filters: [] };
    calls.push(call);
    const finish = () => Promise.resolve(handler(call) ?? { data: null, error: null });
    const chain: any = {
      select: (columns: string) => { call.op ||= 'select'; call.columns = columns; return chain; },
      update: (patch: unknown) => { call.op = 'update'; call.payload = patch; return chain; },
      eq: (...args: unknown[]) => { call.filters.push(['eq', ...args]); return chain; },
      in: (...args: unknown[]) => { call.filters.push(['in', ...args]); return chain; },
      lt: (...args: unknown[]) => { call.filters.push(['lt', ...args]); return chain; },
      order: (...args: unknown[]) => { call.filters.push(['order', ...args]); return chain; },
      limit: (...args: unknown[]) => { call.filters.push(['limit', ...args]); return chain; },
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => finish().then(resolve, reject),
    };
    return chain;
  });
  return calls;
}
const noteReads = (calls: DbCall[]) => calls.filter((c) => c.table === 'note');
const jobUpdates = (calls: DbCall[]) => calls.filter((c) => c.table === 'workflow_job' && c.op === 'update');
const quietSweep = (t: test.TestContext) => ({
  log: t.mock.method(console, 'log', () => undefined),
  warn: t.mock.method(console, 'warn', () => undefined),
});
const RESTART_MESSAGE = 'Server restarted while this job was running. Please try again.';

test('reconstructResultFromNote rebuilds the job result from a note row and defaults drifted columns', () => {
  const diarization = [{ speaker: 'Speaker 1', text: 'Hi', start: 0, end: 1 }];
  assert.deepEqual(reconstructResultFromNote({
    diarization, summary: 'S', summary_translations: { en: 'S', ko: '요약' }, transcription_language: 'ko',
    transcription_translations: { en: 'Hi' }, diarization_translations: { en: diarization }, name: 'Title', tags: ['a'],
    duration_seconds: 61, meeting_at: '2026-10-01T10:00:00.000Z',
  }), {
    transcript: diarization, summary: 'S', summaryTranslations: { en: 'S', ko: '요약' }, transcriptionLanguage: 'ko',
    transcriptionTranslations: { en: 'Hi' }, diarizationTranslations: { en: diarization }, title: 'Title', tags: ['a'],
    audioDurationSeconds: 61, meetingStartAt: '2026-10-01T10:00:00.000Z',
  });
  assert.deepEqual(reconstructResultFromNote({ diarization: 'x', summary: 3, transcription_language: 'fr', name: null, tags: 'a', duration_seconds: '61', meeting_at: 5 }), {
    transcript: [], summary: '', summaryTranslations: {}, transcriptionLanguage: null, transcriptionTranslations: {},
    diarizationTranslations: {}, title: '', tags: [], audioDurationSeconds: null, meetingStartAt: null,
  });
});

test('sweep scans stale queued/processing jobs oldest first, capped, and stops when there are none', async (t) => {
  const { warn } = quietSweep(t);
  let calls = fakeDb(t, () => ({ data: [], error: null }));
  const before = Date.now();
  await failOrphanedJobs();
  const after = Date.now();
  assert.equal(calls.length, 1, 'no further queries without stale rows');
  const [query] = calls;
  assert.equal(query!.columns, 'id, user_id, note_id');
  assert.deepEqual(query!.filters.filter((f) => f[0] !== 'lt'), [
    ['in', 'status', ['queued', 'processing']], ['order', 'updated_at', { ascending: true }], ['limit', MAX_ORPHAN_RECONCILE],
  ]);
  assert.equal(MAX_ORPHAN_RECONCILE, 200);
  const [, column, cutoff] = query!.filters.find((f) => f[0] === 'lt')!;
  assert.equal(column, 'updated_at');
  const cutoffMs = Date.parse(String(cutoff));
  assert.ok(cutoffMs >= before - 5 * 60_000 && cutoffMs <= after - 5 * 60_000, 'cutoff is now minus the 5 minute orphan threshold');

  (supabase.from as unknown as { mock: { restore(): void } }).mock.restore();
  calls = fakeDb(t, () => ({ data: null, error: { message: 'scan denied' } }));
  await failOrphanedJobs();
  assert.equal(calls.length, 1);
  assert.equal(warn.mock.calls[0]!.arguments[0], 'Could not scan for orphaned workflow jobs: scan denied');

  (supabase.from as unknown as { mock: { restore(): void } }).mock.restore();
  calls = fakeDb(t, () => ({ data: null, error: null }));
  await failOrphanedJobs();
  assert.equal(calls.length, 1, 'a null scan result is treated as empty');
});

test('sweep is inert without Supabase service configuration', async (t) => {
  const calls = fakeDb(t, () => ({ data: [], error: null }));
  for (const key of ['supabaseUrl', 'serviceRoleKey'] as const) {
    const saved = env[key];
    env[key] = '';
    try { await failOrphanedJobs(); } finally { env[key] = saved; }
  }
  assert.equal(calls.length, 0);
});

test('sweep recovers jobs whose note exists for the same user and fails the rest in one write', async (t) => {
  const { log } = quietSweep(t);
  const note = (id: string, userId: unknown) => ({ id, user_id: userId, summary: `summary ${id}`, name: `title ${id}`, diarization: [], tags: [] });
  const notes = [note('n1', 'u1'), note('n2', 'u2'), note('n5', null), { user_id: 'u1' }];
  const calls = fakeDb(t, (call) => {
    if (call.table === 'workflow_job' && call.op === 'select') return { data: [
      { id: 'j1', user_id: 'u1', note_id: 'n1' }, { id: 'j2', user_id: 'u1', note_id: 'n2' }, { id: 'j3', user_id: 'u1', note_id: 'n3' },
      { id: 'j4', user_id: 'u1', note_id: null }, { id: 'j5', user_id: 'u1', note_id: 'n5' }, { id: 'j6', user_id: 'u1', note_id: 'n1' },
    ], error: null };
    if (call.table === 'note') return { data: notes, error: null };
    return { data: null, error: null };
  });
  await failOrphanedJobs();
  const [read] = noteReads(calls);
  assert.equal(read!.columns, '*');
  assert.deepEqual(read!.filters, [['in', 'id', ['n1', 'n2', 'n3', 'n5']]], 'distinct non-null note ids');
  const updates = jobUpdates(calls);
  assert.deepEqual(updates.map((u) => u.filters), [[['eq', 'id', 'j1']], [['eq', 'id', 'j5']], [['eq', 'id', 'j6']], [['in', 'id', ['j2', 'j3', 'j4']]]]);
  for (const [index, source] of [[0, notes[0]], [1, notes[2]], [2, notes[0]]] as const) {
    const patch = updates[index]!.payload as Record<string, unknown>;
    assert.deepEqual(withoutUpdatedAt(patch), { status: 'completed', stage: 'completed', progress: 100, result: reconstructResultFromNote(source), error: null });
  }
  const failPatch = updates[3]!.payload as Record<string, unknown>;
  assert.deepEqual(withoutUpdatedAt(failPatch), { status: 'failed', stage: 'failed', error: RESTART_MESSAGE }, 'the failure write has no progress field');
  assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]), [
    'Recovered 3 orphaned workflow job(s) to completed from an existing note.',
    'Marked 3 orphaned workflow job(s) as failed.',
  ]);
});

test('sweep skips the note lookup without note ids and fails everything when the lookup errors', async (t) => {
  const { log, warn } = quietSweep(t);
  let noteError = false;
  let rows: unknown[] = [{ id: 'j1', user_id: 'u1', note_id: null }];
  let calls = fakeDb(t, (call) => {
    if (call.table === 'workflow_job' && call.op === 'select') return { data: rows, error: null };
    if (call.table === 'note') return noteError ? { data: null, error: { message: 'note read denied' } } : { data: [{ id: 'n1', user_id: 'u1' }], error: null };
    return { data: null, error: null };
  });
  await failOrphanedJobs();
  assert.equal(noteReads(calls).length, 0, 'no note query without note ids');
  assert.deepEqual(jobUpdates(calls).map((u) => u.filters), [[['in', 'id', ['j1']]]]);

  (supabase.from as unknown as { mock: { restore(): void } }).mock.restore();
  noteError = true;
  rows = [{ id: 'j1', user_id: 'u1', note_id: 'n1' }, { id: 'j2', user_id: 'u1', note_id: 'n1' }];
  calls = fakeDb(t, (call) => {
    if (call.table === 'workflow_job' && call.op === 'select') return { data: rows, error: null };
    if (call.table === 'note') return { data: null, error: { message: 'note read denied' } };
    return { data: null, error: null };
  });
  await failOrphanedJobs();
  assert.ok(warn.mock.calls.some((c) => c.arguments[0] === 'Could not look up notes while reconciling orphaned jobs: note read denied'));
  assert.deepEqual(jobUpdates(calls).map((u) => u.filters), [[['in', 'id', ['j1', 'j2']]]], 'fall back to failing all');
  assert.ok(!log.mock.calls.some((c) => String(c.arguments[0]).startsWith('Recovered')));
});

test('sweep fails a job whose recovery write fails after two retries, and reports a failed fail-write', async (t) => {
  const { log, warn } = quietSweep(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attempts: string[] = [];
  let failWriteError = false;
  const handler = (call: DbCall) => {
    if (call.table === 'workflow_job' && call.op === 'select') return { data: [{ id: 'j1', user_id: 'u1', note_id: 'n1' }, { id: 'j2', user_id: 'u1', note_id: null }], error: null };
    if (call.table === 'note') return { data: [{ id: 'n1', user_id: 'u1' }], error: null };
    const patch = call.payload as Record<string, unknown>;
    if (patch.status === 'completed') { attempts.push('completed'); return { data: null, error: { message: 'recovery blip' } }; }
    return failWriteError ? { data: null, error: { message: 'fail write denied' } } : { data: null, error: null };
  };
  let calls = fakeDb(t, handler);
  let sweep = failOrphanedJobs();
  for (let i = 0; i < 20; i++) { await turn(); t.mock.timers.tick(2_000); }
  await sweep;
  assert.equal(attempts.length, 3, 'one write plus two retries');
  assert.deepEqual(jobUpdates(calls).at(-1)!.filters, [['in', 'id', ['j2', 'j1']]], 'the unrecovered job joins the failed list last');
  const recoveredLog = log.mock.calls.map((c) => c.arguments[0]);

  (supabase.from as unknown as { mock: { restore(): void } }).mock.restore();
  failWriteError = true;
  attempts.length = 0;
  calls = fakeDb(t, handler);
  sweep = failOrphanedJobs();
  for (let i = 0; i < 20; i++) { await turn(); t.mock.timers.tick(2_000); }
  await sweep;
  t.mock.timers.reset();
  assert.deepEqual(recoveredLog, [
    'Recovered 1 orphaned workflow job(s) to completed from an existing note.',
    'Marked 2 orphaned workflow job(s) as failed.',
  ], 'the recovered count includes a job whose recovery write failed');
  assert.ok(warn.mock.calls.some((c) => c.arguments[0] === 'Could not fail 2 orphaned workflow job(s): fail write denied'));
  assert.equal(log.mock.calls.filter((c) => String(c.arguments[0]).startsWith('Marked')).length, 1, 'no success log after a failed fail-write');
});

test('startup sweeps once on listen, every two minutes after, and stops the schedule on close', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const scans: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: FetchInput) => {
    const url = toUrl(input);
    assert.equal(url.hostname, 'supabase.invalid', 'startup only touches the fake database');
    if (isTable(url, 'workflow_job')) scans.push(url);
    return Response.json([]);
  });
  const interval = t.mock.method(globalThis, 'setInterval');
  const clear = t.mock.method(globalThis, 'clearInterval');
  const stop = startServer({ port: 0, host: '127.0.0.1', dispatcher: getGlobalDispatcher() });
  let stopped = false;
  t.after(async () => { if (!stopped) await stop(); });
  await once(server, 'listening');
  await until(() => scans.length === 1, 'the boot sweep');
  assert.ok(scans[0]!.searchParams.get('updated_at')?.startsWith('lt.'), 'the boot sweep is the stale-job scan');
  const sweeps = interval.mock.calls.filter((c) => c.arguments[1] === 2 * 60_000);
  assert.equal(sweeps.length, 1, 'one periodic sweep schedule');
  (sweeps[0]!.arguments[0] as () => void)();
  await until(() => scans.length === 2, 'the periodic sweep');
  await stop();
  stopped = true;
  assert.ok(clear.mock.calls.some((c) => c.arguments[0] === sweeps[0]!.result), 'closing the server clears the sweep timer');
});
