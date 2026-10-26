// T1-10b characterization: pins the AssemblyAI transcription pipeline (settings load and
// normalization, submit payload, polling cadence and limits, error mapping, result parsing,
// usage recording, transcript translation) and its wiring into the summarize runner
// (checkpoint reuse, no-speech 422, checkpoint save order) before it leaves index.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TranscriptionSettings } from './pipeline/transcription.js';
// Service config must exist before the server modules read env at import time.
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role';
process.env.GEMINI_API_KEY = 'synthetic-gemini';
process.env.ASSEMBLYAI_API_KEY = 'synthetic-assembly';
const { supabase } = await import('./db/supabaseClient.js');
const { env } = await import('./config/env.js');
const { getHttpStatus } = await import('./http/shared.js');
const { noSpeechMessage } = await import('./pipeline/errors.js');
const { buildTranscriptTranslationPrompt } = await import('./prompts.js');
const { parseDiarizedSegmentsWithRecovery } = await import('./parsers.js');
const {
  normalizeDetectedTranscriptLanguage, getOppositeTranscriptLanguage, normalizeKeytermsPrompt,
  normalizeCustomSpelling, loadTranscriptionSettings, transcribeWithAssembly, translateTranscriptSegments,
} = await import('./pipeline/transcription.js');
const { workflowFixture, summarizeBody } = await import('./test-support/workflow.js');

const SUBMIT_URL = 'https://api.assemblyai.com/v2/transcript';
const AUDIO_URL = 'https://audio.invalid/a.ogg';

type DbCall = { table: string; op: string; payload?: unknown; filters: [string, unknown][] };
type DbResult = { data?: unknown; error?: { message: string } | null };

// Records the supabase query-builder chain per table without any network.
function fakeDb(t: test.TestContext, results: Record<string, DbResult> = {}) {
  const calls: DbCall[] = [];
  t.mock.method(supabase, 'from', (table: string) => {
    const call: DbCall = { table, op: '', filters: [] };
    calls.push(call);
    const result = results[table] ?? { data: null, error: null };
    const chain: any = {
      select: (cols: string) => { call.op ||= 'select'; call.payload = cols; return chain; },
      insert: (row: unknown) => { call.op = 'insert'; call.payload = row; return chain; },
      eq: (column: string, value: unknown) => { call.filters.push([column, value]); return chain; },
      maybeSingle: async () => result,
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  });
  return calls;
}

type HttpCall = { url: string; method: string | undefined; headers: Record<string, string>; body: string | null };
type Reply = () => Response;

// Scripted AssemblyAI boundary: one submit reply, then poll replies in order (last repeats).
function fakeAssembly(t: test.TestContext, script: { submit?: Reply; polls: Reply[] }) {
  const calls: HttpCall[] = [];
  let poll = 0;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === 'string' ? init.body : null });
    if (url === SUBMIT_URL) return script.submit ? script.submit() : Response.json({ id: 'tx-1' });
    if (url.startsWith(`${SUBMIT_URL}/`)) return script.polls[Math.min(poll++, script.polls.length - 1)]();
    throw new Error(`Unexpected fetch in transcription contract: ${url}`);
  });
  return { calls, polls: () => calls.filter((c) => c.url !== SUBMIT_URL) };
}

const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };

// Fake setTimeout plus a controllable performance.now (the poll loop's wall clock).
function fakeClock(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = { now: 0 };
  t.mock.method(performance, 'now', () => clock.now);
  return {
    clock,
    async advance(ms: number) { await flush(); clock.now += ms; t.mock.timers.tick(ms); await flush(); },
    // Real timers must be back before any assertion can fail: the test runner itself
    // schedules timers while reporting a failure and would otherwise stall.
    stop() { t.mock.timers.reset(); },
  };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: Error };
// Never leaves a rejection unhandled while the fake clock is being stepped.
function capture<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then((value) => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, error }));
}
// Steps the fake clock until the promise settles, then restores real timers.
async function settle<T>(timer: ReturnType<typeof fakeClock>, promise: Promise<T>, stepMs = 3000, maxSteps = 1000): Promise<Outcome<T>> {
  let done = false;
  const outcome = capture(promise).then((result) => { done = true; return result; });
  for (let step = 0; step < maxSteps && !done; step += 1) await timer.advance(stepMs);
  timer.stop();
  return outcome;
}

