// #23 (S10 follow-up, DEC-0022): when a resumed web or Flutter job's signed audio link has
// expired, the server re-signs the object the stored link named, but only after a strict
// ownership check (recordings bucket, a safe path, the job's file row when a fileId is
// present, and storage.objects.owner_id equal to the job's user). Supabase storage, the file table and the storage_object_owner RPC are a fake HTTP
// server on 127.0.0.1; the app still sees https://supabase.invalid (so the SSRF guard is
// exercised unchanged) and the test forwards those requests to the fake. Everything else
// uses the shared offline fixture. Nothing reads .env and no real service is called.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role';
process.env.GEMINI_API_KEY = 'synthetic-gemini';
process.env.ASSEMBLYAI_API_KEY = 'synthetic-assembly';
// Enabled so a raised ops incident would be observable as a feedback_issues request.
process.env.F9_OPS_AGENT_ENABLED = 'true';
const { audioUnavailableMessage } = await import('./pipeline/errors.js');
const { workflowFixture, summarizeBody, USER, OTHER } = await import('./test-support/workflow.js');
const { completedJobResults } = await import('./jobs/runner.js');
const { recoverClaimedJob } = await import('./jobs/orphanSweep.js');
const { parseProjectSignedUrl, isSafeRecordingPath, RESIGN_EXPIRY_MARGIN_MS } = await import('./pipeline/resumeAudio.js');
type JobClaim = import('./jobs/lease.js').JobClaim;

type FetchInput = Parameters<typeof fetch>[0];
const toUrl = (input: FetchInput) => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, label: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await sleep(5);
  assert.ok(condition(), `timed out waiting for ${label}`);
}
const parseJson = (body: unknown) => {
  if (typeof body !== 'string') return null;
  try { return JSON.parse(body); } catch { return null; }
};

const BUCKET = 'meeting-recordings';
const FILE_ID = '44444444-4444-4444-8444-444444444444';
const PATH = `${FILE_ID}-meeting.m4a`;
const STORAGE_ORIGIN = 'https://supabase.invalid';

