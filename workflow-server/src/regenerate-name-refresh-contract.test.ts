import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowFixture } from './test-support/workflow.js';

// U1/U9 (DEC-0024): the web's name-aware auto refresh asks for a regenerated summary WITHOUT
// the server saving it (persist:false), so a hand-edited summary is never overwritten before the
// user agrees. Every other caller (mobile, history page) keeps the old save-by-default contract.
// The regenerate prompt also tells the model how to treat speakers the user has not named.

const named = [
  { speaker: 'Andrew', speakerKey: 'Speaker A', text: 'Let us ship the web slice first.', start: 0, end: 40 },
  { speaker: 'Hansoo', speakerKey: 'Speaker B', text: 'Agreed, mobile can follow.', start: 40, end: 80 },
];
const mixed = [...named, { speaker: 'Speaker C', speakerKey: 'Speaker C', text: 'Sounds good.', start: 80, end: 82 }];
// A named (40s), B unnamed MAIN (40s), C unnamed minor (2s).
const unnamedMain = [
  named[0],
  { speaker: 'Speaker B', speakerKey: 'Speaker B', text: 'Mobile can follow.', start: 40, end: 80 },
  { speaker: 'Speaker C', speakerKey: 'Speaker C', text: 'Sounds good.', start: 80, end: 82 },
];
// A named, B unnamed but main: nothing minor to fold.
const namedAndMainGeneric = [named[0], { speaker: 'Speaker B', speakerKey: 'Speaker B', text: 'Agreed.', start: 40, end: 80 }];
const anonymous = [
  { speaker: 'Speaker A', speakerKey: 'Speaker A', text: 'Hello.', start: 0, end: 1 },
  { speaker: 'Speaker B', speakerKey: 'Speaker B', text: 'Hi.', start: 1, end: 2 },
];

test('U1/U9 regenerate-summary persist flag and unnamed-speaker prompt rule', async (t) => {
  const f = await workflowFixture();
  t.after(() => f.close());
  t.mock.method(console, 'warn', () => undefined);
  t.mock.method(console, 'log', () => undefined);

  const noteWrites = () => f.state.calls.filter((c) => c.method === 'PATCH' && c.url.pathname.endsWith('/note'));
  // Every string in the Gemini request body, joined with real newlines (bounded depth).
  const promptText = () => {
    const call = f.state.calls.find((c) => c.url.hostname === 'generativelanguage.googleapis.com');
    const strings: string[] = [];
    const collect = (value: unknown, depth: number): void => {
      if (depth > 8) return;
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach((item) => collect(item, depth + 1));
      else if (value && typeof value === 'object') Object.values(value).forEach((item) => collect(item, depth + 1));
    };
    collect(call?.body ?? null, 0);
    return strings.join('\n');
  };
  const regenerate = async (body: Record<string, unknown>) => {
    f.reset();
    const response = await f.request('/regenerate-summary', { body: { noteId: 'fixture-note', ...body } });
    assert.equal(response.status, 200, response.text);
    return response.body as { summary?: string; persisted?: boolean };
  };

  await t.test('default request saves summary_edit and reports persisted true', async () => {
    const body = await regenerate({ diarization: named });
    assert.equal(body.summary, 'Fixture summary');
    assert.equal(body.persisted, true);
    const writes = noteWrites();
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]!.body, { summary_edit: 'Fixture summary' });
  });

  await t.test('persist:false returns the summary without writing the note', async () => {
    const body = await regenerate({ diarization: named, persist: false });
    assert.equal(body.summary, 'Fixture summary');
    assert.equal(body.persisted, false);
    assert.equal(noteWrites().length, 0);
  });

  await t.test('only boolean false skips the save', async () => {
    for (const persist of ['false', 0, null, true]) {
      const body = await regenerate({ diarization: named, persist });
      assert.equal(body.persisted, true, `persist=${JSON.stringify(persist)}`);
      assert.equal(noteWrites().length, 1, `persist=${JSON.stringify(persist)}`);
    }
  });

  const ruleLine = () => {
    const text = promptText();
    const at = text.indexOf('UNNAMED SPEAKERS');
    if (at < 0) return null;
    const end = text.indexOf('\n', at);
    return text.slice(at, end < 0 ? undefined : end);
  };

  await t.test('mixed case: only the minor unnamed labels (under 10% of speaking time) get the other-participants rule', async () => {
    await regenerate({ diarization: mixed, persist: false });
    const rule = ruleLine();
    assert.ok(rule, 'rule expected');
    assert.match(rule, /"Speaker C"/);
    assert.match(rule, /another participant/);
  });

  await t.test('an unnamed MAIN speaker keeps its label and is not folded into other participants', async () => {
    await regenerate({ diarization: unnamedMain, persist: false });
    const rule = ruleLine();
    assert.ok(rule, 'rule expected for the minor label');
    assert.match(rule, /"Speaker C"/);
    assert.doesNotMatch(rule, /Speaker B/);
    assert.match(promptText(), /Speaker B: Mobile can follow/);
  });

  await t.test('no minor unnamed labels: no rule (all named, all generic, or only unnamed main speakers)', async () => {
    for (const diarization of [named, anonymous, namedAndMainGeneric]) {
      await regenerate({ diarization, persist: false });
      assert.equal(ruleLine(), null);
    }
  });
});

