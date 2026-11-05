import assert from 'node:assert/strict';
import test from 'node:test';
import { runPool, selectBackfillCandidates } from './backfill.js';

test('selectBackfillCandidates keeps order, skips processed notes, reports remaining', () => {
  const ids = ['n5', 'n4', 'n3', 'n2', 'n1'];
  assert.deepEqual(selectBackfillCandidates(ids, new Set(['n4', 'n2']), 2), { batch: ['n5', 'n3'], remaining: 1 });
  assert.deepEqual(selectBackfillCandidates(ids, new Set(ids), 10), { batch: [], remaining: 0 });
  assert.deepEqual(selectBackfillCandidates([], new Set(), 10), { batch: [], remaining: 0 });
});

test('runPool bounds concurrency and preserves result order', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await runPool([5, 1, 4, 2, 3], 3, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, n * 5));
    inFlight -= 1;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
  assert.deepEqual(await runPool([], 3, async (n: number) => n), []);
});