const settings = (over: Partial<TranscriptionSettings> = {}): TranscriptionSettings => ({ speechModel: 'universal-3-pro', keytermsPrompt: [], customSpelling: [], summaryContext: '', ...over });
const transcribe = (over: Partial<TranscriptionSettings> = {}) => transcribeWithAssembly({ downloadUrl: AUDIO_URL, noteId: 'n1', userId: 'u1', settings: settings(over) });
const completedNow = (body: Record<string, unknown>): Reply[] => [() => Response.json({ status: 'completed', ...body })];

test('detected-language normalization and opposite-language mapping', () => {
  for (const [input, expected] of [['en', 'en'], ['EN', 'en'], [' en-US ', 'en'], ['en_us', 'en'], ['ko', 'ko'], ['ko_KR', 'ko'], ['english', null], ['fr', null], ['', null], [5, null], [null, null], [undefined, null]] as const) {
    assert.equal(normalizeDetectedTranscriptLanguage(input), expected, String(input));
  }
  assert.equal(getOppositeTranscriptLanguage('en'), 'ko');
  assert.equal(getOppositeTranscriptLanguage('ko'), 'en');
  assert.equal(getOppositeTranscriptLanguage(null), null);
});

test('keyterm and custom-spelling normalization trims, dedupes and caps', () => {
  assert.deepEqual(normalizeKeytermsPrompt('x'), []);
  assert.deepEqual(normalizeKeytermsPrompt([' Alpha ', 'alpha', 3, '', '  ', null, 'Beta', 'ALPHA']), ['Alpha', 'Beta']);
  assert.equal(normalizeKeytermsPrompt(Array.from({ length: 300 }, (_, i) => `term-${i}`)).length, 250);
  assert.deepEqual(normalizeCustomSpelling({}), []);
  assert.deepEqual(normalizeCustomSpelling([
    { from: [' a ', 'a', 'b', 1, ''], to: ' A ' }, { from: [], to: 'x' }, { from: ['q'], to: '  ' }, { from: 'q', to: 'y' },
    null, [], 'x', { from: ['k'], to: 7 },
  ]), [{ from: ['a', 'b'], to: 'A' }]);
  const many = normalizeCustomSpelling(Array.from({ length: 120 }, (_, i) => ({ from: Array.from({ length: 30 }, (_, j) => `f${i}-${j}`), to: `t${i}` })));
  assert.equal(many.length, 100);
  assert.equal(many[0].from.length, 25);
});

test('loadTranscriptionSettings reads the global row and falls back softly', async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const fallback = { speechModel: env.assemblyAiSpeechModel, keytermsPrompt: [], customSpelling: [], summaryContext: '' };
  assert.equal(env.assemblyAiSpeechModel, 'universal-3-pro');
  const calls = fakeDb(t, { workflow_transcription_settings: { data: null, error: null } });
  assert.deepEqual(await loadTranscriptionSettings(), fallback);
  assert.deepEqual([calls[0].table, calls[0].op, calls[0].payload, calls[0].filters],
    ['workflow_transcription_settings', 'select', 'speech_model, keyterms_prompt, custom_spelling, summary_context', [['id', 'global']]]);
  assert.equal(warn.mock.callCount(), 0);

  const restore = () => (supabase.from as unknown as { mock: { restore(): void } }).mock.restore();
  restore(); fakeDb(t, { workflow_transcription_settings: { data: null, error: { message: 'relation missing' } } });
  assert.deepEqual(await loadTranscriptionSettings(), fallback);
  assert.equal(warn.mock.calls[0].arguments[0], 'Could not load transcription settings: relation missing');

  restore(); fakeDb(t, { workflow_transcription_settings: { data: { speech_model: ' u3 ', keyterms_prompt: [' Ann ', 'ann'], custom_spelling: [{ from: ['tek ace'], to: 'TecAce' }], summary_context: ' ctx ' } } });
  assert.deepEqual(await loadTranscriptionSettings(), { speechModel: 'u3', keytermsPrompt: ['Ann'], customSpelling: [{ from: ['tek ace'], to: 'TecAce' }], summaryContext: 'ctx' });
  restore(); fakeDb(t, { workflow_transcription_settings: { data: { speech_model: '  ', keyterms_prompt: 'x', custom_spelling: null, summary_context: 9 } } });
  assert.deepEqual(await loadTranscriptionSettings(), fallback);
});