test('U1/U9 prompt builder is byte-identical without minor unnamed labels', async () => {
  const { buildRegenerateSummaryPrompt, minorUnnamedSpeakerLabels, MINOR_SPEAKER_MAX_SHARE } = await import('./prompts.js');
  const base = {
    now: '2026-10-28T00:00:00.000Z',
    summaryRules: 'Rules.',
    diarizedTranscript: 'Andrew: hi',
    previousSummary: 'Old.',
    speakerProfiles: [],
  };
  assert.equal(buildRegenerateSummaryPrompt(base), buildRegenerateSummaryPrompt({ ...base, unnamedSpeakerLabels: [] }));
  assert.notEqual(buildRegenerateSummaryPrompt(base), buildRegenerateSummaryPrompt({ ...base, unnamedSpeakerLabels: ['Speaker C'] }));

  assert.equal(MINOR_SPEAKER_MAX_SHARE, 0.1);
  assert.deepEqual(minorUnnamedSpeakerLabels(mixed), ['Speaker C']);
  assert.deepEqual(minorUnnamedSpeakerLabels(unnamedMain), ['Speaker C']);
  assert.deepEqual(minorUnnamedSpeakerLabels(namedAndMainGeneric), []);
  assert.deepEqual(minorUnnamedSpeakerLabels(named), []);
  assert.deepEqual(minorUnnamedSpeakerLabels(anonymous), []);
  // Exactly 10% is a main speaker, so it keeps its label.
  assert.deepEqual(
    minorUnnamedSpeakerLabels([
      { speaker: 'Andrew', speakerKey: 'Speaker A', text: 'a', start: 0, end: 9 },
      { speaker: 'Speaker B', speakerKey: 'Speaker B', text: 'b', start: 9, end: 10 },
    ]),
    [],
  );
  // Invalid timing on any segment falls back to text length (web mainSpeakers.ts does the same).
  assert.deepEqual(
    minorUnnamedSpeakerLabels([
      { speaker: 'Andrew', speakerKey: 'Speaker A', text: 'x'.repeat(95) },
      { speaker: 'Speaker B', speakerKey: 'Speaker B', text: 'y'.repeat(5), start: 0, end: 50 },
    ]),
    ['Speaker B'],
  );
  // Legacy segments without speakerKey group by the display label.
  assert.deepEqual(
    minorUnnamedSpeakerLabels([
      { speaker: 'Andrew', text: 'a'.repeat(60) },
      { speaker: 'Unknown Speaker', text: 'b'.repeat(35) },
      { speaker: 'Speaker 3', text: 'c'.repeat(5) },
    ]),
    ['Speaker 3'],
  );
});
