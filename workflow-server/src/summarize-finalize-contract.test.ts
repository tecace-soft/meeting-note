// T1-10c characterization: pins the summarize stage (meeting start inference, Gemini
// attachment parts and the attached-files section, summary call shape, stage/progress
// writes, note persistence with its schema-cache retries, checkpoint cleanup) and the
// post-completion finalize stage (memory fold, ingest speaker naming) before they leave
// index.ts. Offline only: supabase.from and fetch are faked, nothing reads .env.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { SummarizeAudioInput, SummaryAttachmentInput } from './pipeline/types.js';
import type { TranscriptSegment } from './parsers.js';
// Service config must exist before the server modules read env at import time.
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role';
process.env.GEMINI_API_KEY = 'synthetic-gemini';
process.env.ASSEMBLYAI_API_KEY = 'synthetic-assembly';
const { supabase } = await import('./db/supabaseClient.js');
const { env, TRANSLATION_ENABLED } = await import('./config/env.js');
const { STANDARD_FALLBACK_CHAIN } = await import('./gemini-models.js');
const { buildSummaryPrompt } = await import('./prompts.js');
const { buildNoteName, formatMeetingDateForPrompt } = await import('./parsers.js');
const { renderMemoryForContext } = await import('./memory.js');
const {
  buildGeminiAttachmentParts, attachmentSectionHeading, summaryHasAttachmentSection,
  parseAttachmentSection, fallbackAttachmentSection, generateAttachmentSummarySection,
} = await import('./pipeline/attachments.js');
const { inferMeetingStartAt, insertNote, runSummarizeAudio } = await import('./pipeline/summarize.js');
const { finalizeNoteMemory, autoIdentifySpeakersAtIngest } = await import('./pipeline/finalize.js');

type DbError = { message: string; code?: string };
type DbResult = { data?: unknown; error?: DbError | null };
type DbCall = { table: string; op: string; payload?: unknown; options?: unknown; columns?: string; filters: [string, string, unknown][] };
type DbHandler = (call: DbCall) => DbResult | undefined;

// Records the supabase query-builder chain per table without any network. The handler
// sees the finished chain (at await time) and returns its result; a throw from `throwOn`
// simulates a client that rejects synchronously.
function fakeDb(t: test.TestContext, handler: DbHandler = () => undefined, trace?: string[], throwOn?: (table: string) => boolean) {
  const calls: DbCall[] = [];
  t.mock.method(supabase, 'from', (table: string) => {
    if (throwOn?.(table)) throw new Error(`Fixture ${table} client failure`);
    const call: DbCall = { table, op: '', filters: [] };
    calls.push(call);
    const finish = () => {
      trace?.push(`${table}.${call.op}`);
      return Promise.resolve(handler(call) ?? { data: null, error: null });
    };
    const chain: any = {
      select: (columns: string) => { call.op ||= 'select'; call.columns = columns; return chain; },
      insert: (row: unknown) => { call.op = 'insert'; call.payload = row; return chain; },
      upsert: (row: unknown, options: unknown) => { call.op = 'upsert'; call.payload = row; call.options = options; return chain; },
      update: (row: unknown) => { call.op = 'update'; call.payload = row; return chain; },
      delete: () => { call.op = 'delete'; return chain; },
      eq: (column: string, value: unknown) => { call.filters.push(['eq', column, value]); return chain; },
      in: (column: string, value: unknown) => { call.filters.push(['in', column, value]); return chain; },
      order: () => chain,
      limit: () => chain,
      maybeSingle: finish,
      single: finish,
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => finish().then(resolve, reject),
    };
    return chain;
  });
  return calls;
}

type GeminiCall = { model: string; body: any; text: string };
type GeminiReply = { text?: string; status?: number; error?: string } | Promise<{ text?: string; status?: number; error?: string }>;

