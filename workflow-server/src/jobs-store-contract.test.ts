// T1-9a characterization: pins the behavior of the shared types, errors, input parsing,
// job-state persistence and transcript checkpoint helpers before they leave index.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
// Service config must exist before the server modules read env at import time.
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role';
process.env.GEMINI_API_KEY = 'synthetic-gemini';
process.env.ASSEMBLYAI_API_KEY = 'synthetic-assembly';
const { supabase } = await import('./db/supabaseClient.js');
const { HttpError, getHttpStatus } = await import('./http/shared.js');
const { NoSpeechDetectedError, noSpeechMessage } = await import('./pipeline/errors.js');
const { parseSummarizeInput, parseSummaryAttachments } = await import('./pipeline/inputs.js');
const {
  updateWorkflowJob, loadTranscriptCheckpoint, saveTranscriptCheckpoint, deleteTranscriptCheckpoint,
  JOB_HEARTBEAT_INTERVAL_MS, ORPHANED_JOB_THRESHOLD_MS, ORPHANED_JOB_SWEEP_INTERVAL_MS,
} = await import('./jobs/store.js');
const { workflowFixture, summarizeBody, USER } = await import('./test-support/workflow.js');

type Call = { table: string; op: string; payload?: unknown; filters: [string, unknown][]; options?: unknown };
type Result = { data?: unknown; error?: { message: string } | null };

