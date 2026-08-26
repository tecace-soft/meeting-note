# Speaker-ID Discriminability — Design (evidence-anchored suggestion gating)

Status: PLAN (2026-08-26).
Owner: Andrew Yoo.
Relates to: F5 (`F5_SPEAKER_ID_DESIGN.md`), the speaker-suggestion feedback loop + backtest (`eval/speaker-backtest.ts`), the wrong-self fix (`bff15f1`).

## 1. Problem

Text-only speaker identification confidently picks the WRONG same-team member.
It is not a coverage, data-quantity, or model-size problem: all three were measured and ruled out.

Measured evidence (backtest, `eval:speaker-backtest`, and `eval:speaker-diagnose`, 2026-08-24 → 26):
- Aggregate full-roster accuracy sits at ~37% and does not move with more notes (37.9% at 12 notes → 37.3% at 30).
- The failure is CONFUSION, not abstention: for the best-covered user (Andrew, 0% roster gap, 83% rich profiles) 46% of labels are a confidently-wrong REAL name, and 100% of those confusions are OTHER ROSTER MEMBERS, mostly at 0.90 confidence.
- Model bakeoff (2026-08-26): a bigger model raises in-roster recall but NOT discriminability — excluded-arm precision stays 11-22% and high-confidence non-self stays 27-63% right across `gemini-2.5-flash-lite` / `3.5-flash-lite` / `3.5-flash`. Decision: stay on `gemini-2.5-flash-lite`.

Root cause: in a small team everyone discusses the same topics and holds similar roles, so the profile summaries are not DISCRIMINATIVE.
The model resolves the ambiguity by guessing, and reports that guess at high confidence.

## 2. Why prompting alone does not fix it (already tried)

The identify system prompt ALREADY instructs the model to treat direct-address / self-introduction as the strongest signal and to drop to <=0.5 confidence when it cannot tell which label is which (`IDENTIFY_SYSTEM_PROMPT`, `workflow-server/src/memory.ts`).
A dedicated self/non-self asymmetric confidence recalibration was written and A/B-tested at RUNS=3 on 2026-08-25, and REVERTED because no variant beat the deployed baseline.
The model does not reliably self-gate: it rationalizes a confident pick from role/topic overlap regardless of the instruction.

Conclusion: the gate must live in CODE (deterministic), not in the prompt.

## 3. Goal and non-goals

Goal (this iteration): SUGGESTION QUALITY ONLY.
- Raise the precision of the top suggestion the user is shown.
- Make confidence HONEST, so a pick with no concrete evidence can never be shown as high-confidence.

Non-goals (explicitly out of scope this iteration):
- No change to auto-apply. Non-self is already never auto-applied (self-only policy, and the multi-speaker self auto-apply was removed in `bff15f1`), so a wrong suggestion never corrupts a note. That safety is a given, not a target here.
- No extra LLM call (severe lite-only cost cap).
- No new model, no fine-tuning (impossible on hosted Gemini; the bakeoff settled the model choice).
- Over-segmentation (one person split into several labels) is a separate, secondary contributor and is not addressed here.

## 4. Approach: a deterministic evidence-anchor layer over the single identify call

Keep the existing one Gemini identify call exactly as is.
Add a pure, deterministic POST-PROCESSING layer that extracts textual ANCHORS from the transcript we already have, then reshapes each suggestion's name/confidence against those anchors.
No additional model call; runs in the same process right after `parseSuggestions`.

The layer does three things, in order of the evidence it has:

1. VETO a suggestion that a concrete anchor CONTRADICTS.
2. BOOST / OVERRIDE a suggestion that a concrete anchor CONFIRMS.
3. CAP the confidence of a suggestion that has NO concrete anchor (pure role/topic inference), so it is shown as tentative, never confident.

Rule 3 is the core fix: it makes "confident and wrong" structurally impossible, because high confidence now REQUIRES a concrete textual anchor that the code verified.

## 5. Anchor taxonomy

An anchor is a deterministic, high-precision textual signal tying an anonymous label to a name (positive) or excluding one (negative).
Precision over recall: it is fine for a note to have zero anchors (then rule 3 just caps everyone and the list is honestly tentative); a WRONG anchor is the only real harm, so patterns are chosen to almost never fire wrongly.

Anchor types (KO + EN):

- SELF-INTRODUCTION (strong POSITIVE, label = name).
  The speaker of a segment states their own name.
  EN: `I'm <Name>`, `this is <Name>`, `<Name> here`, `my name is <Name>`.
  KO: `제가 <Name>(이에)요/입니다`, `저는 <Name>입니다`, `<Name>입니다` at turn start.
  Bind the name to the SPEAKER of that segment.

- DIRECT-ADDRESS / VOCATIVE (strong NEGATIVE + weak POSITIVE on the responder).
  A speaker addresses someone by name.
  EN: `Thanks, <Name>`, `<Name>, can you ...`, `over to you <Name>`.
  KO: `<Name>님`, `<Name>씨`, `<Name>아/야`.
  NEGATIVE: the speaker of that segment is NOT `<Name>` (you do not address yourself).
  Weak POSITIVE: the person who answers the address (next distinct speaker responding to the request) is LIKELY `<Name>` — used only to confirm, never alone to override.

