// Memory surface: run the REAL memory fold (computeMemoryFold) on a golden
// prior-memory + transcript, then score the two defects captured from prod on
// 2026-08-11: no-supersede accretion (near-duplicate items) and fact-drift
// (asserting undecided/unsupported claims as current fact).

import { atomizeRunOns, computeMemoryFold, consolidateMemory, isRunOnText } from '../../src/memory.js';
import { judgeDuplicateClusters, judgeForbidden } from '../lib/judge.js';
import type { EvalDeps, MemoryGolden, Metric, SurfaceScore } from '../lib/types.js';

function dedupDefectCount(clusters: number[][]): number {
  return clusters.filter((c) => c.length > 1).reduce((acc, c) => acc + (c.length - 1), 0);
}

// Run-on / non-atomic count using the SAME detector the fold/GC use (isRunOnText), so the eval
// and the shipped atomization agree. It's a signal the dup/drift judges miss — a unique
// 600-char multi-subject blob scores perfectly on those.
function runOnCount(texts: string[]): number {
  return texts.filter(isRunOnText).length;
}

export async function runMemorySurface(golden: MemoryGolden, deps: EvalDeps): Promise<SurfaceScore> {
  const surface = `memory:${golden.name}`;
  const res = await computeMemoryFold({
    apiKey: deps.geminiApiKey,
    priorMemory: golden.priorMemory,
    transcript: golden.transcript,
    selfName: golden.selfName,
    noteId: golden.noteId ?? null,
    now: deps.now,
  });
  if ('error' in res) {
    return { surface, ran: true, metrics: [{ label: 'fold succeeded', value: 0 }], notes: [`fold FAILED: ${res.error}`] };
  }

  const active = res.items.filter((i) => i.status === 'active');
  const activeTexts = active.map((i) => i.text);

  const clusters = await judgeDuplicateClusters(deps, activeTexts);
  const dupClusters = clusters.filter((c) => c.length > 1);
  const dedupDefects = dupClusters.reduce((acc, c) => acc + (c.length - 1), 0);

  // F1'': run the REAL consolidation pass on the fold output and re-measure. This is the
  // before/after signal for the dedup work — dupes should drop without new fact-drift.
  const consolidated = await consolidateMemory({ apiKey: deps.geminiApiKey, items: res.items, now: deps.now });
  const activeAfter = consolidated.items.filter((i) => i.status === 'active');
  const activeTextsAfter = activeAfter.map((i) => i.text);
  const dedupDefectsAfter = dedupDefectCount(await judgeDuplicateClusters(deps, activeTextsAfter));

  // Fact-drift is scored on the CONSOLIDATED (shipped) output so the merge cannot smuggle
  // in a forbidden assertion unnoticed.
  const forbidden = await judgeForbidden(deps, activeTextsAfter, golden.forbiddenAssertions);
  const asserted = forbidden.filter((f) => f.asserted);

  // Step 4 auto-quality: run-on measurement + the SURGICAL atomize pass. The shipped
  // consolidation above is merge-only (never splits), so it cannot repair run-on blobs. Here we
  // run atomizeRunOns (splits ONLY the flagged run-on items, no free merge/rewrite) and measure
  // whether it (a) cuts run-on items WITHOUT (b) over-fragmenting (active count blowing up) or
  // (c) introducing fact-drift. Contrast with the blunt consolidate({allowSplit}) which
  // regressed clean cases — atomize should leave already-atomic memory flat.
  const runOnFold = runOnCount(activeTexts);
  const runOnMergeOnly = runOnCount(activeTextsAfter);
  const atomized = await atomizeRunOns({ apiKey: deps.geminiApiKey, items: res.items, now: deps.now });
  const activeAtom = atomized.items.filter((i) => i.status === 'active');
  const activeTextsAtom = activeAtom.map((i) => i.text);
  const runOnAtom = runOnCount(activeTextsAtom);
  const driftAtom = (await judgeForbidden(deps, activeTextsAtom, golden.forbiddenAssertions)).filter((f) => f.asserted).length;

  const opsAdd = res.ops.filter((o) => o.op === 'add').length;
  const opsFold = res.ops.filter((o) => o.op === 'update' || o.op === 'supersede').length;
  const opsArchive = res.ops.filter((o) => o.op === 'archive').length;
  const foldShare = res.ops.length ? opsFold / res.ops.length : 1;

  const notes: string[] = [
    `prior active ${res.priorActiveCount} → result active ${active.length} (ops: ${opsAdd} add, ${opsFold} update/supersede, ${opsArchive} archive)`,
    `consolidation: ${consolidated.ran ? `merged ${consolidated.merged} item(s), active ${active.length} → ${activeAfter.length}, dupes ${dedupDefects} → ${dedupDefectsAfter}` : 'skipped (too few items)'}`,
  ];
  for (const c of dupClusters) notes.push(`DUP cluster (pre): ${c.map((i) => `"${activeTexts[i]}"`).join(' ↔ ')}`);
  for (const f of asserted) notes.push(`DRIFT: memory asserts "${f.claim}"${f.itemIndex !== null ? ` via item "${activeTextsAfter[f.itemIndex]}"` : ''}`);

  notes.push(
    `run-on items: fold ${runOnFold} → merge-only ${runOnMergeOnly} → atomize ${runOnAtom} (active ${active.length} → atomize ${activeAtom.length}, ${atomized.atomized} split); atomize drift ${driftAtom}`,
  );

  const metrics: Metric[] = [
    { label: 'duplicate items (count, lower better)', value: dedupDefectsAfter, detail: `pre-consolidation ${dedupDefects}` },
    { label: 'duplicate items pre-consolidation (count)', value: dedupDefects },
    { label: 'items merged by consolidation (count)', value: consolidated.merged },
    { label: 'fact-drift assertions (count, lower better)', value: asserted.length },
    { label: 'fold-share of ops (update+supersede)', value: foldShare, detail: `${opsFold}/${res.ops.length}` },
    // Step 4 auto-quality signals (surgical atomize):
    { label: 'run-on items before atomize (count, lower better)', value: runOnMergeOnly, detail: `fold ${runOnFold}` },
    { label: 'run-on items after atomize (count, lower better)', value: runOnAtom },
    { label: 'active items after atomize (count, over-fragmentation guard)', value: activeAtom.length, detail: `before ${active.length}` },
    { label: 'fact-drift after atomize (count, lower better)', value: driftAtom },
  ];
  return { surface, ran: true, metrics, notes };
}
