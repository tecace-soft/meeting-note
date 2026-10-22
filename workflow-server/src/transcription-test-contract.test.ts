import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowFixture, USER } from './test-support/workflow.js';
import { isLiteModel } from './gemini-models.js';

const special = 'd9eb0f3d-819e-4b45-8df6-e9f229de2447';
const audio = { fileName: 'fixture.ogg', mimeType: 'audio/ogg', dataBase64: 'YWJj' };
const models = ['assembly_universal2_codeswitch', 'assembly_universal3pro_auto', 'gemini', 'openai'] as const;

test('T1-1 transcription-test parser and authenticated route contracts', async (t) => {
  const f = await workflowFixture(); t.after(() => f.close());
  const { parseTranscriptionTestInput } = await import('./routes/transcriptionTest.js');
  const { env } = await import('./config/env.js'); env.openAiApiKey = 'synthetic-openai';
  await t.test('parser preserves defaults, trimming, valid models and exact input errors', () => {
    for (const model of models) {
      const result = parseTranscriptionTestInput({ dataBase64: ' YWJj ', model });
      assert.deepEqual(result, { fileName: 'audio-test', mimeType: 'application/octet-stream', bytes: new Uint8Array([97, 98, 99]), model });
    }
    assert.equal(parseTranscriptionTestInput({ ...audio, fileName: 'x'.repeat(300), model: 'gemini' }).fileName.length, 240);
    assert.throws(() => parseTranscriptionTestInput({ model: 'gemini' }), { message: 'dataBase64 is required.' });
    assert.throws(() => parseTranscriptionTestInput({ ...audio, model: 'other' }), { message: 'model is required.' });
    assert.throws(() => parseTranscriptionTestInput({ dataBase64: '=', model: 'gemini' }), { message: 'Audio file is empty.' });
    const maximum = 75 * 1024 * 1024;
    const raw = 'A'.repeat(maximum / 3 * 4);
    assert.equal(parseTranscriptionTestInput({ dataBase64: raw, model: 'gemini' }).bytes.byteLength, maximum);
    assert.throws(() => parseTranscriptionTestInput({ dataBase64: raw + 'AAAA', model: 'gemini' }), { message: 'Test audio must be 75 MB or smaller for this page.' });
  });
  await t.test('auth, special-user gate, exact method/path and parser errors remain unchanged', async () => {
    assert.equal((await f.request('/transcription-test', { authenticated: false })).status, 401);
    assert.equal((await f.request('/transcription-test', { body: { ...audio, model: 'gemini' } })).status, 403);
    f.state.caller = special;
    assert.equal((await f.request('/transcription-test', { method: 'GET' })).status, 404);
    assert.equal((await f.request('/transcription-test?x=1', { body: { ...audio, model: 'gemini' } })).status, 404);
    const invalid = await f.request('/transcription-test', { body: { model: 'gemini' } });
    assert.equal(invalid.status, 400); assert.equal(invalid.body.error, 'dataBase64 is required.');
  });
  for (const model of models) await t.test(`${model} success retains response and provider contracts`, async (sub) => {
    f.state.caller = special; f.state.calls.length = 0;
    const previous = globalThis.fetch; const calls: { url: string; body: unknown }[] = [];
    sub.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input); calls.push({ url, body: init?.body });
      if (url.includes('generativelanguage.googleapis.com/upload/')) return new Response('', { headers: { 'x-goog-upload-url': 'https://upload.invalid/fixture' } });
      if (url === 'https://upload.invalid/fixture') return Response.json({ file: { uri: 'https://file.invalid/fixture', mimeType: 'audio/ogg' } });
      if (url.includes('generativelanguage.googleapis.com/v1beta/models/')) return Response.json({ candidates: [{ content: { parts: [{ text: '{"segments":[{"speaker":"Speaker 1","text":"Fixture meeting.","start":0,"end":1}]}' }] } }] });
      if (url === 'https://api.openai.com/v1/audio/transcriptions') {
        assert.ok(init?.body instanceof FormData); assert.equal(init.body.get('response_format'), 'json');
        assert.match(String(init.body.get('prompt')), /original language/);
        return Response.json({ text: ' Fixture meeting. ' });
      }
      return previous(input, init);
    });
    const result = await f.request('/transcription-test', { body: { ...audio, model } });
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(Object.keys(result.body).sort(), ['config', 'fileName', 'latencyMs', 'mimeType', 'model', 'raw', 'segments', 'sizeBytes', 'text'].sort());
    assert.equal(result.body.model, model); assert.equal(result.body.fileName, audio.fileName); assert.equal(result.body.sizeBytes, 3);
    assert.equal(result.body.segments[0].text, 'Fixture meeting.'); assert.ok(result.body.latencyMs >= 0);
    if (model.startsWith('assembly')) {
      assert.deepEqual(result.body.config.speech_models, [model === 'assembly_universal2_codeswitch' ? 'universal-2' : 'universal-3-pro']);
      assert.equal(result.body.config.audio_url, '<assemblyai-upload-url>');
      assert.equal('language_detection' in result.body.config, false);
    }
    if (model === 'gemini') { assert.ok(isLiteModel(result.body.config.model)); assert.equal(result.body.config.parseMode, 'strict-json'); }
    if (model === 'openai') { assert.equal(result.body.text, 'Fixture meeting.'); assert.equal(result.body.segments[0].speaker, 'Transcript'); }
    assert.ok(calls.some(call => call.url.includes(model === 'openai' ? 'api.openai.com' : model === 'gemini' ? 'generativelanguage.googleapis.com' : 'api.assemblyai.com')));
  });
  for (const [label, texts, expectedMode] of [
    ['recover original', ['{"segments":[{"speaker":"Pat","text":"complete"},{"text":"unfinished'], 'recovered-original-json'],
    ['repair JSON', ['{}', '{"segments":[{"speaker":"Pat","text":"repaired"}]}'], 'repaired-json'],
    ['failed repair', ['{}', '{}'], null],
  ] as const) await t.test(`Gemini ${label} preserves recovery behavior`, async (sub) => {
    f.state.caller = special; const previous = globalThis.fetch; let generated = 0;
    sub.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes('generativelanguage.googleapis.com/upload/')) return new Response('', { headers: { 'x-goog-upload-url': 'https://upload.invalid/fixture' } });
      if (url === 'https://upload.invalid/fixture') return Response.json({ file: { uri: 'https://file.invalid/fixture', mimeType: 'audio/ogg' } });
      if (url.includes('generativelanguage.googleapis.com/v1beta/models/')) return Response.json({ candidates: [{ content: { parts: [{ text: texts[generated++] }] } }] });
      return previous(input, init);
    });
    const result = await f.request('/transcription-test', { body: { ...audio, model: 'gemini' } });
    if (expectedMode) { assert.equal(result.status, 200); assert.equal(result.body.config.parseMode, expectedMode); }
    else { assert.equal(result.status, 500); assert.match(result.body.error, /Gemini returned malformed transcript JSON and recovery failed/); }
    assert.equal(generated, texts.length);
  });
  await t.test('OpenAI diarization model omits unsupported prompt while retaining JSON response', async (sub) => {
    f.state.caller = special; const previous = globalThis.fetch; const model = env.transcriptionTestOpenAiModel;
    env.transcriptionTestOpenAiModel = 'fixture-diarize'; sub.after(() => { env.transcriptionTestOpenAiModel = model; });
    sub.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input) === 'https://api.openai.com/v1/audio/transcriptions') {
        assert.ok(init?.body instanceof FormData); assert.equal(init.body.has('prompt'), false);
        return Response.json({ text: 'fixture' });
      }
      return previous(input, init);
    });
    const result = await f.request('/transcription-test', { body: { ...audio, model: 'openai' } });
    assert.equal(result.status, 200); assert.match(result.body.config.prompt, /not sent/);
  });
  for (const model of ['assembly_universal2_codeswitch', 'gemini', 'openai'] as const) await t.test(`${model} provider failure retains HTTP error`, async (sub) => {
    f.state.caller = special; const previous = globalThis.fetch;
    sub.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const hostname = new URL(String(input)).hostname;
      if (['api.assemblyai.com', 'generativelanguage.googleapis.com', 'api.openai.com'].includes(hostname)) return Response.json({ error: { message: 'fixture failure' } }, { status: 400 });
      return previous(input, init);
    });
    const result = await f.request('/transcription-test', { body: { ...audio, model } });
    assert.equal(result.status, 500); assert.match(result.body.error, /failed \(400\)/);
  });
  f.state.caller = USER;
});