// ---------------------------------------------------------------------------
// Fake Supabase storage + file table + storage_object_owner on 127.0.0.1
// ---------------------------------------------------------------------------

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
// Same shape as a Supabase storage token: a JWT whose payload names "<bucket>/<name>".
function mintToken(objectKey: string, expSeconds: number): string {
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ url: objectKey, iat: expSeconds - 21_600, exp: expSeconds })}.fake-signature`;
}
function readToken(token: string | null): { url?: unknown; exp?: unknown } | null {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { return null; }
}
const nowSeconds = () => Math.floor(Date.now() / 1000);
// A link the client signed earlier: exp in the past by default (the 6 h link outlived by a long outage).
function storedLink(path = PATH, expSeconds = nowSeconds() - 3_600, encode = (p: string) => p): string {
  return `${STORAGE_ORIGIN}/storage/v1/object/sign/${BUCKET}/${encode(path)}?token=${mintToken(`${BUCKET}/${path}`, expSeconds)}`;
}

interface FakeStorageState {
  objects: Map<string, { owner: string | null }>;
  files: Map<string, Record<string, unknown>>;
  signStatus: number;
  // When set, the sign endpoint answers with a link to this object key instead.
  signAs: string | null;
  // When not 0, signed GETs (probes) answer with this status.
  probeStatus: number;
  ownerStatus: number;
  fileStatus: number;
  signs: string[];
  probes: string[];
  ownerLookups: Array<{ p_bucket: string; p_name: string }>;
  fileLookups: string[];
  deletes: number;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

async function startFakeStorage(): Promise<{ state: FakeStorageState; origin: string; server: Server }> {
  const state: FakeStorageState = {
    objects: new Map(), files: new Map(), signStatus: 200, signAs: null, probeStatus: 0, ownerStatus: 200, fileStatus: 200,
    signs: [], probes: [], ownerLookups: [], fileLookups: [], deletes: 0,
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = await readBody(req) as Record<string, any> | null;
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const signPrefix = '/storage/v1/object/sign/';
      if (url.pathname.startsWith(signPrefix)) {
        const key = decodeURIComponent(url.pathname.slice(signPrefix.length));
        if (req.method === 'POST') {
          state.signs.push(key);
          if (state.signStatus !== 200) return send(state.signStatus, { statusCode: String(state.signStatus), error: 'internal', message: 'fixture sign failure' });
          if (!state.objects.has(key)) return send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
          const signed = state.signAs ?? key;
          return send(200, { signedURL: `/object/sign/${signed}?token=${mintToken(signed, nowSeconds() + Number(body?.expiresIn ?? 0))}` });
        }
        state.probes.push(key);
        if (state.probeStatus) return send(state.probeStatus, { statusCode: String(state.probeStatus), error: 'fixture', message: 'fixture probe status' });
        const claims = readToken(url.searchParams.get('token'));
        if (!claims || claims.url !== key) return send(400, { statusCode: '400', error: 'InvalidSignature', message: 'The signature is invalid' });
        if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds()) return send(400, { statusCode: '400', error: 'InvalidJWT', message: '"exp" claim timestamp check failed' });
        if (!state.objects.has(key)) return send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        res.writeHead(206, { 'content-type': 'audio/mp4', 'content-range': 'bytes 0-0/1' });
        return res.end(Buffer.from([0]));
      }
      if (url.pathname.startsWith('/storage/v1/')) {
        if (req.method === 'DELETE') state.deletes += 1;
        return send(404, { message: 'unrouted storage call' });
      }
      if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/storage_object_owner') {
        state.ownerLookups.push(body as FakeStorageState['ownerLookups'][number]);
        if (state.ownerStatus !== 200) return send(state.ownerStatus, { code: 'FIXTURE', message: 'fixture owner lookup failure' });
        return send(200, state.objects.get(`${body?.p_bucket}/${body?.p_name}`)?.owner ?? null);
      }
      if (req.method === 'GET' && url.pathname === '/rest/v1/file') {
        const id = (url.searchParams.get('id') ?? '').replace(/^eq\./, '');
        state.fileLookups.push(id);
        if (state.fileStatus !== 200) return send(state.fileStatus, { code: 'FIXTURE', message: 'fixture file lookup failure' });
        const row = state.files.get(id);
        return send(200, row ? [row] : []);
      }
      return send(404, { message: `unrouted ${req.method} ${url.pathname}` });
    })().catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fake storage address');
  return { state, origin: `http://127.0.0.1:${address.port}`, server };
}

const routedToFakeStorage = (url: URL) => url.hostname === 'supabase.invalid'
  && (url.pathname.startsWith('/storage/v1/') || url.pathname === '/rest/v1/file' || url.pathname === '/rest/v1/rpc/storage_object_owner');

// The shared fixture (index.ts imported, S10 RPCs emulated) plus the 127.0.0.1 fake
// storage. No checkpoint and no persisted note, so a resume needs a fresh submission.
async function harness(t: test.TestContext) {
  const f = await workflowFixture();
  const storage = await startFakeStorage();
  const fixtureFetch = globalThis.fetch;
  const forwarded: Array<{ url: URL; method: string; signal: boolean; redirect: RequestRedirect | undefined }> = [];
  const intercept = t.mock.method(globalThis, 'fetch', async (input: FetchInput, init?: RequestInit) => {
    const url = toUrl(input);
    const method = init?.method ?? 'GET';
    if (routedToFakeStorage(url)) {
      forwarded.push({ url, method, signal: Boolean(init?.signal), redirect: init?.redirect });
      f.state.calls.push({ url, method, body: parseJson(init?.body) });
      return fixtureFetch(new URL(url.pathname + url.search, storage.origin), init);
    }
    if (url.hostname === 'supabase.invalid' && url.pathname === '/rest/v1/feedback_issues') {
      f.state.calls.push({ url, method, body: parseJson(init?.body) });
      if (method === 'HEAD') return new Response(null, { headers: { 'content-range': '0-0/0' } });
      return Response.json(method === 'GET' ? [] : null);
    }
    if (url.hostname === 'supabase.invalid' && url.pathname === '/rest/v1/workflow_transcript_checkpoint' && method === 'GET') return Response.json(null);
    if (url.hostname === 'supabase.invalid' && url.pathname === '/rest/v1/note' && method === 'GET' && url.searchParams.get('id')?.startsWith('eq.')) return Response.json(null);
    return fixtureFetch(input, init);
  });
  t.after(async () => {
    intercept.mock.restore();
    await f.close();
    await new Promise<void>((resolve) => storage.server.close(() => resolve()));
  });
  f.state.existingJob = false;
  const own = (path = PATH, owner: string | null = USER) => storage.state.objects.set(`${BUCKET}/${path}`, { owner });
  const fileRow = (row: Partial<Record<'id' | 'user_id' | 'bucket' | 'storage_path', string>> = {}) => {
    const full = { id: FILE_ID, user_id: USER, bucket: BUCKET, storage_path: PATH, ...row };
    storage.state.files.set(full.id, full);
  };
  return { f, storage: storage.state, forwarded, own, fileRow };
}
type Harness = Awaited<ReturnType<typeof harness>>;

