import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNoteName, formatTranscriptText, parseDiarizedSegments, parseSummary } from './parsers.js';

test('parseDiarizedSegments parses valid JSON', () => {
  assert.deepEqual(parseDiarizedSegments('{"segments":[{"speaker":"Speaker 1","text":"Hello"}]}'), [
    { speaker: 'Speaker 1', text: 'Hello' },
  ]);
});

test('parseDiarizedSegments strips markdown fences', () => {
  assert.deepEqual(parseDiarizedSegments('```json\n{"segments":[{"speaker":"Speaker 2","text":"네"}]}\n```'), [
    { speaker: 'Speaker 2', text: '네' },
  ]);
});

test('parseDiarizedSegments rejects malformed JSON', () => {
  assert.throws(() => parseDiarizedSegments('{nope'), /JSON/);
});

test('parseDiarizedSegments requires segments array', () => {
  assert.throws(() => parseDiarizedSegments('{"items":[]}'), /segments array/);
});

test('parseDiarizedSegments normalizes invalid segment fields', () => {
  assert.deepEqual(parseDiarizedSegments('{"segments":[{"speaker":12,"text":"Hi"},{"speaker":"A","text":""}]}'), [
    { speaker: 'Unknown Speaker', text: 'Hi' },
  ]);
});

test('formatTranscriptText joins speaker lines', () => {
  assert.equal(
    formatTranscriptText([
      { speaker: 'A', text: 'One' },
      { speaker: 'B', text: 'Two' },
    ]),
    'A: One\nB: Two',
  );
});

test('parseSummary parses and normalizes tags', () => {
  assert.deepEqual(parseSummary('{"title":"Long Meeting Title With Too Many Words","summary":"Done","tags":["project sync",12]}'), {
    title: 'Long Meeting Title With Too Many',
    summary: 'Done',
    tags: ['project-sync', '12'],
  });
});

test('parseSummary rejects missing summary', () => {
  assert.throws(() => parseSummary('{"title":"Nope","tags":[]}'), /summary/);
});

test('parseSummary recovers JSON wrapped in preamble prose', () => {
  assert.deepEqual(
    parseSummary('Here is the meeting summary you asked for:\n{"title":"T","summary":"Done","tags":[]}'),
    { title: 'T', summary: 'Done', tags: [] },
  );
});

test('parseSummary recovers JSON with trailing prose', () => {
  assert.deepEqual(
    parseSummary('{"title":"T","summary":"Done","tags":[]}\n\nLet me know if you need changes.'),
    { title: 'T', summary: 'Done', tags: [] },
  );
});

test('parseSummary recovery ignores braces inside string values', () => {
  assert.deepEqual(
    parseSummary('noise {"title":"T","summary":"a } b { c","tags":[]} trailing'),
    { title: 'T', summary: 'a } b { c', tags: [] },
  );
});

test('parseSummary still throws when no JSON object is present', () => {
  assert.throws(() => parseSummary('no json here at all'), /JSON/);
});

test('buildNoteName uses YYMMDD and up to five capitalized title words', () => {
  assert.equal(
    buildNoteName({
      title: 'Quarterly Revenue Planning',
      tags: ['sales'],
      summary: 'Team discussed regional goals.',
      createdAt: new Date('2026-06-02T12:00:00.000Z'),
    }),
    '260602_Quarterly_Revenue_Planning',
  );
});

test('buildNoteName uses provided timezone for YYMMDD prefix', () => {
  assert.equal(
    buildNoteName({
      title: 'Late Day Meeting',
      createdAt: new Date('2026-06-02T02:30:00.000Z'),
      timeZone: 'America/Los_Angeles',
    }),
    '260601_Late_Day_Meeting',
  );
});

test('buildNoteName limits note names to five words', () => {
  assert.equal(
    buildNoteName({
      title: 'Quarterly Revenue Planning Follow Up Review',
      tags: ['sales'],
      summary: 'Team discussed regional goals.',
      createdAt: new Date('2026-01-03T12:00:00.000Z'),
    }),
    '260103_Quarterly_Revenue_Planning_Follow_Up',
  );
});

test('buildNoteName falls back when title is empty', () => {
  assert.equal(
    buildNoteName({
      title: '',
      tags: [],
      summary: '',
      createdAt: new Date('2026-01-03T12:00:00.000Z'),
    }),
    '260103_Untitled_Meeting',
  );
});
