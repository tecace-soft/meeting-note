// T1-10a: direct contract for pipeline/androidUpload helpers (pure functions, multipart parser,
// storage and file-row writers) against fake request and supabase boundaries.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { IncomingMessage } from 'node:http';
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role';
process.env.GEMINI_API_KEY = 'synthetic-gemini';
process.env.ASSEMBLYAI_API_KEY = 'synthetic-assembly';
const { supabase } = await import('./db/supabaseClient.js');
const { HttpError, getHttpStatus } = await import('./http/shared.js');
const android = await import('./pipeline/androidUpload.js');
const {
  AUDIO_BUCKET, ANDROID_AUDIO_MAX_BYTES, ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS, ASSEMBLYAI_AUDIO_EXTENSION_RE,
  sanitizeUploadFileName, parseOptionalDate, isSupportedAndroidAudio, parseAndroidMultipartUpload,
  createAudioSignedUrl, uploadAndroidAudioToStorage, createAndroidAudioFileRecord,
} = android;

const B = 'unit-boundary';
function request(parts: string, contentType: string | null = `multipart/form-data; boundary=${B}`): IncomingMessage {
  const req = Readable.from([Buffer.from(parts)]) as unknown as IncomingMessage;
  req.headers = contentType === null ? {} : { 'content-type': contentType };
  return req;
}
const file = (name: string, filename: string, type: string | null, data: string) =>
  `--${B}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n${type ? `Content-Type: ${type}\r\n` : ''}\r\n${data}\r\n`;
