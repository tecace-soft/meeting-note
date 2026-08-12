// Speaker-ID surface (F5): run the REAL identifySpeakers producer on a generic-labeled
// transcript + roster, apply the same >=0.8 auto-apply rule the ingest pipeline uses, and
// score the applied identities against ground truth. Precision is the safety metric (a
// wrong auto-apply corrupts the diarization); recall shows how much context alone resolves
// (expected to rise as the roster/memory grow — the boss's accumulation hypothesis).

import { identifySpeakers } from '../../src/memory.js';
import { containsMatch } from '../lib/scoring.js';
import type { EvalDeps, SpeakerIdGolden, SurfaceScore } from '../lib/types.js';

const AUTO_APPLY_CONFIDENCE = 0.8; // must match index.ts AUTO_IDENTIFY_CONFIDENCE

export async function runSpeakerIdSurface(golden: SpeakerIdGolden, deps: EvalDeps): Promise<SurfaceScore> {
  const surface = `speaker-id:${golden.name}`;
  const res = await identifySpeakers({
    apiKey: deps.geminiApiKey,
    transcript: golden.transcript,
    labels: golden.labels,
    roster: golden.roster,
    selfName: golden.selfName ?? null,
  });
  if ('error' in res) {
    return { surface, ran: true, metrics: [{ label: 'identification succeeded', value: 0 }], notes: [`identify FAILED: ${res.error}`] };
  }

  const byLabel = new Map(res.suggestions.map((s) => [s.label, s]));
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const details: string[] = [];
  for (const exp of golden.expected) {
    const s = byLabel.get(exp.label);
    // Applied name = what the ingest rule would write (>=threshold, self resolves to selfName).
    const applied = s && s.confidence >= AUTO_APPLY_CONFIDENCE
      ? (s.isSelf && golden.selfName ? golden.selfName : s.name)
      : null;
    const expected = exp.name;
    let mark: string;
    if (applied && expected && containsMatch(expected, applied)) { tp += 1; mark = 'correct-apply'; }
    else if (applied) { fp += 1; mark = 'WRONG-apply'; }
    else if (expected) { fn += 1; mark = 'missed (abstained)'; }
    else { tn += 1; mark = 'correct-abstain'; }
    details.push(`${exp.label}: applied=${JSON.stringify(applied)} expected=${JSON.stringify(expected)} conf=${s?.confidence ?? '-'} → ${mark}`);
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 1; // no wrong applies when nothing applied
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const accuracy = golden.expected.length > 0 ? (tp + tn) / golden.expected.length : 0;

  return {
    surface,
    ran: true,
    metrics: [
      { label: 'accuracy (labels correct)', value: accuracy, detail: `${tp + tn}/${golden.expected.length}` },
      { label: 'auto-apply precision', value: precision, detail: `applied ${tp + fp}, correct ${tp}` },
      { label: 'auto-apply recall', value: recall, detail: `tp${tp} fp${fp} fn${fn} tn${tn}` },
    ],
    notes: details,
  };
}