const writesOf = (h: Harness, jobId: string) => h.f.state.calls
  .filter((c) => c.url.pathname === '/rest/v1/rpc/workflow_job_write' && c.body?.p_job_id === jobId)
  .map((c) => c.body.p_patch as Record<string, unknown>);
const terminal = (h: Harness, jobId: string) => writesOf(h, jobId).find((p) => p.status === 'completed' || p.status === 'failed');
const submits = (h: Harness) => h.f.state.calls.filter((c) => c.url.hostname === 'api.assemblyai.com' && c.method === 'POST' && c.url.pathname === '/v2/transcript');
const incidents = (h: Harness) => h.f.state.calls.filter((c) => c.url.pathname === '/rest/v1/feedback_issues');

function claimFor(jobId: string): JobClaim {
  return {
    jobId, userId: USER, noteId: 'fixture-note', status: 'processing', stage: 'transcribing audio',
    generation: 2, attempt: 1, claimCount: 2, transcriptId: null, submissionState: 'none', submissionCount: 0,
  };
}
async function resume(h: Harness, jobId: string, request: Record<string, unknown>) {
  h.f.state.jobRequest = request;
  const outcome = await recoverClaimedJob(claimFor(jobId));
  assert.equal(outcome, 'resumed', `${jobId} resumes`);
  await until(() => Boolean(terminal(h, jobId)), `job ${jobId} to finish`);
  await sleep(30);
  completedJobResults.delete(jobId);
  return terminal(h, jobId)!;
}
const webRequest = (overrides: Record<string, unknown> = {}) => ({ ...summarizeBody, downloadUrl: storedLink(), fileId: FILE_ID, language: 'ko', ...overrides });
const quiet = (t: test.TestContext) => {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  return t.mock.method(console, 'warn', () => undefined);
};
const warned = (warn: ReturnType<typeof quiet>, text: string) => warn.mock.calls.some((c) => String(c.arguments[0]).includes(text));
const refusedWith = (warn: ReturnType<typeof quiet>, jobId: string, reason: string) => warned(warn, `Workflow job ${jobId} does not re-sign its recording (${reason})`);

function assertRefused(h: Harness, warn: ReturnType<typeof quiet>, jobId: string, done: Record<string, unknown>, reason: string) {
  assert.deepEqual([done.status, done.error], ['failed', audioUnavailableMessage('ko')], `${jobId}: the localized "recording is kept" failure`);
  assert.ok(refusedWith(warn, jobId, reason), `${jobId}: the refusal is logged as ${reason}`);
  assert.equal(h.storage.deletes, 0, `${jobId}: the recording is kept`);
}

// ---------------------------------------------------------------------------
// Unit rules
// ---------------------------------------------------------------------------