const field = (name: string, value: string) => `--${B}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
const end = `--${B}--\r\n`;

test('constants keep bucket, size cap and extension list', () => {
  assert.equal(AUDIO_BUCKET, 'meeting-recordings');
  assert.equal(ANDROID_AUDIO_MAX_BYTES, 104_857_600);
  assert.equal(ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS.length, 32);
  assert.equal(ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS[0], '3ga');
  assert.equal(ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS.at(-1), 'wma');
  assert.ok(ASSEMBLYAI_AUDIO_EXTENSION_RE.test('A.M4A'));
  assert.ok(!ASSEMBLYAI_AUDIO_EXTENSION_RE.test('a.m4a.txt'));
  assert.ok(!ASSEMBLYAI_AUDIO_EXTENSION_RE.test('m4a'));
});

test('sanitizeUploadFileName strips paths and non-ascii, collapses whitespace, caps at 180', () => {
  assert.equal(sanitizeUploadFileName('C:\\x\\y/My  Meeting 회의 (1).m4a', 'fb.ogg'), 'My_Meeting_1.m4a');
  assert.equal(sanitizeUploadFileName('회의', 'fb.ogg'), 'fb.ogg');
  assert.equal(sanitizeUploadFileName('', 'fb.ogg'), 'fb.ogg');
  assert.equal(sanitizeUploadFileName('a__b', 'fb.ogg'), 'a_b');
  assert.equal(sanitizeUploadFileName('x'.repeat(300), 'fb.ogg').length, 180);
});

test('parseOptionalDate returns ISO strings or null', () => {
  assert.equal(parseOptionalDate(undefined), null);
  assert.equal(parseOptionalDate('   '), null);
  assert.equal(parseOptionalDate('garbage'), null);
  assert.equal(parseOptionalDate(' 2026-10-01T10:00:00Z '), '2026-10-01T10:00:00.000Z');
});

test('isSupportedAndroidAudio accepts audio/* mime or a supported extension', () => {
  const f = (originalName: string, mimeType: string) => ({ fieldName: 'audio', originalName, mimeType, tempPath: '', sizeBytes: 1 });
  assert.ok(isSupportedAndroidAudio(f('x.bin', 'AUDIO/Foo')));
  assert.ok(isSupportedAndroidAudio(f('X.OPUS', 'application/octet-stream')));
  assert.ok(!isSupportedAndroidAudio(f('x.txt', 'text/plain')));
});

test('parseAndroidMultipartUpload parses fields and file, defaults mime, writes a temp file', async () => {
  const upload = await parseAndroidMultipartUpload(request(field('fileName', 'n') + field('language', 'ko') + file('audio', 'clip', null, 'abc') + end));
  try {
    assert.deepEqual(upload.fields, { fileName: 'n', language: 'ko' });
    assert.equal(upload.file.fieldName, 'audio');
    assert.equal(upload.file.originalName, 'clip');
    assert.equal(upload.file.mimeType, 'text/plain');
    assert.equal(upload.file.sizeBytes, 3);
    assert.ok(upload.file.tempPath.startsWith(tmpdir()));
    assert.match(upload.file.tempPath, /meeting-note-android-[0-9a-f-]{36}\.audio$/);
    assert.equal((await readFile(upload.file.tempPath)).toString(), 'abc');
  } finally { await unlink(upload.file.tempPath).catch(() => undefined); }
});

test('parseAndroidMultipartUpload uses the file extension in the temp name and truncates long field values', async () => {
  const upload = await parseAndroidMultipartUpload(request(field('instructions', 'z'.repeat(20_000)) + file('audio', 'rec.WAV', 'audio/wav', 'x') + end));
  try {
    assert.match(upload.file.tempPath, /\.WAV$/);
    assert.equal(upload.fields.instructions!.length, 20_000);
    assert.equal(upload.file.mimeType, 'audio/wav');
  } finally { await unlink(upload.file.tempPath).catch(() => undefined); }
});

test('parseAndroidMultipartUpload error mapping', async () => {
  const cases: [string, IncomingMessage, number, string][] = [
    ['no content type', request('', null), 400, 'Content-Type must be multipart/form-data.'],
    ['json', request('{}', 'application/json'), 400, 'Content-Type must be multipart/form-data.'],
    ['no file', request(field('a', 'b') + end), 400, 'Missing required multipart file field "audio".'],
    ['wrong field', request(file('clip', 'a.ogg', 'audio/ogg', 'x') + end), 400, 'Only one multipart file field named "audio" is supported.'],
    ['two files', request(file('audio', 'a.ogg', 'audio/ogg', 'x') + file('audio', 'b.ogg', 'audio/ogg', 'y') + end), 400, 'Only one audio file can be uploaded per request.'],
    ['21 fields', request(Array.from({ length: 21 }, (_, i) => field(`f${i}`, 'v')).join('') + file('audio', 'a.ogg', 'audio/ogg', 'x') + end), 400, 'Too many multipart fields.'],
  ];
  for (const [label, req, status, message] of cases) {
    await assert.rejects(parseAndroidMultipartUpload(req), (error: unknown) => {
      assert.ok(error instanceof HttpError, label);
      assert.equal(getHttpStatus(error), status, label);
      assert.equal((error as Error).message, message, label);
      return true;
    });
  }
});

test('parseAndroidMultipartUpload rejects oversize audio with 413', async () => {
  const body = Buffer.concat([Buffer.from(file('audio', 'big.ogg', 'audio/ogg', '').slice(0, -2)), Buffer.alloc(ANDROID_AUDIO_MAX_BYTES + 1, 1), Buffer.from(`\r\n${end}`)]);
  const req = Readable.from([body]) as unknown as IncomingMessage;
  req.headers = { 'content-type': `multipart/form-data; boundary=${B}` };
  await assert.rejects(parseAndroidMultipartUpload(req), (error: unknown) => {
    assert.equal(getHttpStatus(error), 413);
    assert.equal((error as Error).message, 'Audio file exceeds the 100 MB maximum size.');
    return true;
  });
  // Removal of the partial temp file is best effort (unlink is not awaited and can lose to the open stream on Windows), so it is not pinned.
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const name of readdirSync(tmpdir()).filter((n) => n.startsWith('meeting-note-android-') && statSync(join(tmpdir(), n)).size > ANDROID_AUDIO_MAX_BYTES / 2)) await unlink(join(tmpdir(), name)).catch(() => undefined);
});

test('uploadAndroidAudioToStorage writes android/<user>/<note>/<file> without upsert, then signs for 6h', async (t) => {
  const upload = await parseAndroidMultipartUpload(request(file('audio', 'a.ogg', 'audio/ogg', 'payload') + end));
  t.after(() => unlink(upload.file.tempPath).catch(() => undefined));
  const calls: { bucket: string; op: string; args: unknown[] }[] = [];
  let result: { error: { message: string } | null } = { error: null };
  t.mock.method(supabase.storage, 'from', (bucket: string) => ({
    upload: async (...args: unknown[]) => { calls.push({ bucket, op: 'upload', args }); return result; },
    createSignedUrl: async (...args: unknown[]) => { calls.push({ bucket, op: 'sign', args }); return { data: { signedUrl: 'https://signed.invalid/x' }, error: null }; },
  }));
  const out = await uploadAndroidAudioToStorage({ userId: 'u1', noteId: 'n1', fileName: 'f.ogg', mimeType: '', tempPath: upload.file.tempPath });
  assert.deepEqual(out, { storagePath: 'android/u1/n1/f.ogg', signedUrl: 'https://signed.invalid/x' });
  assert.equal(calls[0]!.bucket, 'meeting-recordings');
  assert.equal(calls[0]!.args[0], 'android/u1/n1/f.ogg');
  assert.equal((calls[0]!.args[1] as Buffer).toString(), 'payload');
  assert.deepEqual(calls[0]!.args[2], { cacheControl: '3600', contentType: 'audio/ogg', upsert: false });
  assert.deepEqual(calls[1]!.args, ['android/u1/n1/f.ogg', 21600]);
  result = { error: { message: 'boom' } };
  await assert.rejects(uploadAndroidAudioToStorage({ userId: 'u1', noteId: 'n1', fileName: 'f.ogg', mimeType: 'audio/mp4', tempPath: upload.file.tempPath }), { message: 'boom' });
  assert.equal(calls.length, 3, 'no signing after a failed upload');
});

test('createAudioSignedUrl throws the storage error or a fixed message', async (t) => {
  let reply: { data: { signedUrl?: string } | null; error: Error | null } = { data: null, error: new Error('denied') };
  t.mock.method(supabase.storage, 'from', () => ({ createSignedUrl: async () => reply }));
  await assert.rejects(createAudioSignedUrl('p'), { message: 'denied' });
  reply = { data: {}, error: null };
  await assert.rejects(createAudioSignedUrl('p'), { message: 'Could not create a signed audio URL.' });
});

test('createAndroidAudioFileRecord inserts the android_recording file row and rethrows errors', async (t) => {
  const inserts: { table: string; row: unknown }[] = [];
  let error: { message: string } | null = null;
  t.mock.method(supabase, 'from', (table: string) => ({ insert: async (row: unknown) => { inserts.push({ table, row }); return { error }; } }));
  const input = { id: 'f1', userId: 'u1', fileName: 'a.ogg', storagePath: 'android/u1/n1/a.ogg', mimeType: '', sizeBytes: 7, recordedAt: null };
  await createAndroidAudioFileRecord(input);
  assert.deepEqual(inserts, [{ table: 'file', row: { id: 'f1', user_id: 'u1', name: 'a.ogg', bucket: 'meeting-recordings', storage_path: 'android/u1/n1/a.ogg', public_url: '', mime_type: 'audio/ogg', size_bytes: 7, source: 'android_recording', recorded_at: null } }]);
  error = { message: 'insert failed' };
  await assert.rejects(createAndroidAudioFileRecord(input), { message: 'insert failed' });
});
