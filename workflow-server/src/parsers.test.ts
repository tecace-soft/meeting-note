import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTranscriptText, parseDiarizedSegments, parseSummary } from './parsers.js';

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
