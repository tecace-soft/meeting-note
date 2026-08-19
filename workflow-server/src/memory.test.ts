import assert from 'node:assert/strict';
import test from 'node:test';
import { applyConsolidation, parseConsolidationOps, type ConsolidationOp, type MemoryItem } from './memory.js';

function item(id: string, text: string, opts: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id, text, entities: opts.entities ?? [], status: opts.status ?? 'active',
    createdAt: 't0', updatedAt: opts.updatedAt ?? 't0', sourceNoteIds: opts.sourceNoteIds ?? [],
  };
}

// ---- parseConsolidationOps ----

test('parseConsolidationOps parses a merge op and drops keepId from dropIds', () => {
  const ops = parseConsolidationOps('{"ops":[{"kind":"merge","keepId":"a","dropIds":["a","b"],"text":"merged","entities":["X"]}]}');
  assert.equal(ops?.length, 1);
  assert.deepEqual(ops?.[0], { kind: 'merge', keepId: 'a', dropIds: ['b'], text: 'merged', entities: ['X'] });
});

test('parseConsolidationOps parses a split op (needs 2+ parts)', () => {
  const ops = parseConsolidationOps('{"ops":[{"kind":"split","id":"c","parts":[{"text":"one","entities":[]},{"text":"two","entities":["Y"]}]}]}');
  assert.equal(ops?.length, 1);
  assert.equal(ops?.[0].kind, 'split');
  assert.equal((ops?.[0] as { parts: unknown[] }).parts.length, 2);
});

test('parseConsolidationOps drops a merge with no dropIds and a split with <2 parts', () => {
  const ops = parseConsolidationOps('{"ops":[{"kind":"merge","keepId":"a","dropIds":[],"text":"x"},{"kind":"split","id":"c","parts":[{"text":"only"}]}]}');
  assert.deepEqual(ops, []);
});

test('parseConsolidationOps strips code fences, accepts a bare array, null for garbage', () => {
  const ops = parseConsolidationOps('```json\n[{"kind":"merge","keepId":"a","dropIds":["b"],"text":"m"}]\n```');
  assert.equal(ops?.length, 1);
  assert.deepEqual(parseConsolidationOps('{"ops":[]}'), []);
  assert.equal(parseConsolidationOps('not json at all'), null);
});

// ---- applyConsolidation: merge ----

test('applyConsolidation merge: survivor keeps keepId with atomic text, losers archived', () => {
  const items = [
    item('a', 'old A', { entities: ['P'], sourceNoteIds: ['n1'] }),
    item('b', 'dup of A', { entities: ['Q'], sourceNoteIds: ['n2'] }),
    item('c', 'unrelated'),
  ];
  const ops: ConsolidationOp[] = [{ kind: 'merge', keepId: 'a', dropIds: ['b'], text: 'merged A', entities: ['R'] }];
  const { items: out, merged } = applyConsolidation(items, ops, 't5');
  assert.equal(merged, 1);
  const a = out.find((i) => i.id === 'a')!;
  assert.equal(a.status, 'active');
  assert.equal(a.text, 'merged A'); // atomic replacement, NOT a concatenation
  assert.deepEqual(a.entities, ['P', 'Q', 'R']); // union
  assert.deepEqual(a.sourceNoteIds, ['n1', 'n2']); // union
  assert.equal(a.updatedAt, 't5');
  assert.equal(out.find((i) => i.id === 'b')!.status, 'archived'); // loser
  assert.equal(out.find((i) => i.id === 'c')!.status, 'active'); // untouched
});

test('applyConsolidation merge: empty text falls back to survivor text', () => {
  const items = [item('a', 'keep me'), item('b', 'dup')];
  const { items: out } = applyConsolidation(items, [{ kind: 'merge', keepId: 'a', dropIds: ['b'], text: '   ', entities: [] }], 't1');
  assert.equal(out.find((i) => i.id === 'a')!.text, 'keep me');
});

test('applyConsolidation merge: ignores missing / archived / already-claimed ids', () => {
  const items = [item('a', 'A'), item('b', 'B'), item('x', 'X', { status: 'archived' })];
  const ops: ConsolidationOp[] = [
    { kind: 'merge', keepId: 'a', dropIds: ['missing'], text: 'm1', entities: [] }, // no valid drop -> skipped
    { kind: 'merge', keepId: 'a', dropIds: ['b'], text: 'm2', entities: [] },       // valid -> merges
    { kind: 'merge', keepId: 'b', dropIds: ['x'], text: 'm3', entities: [] },       // b claimed + x archived -> skipped
  ];
  const { items: out, merged } = applyConsolidation(items, ops, 't2');
  assert.equal(merged, 1);
  assert.equal(out.find((i) => i.id === 'a')!.text, 'm2');
  assert.equal(out.find((i) => i.id === 'b')!.status, 'archived');
  assert.equal(out.find((i) => i.id === 'x')!.status, 'archived');
});

// ---- applyConsolidation: split ----

test('applyConsolidation split: archives the run-on item and adds one atomic item per part', () => {
  const items = [item('a', 'subject one; subject two', { entities: ['P'], sourceNoteIds: ['n1', 'n2'] })];
  const ops: ConsolidationOp[] = [{ kind: 'split', id: 'a', parts: [
    { text: 'Subject one.', entities: ['P'] },
    { text: 'Subject two.', entities: ['Q'] },
  ] }];
  const { items: out, merged } = applyConsolidation(items, ops, 't9');
  assert.equal(merged, 0); // split is not a merge
  assert.equal(out.find((i) => i.id === 'a')!.status, 'archived');
  const active = out.filter((i) => i.status === 'active');
  assert.equal(active.length, 2);
  assert.deepEqual(active.map((i) => i.text).sort(), ['Subject one.', 'Subject two.']);
  for (const it of active) assert.deepEqual(it.sourceNoteIds, ['n1', 'n2']); // parts inherit provenance
});

test('applyConsolidation with no ops is a no-op', () => {
  const items = [item('a', 'A'), item('b', 'B')];
  const { merged } = applyConsolidation(items, [], 't1');
  assert.equal(merged, 0);
  assert.equal(items.every((i) => i.status === 'active'), true);
});