test('submit payload is fixed, then polls 1s first and every 3s after; result, usage and logs are pinned', async (t) => {
  const log = t.mock.method(console, 'log', () => undefined);
  const db = fakeDb(t);
  const timer = fakeClock(t);
  const http = fakeAssembly(t, { polls: [
    () => Response.json({ status: 'queued' }),
    () => Response.json({ status: 'processing' }),
    () => Response.json({
      status: 'completed', speech_model_used: 'universal-2', language_code: 'ko_KR', language_detection_results: null, audio_duration: 42,
      utterances: [
        { speaker: 'A', text: ' Hello ', start: 1500, end: 3000 },
        { speaker: 2, text: 'Second', start: 3000, end: 4500, translated_texts: { en: ' Hi ', ko: '  ', xx: 5 } },
        { text: 'No speaker' },
        { speaker: 'B', text: '   ', start: 0, end: 99_999 },
        null,
      ],
    }),
  ] });
  const pending = transcribe({ speechModel: 'ignored-model', summaryContext: 'ignored' });
  pending.catch(() => undefined); // asserted below via settle()
  await flush();
  // Poll count observed after each step of the fake clock; asserted once real timers are back.
  const observed = [http.calls.length];
  for (const ms of [999, 1, 2999, 1, 2999, 1]) {
    await timer.advance(ms);
    observed.push(http.polls().length);
  }
  const outcome = await settle(timer, pending);
  assert.deepEqual(observed, [1, 0, 1, 1, 2, 2, 3], 'submit first, then polls at 1s, 4s and 7s');
  assert.deepEqual(http.calls[0], {
    url: SUBMIT_URL, method: 'POST', headers: { authorization: 'synthetic-assembly', 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: AUDIO_URL, speaker_labels: true, speech_models: ['universal-2'] }),
  });
  assert.deepEqual(http.polls()[0], { url: `${SUBMIT_URL}/tx-1`, method: undefined, headers: { authorization: 'synthetic-assembly' }, body: null });
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.error.message);
  const result = outcome.value;

  assert.deepEqual(result, {
    segments: [
      { speaker: 'Speaker A', speakerKey: 'Speaker A', text: 'Hello', start: 1.5, end: 3 },
      { speaker: 'Speaker 2', speakerKey: 'Speaker 2', text: 'Second', start: 3, end: 4.5, translations: { en: 'Hi' } },
      { speaker: 'Speaker ?', speakerKey: 'Speaker ?', text: 'No speaker', start: undefined, end: undefined },
    ],
    latencyMs: 7000, audioDurationSeconds: 42, detectedLanguage: 'ko',
  });
  assert.equal(db.length, 1);
  assert.deepEqual([db[0].table, db[0].op], ['workflow_usage', 'insert']);
  const usage = db[0].payload as Record<string, unknown>;
  assert.deepEqual([usage.note_id, usage.user_id, usage.stage, usage.provider, usage.model, usage.input_type, usage.latency_ms],
    ['n1', 'u1', 'transcription', 'assemblyai', 'universal-2', 'audio', 7000]);
  assert.deepEqual(usage.usage_metadata, { transcriptId: 'tx-1', audioDurationSeconds: 42, pricePerHourUsd: env.assemblyAiPricePerHourUsd });
  assert.deepEqual(log.mock.calls.map((c) => c.arguments), [
    ['AssemblyAI transcript submit config:', JSON.stringify({ speech_models: ['universal-2'], languageSettings: 'none', selectedLanguageAffectsTranscription: false, translationTargets: [], translationMatchOriginalUtterance: false, hasKeytermsPrompt: false, customSpellingCount: 0 })],
    ['AssemblyAI transcript completed:', JSON.stringify({ transcriptId: 'tx-1', speechModelUsed: 'universal-2', languageCode: 'ko_KR', languageDetectionResults: null })],
  ]);
});