test('parseProjectSignedUrl reads bucket, path and expiry only from this project\'s signed storage links', () => {
  const exp = nowSeconds() + 60;
  assert.deepEqual(parseProjectSignedUrl(storedLink(PATH, exp)), { bucket: BUCKET, path: PATH, expiresAtMs: exp * 1000 });
  assert.equal(parseProjectSignedUrl(`${STORAGE_ORIGIN}/storage/v1/object/sign/${BUCKET}/${PATH}?token=garbage`)!.expiresAtMs, null, 'an unreadable token has no known expiry');
  assert.equal(parseProjectSignedUrl(`${STORAGE_ORIGIN}/storage/v1/object/sign/${BUCKET}/${PATH}`)!.expiresAtMs, null);
  for (const foreign of [
    `https://audio.invalid/storage/v1/object/sign/${BUCKET}/${PATH}?token=t`,
    `http://supabase.invalid/storage/v1/object/sign/${BUCKET}/${PATH}?token=t`,
    `https://supabase.invalid.evil.invalid/storage/v1/object/sign/${BUCKET}/${PATH}?token=t`,
    `https://user@supabase.invalid:8443/storage/v1/object/sign/${BUCKET}/${PATH}?token=t`,
    `${STORAGE_ORIGIN}/storage/v1/object/public/${BUCKET}/${PATH}`,
    `${STORAGE_ORIGIN}/storage/v1/object/sign/${BUCKET}`,
    `${STORAGE_ORIGIN}/storage/v1/object/sign/${BUCKET}/%E0%A4%A`,
    'not a url',
  ]) assert.equal(parseProjectSignedUrl(foreign), null, foreign);
});

test('isSafeRecordingPath accepts upload names and refuses traversal, encoding and odd shapes', () => {
  for (const ok of [PATH, 'a', 'rec_1.m4a', `android/${USER}/fixture-note/a.ogg`]) assert.equal(isSafeRecordingPath(ok), true, ok);
  for (const bad of ['', '.', '..', '../x.ogg', 'a/../../private/x.ogg', 'a/./b.ogg', './a.ogg', '/a.ogg', 'a.ogg/', 'a//b.ogg',
    'a\\b.ogg', '%2e%2e/x.ogg', 'a%2Fb.ogg', 'a b.ogg', 'a?b.ogg', 'a#b.ogg', '.hidden', 'a\u0000.ogg', 'é.ogg',
    'a/b/c/d/e.ogg', 'x'.repeat(513)]) assert.equal(isSafeRecordingPath(bad), false, JSON.stringify(bad));
});

// ---------------------------------------------------------------------------
// Resume contracts
// ---------------------------------------------------------------------------

test('an expired link on resume, owner matching: re-signs from the file row, then transcribes', async (t) => {
  quiet(t);
  const log = t.mock.method(console, 'log', () => undefined);
  const h = await harness(t);
  h.own(); h.fileRow();
  const done = await resume(h, 'resign-job', webRequest());
  assert.equal(done.status, 'completed');
  assert.deepEqual(h.storage.signs, [`${BUCKET}/${PATH}`], 'exactly the job\'s object is signed, once');
  assert.deepEqual(h.storage.fileLookups, [FILE_ID]);
  assert.deepEqual(h.storage.ownerLookups, [{ p_bucket: BUCKET, p_name: PATH }]);
  const submitted = String(submits(h)[0]!.body.audio_url);
  const fresh = parseProjectSignedUrl(submitted)!;
  assert.deepEqual([fresh.bucket, fresh.path], [BUCKET, PATH], 'AssemblyAI gets a fresh link to the same object');
  assert.ok(fresh.expiresAtMs! > Date.now() + 5 * 3_600_000, 'the fresh link has the full 6 h');
  assert.deepEqual(h.storage.probes, [`${BUCKET}/${PATH}`], 'a known-expired link is not probed; only the fresh link is');
  assert.ok(h.forwarded.filter((c) => c.method === 'GET' && c.url.pathname.startsWith('/storage/')).every((c) => c.redirect === 'error'), 'probes refuse redirects');
  assert.ok(h.forwarded.every((c) => c.signal), 'every re-sign I/O (file row, owner, sign, probe) is bounded by a signal');
  assert.ok(log.mock.calls.some((c) => String(c.arguments[0]).startsWith('Workflow job resign-job re-signed its recording')), 'the re-sign is logged');
  assert.equal(incidents(h).length, 0);
});

