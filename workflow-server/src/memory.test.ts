import assert from 'node:assert/strict';
import test from 'node:test';
import { applyConsolidation, parseConsolidationGroups, type ConsolidationGroup, type MemoryItem } from './memory.js';

function item(id: string, text: string, opts: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id, text, entities: opts.entities ?? [], status: opts.status ?? 'active',
    createdAt: 't0', updatedAt: opts.updatedAt ?? 't0', sourceNoteIds: opts.sourceNoteIds ?? [],
  };
}

// ---- parseConsolidationGroups ----

test('parseConsolidationGroups parses groups and drops singletons', () => {
  const g = parseConsolidationGroups('{"groups":[{"ids":["a","b"],"text":"merged","entities":["X"]},{"ids":["c"],"text":"solo"}]}');
  assert.equal(g?.length, 1);
  assert.deepEqual(g?.[0].ids, ['a', 'b']);
  assert.equal(g?.[0].text, 'merged');
});

test('parseConsolidationGroups strips code fences and accepts a bare array', () => {
  const g = parseConsolidationGroups('```json\n[{"ids":["a","b"],"text":"m"}]\n```');
  assert.equal(g?.length, 1);
  assert.deepEqual(g?.[0].ids, ['a', 'b']);
});

test('parseConsolidationGroups returns [] for empty groups, null for garbage', () => {
  assert.deepEqual(parseConsolidationGroups('{"groups":[]}'), []);
  assert.equal(parseConsolidationGroups('not json at all'), null);
});

test('parseConsolidationGroups dedups ids within a group and drops <2 after dedup', () => {
  const g = parseConsolidationGroups('{"groups":[{"ids":["a","a"],"text":"x"},{"ids":["b","c","c"],"text":"y"}]}');
  assert.equal(g?.length, 1); // ["a","a"] collapses to 1 id -> dropped; ["b","c"] kept
  assert.deepEqual(g?.[0].ids, ['b', 'c']);
});

// ---- applyConsolidation ----

test('applyConsolidation merges a group: survivor keeps first id, losers archived', () => {
  const items = [
    item('a', 'old A', { entities: ['P'], sourceNoteIds: ['n1'] }),
    item('b', 'dup of A', { entities: ['Q'], sourceNoteIds: ['n2'] }),
    item('c', 'unrelated'),
  ];
  const groups: ConsolidationGroup[] = [{ ids: ['a', 'b'], text: 'merged A', entities: ['R'] }];
  const { items: out, merged } = applyConsolidation(items, groups, 't5');
  assert.equal(merged, 1);
  const a = out.find((i) => i.id === 'a')!;
  const b = out.find((i) => i.id === 'b')!;
  const c = out.find((i) => i.id === 'c')!;
  assert.equal(a.status, 'active');
  assert.equal(a.text, 'merged A');
  assert.deepEqual(a.entities, ['P', 'Q', 'R']); // union
  assert.deepEqual(a.sourceNoteIds, ['n1', 'n2']); // union
  assert.equal(a.updatedAt, 't5');
  assert.equal(b.status, 'archived'); // loser
  assert.equal(c.status, 'active'); // untouched
});

test('applyConsolidation: empty merged text falls back to survivor text', () => {
  const items = [item('a', 'keep me'), item('b', 'dup')];
  const { items: out } = applyConsolidation(items, [{ ids: ['a', 'b'], text: '   ', entities: [] }], 't1');
  assert.equal(out.find((i) => i.id === 'a')!.text, 'keep me');
});

test('applyConsolidation ignores missing / archived / already-claimed ids', () => {
  const items = [
    item('a', 'A'), item('b', 'B'),
    item('x', 'X', { status: 'archived' }),
  ];
  const groups: ConsolidationGroup[] = [
    { ids: ['a', 'missing'], text: 'm1', entities: [] }, // only 1 valid -> skipped
    { ids: ['a', 'b'], text: 'm2', entities: [] },       // valid -> merges
    { ids: ['b', 'x'], text: 'm3', entities: [] },       // b claimed + x archived -> skipped
  ];
  const { items: out, merged } = applyConsolidation(items, groups, 't2');
  assert.equal(merged, 1);
  assert.equal(out.find((i) => i.id === 'a')!.text, 'm2');
  assert.equal(out.find((i) => i.id === 'b')!.status, 'archived');
  assert.equal(out.find((i) => i.id === 'x')!.status, 'archived'); // stays archived, untouched
});

test('applyConsolidation with no groups is a no-op', () => {
  const items = [item('a', 'A'), item('b', 'B')];
  const { merged } = applyConsolidation(items, [], 't1');
  assert.equal(merged, 0);
  assert.equal(items.every((i) => i.status === 'active'), true);
});