test('keyterms and custom spelling are appended to the submit payload when present', async (t) => {
  const log = t.mock.method(console, 'log', () => undefined);
  const db = fakeDb(t);
  const timer = fakeClock(t);
  const customSpelling = [{ from: ['tek ace'], to: 'TecAce' }, { from: ['ax kh'], to: 'AXKH' }];
  const http = fakeAssembly(t, { submit: () => Response.json({ id: ' tx 2 ' }), polls: completedNow({ text: 'Plain', utterances: [] }) });
  const outcome = await settle(timer, transcribe({ keytermsPrompt: ['Andrew'], customSpelling }));
  assert.ok(outcome.ok, 'transcription should succeed');
  assert.equal(http.calls[0].body, JSON.stringify({ audio_url: AUDIO_URL, speaker_labels: true, speech_models: ['universal-2'], keyterms_prompt: ['Andrew'], custom_spelling: customSpelling }));
  const submitLog = JSON.parse(String(log.mock.calls[0].arguments[1]));
  assert.deepEqual([submitLog.hasKeytermsPrompt, submitLog.customSpellingCount], [true, 2]);
  assert.equal(http.polls()[0].url, `${SUBMIT_URL}/%20tx%202%20`, 'poll uses the raw id, URL-encoded');
  assert.equal(JSON.parse(String(log.mock.calls[1].arguments[1])).transcriptId, ' tx 2 ', 'completed log keeps the raw id');
  assert.equal((db[0].payload as { usage_metadata: { transcriptId: string } }).usage_metadata.transcriptId, 'tx 2', 'usage stores the trimmed id');
});

test('result parsing: duration fallbacks, no-utterance text fallback and empty transcripts', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const cases: Array<[Record<string, unknown>, { segments: unknown[]; audioDurationSeconds: number | null; detectedLanguage: 'en' | 'ko' | null; usageSeconds: number }]> = [
    [{ text: ' Whole text ', audio_duration_seconds: 12, language_code: 'en' }, { segments: [{ speaker: 'Unknown Speaker', speakerKey: 'Unknown Speaker', text: 'Whole text' }], audioDurationSeconds: 12, detectedLanguage: 'en', usageSeconds: 12 }],
    [{ utterances: [{ speaker: 'A', text: 'x', start: 0, end: 2500 }, { speaker: 'A', text: 'y', start: 2500, end: 9000 }] }, { segments: [{ speaker: 'Speaker A', speakerKey: 'Speaker A', text: 'x', start: 0, end: 2.5 }, { speaker: 'Speaker A', speakerKey: 'Speaker A', text: 'y', start: 2.5, end: 9 }], audioDurationSeconds: 9, detectedLanguage: null, usageSeconds: 9 }],
    [{ text: '', utterances: [], audio_duration: 0 }, { segments: [], audioDurationSeconds: null, detectedLanguage: null, usageSeconds: 0 }],
    [{ text: 'hi', audio_duration: 'x', audio_duration_seconds: -3 }, { segments: [{ speaker: 'Unknown Speaker', speakerKey: 'Unknown Speaker', text: 'hi' }], audioDurationSeconds: null, detectedLanguage: null, usageSeconds: 0 }],
  ];
  for (const [body, expected] of cases) {
    await t.test(JSON.stringify(body).slice(0, 60), async (st) => {
      const db = fakeDb(st);
      const timer = fakeClock(st);
      fakeAssembly(st, { polls: completedNow(body) });
      const outcome = await settle(timer, transcribe());
      assert.ok(outcome.ok, outcome.ok ? '' : outcome.error.message);
      const { segments, audioDurationSeconds, detectedLanguage } = outcome.value;
      assert.deepEqual({ segments, audioDurationSeconds, detectedLanguage }, { segments: expected.segments, audioDurationSeconds: expected.audioDurationSeconds, detectedLanguage: expected.detectedLanguage });
      assert.equal((db[0].payload as { usage_metadata: { audioDurationSeconds: number } }).usage_metadata.audioDurationSeconds, expected.usageSeconds);
    });
  }
});