// Records the query-builder chain a helper builds; results[n] is returned for the nth query.
function fakeFrom(t: test.TestContext, results: Result[]) {
  const calls: Call[] = [];
  t.mock.method(supabase, 'from', (table: string) => {
    const call: Call = { table, op: '', filters: [] };
    const result = results[Math.min(calls.length, results.length - 1)] ?? { data: null, error: null };
    calls.push(call);
    const chain: any = {
      select: (cols: string) => { call.op ||= 'select'; call.payload = cols; return chain; },
      update: (patch: unknown) => { call.op = 'update'; call.payload = patch; return chain; },
      upsert: (row: unknown, options: unknown) => { call.op = 'upsert'; call.payload = row; call.options = options; return chain; },
      delete: () => { call.op = 'delete'; return chain; },
      eq: (column: string, value: unknown) => { call.filters.push([column, value]); return chain; },
      maybeSingle: async () => result,
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  });
  return calls;
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('heartbeat and orphan timing constants keep their relationship', () => {
  assert.equal(JOB_HEARTBEAT_INTERVAL_MS, 60_000);
  assert.equal(ORPHANED_JOB_THRESHOLD_MS, 5 * 60_000);
  assert.equal(ORPHANED_JOB_SWEEP_INTERVAL_MS, 2 * 60_000);
  assert.ok(ORPHANED_JOB_THRESHOLD_MS > JOB_HEARTBEAT_INTERVAL_MS * 2, 'a live heartbeating job is never swept');
});

test('NoSpeechDetectedError is a 422 HttpError with localized guidance', () => {
  const error = new NoSpeechDetectedError(noSpeechMessage('ko'));
  assert.ok(error instanceof HttpError); assert.ok(error instanceof Error);
  assert.equal(error.name, 'NoSpeechDetectedError'); assert.equal(error.status, 422);
  assert.equal(getHttpStatus(error), 422);
  assert.equal(noSpeechMessage('ko'), '녹음에서 음성을 찾지 못했어요. 말소리가 담긴 녹음으로 다시 시도해 주세요.');
  assert.equal(noSpeechMessage('en'), 'No speech was found in this recording. Please try again with audio that contains speech.');
});

test('parseSummarizeInput requires identifiers, normalizes optional fields and defaults language to en', () => {
  const input = parseSummarizeInput({ ...summarizeBody, userName: '  Ann ', meetingAt: '2026-01-02T03:04:05Z', userTimeZone: ' UTC ', fileId: ' f1 ', speakerContext: 7, attachments: 'nope', language: 'fr' });
  assert.deepEqual(input, {
    downloadUrl: summarizeBody.downloadUrl, fileName: 'fixture.ogg', promptId: 'fixture', summaryRulesOverride: 'Summarize.',
    userId: USER, userName: 'Ann', noteId: 'fixture-note', meetingAt: '2026-01-02T03:04:05.000Z', userTimeZone: 'UTC',
    fileId: 'f1', instructions: '', speakerContext: '', attachments: [], language: 'en',
  });
  assert.equal(parseSummarizeInput({ ...summarizeBody, language: 'ko', fileId: '  ' }).language, 'ko');
  assert.equal(parseSummarizeInput({ ...summarizeBody, fileId: '  ' }).fileId, null);
  assert.equal(parseSummarizeInput({ ...summarizeBody, meetingAt: 'garbage' }).meetingAt, null);
  assert.equal(parseSummarizeInput({ ...summarizeBody, summaryRulesOverride: 3 }).summaryRulesOverride, undefined);
  for (const key of ['downloadUrl', 'fileName', 'promptId', 'userId', 'noteId']) {
    assert.throws(() => parseSummarizeInput({ ...summarizeBody, [key]: '' }), (error: Error) => error.message.includes('required') && getHttpStatus(error) === 400, key);
  }
});

test('parseSummaryAttachments filters by type, MIME, base64 and size limits', () => {
  assert.deepEqual(parseSummaryAttachments(undefined), []);
  const ok = { name: ' a.txt ', mimeType: 'text/plain', dataBase64: 'aGk=' };
  assert.deepEqual(parseSummaryAttachments([ok, null, [], 'x', { ...ok, mimeType: 'application/zip' }, { ...ok, dataBase64: 'not base64!' }, { ...ok, dataBase64: '' }]),
    [{ name: 'a.txt', mimeType: 'text/plain', dataBase64: 'aGk=' }]);
  assert.deepEqual(parseSummaryAttachments([{ name: '  ', mimeType: ' ', dataBase64: 'aGk=' }]), []);
  assert.equal(parseSummaryAttachments(Array.from({ length: 12 }, () => ok)).length, 10);
  assert.equal(parseSummaryAttachments([{ ...ok, name: 'n'.repeat(500) }])[0].name.length, 240);
  const big = 'A'.repeat(Math.ceil((26 * 1024 * 1024 * 4) / 3));
  assert.deepEqual(parseSummaryAttachments([ok, { ...ok, name: 'big', dataBase64: big }, { ...ok, name: 'after' }]).map((a) => a.name), ['a.txt'], 'an oversize item stops the scan');
});

test('updateWorkflowJob writes the patch plus updated_at filtered by job id only', async (t) => {
  const calls = fakeFrom(t, [{ error: null }]);
  assert.equal(await updateWorkflowJob(null, { status: 'failed' }), false);
  assert.equal(calls.length, 0, 'a null job id never touches the database');
  assert.equal(await updateWorkflowJob('job-1', { status: 'processing', stage: 'transcribing', progress: 10 }), true);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.table, 'workflow_job'); assert.equal(call.op, 'update');
  const patch = call.payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(patch).sort(), ['progress', 'stage', 'status', 'updated_at']);
  assert.equal(new Date(String(patch.updated_at)).toISOString(), patch.updated_at);
  assert.deepEqual(call.filters, [['id', 'job-1']]);
  await updateWorkflowJob('job-1', {});
  assert.deepEqual(Object.keys(calls[1].payload as object), ['updated_at'], 'heartbeat is an empty patch');
});