test('a link whose expiry is not readable is probed first; a 4xx probe re-signs, a live link is reused', async (t) => {
  quiet(t);
  const h = await harness(t);
  h.own(); h.fileRow();
  // Unreadable token: the probe decides. The fake answers 400 (invalid signature) like Supabase.
  const unreadable = `${STORAGE_ORIGIN}/storage/v1/object/sign/${BUCKET}/${PATH}?token=garbage`;
  const done = await resume(h, 'probe-4xx-job', webRequest({ downloadUrl: unreadable }));
  assert.equal(done.status, 'completed');
  assert.deepEqual(h.storage.probes, [`${BUCKET}/${PATH}`, `${BUCKET}/${PATH}`], 'the stored link, then the fresh one');
  assert.equal(h.storage.signs.length, 1);
  assert.notEqual(submits(h)[0]!.body.audio_url, unreadable);

  h.f.reset(); h.storage.signs.length = 0; h.storage.probes.length = 0; h.storage.fileLookups.length = 0;
  const live = storedLink(PATH, nowSeconds() + 3_600);
  const reused = await resume(h, 'live-link-job', webRequest({ downloadUrl: live }));
  assert.equal(reused.status, 'completed');
  assert.equal(h.storage.signs.length, 0, 'a live link is not re-signed');
  assert.equal(h.storage.fileLookups.length, 0, 'and no ownership lookup is needed');
  assert.equal(submits(h)[0]!.body.audio_url, live);

  h.f.reset(); h.storage.signs.length = 0;
  // Five minutes left: AssemblyAI might fetch it after it expires.
  assert.ok(RESIGN_EXPIRY_MARGIN_MS >= 10 * 60_000, 'the margin covers the provider fetch delay');
  const nearlyExpired = storedLink(PATH, nowSeconds() + 300);
  await resume(h, 'near-expiry-job', webRequest({ downloadUrl: nearlyExpired }));
  assert.equal(h.storage.signs.length, 1, 'a link inside the expiry margin is re-signed before AssemblyAI fetches it');
});

test('a storage 5xx or network failure on the probe does not re-sign (current behavior)', async (t) => {
  quiet(t);
  const h = await harness(t);
  h.own(); h.fileRow();
  const unreadable = `${STORAGE_ORIGIN}/storage/v1/object/sign/${BUCKET}/${PATH}?token=garbage`;
  const restore = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: FetchInput, init?: RequestInit) => {
    const url = toUrl(input);
    if (url.hostname === 'supabase.invalid' && url.pathname.startsWith('/storage/v1/object/sign/') && (init?.method ?? 'GET') === 'GET') {
      return new Response('down', { status: 503 });
    }
    return restore(input, init);
  });
  const done = await resume(h, 'storage-down-job', webRequest({ downloadUrl: unreadable }));
  assert.deepEqual([done.status, done.error], ['failed', audioUnavailableMessage('ko')]);
  assert.equal(h.storage.signs.length, 0);
  assert.equal(submits(h).length, 0);
});