test('submit and fatal poll errors keep their messages and HTTP status mapping', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const run = async (st: test.TestContext, script: { submit?: Reply; polls: Reply[] }) => {
    const db = fakeDb(st);
    const timer = fakeClock(st);
    const http = fakeAssembly(st, script);
    const outcome = await settle(timer, transcribe());
    assert.ok(!outcome.ok, 'expected a rejection');
    return { error: outcome.error, http, db };
  };
  await t.test('missing API key fails before any request', async (st) => {
    const http = fakeAssembly(st, { polls: [] });
    const original = env.assemblyAiApiKey;
    env.assemblyAiApiKey = '';
    try {
      await assert.rejects(transcribe(), { message: 'ASSEMBLYAI_API_KEY is missing.' });
    } finally {
      env.assemblyAiApiKey = original;
    }
    assert.equal(http.calls.length, 0);
  });
  await t.test('submit HTTP failure includes status and the first 800 body chars', async (st) => {
    const { error, http, db } = await run(st, { submit: () => new Response('x'.repeat(900), { status: 401 }), polls: [] });
    assert.equal(error.message, `AssemblyAI transcript submit failed (401): ${'x'.repeat(800)}`);
    assert.equal(getHttpStatus(error), 500);
    assert.equal(http.polls().length, 0); assert.equal(db.length, 0, 'no usage on a failed submit');
  });
  await t.test('a submit body mentioning a token maps to 400 through the shared substring rule', async (st) => {
    const { error } = await run(st, { submit: () => new Response('Invalid API token', { status: 401 }), polls: [] });
    assert.equal(error.message, 'AssemblyAI transcript submit failed (401): Invalid API token');
    assert.equal(getHttpStatus(error), 400);
  });
  for (const body of [{}, { id: '  ' }, { id: 7 }]) {
    await t.test(`submit without an id: ${JSON.stringify(body)}`, async (st) => {
      const { error, http } = await run(st, { submit: () => Response.json(body), polls: [] });
      assert.equal(error.message, 'AssemblyAI did not return a transcript id.');
      assert.equal(http.polls().length, 0);
    });
  }
  await t.test('submit with a non-JSON 200 body rejects with the JSON SyntaxError', async (st) => {
    const { error } = await run(st, { submit: () => new Response('not json'), polls: [] });
    assert.equal(error.name, 'SyntaxError');
  });
  await t.test('a non-transient poll status aborts immediately', async (st) => {
    const { error, http, db } = await run(st, { polls: [() => new Response('g'.repeat(900), { status: 404 })] });
    assert.equal(error.message, `AssemblyAI transcript poll failed (404): ${'g'.repeat(800)}`);
    assert.equal(getHttpStatus(error), 500);
    assert.equal(http.polls().length, 1); assert.equal(db.length, 0);
  });
  await t.test('an AssemblyAI error status aborts with its message', async (st) => {
    const { error, http } = await run(st, { polls: [() => Response.json({ status: 'error', error: 'Audio unreadable' })] });
    assert.equal(error.message, 'Audio unreadable');
    assert.equal(http.polls().length, 1);
  });
  await t.test('an AssemblyAI error status without a message uses the default', async (st) => {
    const { error } = await run(st, { polls: [() => Response.json({ status: 'error', error: 5 })] });
    assert.equal(error.message, 'AssemblyAI transcription failed.');
    assert.equal(getHttpStatus(error), 500);
  });
});

