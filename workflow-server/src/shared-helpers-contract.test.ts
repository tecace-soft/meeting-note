import assert from 'node:assert/strict';
import test from 'node:test';
import { env } from './config/env.js';
import { supabase } from './db/supabaseClient.js';
import { GEMINI_2_5_FLASH_LITE as primary, GEMINI_3_1_FLASH_LITE as fallback } from './gemini-models.js';
import { callGeminiWithFallback, delay, recordGeminiUsage, recordAssemblyUsage, getPersonalMemoryContext, buildSpeakerContextFromSegments, normalizeTranscriptSegment, recoverCompleteDiarizedSegments, parseDiarizedSegmentsWithRecovery } from './index.js';

const success = () => Response.json({ candidates: [{ content: { parts: [{ text: 'fixture result' }] } }], usageMetadata: { promptTokenCount: 3 } });
const input = { stage: 'Fixture', model: primary, fallbackModels: [primary, fallback, fallback], parts: [{ text: 'fixture' }] };

test('Gemini fallback preserves dedup order and missing-model failover', async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0]) => {
    calls.push(String(url));
    return calls.length === 1 ? Response.json({ error: { message: 'not found' } }, { status: 404 }) : success();
  });
  const result = await callGeminiWithFallback(input);
  assert.equal(result.model, fallback); assert.equal(result.text, 'fixture result');
  assert.deepEqual(result.usageMetadata, { promptTokenCount: 3 });
  assert.ok(result.latencyMs >= 0);
  assert.equal(calls.length, 2); assert.ok(calls[0].includes(primary)); assert.ok(calls[1].includes(fallback));
});

test('Gemini transient retry stays on the same model and permanent failure stops the chain', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0]) => {
    assert.ok(String(url).includes(primary)); calls++;
    return calls === 1 ? Response.json({ error: { message: 'busy' } }, { status: 429 }) : success();
  });
  const pending = callGeminiWithFallback(input);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1); t.mock.timers.tick(1000);
  assert.equal((await pending).model, primary); assert.equal(calls, 2);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'denied' } }, { status: 400 }));
  await assert.rejects(callGeminiWithFallback(input), /Fixture:.*denied/);
  const empty = callGeminiWithFallback({ ...input, model: '', fallbackModels: [] });
  await assert.rejects(empty, { message: 'Gemini request failed.' });
});

test('shared delay waits until its existing deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let finished = false;
  const pending = delay(10).then(() => { finished = true; });
  t.mock.timers.tick(9); await Promise.resolve(); assert.equal(finished, false);
  t.mock.timers.tick(1); await pending; assert.equal(finished, true);
});

test('usage helpers preserve provider payloads, Assembly price and non-throwing DB errors', async (t) => {
  const writes: Record<string, any>[] = []; const warnings = t.mock.method(console, 'warn', () => undefined);
  t.mock.method(supabase, 'from', (table: string) => {
    assert.equal(table, 'workflow_usage');
    return { insert: async (value: Record<string, unknown>) => { writes.push(value); return { error: { message: 'fixture' } }; } } as never;
  });
  const price = env.assemblyAiPricePerHourUsd; t.after(() => { env.assemblyAiPricePerHourUsd = price; });
  env.assemblyAiPricePerHourUsd = 0.21;
  await recordGeminiUsage({ noteId: 'note', userId: 'owner', stage: 'summary', model: primary, inputType: 'text', usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }, latencyMs: 7 });
  assert.deepEqual([writes[0].provider, writes[0].stage, writes[0].note_id, writes[0].user_id, writes[0].model, writes[0].prompt_tokens, writes[0].candidates_tokens, writes[0].total_tokens, writes[0].latency_ms], ['google-gemini', 'summary', 'note', 'owner', primary, 3, 2, 5, 7]);
  await recordAssemblyUsage({ noteId: 'note', userId: 'owner', model: 'universal-2', latencyMs: 8, transcriptId: 'fixture', audioDurationSeconds: 3600 });
  assert.equal(writes[1].estimated_cost_usd, 0.21); assert.equal(writes[1].stage, 'transcription');
  assert.deepEqual(writes[1].usage_metadata, { transcriptId: 'fixture', audioDurationSeconds: 3600, pricePerHourUsd: 0.21 });
  env.assemblyAiPricePerHourUsd = NaN;
  await recordAssemblyUsage({ noteId: 'note', userId: 'owner', model: 'universal-2', latencyMs: 8, transcriptId: 'fixture', audioDurationSeconds: -2 });
  assert.equal(writes[2].estimated_cost_usd, 0); assert.equal(warnings.mock.callCount(), 3);
});

test('memory context retains credential guards, owner scope and best-effort failure behavior', async (t) => {
  const previous = { supabaseUrl: env.supabaseUrl, serviceRoleKey: env.serviceRoleKey };
  t.after(() => { Object.assign(env, previous); });
  const calls: unknown[][] = []; let fail = false;
  t.mock.method(supabase, 'from', (table: string) => {
    calls.push([table]);
    return { select: (columns: string) => ({ eq: (key: string, value: string) => ({ maybeSingle: async () => {
      calls.push([columns, key, value]); if (fail) throw new Error('fixture failure');
      return { data: { memory: null }, error: null };
    } }) }) } as never;
  });
  env.supabaseUrl = ''; env.serviceRoleKey = '';
  assert.equal(await getPersonalMemoryContext('owner'), ''); assert.equal(calls.length, 0);
  env.supabaseUrl = 'https://db.invalid'; env.serviceRoleKey = 'synthetic';
  assert.equal(await getPersonalMemoryContext(undefined), ''); assert.equal(calls.length, 0);
  assert.equal(await getPersonalMemoryContext('owner'), '');
  assert.deepEqual(calls, [['user_memory'], ['memory', 'user_id', 'owner']]);
  fail = true; t.mock.method(console, 'warn', () => undefined);
  assert.equal(await getPersonalMemoryContext('owner'), '');
});

test('speaker context retains first occurrence and filters only existing generic labels', () => {
  const segment = (speaker: string) => ({ speaker, text: 'fixture' });
  assert.equal(buildSpeakerContextFromSegments(['Unknown Speaker', 'Speaker A', 'speaker 2', ''].map(segment)), null);
  assert.equal(buildSpeakerContextFromSegments(['Pat', 'Lee', 'Pat'].map(segment)), "Meeting participants (the transcript's speaker labels are these real names): Pat, Lee.");
});

test('recovery parsers retain speaker keys, timestamps and only complete JSON objects', () => {
  assert.equal(normalizeTranscriptSegment({ text: ' ' }), null);
  assert.deepEqual(normalizeTranscriptSegment({ text: ' x ', speaker_key: ' A ', start: 0, end: NaN }), { text: 'x', speaker: 'Unknown Speaker', speakerKey: 'A', start: 0 });
  const raw = '{"segments":[{"speaker":"Pat","speaker_key":"A","text":"literal } [","start":0},{"text":"unfinished';
  const expected = [{ speaker: 'Pat', speakerKey: 'A', text: 'literal } [', start: 0 }];
  assert.deepEqual(recoverCompleteDiarizedSegments(raw), expected);
  assert.deepEqual(parseDiarizedSegmentsWithRecovery(raw), { segments: expected, recovered: true });
  assert.equal(parseDiarizedSegmentsWithRecovery('{"segments":[{"speaker":"Pat","text":"ok"}]}').recovered, false);
  assert.throws(() => parseDiarizedSegmentsWithRecovery('not JSON'));
});
