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
  const promptText = () => {
    const call = f.state.calls.find((c) => c.url.hostname === 'generativelanguage.googleapis.com');
    return JSON.stringify(call?.body ?? null);
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

  await t.test('mixed named and generic labels add the other-participants rule with the generic labels', async () => {
    await regenerate({ diarization: mixed, persist: false });
    const text = promptText();
    assert.match(text, /UNNAMED SPEAKERS/);
    assert.match(text, /Speaker C/);
    assert.match(text, /other participant/);
  });

  await t.test('all named or all generic transcripts keep the prompt without the rule', async () => {
    await regenerate({ diarization: named, persist: false });
    assert.doesNotMatch(promptText(), /UNNAMED SPEAKERS/);
    await regenerate({ diarization: anonymous, persist: false });
    assert.doesNotMatch(promptText(), /UNNAMED SPEAKERS/);
  });
});

test('U1/U9 prompt builder is byte-identical without unnamed labels', async () => {
  const { buildRegenerateSummaryPrompt, unnamedSpeakerLabels } = await import('./prompts.js');
  const base = {
    now: '2026-10-28T00:00:00.000Z',
    summaryRules: 'Rules.',
    diarizedTranscript: 'Andrew: hi',
    previousSummary: 'Old.',
    speakerProfiles: [],
  };
  assert.equal(buildRegenerateSummaryPrompt(base), buildRegenerateSummaryPrompt({ ...base, unnamedSpeakerLabels: [] }));
  assert.notEqual(buildRegenerateSummaryPrompt(base), buildRegenerateSummaryPrompt({ ...base, unnamedSpeakerLabels: ['Speaker C'] }));

  assert.deepEqual(unnamedSpeakerLabels(mixed), ['Speaker C']);
  assert.deepEqual(unnamedSpeakerLabels(named), []);
  assert.deepEqual(unnamedSpeakerLabels(anonymous), []);
  const withGeneric: { speaker: string; text: string }[] = [
    ...named,
    { speaker: 'Unknown Speaker', text: 'x' },
    { speaker: 'Speaker 3', text: 'y' },
    { speaker: 'Speaker 3', text: 'z' },
  ];
  assert.deepEqual(unnamedSpeakerLabels(withGeneric), ['Unknown Speaker', 'Speaker 3']);
});