test('updateWorkflowJob retries with exponential backoff, then warns and returns false', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warn = t.mock.method(console, 'warn', () => undefined);
  const flaky = fakeFrom(t, [{ error: { message: 'blip' } }, { error: { message: 'blip' } }, { error: null }]);
  let pending = updateWorkflowJob('job-2', { status: 'completed' }, { retries: 4 });
  for (const wait of [1000, 2000]) { await turn(); t.mock.timers.tick(wait); }
  assert.equal(await pending, true); assert.equal(flaky.length, 3); assert.equal(warn.mock.callCount(), 0);

  (supabase.from as unknown as { mock: { restore(): void } }).mock.restore();
  const down = fakeFrom(t, [{ error: { message: 'down' } }]);
  pending = updateWorkflowJob('job-3', { status: 'failed' }, { retries: 2 });
  for (const wait of [1000, 2000]) { await turn(); t.mock.timers.tick(wait); }
  assert.equal(await pending, false); assert.equal(down.length, 3);
  assert.equal(warn.mock.calls[0].arguments[0], 'Could not update workflow job job-3: down');

  (supabase.from as unknown as { mock: { restore(): void } }).mock.restore();
  const once = fakeFrom(t, [{ error: { message: 'once' } }]);
  assert.equal(await updateWorkflowJob('job-4', {}), false); assert.equal(once.length, 1, 'no retries by default');
});

test('transcript checkpoint load validates rows and fails soft', async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const segs = [{ speaker: 'Speaker 1', text: 'Hi', start: 0, end: 1 }];
  const restore = () => (supabase.from as unknown as { mock: { restore(): void } }).mock.restore();
  let calls = fakeFrom(t, [{ data: { segments: segs, audio_duration_seconds: 12, detected_language: 'ko' } }]);
  assert.deepEqual(await loadTranscriptCheckpoint('n1', 'u1'), { segments: segs, audioDurationSeconds: 12, detectedLanguage: 'ko' });
  assert.deepEqual([calls[0].table, calls[0].op, calls[0].payload, calls[0].filters],
    ['workflow_transcript_checkpoint', 'select', 'segments, audio_duration_seconds, detected_language', [['note_id', 'n1'], ['user_id', 'u1']]]);
  restore(); fakeFrom(t, [{ data: { segments: segs, audio_duration_seconds: 'x', detected_language: 'fr' } }]);
  assert.deepEqual(await loadTranscriptCheckpoint('n1', 'u1'), { segments: segs, audioDurationSeconds: null, detectedLanguage: null });
  for (const data of [null, { segments: [], audio_duration_seconds: 1, detected_language: 'en' }, { segments: 'x' }]) {
    restore(); fakeFrom(t, [{ data }]);
    assert.equal(await loadTranscriptCheckpoint('n1', 'u1'), null);
  }
  assert.equal(warn.mock.callCount(), 0);
  restore(); calls = fakeFrom(t, [{ error: { message: 'relation missing' } }]);
  assert.equal(await loadTranscriptCheckpoint('n1', 'u1'), null);
  assert.equal(warn.mock.calls[0].arguments[0], 'Could not load transcript checkpoint for note n1: relation missing');
});

test('transcript checkpoint save upserts by note_id and delete filters by note; both are best-effort', async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const segs = [{ speaker: 'Speaker 1', text: 'Hi', start: 0, end: 1 }];
  const restore = () => (supabase.from as unknown as { mock: { restore(): void } }).mock.restore();
  let calls = fakeFrom(t, [{ error: null }]);
  await saveTranscriptCheckpoint({ noteId: 'n1', userId: 'u1', segments: segs, audioDurationSeconds: 5, detectedLanguage: 'en' });
  const row = calls[0].payload as Record<string, unknown>;
  assert.deepEqual([calls[0].table, calls[0].op, calls[0].options], ['workflow_transcript_checkpoint', 'upsert', { onConflict: 'note_id' }]);
  assert.deepEqual(Object.keys(row).sort(), ['audio_duration_seconds', 'detected_language', 'note_id', 'segments', 'updated_at', 'user_id']);
  assert.deepEqual([row.note_id, row.user_id, row.segments, row.audio_duration_seconds, row.detected_language], ['n1', 'u1', segs, 5, 'en']);
  restore(); calls = fakeFrom(t, [{ error: null }]);
  await deleteTranscriptCheckpoint('n1');
  assert.deepEqual([calls[0].table, calls[0].op, calls[0].filters], ['workflow_transcript_checkpoint', 'delete', [['note_id', 'n1']]]);
  restore(); fakeFrom(t, [{ error: { message: 'write denied' } }]);
  await saveTranscriptCheckpoint({ noteId: 'n2', userId: 'u1', segments: segs, audioDurationSeconds: null, detectedLanguage: null });
  restore(); fakeFrom(t, [{ error: { message: 'delete denied' } }]);
  await deleteTranscriptCheckpoint('n2');
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments[0]), [
    'Could not persist transcript checkpoint for note n2: write denied',
    'Could not delete transcript checkpoint for note n2: delete denied']);
});

