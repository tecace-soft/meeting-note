// Memory surface: run the REAL memory fold (computeMemoryFold) on a golden
// prior-memory + transcript, then score the two defects captured from prod on
// 2026-08-11: no-supersede accretion (near-duplicate items) and fact-drift
// (asserting undecided/unsupported claims as current fact).

import { computeMemoryFold } from '../../src/memory.js';
import { judgeDuplicateClusters, judgeForbidden } from '../lib/judge.js';
import type { EvalDeps, MemoryGolden, Metric, SurfaceScore } from '../lib/types.js';

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

  const forbidden = await judgeForbidden(deps, activeTexts, golden.forbiddenAssertions);
  const asserted = forbidden.filter((f) => f.asserted);

  const opsAdd = res.ops.filter((o) => o.op === 'add').length;
  const opsFold = res.ops.filter((o) => o.op === 'update' || o.op === 'supersede').length;
  const opsArchive = res.ops.filter((o) => o.op === 'archive').length;
  const foldShare = res.ops.length ? opsFold / res.ops.length : 1;

  const notes: string[] = [
    `prior active ${res.priorActiveCount} → result active ${active.length} (ops: ${opsAdd} add, ${opsFold} update/supersede, ${opsArchive} archive)`,
  ];
  for (const c of dupClusters) notes.push(`DUP cluster: ${c.map((i) => `"${activeTexts[i]}"`).join(' ↔ ')}`);
  for (const f of asserted) notes.push(`DRIFT: memory asserts "${f.claim}"${f.itemIndex !== null ? ` via item "${activeTexts[f.itemIndex]}"` : ''}`);

  const metrics: Metric[] = [
    { label: 'duplicate items (count, lower better)', value: dedupDefects },
    { label: 'fact-drift assertions (count, lower better)', value: asserted.length },
    { label: 'fold-share of ops (update+supersede)', value: foldShare, detail: `${opsFold}/${res.ops.length}` },
  ];
  return { surface, ran: true, metrics, notes };
}