test('transient poll failures are tolerated up to five in a row, across kinds, and reset on success', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const warn = t.mock.method(console, 'warn', () => undefined);
  const s503 = () => new Response('busy', { status: 503 });
  const s429 = () => new Response('slow down', { status: 429 });
  const network = () => { throw new Error('socket hang up'); };
  const badJson = () => new Response('not json');
  const processing = () => Response.json({ status: 'processing' });
  const done = () => Response.json({ status: 'completed', text: 'ok' });
  const run = async (st: test.TestContext, polls: Reply[]) => {
    fakeDb(st);
    const timer = fakeClock(st);
    const http = fakeAssembly(st, { polls });
    const outcome = await settle(timer, transcribe());
    return { outcome, polls: http.polls().length };
  };
  await t.test('five mixed failures then completion succeeds', async (st) => {
    const r = await run(st, [s503, s429, network, badJson, s503, done]);
    assert.ok(r.outcome.ok, 'five tolerated failures then success'); assert.equal(r.polls, 6);
    assert.deepEqual(warn.mock.calls.slice(0, 5).map((c) => c.arguments[0]), [
      'AssemblyAI transcript poll transient 503 (1/5), retrying.',
      'AssemblyAI transcript poll transient 429 (2/5), retrying.',
      'AssemblyAI transcript poll network error (3/5), retrying. socket hang up',
      'AssemblyAI transcript poll returned invalid JSON (4/5), retrying.',
      'AssemblyAI transcript poll transient 503 (5/5), retrying.',
    ]);
  });
  await t.test('a non-failing poll resets the counter', async (st) => {
    const r = await run(st, [s503, s503, s503, s503, s503, processing, s503, s503, s503, s503, s503, done]);
    assert.ok(r.outcome.ok, 'the counter resets on a good poll'); assert.equal(r.polls, 12);
  });
  await t.test('the sixth consecutive transient status fails', async (st) => {
    const r = await run(st, [s503, s503, s503, s503, s503, () => new Response('b'.repeat(900), { status: 502 })]);
    assert.ok(!r.outcome.ok, 'sixth transient status fails'); assert.equal(r.polls, 6);
    assert.equal(r.outcome.error.message, `AssemblyAI transcript poll failed after 6 consecutive transient errors (last 502): ${'b'.repeat(800)}`);
  });
  await t.test('the sixth consecutive network error fails', async (st) => {
    const r = await run(st, [network]);
    assert.ok(!r.outcome.ok, 'sixth network error fails'); assert.equal(r.polls, 6);
    assert.equal(r.outcome.error.message, 'AssemblyAI transcript poll failed after 6 consecutive network errors: socket hang up');
  });
  await t.test('the sixth consecutive invalid JSON body fails', async (st) => {
    const r = await run(st, [() => new Response('j'.repeat(600))]);
    assert.ok(!r.outcome.ok, 'sixth invalid JSON body fails'); assert.equal(r.polls, 6);
    assert.equal(r.outcome.error.message, `AssemblyAI transcript poll returned invalid JSON 6 times in a row (200): ${'j'.repeat(500)}`);
  });
});

test('polling gives up after 30 minutes measured from before submit (601 polls at 1s + 3s cadence)', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const db = fakeDb(t);
  const timer = fakeClock(t);
  const http = fakeAssembly(t, { polls: [() => Response.json({ status: 'processing' })] });
  const result = await settle(timer, transcribe(), 1000, 2000);
  assert.ok(!result.ok, 'polling must time out');
  assert.equal(result.error.message, 'AssemblyAI transcription timed out.');
  assert.equal(getHttpStatus(result.error), 500);
  assert.equal(http.polls().length, 601);
  assert.equal(db.length, 0, 'no usage row for a timed-out transcription');
});