// Runs a real job through the HTTP fixture and waits for it to reach `status`.
async function runJob(t: test.TestContext, options: { status: 'completed' | 'failed'; checkpoint: boolean; aiFailure?: boolean; silentAudio?: boolean }) {
  const f = await workflowFixture();
  t.after(() => f.close());
  const originalFetch = globalThis.fetch;
  const intercept = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!options.checkpoint && url.pathname.endsWith('/workflow_transcript_checkpoint') && (init?.method ?? 'GET') === 'GET') return Response.json(null);
    if (options.silentAudio && url.hostname === 'api.assemblyai.com' && !url.pathname.includes('/upload')) {
      return Response.json({ id: 'fixture-transcript', status: 'completed', text: '', utterances: [] });
    }
    return originalFetch(input, init);
  });
  t.after(() => intercept.mock.restore());
  f.state.existingJob = false;
  f.state.aiFailure = options.aiFailure ?? false;
  const submitted = await f.request('/summarize-audio/jobs', { body: summarizeBody });
  assert.equal(submitted.status, 202, submitted.text);
  const deadline = Date.now() + 5_000;
  while (f.state.jobStatus !== options.status && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return f;
}

test('job success writes completed with the full result and clears the checkpoint', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const f = await runJob(t, { status: 'completed', checkpoint: true });
  const terminal = f.state.jobUpdates.filter((patch) => patch.status);
  const done = terminal.at(-1)!;
  assert.deepEqual([done.status, done.stage, done.progress, done.error], ['completed', 'completed', 100, null]);
  assert.equal((done.result as { summary: string }).summary, 'Fixture summary');
  assert.ok(f.state.jobUpdates.every((p) => !('user_id' in p) && typeof p.updated_at === 'string'));
  assert.ok(f.state.calls.some((c) => c.url.pathname.endsWith('/workflow_transcript_checkpoint') && c.method === 'DELETE'));
});

test('job failure writes failed with the error message and keeps the checkpoint', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const f = await runJob(t, { status: 'failed', checkpoint: true, aiFailure: true });
  const failed = f.state.jobUpdates.find((p) => p.status === 'failed')!;
  assert.deepEqual([failed.stage, failed.progress], ['failed', 100]);
  assert.match(String(failed.error), /Fixture AI failure/);
  assert.ok(!f.state.calls.some((c) => c.url.pathname.endsWith('/workflow_transcript_checkpoint') && c.method === 'DELETE'));
});

test('a recording with no speech fails the job with the localized message and no failure log', async (t) => {
  const log = t.mock.method(console, 'log', () => undefined);
  const error = t.mock.method(console, 'error', () => undefined);
  const f = await runJob(t, { status: 'failed', checkpoint: false, silentAudio: true });
  const failed = f.state.jobUpdates.find((p) => p.status === 'failed')!;
  assert.equal(failed.error, noSpeechMessage('en'));
  assert.ok(log.mock.calls.some((c) => String(c.arguments[0]).includes('ended with no detectable speech')));
  assert.equal(error.mock.callCount(), 0, 'no error log and no incident for a silent recording');
});