- REFERENCE / THIRD-PERSON MENTION (NEGATIVE only).
  A speaker refers to `<Name>` in the third person (`<Name> said`, `<Name> is going to`, `<Name>가 했어요`).
  NEGATIVE: the speaker of that segment is probably not `<Name>` (people rarely narrate themselves in the third person). Lower precision, so NEGATIVE-only and weighted below vocative.

Name matching against the roster + selfName uses the existing `normalizeSpeakerName` (strips parenthetical script variants) and `containsMatch`, so `한수` matches `Hansoo Lee` / `이한수` where the roster ties them.
Only names present in the roster or the selfName are eligible anchors; a bare first name that matches no known person is ignored (avoids inventing identities).

## 6. Application rules (deterministic, applied per label after parse)

Inputs: the model `suggestions[]`, the anchor set derived from the transcript, the roster, `selfName`.
For each suggestion `s` for label `L` with model name `N` and confidence `c`:

- If a NEGATIVE anchor says `L` is not `N` (and no stronger positive anchor says otherwise): VETO.
  Set the name to the best anchor-consistent roster name if one exists, else null; cap confidence <= 0.35 (tentative/abstain). This kills the "confident wrong teammate" case directly.
- Else if a POSITIVE self-introduction anchor says `L` is `M`:
  If `N == M`, BOOST (c = max(c, 0.9)). If `N != M`, OVERRIDE to `M` at 0.9 (self-intro outranks the model). Set `isSelf` iff `M` is the self, preserving the existing SELF-CONSISTENCY invariant.
- Else (no concrete anchor for `L`): CAP.
  If `s` is non-self, cap c <= 0.6 so it is shown as a suggestion, never auto-apply-eligible and never displayed as "confident".
  Leave self as is (the self prior is legitimately strong and is handled by the existing self-only path).

Ordering: NEGATIVE veto is evaluated before POSITIVE boost so a contradicted self-intro (rare) does not both override and get vetoed; ties resolve to the lower confidence (favor caution).
The layer never invents a speakerId not in the roster and never echoes an anonymous label as a name (existing `parseSuggestions` guards stay in front of it).

## 7. Where it lives

- New pure module `workflow-server/src/speakerAnchors.ts`: `extractAnchors(segments)` and `applyAnchors(suggestions, anchors, roster, selfName)`, both pure and unit-testable (Power-of-Ten rule 9: deterministic, no I/O).
- Wired in `identifySpeakers` (`workflow-server/src/memory.ts`) right after `parseSuggestions`.
- MIRRORED in the web-UI copy `supabase/functions/identify-speakers/index.ts` (the two must stay behaviorally identical, per the existing sync note). The anchor logic is plain string work, so the port is mechanical.
- The transcript the layer reads is the SAME anonymized `speakerKey`-labelled transcript the model saw, so anchors are computed against the exact input, and the backtest replays it faithfully.

## 8. Metric and gate

Add a SUGGESTION-QUALITY view to `eval/speaker-backtest.ts` (the auto-apply policy table stays; it is now secondary because auto-apply is self-only):
- Top-suggestion precision: of labels where a non-self name is SHOWN at or above a display floor, the fraction correct.
- Honest-calibration: the existing per-confidence-bucket accuracy table, but the target becomes "high buckets are actually high" rather than raw accuracy.
- Confident-wrong count: non-self suggestions at >=0.8 that are wrong. This is the number the design must drive DOWN; it is the quantified form of the boss's garbage-suggestion complaint.

Gate to ship (measured A/B: anchors OFF vs ON, same notes, RUNS>=3):
1. Confident-wrong (non-self >=0.8, wrong) drops materially.
2. Top-suggestion precision rises or holds.
3. SELF recall does not regress (the self path must be untouched).
An A/B that fails any of these is reverted, exactly as the 2026-08-25 recalibration was.

## 9. Risks and limits

- KO/EN pattern brittleness: vocative/self-intro phrasing varies. Mitigation: precision-first patterns, unit tests over real transcript snippets, and rule 3 as the safe default when no anchor fires (the system degrades to today's behavior, capped, not worse).
- Vocative → responder mapping is ambiguous in cross-talk; that is why the responder positive is weak-only and never overrides alone.
- Diarization over-segmentation splits one speaker across labels, which can scatter a single person's self-intro; anchors help per-label but do not merge labels (out of scope).
- If deterministic rules plateau below the gate, the fallback is method C from the 2026-08-26 decision: a dedicated evidence-extraction LLM pass (accepted cost) — deferred until rules are shown insufficient.

## 10. Next steps

1. Build `speakerAnchors.ts` (extract + apply) with unit tests on real KO/EN snippets.
2. Add the suggestion-quality metric + anchors OFF/ON toggle to `eval/speaker-backtest.ts`.
3. Run the gated A/B (RUNS>=3, both arms); keep only if the gate passes.
4. If it passes: wire into `memory.ts`, mirror into the edge function, redeploy, keep the two prompts/layers in sync.
5. Log via the existing suggestion feedback loop so live regressions are caught.