test('translateTranscriptSegments calls Gemini with the translation prompt and records usage', async (t) => {
  const log = t.mock.method(console, 'log', () => undefined);
  const db = fakeDb(t);
  const translated = JSON.stringify({ segments: [{ speaker: 'Speaker A', text: '안녕', start: 1.5, end: 3 }, { speaker: 'Speaker B', text: '둘' }] });
  const gemini: Array<{ url: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    gemini.push({ url, body: JSON.parse(String(init?.body)) });
    return Response.json({ candidates: [{ content: { parts: [{ text: translated }] } }], usageMetadata: { promptTokenCount: 10 } });
  });
  const source = [
    { speaker: 'Speaker A', speakerKey: 'Speaker A', text: 'Hello', start: 1.5, end: 3, translations: { ko: 'x' } },
    { speaker: 'Speaker B', speakerKey: 'Speaker B', text: 'Two' },
  ];
  const result = await translateTranscriptSegments({ segments: source, targetLanguage: 'ko', noteId: 'n1', userId: 'u1' });
  assert.deepEqual(result, parseDiarizedSegmentsWithRecovery(translated).segments);
  assert.equal(gemini.length, 1);
  assert.equal(gemini[0].url, `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.summaryModel)}:generateContent`);
  assert.deepEqual(gemini[0].body.generationConfig, { temperature: 0.2, maxOutputTokens: 32768, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } });
  assert.deepEqual(gemini[0].body.contents, [{ role: 'user', parts: [{ text: buildTranscriptTranslationPrompt({ targetLanguage: 'ko', segments: [{ speaker: 'Speaker A', text: 'Hello', start: 1.5, end: 3 }, { speaker: 'Speaker B', text: 'Two' }] }) }] }]);
  assert.equal(log.mock.calls[0].arguments[0], `Transcript translation (ko): calling Gemini model ${env.summaryModel}`);
  assert.deepEqual([db[0].table, db[0].op], ['workflow_usage', 'insert']);
  const usage = db[0].payload as Record<string, unknown>;
  assert.deepEqual([usage.stage, usage.provider, usage.model, usage.input_type], ['transcript-translation-ko', 'google-gemini', env.summaryModel, 'text']);
});

// Runner wiring through the real HTTP routes with the offline workflow fixture.
async function runnerFixture(t: test.TestContext, options: { checkpoint: boolean; assembly?: Record<string, unknown>; settingsRow?: Record<string, unknown> }) {
  const f = await workflowFixture();
  t.after(() => f.close());
  const originalFetch = globalThis.fetch;
  const intercept = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    if (!options.checkpoint && url.pathname.endsWith('/workflow_transcript_checkpoint') && method === 'GET') {
      f.state.calls.push({ url, method, body: null });
      return Response.json(null);
    }
    if (options.settingsRow && url.pathname.endsWith('/workflow_transcription_settings') && method === 'GET') {
      f.state.calls.push({ url, method, body: null });
      return Response.json(options.settingsRow);
    }
    if (options.assembly && url.hostname === 'api.assemblyai.com' && url.pathname.startsWith('/v2/transcript/')) {
      f.state.calls.push({ url, method, body: null });
      return Response.json({ id: 'fixture-transcript', status: 'completed', ...options.assembly });
    }
    return originalFetch(input, init);
  });
  t.after(() => intercept.mock.restore());
  return f;
}

const indexOf = (calls: { url: URL; method: string; body: any }[], predicate: (c: { url: URL; method: string; body: any }) => boolean) => calls.findIndex(predicate);

test('runner reuses an existing transcript checkpoint without contacting AssemblyAI or re-saving', async (t) => {
  const log = t.mock.method(console, 'log', () => undefined);
  const f = await runnerFixture(t, { checkpoint: true });
  const r = await f.request('/summarize-audio', { body: summarizeBody });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.transcript, [{ speaker: 'Speaker 1', text: 'Fixture meeting.', start: 0, end: 1 }]);
  assert.ok(!f.state.calls.some((c) => c.url.hostname === 'api.assemblyai.com'), 'no AssemblyAI call when a checkpoint exists');
  assert.ok(!f.state.calls.some((c) => c.url.pathname.endsWith('/workflow_transcript_checkpoint') && c.method === 'POST'), 'no checkpoint save');
  const settingsAt = indexOf(f.state.calls, (c) => c.url.pathname.endsWith('/workflow_transcription_settings'));
  const checkpointAt = indexOf(f.state.calls, (c) => c.url.pathname.endsWith('/workflow_transcript_checkpoint') && c.method === 'GET');
  assert.ok(settingsAt >= 0 && settingsAt < checkpointAt, 'settings load before the checkpoint lookup');
  assert.ok(log.mock.calls.some((c) => c.arguments[0] === 'Reusing persisted transcript checkpoint for note fixture-note (1 segments); skipping re-transcription.'), 'checkpoint reuse log');
});