test('ownership mismatches fail with the localized message and never sign', async (t) => {
  const warn = quiet(t);
  const h = await harness(t);
  const cases: Array<[string, string, () => void, Record<string, unknown>?]> = [
    // A file row in the job user's name pointing at another user's upload (file rows are client-writable).
    ['forged-row', 'storage-owner-mismatch', () => { h.own(PATH, OTHER); h.fileRow(); }],
    // Legacy object without a recorded owner: never trusted for a re-sign.
    ['null-owner', 'storage-owner-unknown', () => { h.own(PATH, null); h.fileRow(); }],
    ['foreign-row', 'file-owner-mismatch', () => { h.own(PATH, USER); h.fileRow({ user_id: OTHER }); }],
    ['other-bucket-row', 'file-bucket-mismatch', () => { h.own(PATH, USER); h.fileRow({ bucket: 'meeting-note-images' }); }],
    // The row names a different object than the job's stored link: never swap the audio.
    ['other-object-row', 'file-path-mismatch', () => { h.own(PATH, USER); h.own('55555555-5555-4555-8555-555555555555-other.m4a', USER); h.fileRow({ storage_path: '55555555-5555-4555-8555-555555555555-other.m4a' }); }],
    ['missing-row', 'file-row-missing', () => { h.own(PATH, USER); }],
    ['malformed-file-id', 'invalid-file-id', () => { h.own(PATH, USER); h.fileRow(); }, { fileId: 'not-a-uuid' }],
    ['other-bucket-link', 'link-bucket-mismatch', () => { h.own(PATH, USER); h.fileRow(); },
      { downloadUrl: `${STORAGE_ORIGIN}/storage/v1/object/sign/meeting-note-images/${PATH}?token=${mintToken(`meeting-note-images/${PATH}`, nowSeconds() - 60)}` }],
  ];
  for (const [jobId, reason, arrange, overrides] of cases) {
    h.f.reset();
    h.storage.objects.clear(); h.storage.files.clear(); h.storage.signs.length = 0;
    arrange();
    const done = await resume(h, jobId, webRequest(overrides));
    assertRefused(h, warn, jobId, done, reason);
    assert.equal(h.storage.signs.length, 0, `${jobId}: nothing is signed`);
    assert.equal(submits(h).length, 0, `${jobId}: nothing is submitted`);
    assert.equal(incidents(h).length, 0, `${jobId}: an expected outcome, not an ops incident`);
  }
});

test('refusal logs quote decoded client-supplied text so it cannot forge log lines', async (t) => {
  const warn = quiet(t);
  const h = await harness(t);
  h.own(); h.fileRow();
  const forged = 'x\nWorkflow job forged-job re-signed its recording';
  const link = `${STORAGE_ORIGIN}/storage/v1/object/sign/${encodeURIComponent(forged)}/${PATH}?token=${mintToken(`x/${PATH}`, nowSeconds() - 60)}`;
  const done = await resume(h, 'log-injection-job', webRequest({ downloadUrl: link }));
  assertRefused(h, warn, 'log-injection-job', done, 'link-bucket-mismatch');
  const lines = warn.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(lines.every((line) => !/[\r\n]/.test(line)), 'every warning stays on one line');
  assert.ok(!lines.some((line) => line.startsWith('Workflow job forged-job')), 'no forged entry');
  assert.ok(lines.some((line) => line.includes('link-bucket-mismatch') && line.includes('\\\\nWorkflow job forged-job')), 'the decoded bucket is logged escaped');
});

test('a request without fileId re-signs from the stored link path only when storage owns it to the job user', async (t) => {
  const warn = quiet(t);
  const h = await harness(t);
  const { fileId: _omit, ...withoutFileId } = webRequest();

  // Owner matches: re-signed from the stored link's object, no file row involved.
  h.own(PATH, USER);
  const done = await resume(h, 'no-file-id-job', withoutFileId);
  assert.equal(done.status, 'completed');
  assert.deepEqual(h.storage.fileLookups, [], 'no file row lookup without a fileId');
  assert.deepEqual(h.storage.ownerLookups, [{ p_bucket: BUCKET, p_name: PATH }]);
  assert.deepEqual(h.storage.signs, [`${BUCKET}/${PATH}`]);
  const fresh = parseProjectSignedUrl(String(submits(h)[0]!.body.audio_url))!;
  assert.deepEqual([fresh.bucket, fresh.path], [BUCKET, PATH]);

  // Owner is another user, or unknown (legacy): refused, nothing signed.
  for (const [jobId, owner, reason] of [['no-file-id-foreign', OTHER, 'storage-owner-mismatch'], ['no-file-id-null-owner', null, 'storage-owner-unknown']] as const) {
    h.f.reset(); h.storage.signs.length = 0; h.storage.objects.clear();
    h.own(PATH, owner);
    const refused = await resume(h, jobId, withoutFileId);
    assertRefused(h, warn, jobId, refused, reason);
    assert.equal(h.storage.signs.length, 0, `${jobId}: nothing is signed`);
    assert.equal(submits(h).length, 0, `${jobId}: nothing is submitted`);
    assert.equal(incidents(h).length, 0, `${jobId}: no ops incident`);
  }

  // A live link is still reused as is.
  h.f.reset(); h.storage.signs.length = 0;
  const live = storedLink(PATH, nowSeconds() + 3_600);
  const reachable = await resume(h, 'no-file-id-live-job', { ...withoutFileId, downloadUrl: live });
  assert.equal(reachable.status, 'completed');
  assert.equal(submits(h)[0]!.body.audio_url, live);
  assert.equal(h.storage.signs.length, 0);
});

