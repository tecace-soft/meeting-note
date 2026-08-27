# Speaker-ID Signature Identifier — Design

Status: PLAN (2026-08-27).
Owner: Andrew Yoo.
Relates to: `SPEAKER_DISCRIMINABILITY_DESIGN.md` (anchor layer, shipped), `eval/speaker-signature-probe.ts` (ceiling), F5.

## 1. Why (measured)

Within-roster confusion is the root cause of low speaker-ID accuracy, and it is NOT a coverage / data / model / prompt problem (all four ruled out by measurement).
The shipped anchor layer made confidence HONEST (confident-wrong 45 → 0) but did not raise correctness, because explicit naming events (self-intro / vocative) are rare in recurring-team meetings.

The signature ceiling probe (`eval:speaker-signature`, TF-IDF, no LLM, leave-one-meeting-out) proved the real lever:

| approach | accuracy |
| --- | --- |
| random-within-set chance | 30.9% |
| current LLM identify | ~37% |
| signature closed-set | 66.0% |
| signature closed-set, warm (speaker has history) | **77.5%** |
| signature open-set (whole roster) | 61.7% |
| signature open-set, warm | 72.5% |

Root insight: identify fails because it matches each person's ROLE-SUMMARY profile (everyone on a small team looks the same), while a signature matches each person's ACTUAL past language (their distinctive projects / phrasing = a TEXT voiceprint).
Open-set ≈ closed-set, so an attendee list is not required (fits the minimize-input direction).

## 2. Decisions locked

- **Where signatures are computed:** ON-THE-FLY in the `identify-speakers` edge function. It gains a service-role Supabase client, reads the user's recent labeled notes at suggest time, and builds signatures in memory. No migration, always fresh, keeps the always-on availability. (A stored `speaker.signature` column is the later optimization once this is validated.)
- **Combination with the LLM:** SIGNATURE-PRIMARY, LLM FALLBACK. A confident signature match wins; the LLM identify is used only for cold-start (a person with no history) or a weak/ambiguous signal.
- **Representation:** TF-IDF bag-of-words cosine for v1 (zero cost, deterministic, already proven at 77.5%). Embeddings are a future lever only if a measured plateau demands it.

## 3. Architecture and flow

Client contract is unchanged: it still POSTs `{ transcriptText, labels, roster, selfName }` to `identify-speakers`.
The edge function does more work:

1. Auth (unchanged).
2. Build corpora: with a service-role Supabase client, load the user's most recent labeled notes (bounded, `SIG_MAX_NOTES` ≈ 60), and for each roster person aggregate their utterances from `note.diarization`, keyed by a canonical (parenthetical-stripped) name. EXCLUDE the note currently being suggested (`noteId`, when the client sends it) so a re-suggest never reads its own partial labels.
3. Signature match: for each anonymous label, build its utterance vector from `transcriptText`, cosine-match (TF-IDF, per-user IDF) against every roster person's signature (open-set). Rank; take top1 and the margin `top1 − top2`.
4. Decide per label:
   - WARM + STRONG (top1 person has history, `top1 ≥ T_score` and `margin ≥ T_margin`): signature suggestion — `{ name, speakerId, confidence, isSelf }`, and emit a synthetic `signature` POSITIVE anchor for it (see §5).
   - else: mark the label for LLM FALLBACK.
5. LLM identify (only if any label needs fallback, or roster is empty): one Gemini call as today, producing suggestions for the fallback labels (self detection, new-name, cold-start).
6. Merge signature-decided + LLM-decided suggestions into one list (one per label).
7. Anchor gate: run the existing anchor layer over the merged list. The `signature` positive anchor makes a strong signature pick evidence-backed, so the CAP does not lower it and it can show at high confidence; every unanchored non-self pick is still capped ≤ 0.6.
8. Invariants: at most one `isSelf`; self-consistency (isSelf ⟺ name is self). Resolve a signature/LLM disagreement on self toward the single best.
9. Return `{ suggestions }` (same shape).

Skipping the LLM entirely when every label is confidently signature-matched saves the Gemini call (cheaper, faster) — a bonus, not the goal.

## 4. The pure module (shared by edge fn + backtest)

`workflow-server/src/speakerSignature.ts` (pure, deterministic, unit-tested; NO I/O):