test('runner without a checkpoint: stage write, lookup, submit, poll, usage, checkpoint save, then summary', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const f = await runnerFixture(t, { checkpoint: false, settingsRow: { speech_model: 'u3', keyterms_prompt: ['Fixture'], custom_spelling: [], summary_context: '' } });
  f.state.existingJob = false;
  const submitted = await f.request('/summarize-audio/jobs', { body: summarizeBody });
  assert.equal(submitted.status, 202, submitted.text);
  const deadline = Date.now() + 5_000;
  while (f.state.jobStatus !== 'completed' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.state.jobStatus, 'completed');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const calls = f.state.calls;
  const order = [
    indexOf(calls, (c) => c.url.pathname.endsWith('/workflow_transcription_settings')),
    indexOf(calls, (c) => c.url.pathname.endsWith('/workflow_job') && c.method === 'PATCH' && c.body?.stage === 'transcribing audio'),
    indexOf(calls, (c) => c.url.pathname.endsWith('/workflow_transcript_checkpoint') && c.method === 'GET'),
    indexOf(calls, (c) => c.url.href === SUBMIT_URL && c.method === 'POST'),
    indexOf(calls, (c) => c.url.href === `${SUBMIT_URL}/fixture-transcript`),
    indexOf(calls, (c) => c.url.pathname.endsWith('/workflow_usage') && c.body?.provider === 'assemblyai'),
    indexOf(calls, (c) => c.url.pathname.endsWith('/workflow_transcript_checkpoint') && c.method === 'POST'),
    indexOf(calls, (c) => c.url.hostname === 'generativelanguage.googleapis.com'),
  ];
  assert.ok(order.every((at) => at >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, `call order ${JSON.stringify(order)}`);
  assert.equal(calls.filter((c) => c.url.href === SUBMIT_URL).length, 1, 'exactly one submission');
  assert.deepEqual(calls[order[3]].body, { audio_url: summarizeBody.downloadUrl, speaker_labels: true, speech_models: ['universal-2'], keyterms_prompt: ['Fixture'] });
  const saved = calls[order[6]].body as Record<string, unknown>;
  assert.deepEqual([saved.note_id, saved.segments, saved.audio_duration_seconds, saved.detected_language],
    ['fixture-note', [{ speaker: 'Speaker A', speakerKey: 'Speaker A', text: 'Fixture meeting.', start: 0, end: 1 }], 1, null]);
});

test('runner maps a completed transcript with no speech to 422 without saving a checkpoint or summarizing', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  const f = await runnerFixture(t, { checkpoint: false, assembly: { text: '', utterances: [] } });
  const r = await f.request('/summarize-audio', { body: { ...summarizeBody, language: 'ko' } });
  assert.equal(r.status, 422, r.text);
  assert.deepEqual(r.body, { error: noSpeechMessage('ko') });
  assert.ok(f.state.calls.some((c) => c.url.pathname.endsWith('/workflow_usage')), 'the paid transcription is still recorded');
  assert.ok(!f.state.calls.some((c) => c.url.pathname.endsWith('/workflow_transcript_checkpoint') && c.method === 'POST'), 'no checkpoint save');
  assert.ok(!f.state.calls.some((c) => c.url.hostname === 'generativelanguage.googleapis.com'), 'no summary for a silent recording');
});

test('runner surfaces an AssemblyAI submit failure as a 500 with the provider message and no checkpoint', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  const f = await runnerFixture(t, { checkpoint: false });
  f.state.aiFailure = true;
  const r = await f.request('/summarize-audio', { body: summarizeBody });
  assert.equal(r.status, 500, r.text);
  assert.deepEqual(r.body, { error: 'AssemblyAI transcript submit failed (400): {"error":"Fixture transcription failure"}' });
  assert.ok(!f.state.calls.some((c) => c.url.pathname.endsWith('/workflow_transcript_checkpoint') && c.method === 'POST'), 'no checkpoint save');
  assert.ok(!f.state.calls.some((c) => c.url.pathname.endsWith('/workflow_usage')), 'no usage row for a failed submit');
});