test('SSRF and path traversal: foreign hosts are never fetched or re-signed, unsafe paths are refused before any signing', async (t) => {
  const warn = quiet(t);
  const h = await harness(t);
  // A link outside the project storage host: unchanged behavior (no probe, no re-sign).
  h.own(); h.fileRow();
  const foreign = await resume(h, 'foreign-host-job', webRequest({ downloadUrl: 'https://audio.invalid/storage/v1/object/sign/meeting-recordings/x?token=t' }));
  assert.equal(foreign.status, 'completed');
  assert.ok(!h.f.state.calls.some((c) => c.url.hostname === 'audio.invalid'), 'the server never fetches a client-supplied host');
  assert.equal(h.storage.fileLookups.length + h.storage.signs.length, 0);

  // Traversal with encoded slashes: the stored link and the forged row name the same literal
  // object key, owned by the job user, but signing it would resolve to another bucket.
  const traversal = 'u/../../private/victim.ogg';
  const cases: Array<[string, string]> = [
    ['traversal-job', traversal],
    ['dot-segment-job', 'u/./x.ogg'],
    ['encoded-dots-job', '%2e%2e/x.ogg'],
  ];
  for (const [jobId, path] of cases) {
    h.f.reset();
    h.storage.objects.clear(); h.storage.files.clear(); h.storage.signs.length = 0; h.storage.ownerLookups.length = 0;
    h.own(path, USER);
    h.storage.objects.set('private/victim.ogg', { owner: OTHER });
    h.fileRow({ storage_path: path });
    const done = await resume(h, jobId, webRequest({ downloadUrl: storedLink(path, nowSeconds() - 60, (p) => p.split('/').map(encodeURIComponent).join('%2F')) }));
    assertRefused(h, warn, jobId, done, 'unsafe-path');
    assert.equal(h.storage.signs.length, 0, `${jobId}: nothing is signed`);
    assert.equal(h.storage.ownerLookups.length, 0, `${jobId}: refused before any lookup`);
    assert.equal(submits(h).length, 0);
  }
});

test('a re-sign failure fails with the localized message and keeps the recording', async (t) => {
  const warn = quiet(t);
  const h = await harness(t);
  const cases: Array<[string, string, () => void]> = [
    ['sign-error-job', 'sign-failed', () => { h.storage.signStatus = 500; }],
    ['sign-refused-job', 'sign-failed', () => { h.storage.signStatus = 400; }],
    ['owner-lookup-error-job', 'lookup-failed', () => { h.storage.ownerStatus = 500; }],
    ['file-lookup-error-job', 'lookup-failed', () => { h.storage.fileStatus = 500; }],
    // The object was deleted after the job started: storage has no owner for it any more.
    ['deleted-object-job', 'storage-owner-unknown', () => { h.storage.objects.delete(`${BUCKET}/${PATH}`); }],
    // Storage answered with a link to another object: never submitted.
    ['wrong-signed-object-job', 'signed-link-mismatch', () => { h.storage.signAs = `${BUCKET}/other.m4a`; }],
    // The fresh link does not answer either.
    ['fresh-unreachable-job', 'fresh-link-unreachable', () => { h.storage.probeStatus = 400; }],
  ];
  for (const [jobId, reason, arrange] of cases) {
    h.f.reset();
    Object.assign(h.storage, { signStatus: 200, signAs: null, probeStatus: 0, ownerStatus: 200, fileStatus: 200 });
    h.storage.objects.clear(); h.storage.files.clear();
    h.own(); h.fileRow();
    arrange();
    const done = await resume(h, jobId, webRequest());
    assertRefused(h, warn, jobId, done, reason);
    assert.equal(submits(h).length, 0, `${jobId}: nothing is submitted`);
    assert.equal(incidents(h).length, 0, `${jobId}: no ops incident`);
  }
});