// Scripted Gemini boundary: file upload start/finalize and generateContent.
function fakeGemini(t: test.TestContext, reply: (call: GeminiCall) => GeminiReply, trace?: string[]) {
  const generate: GeminiCall[] = [];
  const uploads: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  let session = 0;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    if (url === 'https://generativelanguage.googleapis.com/upload/v1beta/files') {
      trace?.push('gemini.upload-start');
      uploads.push({ url, headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
      session += 1;
      return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': `https://upload.invalid/session-${session}` } });
    }
    if (url.startsWith('https://upload.invalid/')) {
      trace?.push('gemini.upload-finalize');
      const bytes = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : null;
      uploads.push({ url, headers, body: bytes });
      const n = url.split('-').pop();
      return Response.json({ file: { uri: `https://files.invalid/${n}`, mimeType: `fixture/type-${n}` } });
    }
    const match = url.match(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/([^:]+):generateContent$/);
    if (!match) throw new Error(`Unexpected fetch in summarize contract: ${url}`);
    const body = JSON.parse(String(init?.body));
    const call: GeminiCall = { model: decodeURIComponent(match[1]), body, text: String(body.contents?.[0]?.parts?.[0]?.text ?? '') };
    generate.push(call);
    trace?.push('gemini.generate');
    const outcome = await reply(call);
    if (outcome.status && outcome.status >= 400) {
      return Response.json({ error: { message: outcome.error ?? 'Fixture Gemini failure' } }, { status: outcome.status });
    }
    return Response.json({ candidates: [{ content: { parts: [{ text: outcome.text ?? '{}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } });
  });
  return { generate, uploads };
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const stripUpdatedAt = (row: unknown) => {
  const { updated_at: _updatedAt, ...rest } = row as Record<string, unknown>;
  return rest;
};
const jobUpdates = (calls: DbCall[]) => calls.filter((c) => c.table === 'workflow_job' && c.op === 'update').map((c) => stripUpdatedAt(c.payload));
const quiet = (t: test.TestContext) => ({
  log: t.mock.method(console, 'log', () => undefined),
  warn: t.mock.method(console, 'warn', () => undefined),
});

const SUMMARY_JSON = JSON.stringify({ title: 'Quarterly roadmap review', summary: '## Summary\nRoadmap agreed.', tags: ['roadmap', 'q4'] });
const segments: TranscriptSegment[] = [
  { speaker: 'Speaker A', text: 'Let us review the roadmap.', start: 0, end: 2 },
  { speaker: 'Speaker B', text: 'Agreed.', start: 2, end: 3 },
];
const baseInput = (over: Partial<SummarizeAudioInput> = {}): SummarizeAudioInput => ({
  downloadUrl: 'https://audio.invalid/a.ogg',
  fileName: 'standup.ogg',
  instructions: 'Focus on decisions.',
  promptId: 'prompt-1',
  summaryRulesOverride: '  Use bullet points.  ',
  userId: 'u1',
  userName: 'Andrew',
  noteId: 'n1',
  meetingAt: '2026-10-26T18:00:00.000Z',
  userTimeZone: 'America/Los_Angeles',
  fileId: 'file-1',
  speakerContext: 'Speaker A is Ann.',
  attachments: [],
  language: 'en',
  ...over,
});

test('inferMeetingStartAt subtracts a positive finite duration from a parseable end time', () => {
  assert.equal(inferMeetingStartAt(null, 60), null);
  assert.equal(inferMeetingStartAt('', 60), null);
  assert.equal(inferMeetingStartAt('not a date', 60), null);
  const end = '2026-10-26T10:00:00+09:00';
  assert.equal(inferMeetingStartAt(end, null), '2026-10-26T01:00:00.000Z', 'no duration keeps the end time, normalized to ISO');
  for (const duration of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '60' as unknown as number]) {
    assert.equal(inferMeetingStartAt(end, duration), '2026-10-26T01:00:00.000Z', `non-positive or non-finite duration ${String(duration)}`);
  }
  assert.equal(inferMeetingStartAt(end, 90), '2026-10-26T00:58:30.000Z');
  assert.equal(inferMeetingStartAt(end, 1.0004), '2026-10-26T00:59:59.000Z', 'duration rounds to whole milliseconds');
  assert.equal(inferMeetingStartAt(end, 1.0006), '2026-10-26T00:59:58.999Z');
  assert.equal(inferMeetingStartAt(end, 0.0004), '2026-10-26T01:00:00.000Z', 'sub-millisecond duration rounds to zero');
  assert.equal(inferMeetingStartAt('2026-10-26', 3600), '2026-10-25T23:00:00.000Z', 'date-only strings parse as UTC midnight');
});

test('attached-files section heading, detection, parsing and fallback', () => {
  assert.equal(attachmentSectionHeading('en'), '## Attached Files');
  assert.equal(attachmentSectionHeading('ko'), '## 첨부 파일');

  assert.equal(summaryHasAttachmentSection('Intro\n## Attached Files\n- a', 'en'), true);
  assert.equal(summaryHasAttachmentSection('Intro\n## attached files   \n- a', 'en'), true, 'case-insensitive, trailing spaces allowed');
  assert.equal(summaryHasAttachmentSection('## Attached Files (2)\n- a', 'en'), false, 'heading must be the whole line');
  assert.equal(summaryHasAttachmentSection('### Attached Files\n- a', 'en'), false);
  assert.equal(summaryHasAttachmentSection('## Attached Files', 'ko'), false, 'language-specific heading');
  assert.equal(summaryHasAttachmentSection('x\n## 첨부 파일\n- a', 'ko'), true);

  assert.equal(parseAttachmentSection('{"sectionMarkdown":"## Attached Files\\n- deck.pdf: roadmap"}', 'en'), '## Attached Files\n- deck.pdf: roadmap');
  assert.equal(parseAttachmentSection('```json\n{"sectionMarkdown":"  - deck.pdf: roadmap  "}\n```', 'en'), '## Attached Files\n- deck.pdf: roadmap', 'fences stripped, heading prepended');
  assert.equal(parseAttachmentSection('{"sectionMarkdown":"- 자료"}', 'ko'), '## 첨부 파일\n- 자료');
  for (const raw of ['{}', '{"sectionMarkdown":"   "}', '{"sectionMarkdown":5}', '[{"sectionMarkdown":"x"}]', 'null']) {
    assert.throws(() => parseAttachmentSection(raw, 'en'), { message: 'Attachment section JSON must include sectionMarkdown.' }, raw);
  }
  assert.throws(() => parseAttachmentSection('not json', 'en'), SyntaxError);

  const files: SummaryAttachmentInput[] = [{ name: 'deck.pdf', mimeType: 'application/pdf', dataBase64: 'eA==' }, { name: 'shot.png', mimeType: 'image/png', dataBase64: 'eA==' }];
  assert.equal(fallbackAttachmentSection(files, 'en'), '## Attached Files\n'
    + '- deck.pdf (application/pdf): This file was attached, but its relationship to the transcript could not be analyzed in this run.\n'
    + '- shot.png (image/png): This file was attached, but its relationship to the transcript could not be analyzed in this run.');
  assert.equal(fallbackAttachmentSection(files.slice(0, 1), 'ko'), '## 첨부 파일\n- deck.pdf (application/pdf): 첨부 파일이 제공되었지만 이 실행에서 회의 기록과의 관계 분석을 완료하지 못했습니다.');
  assert.equal(fallbackAttachmentSection([], 'en'), '## Attached Files\n- Attachments were provided, but file details could not be confirmed in this run.');
  assert.equal(fallbackAttachmentSection([], 'ko'), '## 첨부 파일\n- 첨부 파일이 제공되었지만 이 실행에서 파일 정보를 확인하지 못했습니다.');
});

test('buildGeminiAttachmentParts uploads each non-empty file in order and builds the context part', async (t) => {
  const http = fakeGemini(t, () => ({ text: '{}' }));
  assert.deepEqual(await buildGeminiAttachmentParts([]), []);
  assert.deepEqual(await buildGeminiAttachmentParts([{ name: 'empty.txt', mimeType: 'text/plain', dataBase64: '' }]), [], 'zero-byte files are skipped');
  assert.equal(http.uploads.length, 0, 'no upload for empty input');

  const parts = await buildGeminiAttachmentParts([
    { name: 'deck.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('PDF').toString('base64') },
    { name: 'empty.txt', mimeType: 'text/plain', dataBase64: '' },
    { name: 'notes.txt', mimeType: 'text/plain', dataBase64: Buffer.from('hello').toString('base64') },
  ]);
  assert.deepEqual(http.uploads.map((u) => u.url), [
    'https://generativelanguage.googleapis.com/upload/v1beta/files', 'https://upload.invalid/session-1',
    'https://generativelanguage.googleapis.com/upload/v1beta/files', 'https://upload.invalid/session-2',
  ]);
  assert.deepEqual(http.uploads[0].body, { file: { display_name: 'deck.pdf' } });
  assert.deepEqual([http.uploads[0].headers['x-goog-api-key'], http.uploads[0].headers['x-goog-upload-header-content-length'], http.uploads[0].headers['x-goog-upload-header-content-type']], ['synthetic-gemini', '3', 'application/pdf']);
  assert.equal(http.uploads[1].body, 'PDF');
  assert.deepEqual(http.uploads[2].body, { file: { display_name: 'notes.txt' } });

  assert.equal(parts.length, 3);
  assert.deepEqual(parts.slice(1), [
    { fileData: { mimeType: 'fixture/type-1', fileUri: 'https://files.invalid/1' } },
    { fileData: { mimeType: 'fixture/type-2', fileUri: 'https://files.invalid/2' } },
  ], 'file parts use the uploaded mime type and uri');
  const text = String(parts[0].text);
  assert.ok(text.startsWith('ATTACHED FILE CONTEXT\nThe user attached 2 files from the meeting.'), 'plural count from uploaded files only');
  assert.ok(text.includes('Attached files:\n1. deck.pdf (fixture/type-1)\n2. notes.txt (fixture/type-2)\n'), 'numbered list uses uploaded mime types');
  assert.ok(text.includes('- The summary must contain a dedicated attached-files section. Do not omit this section.'), 'section rule present');
  assert.equal(sha256(text), 'c3f3eedba51dad68294814d2e2d04f5d42892a3b206d2a3bad87ed89f4e9dbc3', 'attachment context text is byte-identical across the move');

  const single = await buildGeminiAttachmentParts([{ name: 'a.png', mimeType: 'image/png', dataBase64: 'eA==' }]);
  assert.ok(String(single[0].text).startsWith('ATTACHED FILE CONTEXT\nThe user attached 1 file from the meeting.'), 'singular count');
});

test('buildGeminiAttachmentParts propagates an upload failure', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('quota', { status: 500 }));
  await assert.rejects(
    buildGeminiAttachmentParts([{ name: 'deck.pdf', mimeType: 'application/pdf', dataBase64: 'eA==' }]),
    { message: 'Gemini file upload start failed (500): quota' },
  );
});

test('generateAttachmentSummarySection call shape', async (t) => {
  const { log } = quiet(t);
  const http = fakeGemini(t, () => ({ text: '{"sectionMarkdown":"## Attached Files\\n- deck"}' }));
  const attachmentParts = [{ fileData: { mimeType: 'application/pdf', fileUri: 'https://files.invalid/1' } }];
  const result = await generateAttachmentSummarySection({
    attachmentParts,
    attachments: [{ name: 'deck.pdf', mimeType: 'application/pdf', dataBase64: 'eA==' }],
    transcriptText: 'Speaker A: hi',
    existingSummary: '## Summary\nhi',
    language: 'en',
  });
  assert.equal(result.text, '{"sectionMarkdown":"## Attached Files\\n- deck"}');
  assert.equal(result.model, env.summaryModel);
  assert.equal(http.generate.length, 1);
  const call = http.generate[0];
  assert.equal(call.model, env.summaryModel);
  assert.deepEqual(call.body.generationConfig, { temperature: 0.2, maxOutputTokens: 4096, responseMimeType: 'application/json' }, 'no thinking budget on this call');
  assert.deepEqual(call.body.contents[0].parts.slice(1), attachmentParts);
  assert.ok(call.text.startsWith('Generate the required attached-files section for a meeting summary.'), 'prompt opener');
  assert.ok(call.text.includes('- Write the section in English.'), 'output language');
  assert.ok(call.text.includes('- The sectionMarkdown value MUST start with this exact heading: ## Attached Files'), 'heading rule');
  assert.ok(call.text.includes('ATTACHED FILES\n1. deck.pdf (application/pdf)\n\nTRANSCRIPT\n\'\'\'\nSpeaker A: hi\n\'\'\'\n\nCURRENT SUMMARY\n\'\'\'\n## Summary\nhi\n\'\'\''), 'files, transcript and summary blocks');
  assert.equal(sha256(call.text), '9ffea8c94f4f370dc4d39922e89726d46660db2da12c420662d3b9bb618f329f', 'attachment section prompt is byte-identical across the move');
  assert.equal(log.mock.calls[0].arguments[0], `Attachment section generation: calling Gemini model ${env.summaryModel}`);

  http.generate.length = 0;
  await generateAttachmentSummarySection({ attachmentParts: [], attachments: [], transcriptText: '', existingSummary: '', language: 'ko' });
  assert.ok(http.generate[0].text.includes('- Write the section in Korean.') && http.generate[0].text.includes('"sectionMarkdown": "## 첨부 파일\\n- ..."'), 'Korean heading and language');
});

test('generateAttachmentSummarySection falls back across the standard chain on a missing model', async (t) => {
  quiet(t);
  const http = fakeGemini(t, (call) => (call.model === env.summaryModel ? { status: 404, error: 'model not found' } : { text: '{}' }));
  const result = await generateAttachmentSummarySection({ attachmentParts: [], attachments: [], transcriptText: 't', existingSummary: 's', language: 'en' });
  const expectedChain = [...new Set([env.summaryModel, ...STANDARD_FALLBACK_CHAIN])];
  assert.deepEqual(http.generate.map((c) => c.model), expectedChain.slice(0, 2));
  assert.equal(result.model, expectedChain[1]);
});

const noteRow = {
  noteId: 'n1', userId: 'u1', userName: 'Andrew', downloadUrl: 'https://audio.invalid/a.ogg', transcriptText: 'Speaker A: hi',
  transcriptionLanguage: 'en' as const, transcriptionTranslations: { ko: 'Speaker A: 안녕' }, summary: 'S', summaryTranslations: { en: 'S', ko: '' },
  title: '2026-10-26_T', tags: ['t'], segments: [{ speaker: 'Speaker A', text: 'hi' }], diarizationTranslations: { ko: [{ speaker: 'Speaker A', text: '안녕' }] },
  meetingAt: '2026-10-26T00:00:00.000Z', fileId: 'f1', audioDurationSeconds: 12,
};
const fullPayload = {
  transcription: 'Speaker A: hi', transcription_language: 'en', transcription_translations: { ko: 'Speaker A: 안녕' }, summary: 'S',
  summary_translations: { en: 'S', ko: '' }, user_id: 'u1', user_name: 'Andrew', id: 'n1', audio_file: 'https://audio.invalid/a.ogg',
  name: '2026-10-26_T', tags: ['t'], diarization: [{ speaker: 'Speaker A', text: 'hi' }], diarization_translations: { ko: [{ speaker: 'Speaker A', text: '안녕' }] },
  meeting_at: '2026-10-26T00:00:00.000Z', audio_file_id: 'f1', duration_seconds: 12,
};
const UPSERT_OPTIONS = { onConflict: 'id', ignoreDuplicates: true };

test('insertNote upserts the full payload idempotently on the note id', async (t) => {
  const { warn } = quiet(t);
  const calls = fakeDb(t);
  await insertNote(noteRow);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].table, calls[0].op, calls[0].options], ['note', 'upsert', UPSERT_OPTIONS]);
  assert.deepEqual(calls[0].payload, fullPayload);
  assert.equal(warn.mock.callCount(), 0);
});

test('insertNote retries once without translation columns on a PGRST204 for any of them', async (t) => {
  for (const column of ['transcription_language', 'transcription_translations', 'diarization_translations']) {
    await t.test(column, async (st) => {
      const { warn } = quiet(st);
      let n = 0;
      // Mentions duration too: the translation branch wins and keeps duration_seconds.
      const calls = fakeDb(st, () => (n++ === 0 ? { error: { code: 'PGRST204', message: `Could not find the '${column}' column ('duration_seconds')` } } : undefined));
      await insertNote(noteRow);
      assert.equal(calls.length, 2);
      const { transcription_language: _a, transcription_translations: _b, diarization_translations: _c, ...rest } = fullPayload;
      assert.deepEqual(calls[1].payload, rest);
      assert.deepEqual(calls[1].options, UPSERT_OPTIONS);
      assert.equal(warn.mock.calls[0].arguments[0], 'Inserted note without transcript translation columns because the PostgREST schema cache is missing them.');
    });
  }
});

test('insertNote retries once without duration_seconds on a PGRST204 for it', async (t) => {
  const { warn } = quiet(t);
  let n = 0;
  const calls = fakeDb(t, () => (n++ === 0 ? { error: { code: 'PGRST204', message: "Could not find the 'duration_seconds' column" } } : undefined));
  await insertNote(noteRow);
  const { duration_seconds: _d, ...rest } = fullPayload;
  assert.deepEqual(calls[1].payload, rest);
  assert.equal(warn.mock.calls[0].arguments[0], 'Inserted note without duration_seconds because the column is missing from the PostgREST schema cache.');
});

test('insertNote throws retry errors and any other error unchanged', async (t) => {
  quiet(t);
  const retryError = { code: 'X', message: 'retry failed' };
  let n = 0;
  fakeDb(t, () => (n++ === 0 ? { error: { code: 'PGRST204', message: "'transcription_language'" } } : { error: retryError }));
  await assert.rejects(insertNote(noteRow), (error) => error === retryError);

  (supabase.from as unknown as { mock: { restore(): void } }).mock.restore();
  n = 0;
  fakeDb(t, () => (n++ === 0 ? { error: { code: 'PGRST204', message: "'duration_seconds'" } } : { error: retryError }));
  await assert.rejects(insertNote(noteRow), (error) => error === retryError);

  for (const failure of [{ code: 'PGRST204', message: "Could not find the 'name' column" }, { code: '23505', message: "'transcription_language' duplicate" }]) {
    (supabase.from as unknown as { mock: { restore(): void } }).mock.restore();
    const calls = fakeDb(t, () => ({ error: failure }));
    await assert.rejects(insertNote(noteRow), (error) => error === failure, failure.message);
    assert.equal(calls.length, 1, 'no retry for other errors');
  }
});

type RunnerOptions = {
  checkpointLanguage?: 'en' | 'ko' | null;
  memory?: unknown;
  summaryPrompt?: unknown;
  noteError?: DbError;
  reply?: (call: GeminiCall) => GeminiReply;
};

// Summarize runner with a transcript checkpoint hit (AssemblyAI is never contacted).
function runnerBoundary(t: test.TestContext, options: RunnerOptions = {}) {
  const trace: string[] = [];
  const calls = fakeDb(t, (call) => {
    if (call.table === 'workflow_transcript_checkpoint' && call.op === 'select') {
      return { data: { segments, audio_duration_seconds: 90, detected_language: options.checkpointLanguage ?? null } };
    }
    if (call.table === 'user_memory') return { data: options.memory === undefined ? null : { memory: options.memory } };
    if (call.table === 'summary_prompt') return { data: options.summaryPrompt === undefined ? null : { prompt: options.summaryPrompt } };
    if (call.table === 'note' && options.noteError) return { error: options.noteError };
    return undefined;
  }, trace);
  const http = fakeGemini(t, options.reply ?? (() => ({ text: SUMMARY_JSON })), trace);
  return { trace, calls, http };
}

test('runSummarizeAudio requires Supabase, Gemini and AssemblyAI configuration before any work', async (t) => {
  const calls = fakeDb(t);
  const saved = { supabaseUrl: env.supabaseUrl, serviceRoleKey: env.serviceRoleKey, geminiApiKey: env.geminiApiKey, assemblyAiApiKey: env.assemblyAiApiKey };
  t.after(() => Object.assign(env, saved));
  const cases: [Partial<typeof saved>, string][] = [
    [{ supabaseUrl: '' }, 'Supabase service configuration is missing.'],
    [{ serviceRoleKey: '' }, 'Supabase service configuration is missing.'],
    [{ geminiApiKey: '', assemblyAiApiKey: '' }, 'Gemini API key is missing.'],
    [{ assemblyAiApiKey: '' }, 'AssemblyAI API key is missing.'],
  ];
  for (const [patch, message] of cases) {
    Object.assign(env, saved, patch);
    await assert.rejects(runSummarizeAudio(baseInput(), 'job-1'), { message }, message);
  }
  Object.assign(env, saved);
  assert.equal(calls.length, 0, 'no job write or read before the configuration check');
});

test('runSummarizeAudio happy path: stage writes, summary call, usage, note, checkpoint delete, result', async (t) => {
  const { log } = quiet(t);
  const memory = { version: 2, items: [{ text: 'Andrew owns the Q4 roadmap.', status: 'active' }] };
  const { trace, calls, http } = runnerBoundary(t, { memory });
  const input = baseInput();
  const result = await runSummarizeAudio(input, 'job-1');

  assert.deepEqual(jobUpdates(calls), [
    { status: 'processing', stage: 'loading inputs', progress: 10 },
    { stage: 'transcribing audio', progress: 25 },
    { stage: 'generating summary', progress: 75 },
    { stage: 'saving note', progress: 92 },
  ]);
  assert.ok(calls.filter((c) => c.table === 'workflow_job').every((c) => c.filters.length === 1 && c.filters[0][1] === 'id' && c.filters[0][2] === 'job-1'), 'job writes target the job id');
  assert.deepEqual(trace, [
    'workflow_job.update', 'workflow_transcription_settings.select', 'workflow_job.update', 'workflow_transcript_checkpoint.select',
    'user_memory.select', 'workflow_job.update', 'gemini.generate', 'workflow_usage.insert', 'workflow_job.update',
    'note.upsert', 'workflow_transcript_checkpoint.delete',
  ]);
  assert.ok(!calls.some((c) => c.table === 'summary_prompt'), 'a non-blank override skips the saved prompt');

  // Exactly one summary call (alternate-language summary disabled) with the pinned shape.
  assert.equal(TRANSLATION_ENABLED, false);
  assert.equal(http.generate.length, 1);
  const call = http.generate[0];
  assert.equal(call.model, env.summaryModel);
  assert.deepEqual(call.body.generationConfig, { temperature: 0.2, maxOutputTokens: 16384, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } });
  assert.equal(call.body.contents[0].parts.length, 1);
  const now = call.text.match(/Today's date is (\S+)/)?.[1] ?? '';
  const meetingStartAt = '2026-10-26T17:58:30.000Z';
  assert.equal(call.text, buildSummaryPrompt({
    now,
    meetingDate: formatMeetingDateForPrompt(new Date(meetingStartAt), 'America/Los_Angeles'),
    instructions: 'Focus on decisions.',
    summaryRules: 'Use bullet points.',
    fileName: 'standup.ogg',
    transcript: 'Speaker A: Let us review the roadmap.\nSpeaker B: Agreed.',
    speakerContext: 'Speaker A is Ann.',
    globalSummaryContext: '',
    personalMemoryContext: renderMemoryForContext(memory),
    outputLanguage: 'en',
    hasAttachments: false,
  }), 'summary prompt inputs');
  assert.ok(renderMemoryForContext(memory).length > 0, 'fixture memory renders to a non-empty block');
  assert.ok(log.mock.calls.some((c) => c.arguments[0] === 'Processing audio standup.ogg with AssemblyAI universal-2 and no explicit language settings. Selected summary language: en'), 'start log');

  const usage = calls.find((c) => c.table === 'workflow_usage')!.payload as Record<string, unknown>;
  assert.deepEqual([usage.note_id, usage.user_id, usage.stage, usage.provider, usage.model, usage.input_type], ['n1', 'u1', 'summarization', 'google-gemini', env.summaryModel, 'text']);

  const expectedName = buildNoteName({ title: 'Quarterly roadmap review', tags: ['roadmap', 'q4'], summary: '## Summary\nRoadmap agreed.', createdAt: new Date(meetingStartAt), timeZone: 'America/Los_Angeles' });
  const note = calls.find((c) => c.table === 'note')!;
  assert.deepEqual(note.options, UPSERT_OPTIONS);
  assert.deepEqual(note.payload, {
    transcription: 'Speaker A: Let us review the roadmap.\nSpeaker B: Agreed.', transcription_language: null, transcription_translations: {},
    summary: '## Summary\nRoadmap agreed.', summary_translations: { en: '## Summary\nRoadmap agreed.', ko: '' }, user_id: 'u1', user_name: 'Andrew',
    id: 'n1', audio_file: 'https://audio.invalid/a.ogg', name: expectedName, tags: ['roadmap', 'q4'], diarization: segments, diarization_translations: {},
    meeting_at: meetingStartAt, audio_file_id: 'file-1', duration_seconds: 90,
  });
  const cleanup = calls.find((c) => c.table === 'workflow_transcript_checkpoint' && c.op === 'delete')!;
  assert.deepEqual(cleanup.filters, [['eq', 'note_id', 'n1']]);

  assert.deepEqual(result, {
    transcript: segments, summary: '## Summary\nRoadmap agreed.', summaryTranslations: { en: '## Summary\nRoadmap agreed.', ko: '' },
    transcriptionLanguage: null, transcriptionTranslations: {}, diarizationTranslations: {}, title: expectedName, tags: ['roadmap', 'q4'],
    audioDurationSeconds: 90, meetingStartAt,
  });
});

test('runSummarizeAudio without a job id writes no job rows and keeps a null meeting date null', async (t) => {
  quiet(t);
  const { calls, http } = runnerBoundary(t, { summaryPrompt: 'Saved rules.' });
  const result = await runSummarizeAudio(baseInput({ meetingAt: null, language: 'ko', summaryRulesOverride: undefined }), null);
  assert.equal(jobUpdates(calls).length, 0);
  assert.equal(result.meetingStartAt, null);
  assert.deepEqual(result.summaryTranslations, { en: '', ko: '## Summary\nRoadmap agreed.' });
  assert.ok(http.generate[0].text.includes('Meeting date is unknown; do not assume it is today unless the transcript says so.'), 'unknown meeting date line');
  const note = calls.find((c) => c.table === 'note')!.payload as Record<string, unknown>;
  assert.equal(note.meeting_at, null);
  const prompt = calls.find((c) => c.table === 'summary_prompt')!;
  assert.deepEqual([prompt.columns, prompt.filters], ['prompt', [['eq', 'id', 'prompt-1'], ['eq', 'user_id', 'u1']]]);
});

test('runSummarizeAudio loads the saved prompt when the override is blank and fails before transcription when it is missing', async (t) => {
  quiet(t);
  await t.test('blank override uses the trimmed saved prompt', async (st) => {
    quiet(st);
    const { http } = runnerBoundary(st, { summaryPrompt: '  Saved rules.  ' });
    await runSummarizeAudio(baseInput({ summaryRulesOverride: '   ' }), null);
    assert.ok(http.generate[0].text.includes('Saved rules.'), 'saved rules reach the prompt');
  });
  await t.test('missing prompt rejects after the first stage write only', async (st) => {
    quiet(st);
    const { trace } = runnerBoundary(st, { summaryPrompt: '   ' });
    await assert.rejects(runSummarizeAudio(baseInput({ summaryRulesOverride: undefined }), 'job-1'), { message: 'Selected summary prompt was not found for this user.' });
    assert.deepEqual(trace, ['workflow_job.update', 'summary_prompt.select']);
  });
});

test('runSummarizeAudio translates the transcript in parallel with the summary and waits for it before saving', async (t) => {
  quiet(t);
  let releaseTranslation: () => void = () => undefined;
  const translationGate = new Promise<void>((resolve) => { releaseTranslation = resolve; });
  const order: string[] = [];
  const { calls } = runnerBoundary(t, {
    checkpointLanguage: 'en',
    reply: async (call) => {
      if (call.text.includes("Today's date is")) {
        order.push('summary');
        releaseTranslation();
        return { text: SUMMARY_JSON };
      }
      order.push('translation-start');
      // Released by the summary call; the timeout only prevents a hang if the code were sequential.
      await Promise.race([translationGate, new Promise((resolve) => setTimeout(resolve, 500))]);
      // Finish well after the summary so an unawaited translation would miss the note write.
      await new Promise((resolve) => setTimeout(resolve, 100));
      order.push('translation-end');
      return { text: JSON.stringify({ segments: [{ speaker: 'Speaker A', text: '로드맵을 검토합시다.', start: 0, end: 2 }] }) };
    },
  });
  const result = await runSummarizeAudio(baseInput(), 'job-1');
  assert.deepEqual(order, ['translation-start', 'summary', 'translation-end'], 'summary starts while the translation is in flight');
  const translated = [{ speaker: 'Speaker A', text: '로드맵을 검토합시다.', start: 0, end: 2 }];
  assert.deepEqual(result.diarizationTranslations, { ko: translated });
  assert.deepEqual(result.transcriptionTranslations, { ko: 'Speaker A: 로드맵을 검토합시다.' });
  assert.equal(result.transcriptionLanguage, 'en');
  const note = calls.find((c) => c.table === 'note')!.payload as Record<string, unknown>;
  assert.deepEqual([note.transcription_language, note.diarization_translations, note.transcription_translations], ['en', { ko: translated }, { ko: 'Speaker A: 로드맵을 검토합시다.' }]);
  const stages = calls.filter((c) => c.table === 'workflow_usage').map((c) => (c.payload as Record<string, unknown>).stage);
  assert.deepEqual(stages, ['summarization', 'transcript-translation-ko']);
});

test('runSummarizeAudio keeps the note when the transcript translation fails', async (t) => {
  const { warn } = quiet(t);
  const { calls } = runnerBoundary(t, {
    checkpointLanguage: 'ko',
    reply: (call) => (call.text.includes("Today's date is") ? { text: SUMMARY_JSON } : { status: 400, error: 'Fixture translation failure' }),
  });
  const result = await runSummarizeAudio(baseInput(), null);
  assert.deepEqual([result.transcriptionLanguage, result.diarizationTranslations, result.transcriptionTranslations], ['ko', {}, {}]);
  assert.ok(calls.some((c) => c.table === 'note' && c.op === 'upsert'), 'note saved');
  assert.ok(warn.mock.calls.some((c) => c.arguments[0] === 'Transcript translation to en failed:'), 'translation failure is logged');
});

test('runSummarizeAudio propagates a summary failure without saving the note or deleting the checkpoint', async (t) => {
  quiet(t);
  const { calls } = runnerBoundary(t, { reply: () => ({ status: 400, error: 'Fixture summary failure' }) });
  await assert.rejects(runSummarizeAudio(baseInput(), 'job-1'), { message: 'Summarization: Gemini API error (400): Fixture summary failure' });
  assert.ok(!calls.some((c) => c.table === 'note'), 'no note');
  assert.ok(!calls.some((c) => c.table === 'workflow_transcript_checkpoint' && c.op === 'delete'), 'checkpoint kept for the retry');
  assert.deepEqual(jobUpdates(calls).map((u) => u.stage), ['loading inputs', 'transcribing audio', 'generating summary'], 'no terminal write from the runner');
});

test('runSummarizeAudio rejects an empty summary before saving', async (t) => {
  quiet(t);
  const { calls } = runnerBoundary(t, { reply: () => ({ text: JSON.stringify({ title: 'T', summary: '   ', tags: [] }) }) });
  await assert.rejects(runSummarizeAudio(baseInput(), 'job-1'), { message: 'Summary JSON must include a non-empty summary string.' });
  assert.ok(!calls.some((c) => c.table === 'note'), 'no note');
  assert.ok(calls.some((c) => c.table === 'workflow_usage'), 'the paid summary call is still recorded');
});

test('runSummarizeAudio propagates a note write failure and keeps the transcript checkpoint', async (t) => {
  quiet(t);
  const noteError = { code: '08006', message: 'connection lost' };
  const { calls } = runnerBoundary(t, { noteError });
  await assert.rejects(runSummarizeAudio(baseInput(), 'job-1'), (error) => error === noteError);
  assert.ok(!calls.some((c) => c.table === 'workflow_transcript_checkpoint' && c.op === 'delete'), 'checkpoint kept for the retry');
  assert.equal(jobUpdates(calls).at(-1)?.stage, 'saving note');
});

test('runSummarizeAudio with attachments: upload, summary parts, attachment section call and usage', async (t) => {
  quiet(t);
  const attachments = [{ name: 'deck.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('PDF').toString('base64') }];
  const { calls, http, trace } = runnerBoundary(t, {
    reply: (call) => (call.text.includes("Today's date is")
      ? { text: JSON.stringify({ title: 'Roadmap', summary: '  ## Summary\nRoadmap agreed.  ', tags: [] }) }
      : { text: '{"sectionMarkdown":"- deck.pdf: roadmap slides"}' }),
  });
  const result = await runSummarizeAudio(baseInput({ attachments }), 'job-1');
  assert.deepEqual(jobUpdates(calls).map((u) => u.progress), [10, 25, 75, 82, 92]);
  assert.equal(jobUpdates(calls)[3].stage, 'generating attachment summary');
  assert.deepEqual(trace.filter((s) => s.startsWith('gemini')), ['gemini.upload-start', 'gemini.upload-finalize', 'gemini.generate', 'gemini.generate']);
  const [summaryCall, sectionCall] = http.generate;
  const summaryParts = summaryCall.body.contents[0].parts;
  assert.equal(summaryParts.length, 3, 'prompt, attachment context and one file part');
  assert.ok(String(summaryParts[1].text).startsWith('ATTACHED FILE CONTEXT'), 'attachment context part');
  assert.deepEqual(summaryParts[2], { fileData: { mimeType: 'fixture/type-1', fileUri: 'https://files.invalid/1' } });
  const now = summaryCall.text.match(/Today's date is (\S+)/)?.[1] ?? '';
  assert.equal(summaryCall.text, buildSummaryPrompt({
    now, meetingDate: formatMeetingDateForPrompt(new Date('2026-10-26T17:58:30.000Z'), 'America/Los_Angeles'), instructions: 'Focus on decisions.',
    summaryRules: 'Use bullet points.', fileName: 'standup.ogg', transcript: 'Speaker A: Let us review the roadmap.\nSpeaker B: Agreed.',
    speakerContext: 'Speaker A is Ann.', globalSummaryContext: '', personalMemoryContext: '', outputLanguage: 'en', hasAttachments: true,
  }), 'hasAttachments reaches the summary prompt');
  assert.ok(sectionCall.text.includes("CURRENT SUMMARY\n'''\n## Summary\nRoadmap agreed.\n'''"), 'section call sees the parsed (trimmed) summary');
  assert.deepEqual(sectionCall.body.contents[0].parts.slice(1), summaryParts.slice(1), 'section call reuses the uploaded parts');
  assert.equal(result.summary, '## Summary\nRoadmap agreed.\n\n## Attached Files\n- deck.pdf: roadmap slides');
  assert.deepEqual(result.summaryTranslations, { en: result.summary, ko: '' });
  const stages = calls.filter((c) => c.table === 'workflow_usage').map((c) => (c.payload as Record<string, unknown>).stage);
  assert.deepEqual(stages, ['summarization', 'attachment-summary-section']);
});

test('runSummarizeAudio skips the section call when the summary already has it, and falls back when the call fails', async (t) => {
  const attachments = [{ name: 'deck.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('PDF').toString('base64') }];
  await t.test('summary already contains the section', async (st) => {
    quiet(st);
    const { http, calls } = runnerBoundary(st, { reply: () => ({ text: JSON.stringify({ title: 'R', summary: 'S\n## Attached Files\n- deck', tags: [] }) }) });
    const result = await runSummarizeAudio(baseInput({ attachments }), 'job-1');
    assert.equal(http.generate.length, 1);
    assert.equal(result.summary, 'S\n## Attached Files\n- deck');
    assert.ok(!jobUpdates(calls).some((u) => u.progress === 82), 'no attachment stage');
  });
  await t.test('section call failure appends the fallback section', async (st) => {
    const { warn } = quiet(st);
    runnerBoundary(st, {
      reply: (call) => (call.text.includes("Today's date is") ? { text: JSON.stringify({ title: 'R', summary: ' S ', tags: [] }) } : { status: 400, error: 'Fixture section failure' }),
    });
    const result = await runSummarizeAudio(baseInput({ attachments, language: 'ko' }), 'job-1');
    assert.equal(result.summary, `S\n\n${fallbackAttachmentSection(attachments, 'ko')}`);
    assert.ok(warn.mock.calls.some((c) => c.arguments[0] === 'Attachment summary section generation failed:'), 'warned');
  });
  await t.test('unparseable section JSON also falls back', async (st) => {
    quiet(st);
    runnerBoundary(st, {
      reply: (call) => (call.text.includes("Today's date is") ? { text: JSON.stringify({ title: 'R', summary: 'S', tags: [] }) } : { text: '{"other":1}' }),
    });
    const result = await runSummarizeAudio(baseInput({ attachments }), null);
    assert.equal(result.summary, `S\n\n${fallbackAttachmentSection(attachments, 'en')}`);
  });
  await t.test('only zero-byte attachments behave like no attachments', async (st) => {
    quiet(st);
    const { http } = runnerBoundary(st, { reply: () => ({ text: JSON.stringify({ title: 'R', summary: 'S', tags: [] }) }) });
    const result = await runSummarizeAudio(baseInput({ attachments: [{ name: 'e.txt', mimeType: 'text/plain', dataBase64: '' }] }), null);
    assert.equal(http.uploads.length, 0);
    assert.equal(http.generate.length, 1);
    assert.equal(result.summary, 'S');
  });
});

const INSIGHT_OPENER = 'You extract a STRUCTURED INDEX of ONE meeting';

// Finalize boundary: memory fold reads user_memory; insight extraction answers '{}';
// any other Gemini prompt (the memory fold itself) fails non-retryably so no backoff runs.
function finalizeBoundary(t: test.TestContext, options: { processed?: boolean; throwOn?: (table: string) => boolean; noteUpdateError?: DbError; insightFails?: boolean } = {}) {
  const trace: string[] = [];
  const calls = fakeDb(t, (call) => {
    if (call.table === 'user_memory' && call.op === 'select') {
      return { data: options.processed === false ? null : { memory: { version: 2, items: [] }, processed_note_ids: ['n1'] } };
    }
    if (call.table === 'note' && call.op === 'update' && options.noteUpdateError) return { error: options.noteUpdateError };
    if (call.table === 'note_insight' && call.op === 'update') return { data: [{ note_id: 'n1' }] };
    return undefined;
  }, trace, options.throwOn);
  const http = fakeGemini(t, (call) => (call.text.startsWith(INSIGHT_OPENER) && !options.insightFails ? { text: '{}' } : { status: 400, error: 'Fixture fold failure' }), trace);
  return { trace, calls, http };
}

const soloSegments: TranscriptSegment[] = [
  { speaker: 'Speaker A', speakerKey: 'Speaker A', text: 'Note to self.', start: 0, end: 1 },
  { speaker: 'Speaker A', speakerKey: 'Speaker A', text: 'Ship it.', start: 1, end: 2 },
];

test('finalizeNoteMemory folds memory first, then names a solo speaker and refreshes the insight', async (t) => {
  const { log } = quiet(t);
  const { trace, calls, http } = finalizeBoundary(t);
  await finalizeNoteMemory(baseInput({ userName: 'Andrew' }), soloSegments);
  assert.deepEqual(trace, ['user_memory.select', 'note.update', 'gemini.generate', 'note_insight.update']);
  assert.deepEqual(calls[0].filters, [['eq', 'user_id', 'u1']]);
  const update = calls.find((c) => c.table === 'note')!;
  assert.deepEqual(update.payload, { diarization: soloSegments.map((s) => ({ ...s, speaker: 'Andrew' })) });
  assert.deepEqual(update.filters, [['eq', 'id', 'n1']]);
  assert.ok(http.generate[0].text.includes('Andrew: Note to self.\nAndrew: Ship it.'), 'insight sees the named transcript');
  assert.ok(http.generate[0].text.includes("Meeting participants (the transcript's speaker labels are these real names): Andrew."), 'insight sees the named speaker context');
  assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]).filter((m) => !String(m).includes('calling Gemini')), [
    'Memory fold note=n1 items=0 insight=false skipped=true',
    'Auto-named 1 speaker(s) for note n1: Andrew',
  ]);
});

test('finalizeNoteMemory passes the transcript and summary speaker hint to an unprocessed fold', async (t) => {
  const { log } = quiet(t);
  const { http, calls } = finalizeBoundary(t, { processed: false });
  await finalizeNoteMemory(baseInput({ userName: '', speakerContext: 'Speaker A is Ann.' }), segments);
  const insight = http.generate.find((c) => c.text.startsWith(INSIGHT_OPENER));
  assert.ok(insight, 'fold runs insight extraction');
  assert.ok(insight.text.includes('Speaker A: Let us review the roadmap.\nSpeaker B: Agreed.'), 'original-language transcript');
  assert.ok(insight.text.includes('Speaker A is Ann.'), 'summary speaker hint reaches the fold');
  assert.ok(log.mock.calls.some((c) => c.arguments[0] === 'Memory fold note=n1 items=0 insight=true skipped=false'), 'fold log');
  assert.ok(!calls.some((c) => c.table === 'note'), 'two anonymous speakers are never auto-named');
});

test('finalizeNoteMemory never names speakers for an owner without a name (Android jobs)', async (t) => {
  quiet(t);
  const { calls } = finalizeBoundary(t);
  await finalizeNoteMemory(baseInput({ userName: '' }), soloSegments);
  assert.ok(!calls.some((c) => c.table === 'note'), 'no diarization write');
});

test('finalizeNoteMemory isolates a fold failure from speaker naming and never throws', async (t) => {
  const { warn, log } = quiet(t);
  const { calls } = finalizeBoundary(t, { throwOn: (table) => table === 'user_memory' });
  await finalizeNoteMemory(baseInput(), soloSegments);
  assert.equal(warn.mock.calls[0].arguments[0], 'Memory fold failed for note n1:');
  assert.equal((warn.mock.calls[0].arguments[1] as Error).message, 'Fixture user_memory client failure');
  assert.ok(calls.some((c) => c.table === 'note' && c.op === 'update'), 'speaker naming still runs');
  assert.ok(log.mock.calls.some((c) => c.arguments[0] === 'Auto-named 1 speaker(s) for note n1: Andrew'), 'named');
});

test('finalizeNoteMemory isolates a speaker naming failure and guards the whole body', async (t) => {
  await t.test('speaker step throws', async (st) => {
    const { warn } = quiet(st);
    finalizeBoundary(st, { throwOn: (table) => table === 'note' });
    await finalizeNoteMemory(baseInput(), soloSegments);
    assert.equal(warn.mock.calls[0].arguments[0], 'Auto speaker identify failed for note n1:');
    assert.equal((warn.mock.calls[0].arguments[1] as Error).message, 'Fixture note client failure');
  });
  await t.test('invalid segments hit the outer guard', async (st) => {
    const { warn } = quiet(st);
    const { calls } = finalizeBoundary(st);
    await finalizeNoteMemory(baseInput(), null as unknown as TranscriptSegment[]);
    assert.equal(warn.mock.calls[0].arguments[0], 'finalizeNoteMemory failed for note n1:');
    assert.equal(calls.length, 0);
  });
});

test('autoIdentifySpeakersAtIngest only names the single anonymous speaker after the owner', async (t) => {
  const run = (over: { selfName?: string | null; segments?: TranscriptSegment[] } = {}) => autoIdentifySpeakersAtIngest({
    noteId: 'n1', userId: 'u1', selfName: over.selfName === undefined ? '  Andrew  ' : over.selfName, segments: over.segments ?? soloSegments,
  });

  await t.test('no anonymous labels, several anonymous labels, or no owner name: no writes, no model call', async (st) => {
    quiet(st);
    const { calls, http } = finalizeBoundary(st);
    await run({ segments: [{ speaker: 'Ann', text: 'hi' }, { speaker: 'Speakerphone', text: 'x' }] });
    await run({ segments });
    await run({ segments: [{ speaker: 'Speaker A', text: 'a' }, { speaker: 'speaker 2', text: 'b' }] });
    await run({ selfName: null });
    await run({ selfName: '   ' });
    assert.equal(calls.length, 0);
    assert.equal(http.generate.length, 0);
  });

  await t.test('no Gemini key: nothing happens', async (st) => {
    quiet(st);
    const saved = env.geminiApiKey;
    st.after(() => { env.geminiApiKey = saved; });
    env.geminiApiKey = '';
    const { calls } = finalizeBoundary(st);
    await run();
    assert.equal(calls.length, 0);
  });

  await t.test('one anonymous label among named speakers is named; others are untouched', async (st) => {
    const { log } = quiet(st);
    const { calls, http } = finalizeBoundary(st);
    const mixed: TranscriptSegment[] = [
      { speaker: 'Bob', text: 'Status?', start: 0, end: 1 },
      { speaker: 'speaker 1', speakerKey: 'Speaker 1', text: 'Done.', start: 1, end: 2, translations: { ko: '완료.' } },
    ];
    await run({ segments: mixed });
    assert.deepEqual(calls.find((c) => c.table === 'note')!.payload, { diarization: [mixed[0], { ...mixed[1], speaker: 'Andrew' }] });
    assert.ok(http.generate[0].text.includes('Bob: Status?\nAndrew: Done.'), 'named transcript');
    assert.ok(http.generate[0].text.includes("Meeting participants (the transcript's speaker labels are these real names): Bob, Andrew."), 'speaker context');
    assert.equal(log.mock.calls.at(-1)?.arguments[0], 'Auto-named 1 speaker(s) for note n1: Andrew');
  });

  await t.test('a diarization write error stops before the insight refresh', async (st) => {
    const { warn, log } = quiet(st);
    const { http, calls } = finalizeBoundary(st, { noteUpdateError: { message: 'permission denied' } });
    await run();
    assert.equal(warn.mock.calls[0].arguments[0], 'Diarization update failed for note n1: permission denied');
    assert.equal(http.generate.length, 0);
    assert.ok(!calls.some((c) => c.table === 'note_insight'), 'no insight write');
    assert.ok(!log.mock.calls.some((c) => String(c.arguments[0]).startsWith('Auto-named')), 'no success log');
  });

  await t.test('an insight extraction failure is soft and still logs the naming', async (st) => {
    const { log } = quiet(st);
    const { calls } = finalizeBoundary(st, { insightFails: true });
    await run();
    assert.ok(calls.some((c) => c.table === 'note' && c.op === 'update'), 'diarization written');
    assert.ok(!calls.some((c) => c.table === 'note_insight'), 'no insight row without an extraction');
    assert.equal(log.mock.calls.at(-1)?.arguments[0], 'Auto-named 1 speaker(s) for note n1: Andrew');
  });
});
