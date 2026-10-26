// T1-10a characterization: pins the Android upload route's multipart parsing, size limits,
// storage path/bucket/content-type, file row, filename sanitizing and error mapping before the
// helpers leave index.ts. Runs through the real HTTP route with offline fakes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowFixture, USER } from './test-support/workflow.js';

const BOUNDARY = 'android-contract-boundary';
type Part = { name: string; value?: string; filename?: string; type?: string; data?: Buffer };

function multipart(parts: Part[]): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disposition = `Content-Disposition: form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ''}`;
    const type = p.type ? `\r\nContent-Type: ${p.type}` : '';
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n${disposition}${type}\r\n\r\n`), p.data ?? Buffer.from(p.value ?? ''), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}
const audio = (over: Partial<Part> = {}): Part => ({ name: 'audio', filename: 'fixture.ogg', type: 'audio/ogg', data: Buffer.from('fixture-audio'), ...over });

test('T1-10a Android upload route contract (multipart, limits, storage, errors)', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'warn', () => undefined);
  const f = await workflowFixture();
  const storageUploads: { path: string; headers: Record<string, string>; method: string }[] = [];
  let failStorageUpload = false;
  const fixtureFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'supabase.invalid' && url.pathname.startsWith('/storage/v1/object/') && !url.pathname.includes('/sign/')) {
      storageUploads.push({ path: url.pathname, method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      if (failStorageUpload) return new Response(JSON.stringify({ message: 'bucket exploded', statusCode: '500' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return fixtureFetch(input, init);
  });
  t.after(() => f.close());
  const token = `fixture.${Buffer.from(JSON.stringify({ oid: USER, tid: f.state.tenant })).toString('base64url')}.fixture`;
  const send = async (body: Buffer | string, contentType = `multipart/form-data; boundary=${BOUNDARY}`) => {
    const r = await fetch(f.base + '/android/recordings/jobs', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': contentType }, body: typeof body === 'string' ? body : new Uint8Array(body) });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as Record<string, any> };
  };
  const drain = async () => {
    for (let attempt = 0; attempt < 100 && f.state.jobStatus !== 'completed'; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const check = (name: string, run: () => Promise<void>) => t.test(name, async () => { f.reset(); storageUploads.length = 0; failStorageUpload = false; await run(); });
  const rejects = async (parts: Part[], status: number, error: string) => {
    const r = await send(multipart(parts));
    assert.equal(r.status, status, r.text);
    assert.equal(r.body.error, error);
    assert.equal(storageUploads.length, 0, 'nothing is stored for a rejected upload');
  };

  await check('happy path: storage path, bucket, content-type, file row and job request', async () => {
    const r = await send(multipart([
      audio({ filename: 'My Meeting.m4a', type: 'audio/mp4' }),
      { name: 'fileName', value: 'Weekly sync' }, { name: 'recordingEndedAt', value: '2026-10-01T10:00:00Z' },
      { name: 'language', value: 'ko' }, { name: 'userTimeZone', value: 'Asia/Seoul' }, { name: 'instructions', value: 'be brief' },
    ]));
    assert.equal(r.status, 202, r.text);
    assert.deepEqual(Object.keys(r.body).sort(), ['fileId', 'jobId', 'noteId', 'progress', 'stage', 'status']);
    assert.equal(r.body.status, 'queued');
    const { noteId, fileId } = r.body;
    assert.equal(storageUploads.length, 1);
    // The fileName field has no extension, so the original .m4a extension is appended.
    assert.equal(storageUploads[0]!.path, `/storage/v1/object/meeting-recordings/android/${USER}/${noteId}/Weekly_sync.m4a`);
    assert.equal(storageUploads[0]!.headers['content-type'], 'audio/mp4');
    assert.equal(storageUploads[0]!.headers['cache-control'], 'max-age=3600');
    assert.equal(storageUploads[0]!.headers['x-upsert'], 'false');
    assert.ok(f.state.calls.some((c) => c.url.pathname.includes('/storage/v1/object/sign/meeting-recordings/android/') && c.method === 'POST' && c.body?.expiresIn === 21600));
    const fileRow = f.state.calls.find((c) => c.url.pathname === '/rest/v1/file' && c.method === 'POST')!.body;
    assert.deepEqual(fileRow, { id: fileId, user_id: USER, name: 'Weekly_sync.m4a', bucket: 'meeting-recordings', storage_path: `android/${USER}/${noteId}/Weekly_sync.m4a`, public_url: '', mime_type: 'audio/mp4', size_bytes: 13, source: 'android_recording', recorded_at: '2026-10-01T10:00:00.000Z' });
    const job = f.state.calls.find((c) => c.url.pathname === '/rest/v1/workflow_job' && c.method === 'POST')!.body;
    assert.equal(job.type, 'summarize_audio'); assert.equal(job.note_id, noteId);
    assert.equal(job.request.source, 'android_recording');
    assert.equal(job.request.originalFileName, 'My Meeting.m4a');
    assert.equal(job.request.sizeBytes, 13);
    assert.equal(job.request.language, 'ko'); assert.equal(job.request.userTimeZone, 'Asia/Seoul'); assert.equal(job.request.instructions, 'be brief');
    assert.equal(job.request.promptId, 'android-default'); assert.equal(job.request.meetingAt, '2026-10-01T10:00:00.000Z');
    await drain();
  });
  await check('defaults: unsupported original extension falls back to .ogg, bad date is null, unknown language is en', async () => {
    const r = await send(multipart([audio({ filename: 'rec.xyz', type: 'audio/ogg' }), { name: 'recordingEndedAt', value: 'not a date' }, { name: 'language', value: 'fr' }]));
    assert.equal(r.status, 202, r.text);
    const fileRow = f.state.calls.find((c) => c.url.pathname === '/rest/v1/file' && c.method === 'POST')!.body;
    assert.equal(fileRow.recorded_at, null);
    assert.equal(fileRow.name, 'rec.xyz.ogg');
    const job = f.state.calls.find((c) => c.url.pathname === '/rest/v1/workflow_job' && c.method === 'POST')!.body;
    assert.equal(job.request.language, 'en');
    await drain();
  });
  await check('rejects a non-multipart content type', async () => {
    const r = await send('{}', 'application/json');
    assert.equal(r.status, 400); assert.equal(r.body.error, 'Content-Type must be multipart/form-data.');
  });
  await check('rejects a missing audio field', async () => {
    await rejects([{ name: 'fileName', value: 'x' }], 400, 'Missing required multipart file field "audio".');
  });
  await check('rejects a file under another field name', async () => {
    await rejects([audio({ name: 'recording' })], 400, 'Only one multipart file field named "audio" is supported.');
  });
  await check('rejects two audio files', async () => {
    await rejects([audio(), audio({ filename: 'two.ogg' })], 400, 'Only one audio file can be uploaded per request.');
  });
  await check('rejects more than 20 fields', async () => {
    const fields: Part[] = Array.from({ length: 21 }, (_, i) => ({ name: `f${i}`, value: 'v' }));
    await rejects([...fields, audio()], 400, 'Too many multipart fields.');
  });
  await check('rejects an unsupported audio type with the extension list', async () => {
    const r = await send(multipart([audio({ filename: 'notes.txt', type: 'text/plain' })]));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /^Unsupported audio file\. Upload an audio file supported by AssemblyAI: 3ga, 8svx, aac,.*, webm, wma\.$/);
    assert.equal(storageUploads.length, 0);
  });
  await check('accepts a non-audio mime when the extension is supported and keeps the mime', async () => {
    const r = await send(multipart([audio({ filename: 'clip.WAV', type: 'application/octet-stream' })]));
    assert.equal(r.status, 202, r.text);
    assert.equal(storageUploads[0]!.headers['content-type'], 'application/octet-stream');
    assert.ok(storageUploads[0]!.path.endsWith('/clip.WAV'));
    await drain();
  });
  await check('rejects an empty audio file', async () => {
    await rejects([audio({ data: Buffer.alloc(0) })], 400, 'Uploaded audio file is empty.');
  });
  await check('rejects audio over 100 MB with 413', async () => {
    const r = await send(multipart([audio({ data: Buffer.alloc(100 * 1024 * 1024 + 1, 1) })]));
    assert.equal(r.status, 413, r.text);
    assert.equal(r.body.error, 'Audio file exceeds the 100 MB maximum size.');
    assert.equal(storageUploads.length, 0);
  });
  await check('storage upload failure maps to a 500 with the storage message', async () => {
    failStorageUpload = true;
    const r = await send(multipart([audio()]));
    assert.equal(r.status, 500, r.text);
    assert.equal(r.body.error, 'bucket exploded');
    assert.ok(!f.state.calls.some((c) => c.url.pathname === '/rest/v1/file' && c.method === 'POST'), 'no file row after a failed upload');
  });
  await check('database failure maps to a 500', async () => {
    f.state.dbFailure = true;
    const failed = await send(multipart([audio()]));
    assert.equal(failed.status, 500, failed.text);
  });
});