// ---------------------------------------------------------------------------
// I2: a signed link never leaks through provider errors
// ---------------------------------------------------------------------------

test('redactSignedUrls removes signed storage links and token values', async () => {
  const { redactSignedUrls } = await import('./pipeline/errors.js');
  const link = storedLink(PATH, nowSeconds() + 3_600);
  const token = new URL(link).searchParams.get('token')!;
  const cases = [
    `Download failed for ${link}`,
    `{"error":"bad audio_url \\"${link}\\""}`,
    `relative /object/sign/${BUCKET}/${PATH}?token=${token}&download=1`,
    `upload https://supabase.invalid/storage/v1/object/upload/sign/${BUCKET}/${PATH}?token=${token}`,
  ];
  for (const text of cases) {
    const redacted = redactSignedUrls(text);
    assert.ok(!redacted.includes(token), `token removed: ${redacted}`);
    assert.ok(!redacted.includes(`?token=${token.slice(0, 8)}`), redacted);
  }
  assert.equal(redactSignedUrls(`Download failed for ${link}`), 'Download failed for [signed storage link]');
  assert.equal(redactSignedUrls('AssemblyAI transcription failed.'), 'AssemblyAI transcription failed.', 'plain text is untouched');
});

test('an AssemblyAI error that echoes the audio_url reaches the job row, logs and incident without the signed link', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'warn', () => undefined);
  const error = t.mock.method(console, 'error', () => undefined);
  const h = await harness(t);
  h.own(); h.fileRow();
  const live = storedLink(PATH, nowSeconds() + 3_600);
  const token = new URL(live).searchParams.get('token')!;
  const inner = globalThis.fetch;
  let mode: 'poll-error' | 'submit-rejected' = 'poll-error';
  t.mock.method(globalThis, 'fetch', async (input: FetchInput, init?: RequestInit) => {
    const url = toUrl(input);
    if (url.hostname === 'api.assemblyai.com') {
      const method = init?.method ?? 'GET';
      h.f.state.calls.push({ url, method, body: parseJson(init?.body) });
      if (mode === 'submit-rejected' && method === 'POST') return Response.json({ error: `Cannot access uploaded file at ${live}` }, { status: 400 });
      if (method === 'POST') return Response.json({ id: 'leaky-transcript', status: 'queued' });
      return Response.json({ id: 'leaky-transcript', status: 'error', error: `Download error, unable to download ${live}. Please make sure the file exists.` });
    }
    return inner(input, init);
  });
  for (const [jobId, next] of [['leaky-poll-job', 'poll-error'], ['leaky-submit-job', 'submit-rejected']] as const) {
    h.f.reset(); mode = next; error.mock.resetCalls();
    const done = await resume(h, jobId, webRequest({ downloadUrl: live }));
    assert.equal(done.status, 'failed', jobId);
    assert.ok(String(done.error).includes('[signed storage link]'), `${jobId}: ${done.error}`);
    await until(() => incidents(h).some((c) => c.method === 'POST'), `${jobId}: the incident`);
    await sleep(30);
    const surfaces = [
      String(done.error),
      ...error.mock.calls.flatMap((c) => c.arguments.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a)))),
      ...incidents(h).map((c) => JSON.stringify(c.body ?? null)),
    ];
    assert.ok(surfaces.every((text) => !text.includes(token)), `${jobId}: no surface carries the token`);
  }
});
