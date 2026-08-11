# F8 evaluation harness

A repeatable, measurable check for the memory + indexing quality the 2026-08-11 meeting made the gating discipline: state a hypothesis, then verify it against this eval before/after a change.

It runs the **real production producers** (not copies): `extractInsight` and `computeMemoryFold` from `src/memory.ts`, and the `search_notes` RPC. So a green eval means the shipped code is good, not that a reimplementation is.

## Run

```bash
cd workflow-server
npm run eval           # runs all surfaces against eval/golden/*
npm run typecheck:eval # type-check the harness
```

Requires `GEMINI_API_KEY` in `workflow-server/.env` (insight + memory surfaces call Gemini; the judge does too). The search surface additionally needs a real `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; with local placeholders it **skips** (loudly, never silently). To score search, run with prod Supabase creds in the environment.

Env knobs: `EVAL_JUDGE_MODEL` (default `gemini-2.5-flash`), `EVAL_NOW` (fixed clock for reproducible memory folds).

## Scoring (hybrid — deterministic + LLM judge)

- **insight** — per-field precision/recall/F1 vs a hand-labeled golden. `actions`, `decisions`, `topics` are matched **semantically** by an LLM judge (paraphrase/Korean↔English OK); `people`, `companies` are matched **deterministically** (names are exact-ish). A hard extraction failure (the `c88ee76` runaway-truncation bug) scores 0.
- **memory** — folds a seeded prior memory + the meeting transcript, then scores the two defects captured from prod on 2026-08-11:
  - `duplicate items (count, lower better)` — near-duplicate active items the judge clusters by subject (no-supersede accretion).
  - `fact-drift assertions (count, lower better)` — result items that assert a `forbiddenAssertion` (something undecided/unsupported in the transcript) as current fact.
  - `fold-share of ops` — share of ops that are update/supersede vs add (higher = folding, not accreting).
- **search** — `MRR`, `recall@5`, `recall@10` for `query → expected note` pairs.

Each run prints a table and writes a JSON snapshot to `eval/results/` so two runs can be diffed (the before/after signal).

## Golden set

`eval/golden/{insight,memory,search}/*.json`. Ground truth is hand-authored (see the type definitions in `lib/types.ts`). The first case is the 2026-08-11 morning meeting, which reproduced both memory defects in prod. Add 2-3 more real meetings for a fuller signal — drop a JSON file in the right folder and it is picked up automatically (bounded at 20 per surface).

## Not yet

v1 measures; it does not gate. Promote to a CI threshold (fail the build when macro-F1 drops or defect counts rise) once the golden set is a few meetings deep. See `OPS_BACKLOG.md` F8.
