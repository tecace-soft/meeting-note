import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTrackingError } from './mcpTracking.js';

test('formatTrackingError shows PostgREST error fields instead of [object Object]', () => {
  const pgError = { code: '22P02', message: 'invalid input syntax for type uuid: "mcp-session-abc"', details: null, hint: null };
  assert.equal(formatTrackingError(pgError), '[22P02] invalid input syntax for type uuid: "mcp-session-abc"');
  assert.equal(
    formatTrackingError({ code: '23502', message: 'null value in column "tool_name" violates not-null constraint', details: 'Failing row contains (...)', hint: '' }),
    '[23502] null value in column "tool_name" violates not-null constraint details: Failing row contains (...)',
  );
});

test('formatTrackingError handles Error instances, unknown objects and primitives', () => {
  assert.equal(formatTrackingError(new Error('boom')), 'boom');
  assert.equal(formatTrackingError({ foo: 1 }), '{"foo":1}');
  assert.equal(formatTrackingError('plain'), 'plain');
});
