# Strangler refactor plan: index.ts and the frontend (2026-10-09)

Companion to [2026-10-09-renovation-review.md](./2026-10-09-renovation-review.md).
The review decided incremental over rewrite; this is the concrete, ordered strangler path for the two god-file clusters (Group A item 5).
No code has been written from this plan yet.

## The seam to copy

The repo already proves the pattern.
`workflow-server/src/index.ts:3380` dispatches the knowledge subsystem in one line: `if (await handleMeetingKnowledgeRequest(req, res, url)) return;`.
`index.ts:3389` does the same for MCP via `handleMcpRequest`.
Each handler has signature `(req, res, url) => Promise<boolean>`, returning true when it owned the route and false to fall through.
Every extracted route group should become a module exporting `handle<Group>Request` and be wired with ONE dispatch line, draining the if-chain at `index.ts:3390-3463`.

## Blocking coupling (why T1-0 must be first)

The ~60 top-level functions close over module-level singletons: `supabase` (`index.ts:274`), `env` (`index.ts:229`), the `HttpError` class (`index.ts:105`), and shared helpers (`sendJson`, `sendNoContent`, `readBody`, `corsHeaders`, `getHttpStatus`, `errorMessage`, `getBearerToken`, `getMicrosoftUserId`, `index.ts:278-654`).
Nothing can be peeled out until these are importable, so the first PR lifts them into their own modules with zero behavior change.

## Sequencing against the in-flight fixes

Two fixes are editing `index.ts` right now (idempotency/duplicate-note and transcript checkpoint).
They touch `insertNote` (`index.ts:1174`), `runSummarizeAudio` (`index.ts:1810`), `transcribeWithAssembly` (`index.ts:1240`), `processSummarizeJob` (`index.ts:2251`), and the `workflow_job` writes.
Therefore the jobs extraction (T1-7) and the pipeline extraction (T1-8) MUST land after those merge.
Everything else can proceed first, rebased on top of them.

## Target 1: strangle workflow-server/src/index.ts (3,593 lines)

| Step | What moves (new module) | Size | Notes |
| --- | --- | --- | --- |
| T1-0 | shared primitives: HTTP helpers + HttpError to `src/http/shared.ts`, `supabase` client to `src/http/supabaseClient.ts` | M | PREREQUISITE, pure move, wide diff |
| T1-1 | transcription-test route (`runTranscriptionTest` 3337 + 3 engine helpers) to `src/routes/transcriptionTest.ts` | M | star: safest first peel, gated to one user |
| T1-2 | ops-agent + issue email/notify to `src/ops/agent.ts`, `src/ops/email.ts`, `src/routes/issues.ts`; keep `raiseIncident` exported (used by the 500 handler) | M | star: isolated, pure-function-rich |
| T1-3 | meeting-briefing route to `src/routes/briefing.ts` | S | star-adjacent, pure coercion helpers |
| T1-4 | project-chat + SSE to `src/routes/projectChat.ts` | M | contains the unverified Group-B #2 leak at `index.ts:2415`; extraction makes it testable, does NOT fix it |
| T1-5 | admin/insight routes to `src/routes/admin.ts` | S | DB-heavy, thin tests |
| T1-6 | regenerate-summary to `src/routes/regenerateSummary.ts`; shared prompt loaders to `src/pipeline/prompts.ts` | M | Group-B #4 territory, extract only |
| T1-7 | in-process job queue to `src/jobs/queue.ts` + `src/routes/jobs.ts` | L | SEQUENCE AFTER the in-flight fixes |
| T1-8 | core transcription/summarize pipeline (split into 2-3 sub-PRs: usage, transcription, summarize+finalize) | L | SEQUENCE LAST, the most coupled, direct target of both in-flight fixes |

End state: the router at `index.ts:3376` becomes about eight dispatch lines, and `index.ts` drops from 3,593 lines to a few hundred lines of bootstrapping.

Test-first for every step: export the moved function and add a colocated `*.test.ts` using the existing `node:test` runner (no new infra), characterizing the pure helpers (status/error parsing, segment recovery, HTML escaping, input parsers) BEFORE the move.

## Target 2: frontend data layer and smaller pages

There is no frontend test runner today, and about 22 `supabase.from('note')` plus 24 `supabase.from('speaker')` call sites are scattered across pages/components with no repository abstraction.
A confirmed correctness bug sits here: `src/pages/Project.tsx:738` updates a note with no `user_id` scope, no `.select()`, and no row-count check, then reports success at line 745, while `src/pages/SummaryHistory.tsx:1799` correctly rejects a 0-row (RLS-blocked) update.

| Step | Goal | Size | Notes |
| --- | --- | --- | --- |
| T2-0 | stand up vitest + testing-library + jsdom, ship one trivial passing test | S | star: prerequisite net |
| T2-1 | `src/data/noteRepository.ts` standardizing the owner-scoped, row-count-checked update; migrate the two edit sites | S | star: smallest PR that fixes the Project.tsx silent-success bug |
| T2-2 | migrate the other note call-sites through the repository, one file per PR | M | |
| T2-3 | `src/data/speakerRepository.ts` + migrate the 24 speaker sites | M | |
| T2-4 | decompose `SummaryHistory.tsx` (largest) into hooks + subcomponents, then the other pages | L | many small PRs, renderHook test before each extraction |

## Recommended starting batch

Three steps, each small, independently shippable, leaving the app working:
1. T2-1 (note repository): smallest PR that fixes a confirmed correctness bug.
2. T1-1 (transcription-test): safest first backend peel (single-user gated).
3. T1-2 (ops/issues): isolated and pure-function-rich.

T2-0 and T1-0 are the prerequisites and can run in parallel before the batch.
The jobs and pipeline extractions (T1-7, T1-8) wait for the in-flight idempotency and checkpoint fixes to merge.
