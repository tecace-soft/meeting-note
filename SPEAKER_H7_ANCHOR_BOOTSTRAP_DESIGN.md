# H7 — Cold-start anchor bootstrap (design)

Status: DESIGN (2026-09-01). Owner: Andrew Yoo.
Follows `SPEAKER_SIGNATURE_DESIGN.md` + `SPEAKER_DISCRIMINABILITY_DESIGN.md`; see memory `speaker-suggestion-feedback-loop`.

## Problem — the cold-start gap

The shipped identifier is strong on **warm** speakers (people with prior labeled history → a TF-IDF signature; ~82% warm) and now de-duplicated per person (defect-1 fix). It is near-blind on **cold-start** people — a participant with NO prior history:

- The signature stage can't build a signature for them → they fall to the LLM.
- The anchor layer (`speakerAnchors.ts`) is **precision-first and roster-gated**: `matchToken` only keeps an extracted name if it resolves to a name ALREADY in the roster/self. So a brand-new person who **introduces themselves** ("제가 Michael입니다" / "this is Michael") is *dropped*, because Michael isn't in the roster yet.

Evidence: boss's "나를 못 찾음" (a participant not surfaced); `eval:speaker-diagnose` shows a real name "Michael Knutsen" **abstained** repeatedly; backtest **excluded arm** (this meeting's people removed from the roster = a cold-start proxy) recall is ~9–25%.

So the exact signal that identifies a first-time person — **they say their own name** — is being thrown away by the roster gate.

## Approach — corroborated anchor bootstrap

Lift the roster gate for NEW names, but only when the name is **corroborated** by more than one anchor, so a one-off common-noun misfire ("저는 담당자입니다") can't become a name. Suggestion-only (never auto-applied; the self-only auto-apply policy is untouched).

Decisions (confirmed with Andrew):
- **Scope = self-introduction + address expansion.** Self-intro is the *assignment* mechanism (a label states its own name → assign that label). Address ("Michael님", "thanks, Michael") is used for *corroboration* and *candidate-pool expansion*, NOT for label assignment by elimination in v1 (too weak: address tells you a person exists and who is NOT them, not which label they are).
- **Guard = cross-corroboration.** A new name is bootstrapped only if it appears in **≥2 independent anchor hits** (e.g. self-intro by label L **and** addressed by another label; or addressed by ≥2 distinct labels; or self-intro across ≥2 distinct turns). Plus a small hard stoplist of obvious role/honorific nouns (담당자/개발자/대표/선생/고객/사장/팀장 …) as a cheap safety net — the backtest's excluded-arm precision is the real gate.

### Mechanism (reuses the existing extract/apply machinery)

1. **Discover corroborated new names** — new function `discoverBootstrapNames(turns, knownNames)`:
   - Re-run the existing self-intro + address regexes, but keep tokens that DO **not** resolve to `knownNames` and DO look like a name (the regex capture groups already constrain to Korean 2–4 syllables / capitalized Latin) and are not in the role-noun stoplist.
   - Tally per candidate name: self-intro hits (with their labels) + address hits (with their labels/turns).
   - A candidate is **corroborated** when total independent hits ≥ 2 (not all the same (label, kind, phrase)).
   - **Assignment**: if a corroborated name has exactly one self-intro label → assign name→label. Ambiguous (multiple self-intro labels) or address-only → the name joins the candidate pool but is not assigned to a label in v1.
   - Returns `{ newNames: string[]; assignment: Map<label, name> }`.

2. **Expand `knownNames` + reuse `applyAnchors`** in `gateSuggestionsWithAnchors`:
   - `knownNames' = roster ∪ self ∪ corroborated newNames`.
   - Re-run `extractAnchors(turns, knownNames')` — now the new names resolve, so their self-intro becomes a positive anchor and their address becomes a negative (veto) anchor, exactly like a roster member.
   - Run `applyAnchors` with a `roster'` that carries a tentative entry `{ speakerId: null, name: newName }` for each new name. Effect **A** (self-intro naming a non-self person) then assigns the new name to its label with `speakerId: null` — the UI already handles "a name not yet in the roster" as a create-on-confirm.
   - Confidence for a bootstrapped new name = **BOOTSTRAP_CONFIRM = 0.8** (below the known-name CONFIRM 0.9: corroborated self-intro is strong, but there is no roster cross-check). New rationale string.

### Safety (by construction)
- **Never touches the self path** — same invariant as today's anchor layer; only non-self outcomes change, and a bootstrapped name is non-self.
- **Suggestion-only** — `speakerId: null`, user confirms to create the speaker. No auto-write, no auto-apply (self-only policy unchanged).
- **Corroboration + stoplist** bound false new-names; pure + deterministic, so unit-tested and it replays identically in the backtest.
- **No new LLM/API call** — same transcript, more regex.

## Where it ships
Both parallel copies (like the defect-1 fix): `workflow-server/src/speakerAnchors.ts` (backtest lib) and the ported copy in `supabase/functions/identify-speakers/index.ts` (prod). Keep behaviorally identical.

## Gate (backtest)
Measure with `eval:speaker-backtest`, lite-pinned:
- **Primary: EXCLUDED arm recall / accuracy UP** (a self-introducing person the roster doesn't know is now recoverable) — this arm is the cold-start proxy.
- **Guard: precision not worse**, especially non-self suggestion precision and **false-name** (a truly-anonymous label must not get a bootstrapped name). Full-arm accuracy must not regress.
- New unit tests in `speakerAnchors.test.ts`: corroborated self-intro of a new name → bootstrapped; single uncorroborated self-intro → NOT bootstrapped; role-noun ("담당자") even if repeated → NOT bootstrapped; self path untouched; a truly-anonymous label stays null.

Ship only if the excluded-arm improves with precision held. If corroboration proves too strict (no lift) or too loose (precision drop), tune the corroboration threshold / stoplist before shipping.

## Out of scope (v1)
- Address-only assignment by process-of-elimination (map an addressed new name to the one remaining unexplained label). Revisit if the excluded-arm lift is small and diagnosis shows many address-only cold-start cases.
- H8 (org/role ontology) — a separate, larger lever.