- `tokenize(text)` — Korean runs (≥2) + Latin words (≥2); drops 1-char noise and digits. Same as the probe.
- `buildCorpora(notesLabeledSegments)` — person-key → term lists, from segments the CALLER already loaded (the edge fn from the DB, the backtest from its cases). Keeps the module I/O-free (Power-of-Ten rule 1).
- `computeIdf(corpora)` — per-user IDF from per-person documents.
- `signatureFor(personKey, excludeNoteId, corpora)` — TF over that person's utterances in other notes.
- `matchLabel(labelText, corpora, idf, excludeNoteId, opts)` — returns ranked `{ personKey, score }[]` + `warm` flags.
- `decideSuggestions(labels, matches, roster, selfName, opts)` — applies the WARM+STRONG rule and the confidence mapping, returns `{ signatureSuggestions, fallbackLabels }`.

The edge function PORTS this module (like the anchor layer) and adds only the DB read; the backtest imports it directly.
This keeps the shipped path and the measured path identical.

## 5. Confidence, and the anchor-layer interaction

Confidence from the match must be HONEST (the UI dims non-self < 0.7, and the anchor CAP holds non-self picks with no evidence at ≤ 0.6):

- `confidence = f(top1, margin)` — monotonic in both, calibrated on the backtest so a high bucket is actually accurate. Start simple: `conf = clamp01(top1_normalized * marginBoost)`, then tune `T_score` / `T_margin` / the mapping against the calibration table.
- A strong signature pick is EVIDENCE, so it is emitted as a new anchor kind `signature` (positive) that `applyAnchors` treats like a self-introduction: it is exempt from the CAP and may exceed 0.7, so the UI shows it normally. A WEAK signature match is NOT promoted, falls through to the CAP, and shows dimmed — exactly the honest-confidence behavior already shipped.
- Net: only signature picks the backtest shows to be reliable are allowed to appear confident; everything else stays tentative. This preserves the confident-wrong = 0 guarantee.

## 6. Cold-start and edge cases

- A roster person with no prior labeled note has no signature → never a signature suggestion; the LLM handles them.
- A brand-new person not in the roster → LLM new-name path (unchanged).
- A person whose history is tiny (below `MIN_SIG_TOKENS`) is treated as cold (weak signature is unreliable).
- Over-segmentation (one person split across labels within a note) does not hurt signatures: history is keyed by NAME across notes, so it aggregates regardless of per-note label splits.
- The self has a signature too (they are labeled in their own meetings), so signature matching can pick the self; the isSelf flag is set when the matched person is the self, and the self-only invariants still apply.

## 7. Bounds (Power of Ten)

- `SIG_MAX_NOTES` (≈60) caps notes loaded; `SIG_MAX_CORPUS_TOKENS` per person caps memory; `MAX_LABELS` unchanged.
- The DB read has a timeout and a failure path: on any error, fall back to the current LLM-only behavior (never fail the suggestion).
- All matching is bounded loops over labels × roster; no recursion; deterministic.

## 8. Metric and gate

Extend `eval/speaker-backtest.ts` with a SIGNATURE arm: build corpora from each user's cases (leave-one-meeting-out, already available), run the integrated identifier (signature-primary → LLM fallback → anchors), and compare to the current baseline (LLM + anchors).

Gate to ship (paired, RUNS ≥ 3, full + excluded arms):
1. Accuracy beats the current ~37% baseline MATERIALLY (target: approach the probe's warm ceiling).
2. Calibration honest: high-confidence signature picks are actually accurate (confident-wrong stays ~0).
3. Self recall not regressed.
A fail is reverted, exactly as the 2026-08-25 recalibration was.

## 9. Rollout

1. Build `speakerSignature.ts` (pure) + unit tests.
2. Extend the backtest with the signature arm; run the gated A/B.
3. If the gate passes: add the service-role DB read + port the module into `identify-speakers`, deploy the edge function.
4. UI needs NO change — it already dims low-confidence and shows high-confidence normally; the honest confidence now carries a real signal. Mobile likewise (same suggestion shape) — no APK needed.
5. Log via the existing suggestion feedback loop so live regressions surface.

## 10. Open questions (revisit after the backtest)

- Exact `T_score` / `T_margin` and the confidence mapping — set them from the calibration table, not by guess.
- Whether to move to a stored `speaker.signature` column for latency once validated (only if the on-the-fly DB read proves too slow at suggest time).
- Whether embeddings beat TF-IDF enough to justify the cost — measure only if TF-IDF plateaus below target.
