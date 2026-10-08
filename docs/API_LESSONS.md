# API lessons (Gemini)

This file is the accumulating record of hard-won lessons about calling Gemini in this project.
Hand this whole file to a new agent or person before they design a new Gemini call.
Have them check that they are not walking into one of the traps below.

This project calls Gemini over raw `fetch` (there is no `@google/generative-ai` or `@google/genai` SDK dependency).
The only API drift surface is the Gemini model-name strings.
Those strings are pinned in `workflow-server/src/gemini-models.ts` and guarded by an offline drift test in `workflow-server/src/gemini-models.test.ts` (run with `npm test`).

## Lessons

- The `gemini-2.0-*` family was retired and returns 404 (verified 2026-08-18).
  Every fallback chain must end on a live lite model, and dead ids must never reappear (the drift test enforces this).

- Cost policy is lite-only in prod: no non-lite Gemini models (a severe team cost restriction).
  Default and primary paths use `gemini-2.5-flash-lite` or `gemini-3.1-flash-lite`.

- A nested `responseSchema` makes `gemini-3.1-flash-lite` run away to MAX_TOKENS (about 50s, past the 30s abort).
  Dropping the schema yields compact valid JSON in a few seconds (the generate-profile fix, c9a5b34).

- `thinkingConfig.thinkingBudget: 0` is needed to stop thinking tokens from eating `maxOutputTokens` and truncating JSON.
  Some models (for example `gemini-3.5-flash-lite`) reject `0` with a 400, so omit it for those.

- An empty `GEMINI_SUMMARY_MODEL=""` env must use `||` not `??` for the default, or the empty string reaches the API and 404s (prod bug, fixed 361a388).

- `callJsonModel` must retry or fall back on an HTTP-200-but-unparseable body, otherwise about 60% of notes silently get no insight or memory (reliability fix db7345d).

- Model bakeoff finding (2026-08-26): a bigger Gemini model does not improve speaker discriminability, so stay on lite.
  Raw capability was not the lever.

- Where the model registry lives: `workflow-server/src/gemini-models.ts` is the single source of truth, and the drift test is `workflow-server/src/gemini-models.test.ts`.
