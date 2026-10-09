# Full-project review: rewrite vs incremental (2026-10-09)

Purpose: decide whether the "renovation" (full demolition and rebuild) floated in the 2026-10-08 meeting is justified, or whether incremental / strangler refactoring is the better path.
This document is the input to that decision, plus the prioritized action list that came out of it.

## Method

Two independent reviews were run and cross-checked.
One was Claude, as four parallel read-only agents, each on a single lens: architecture and maintainability, reliability and data integrity, security and tenant isolation, code quality and tests.
The other was ChatGPT Codex (sol model), reviewing the whole repo on the same lenses with the same output contract.
Each finding is tagged `incremental-fixable` (a targeted PR closes it) or `structural` (argues the design itself needs rework).

## Verdict

All five review perspectives (four Claude lenses plus Codex) independently concluded the same thing: a full rewrite is NOT justified, and incremental / strangler refactoring is the right path.

The decisive evidence against a rewrite:
- The newest subsystems (`workflow-server/src/knowledge/`, `workflow-server/src/mcp/`) are cleanly modular and well tested, and are attached to the legacy core through a single dispatch line each (`index.ts:3380`, `index.ts:3389`), which is a working strangler-fig seam already running in production.
- The foundations are sound: Supabase schema with owner-scoped RLS, MSAL auth, and a transcribe/summarize pipeline that already carries heartbeats, orphan-job sweeps, idempotency, bounded retries, and dual-layer recording backup.
- Every Critical item from the standing reliability audit (C1 through C9) was already closed in place, without a rewrite.
- Code hygiene is good: `strict: true`, zero `as any`, zero TODO/FIXME, and 529 backend tests that run green in about 7 seconds with no network dependency.

A rewrite would discard this hard-won edge-case handling and re-expose failure classes that are already fixed.
The rot that exists is real but concentrated and mechanical: a couple of god-files and some duplicated wrappers, all extractable in place.

## Cross-validation

### Group A: flagged by BOTH reviews (high confidence, actionable)

| Item | Claude | Codex | Nature |
| --- | --- | --- | --- |
| `meeting-recordings` storage bucket RLS has no owner-scoping (any authenticated user can list/download/overwrite/delete any user's raw audio) | security S1 (verified directly) | #1 High | incremental, TOP priority |
| Recorder prefers partial persisted chunks over complete in-memory chunks, so a cleanly stopped recording can be truncated | reliability #3, #4 | #5 High | incremental |
| Pipeline is process-bound with no mid-transcript checkpoint, so a restart cannot resume (paid transcript discarded) | reliability #5 | #6 structural | incremental (see disagreement) |
| `workflow-server/src/index.ts` is a 3,593-line god-file (router + AI pipeline + job queue + MCP/knowledge host) | architecture + code-quality High | #7 structural | incremental (strangler) |
| No frontend data layer; per-page note-mutation logic duplicated with divergent success detection | architecture | #8 structural | incremental |
| Idempotency is check-then-insert and completion is not atomic, so terminal-write failure can cause a duplicate note and double billing | reliability #1 | #9 Med | incremental |

### Group B: flagged by CODEX ONLY (not verified yet, high value)

These are claims from one reviewer and must be verified in code before any action.

| Item | File refs (from Codex) | Nature |
| --- | --- | --- |
| #2 Project chat passes ALL notes in a project to the model on project-access alone, so a participant can read, via a question, note content that was never shared to them | `workflow-server/src/index.ts:2415`, `supabase/migrations/20260630124500_fix_project_uuid_note_and_chat_fk.sql:32` | High, incremental |
| #4 When a share recipient re-summarizes a note, memory/index are updated under the requester identity, and `note_insight` overwrites `user_id` on note_id conflict, so the original owner can lose the index under RLS | `workflow-server/src/index.ts:2622`, `workflow-server/src/memory.ts:550` | High, incremental |
| #3 Memory fold ignores read errors and overwrites the whole row, and concurrent folds have no version check, so existing memory can be lost | `workflow-server/src/memory.ts:1210`, `:1244` | High, incremental |
| #10 Edge functions' Microsoft Graph fallback auth does not enforce the tenant/email allowlist that token-exchange does, so a valid Graph token from outside the org can burn the org's Gemini spend | `supabase/functions/generate-profile/index.ts:720`, `supabase/functions/identify-speakers/index.ts:698` | Med, incremental |

### Group C: flagged by CLAUDE ONLY (not in Codex)

| Item | Lens | Note |
| --- | --- | --- |
| Mobile app-kill mid-m4a recording is unrecoverable and the partial file is silently deleted | reliability #2 | genuine data loss; the real mechanism behind the vaguely-reported "recording data loss" |
| Frontend has zero tests; no CI gates the 529 backend tests or lint; `--max-warnings 0` lint currently fails with 51 errors | code-quality | cheap, high-leverage safety net |
| Three parallel Gemini-call wrappers with divergent retry/parse policy; edge functions are an unguarded model-drift surface | code-quality + architecture | consolidate onto the 2026-10-08 registry |
| Duplicate `mcp_tracking` migrations with conflicting table definitions | architecture | schema-ledger drift |

Note on the phantom "recording cutoff / data loss": the felt symptom is best explained by (a) the 2-hour hard recording cap that auto-stops capture (by design, not a bug) and (b) Group C's mobile app-kill deletion (the real loss path), which is why it was never reproducible on demand.

## Notable disagreements

- Pipeline checkpoint (Group A, row 3): Codex rates it `structural` (redesign the job-execution model), Claude rates it `incremental-fixable`.
  Assessment: incremental is correct.
  The raw audio is safe in Supabase Storage, so the only thing lost on a restart is the paid transcript (a cost and latency hit), which one checkpoint (persist segments keyed by noteId, skip re-transcription on retry) closes without redesigning anything.
- Recorder truncation (Group A, row 2): Codex rates it High, Claude rates it Low-to-Med.
  Assessment: the trigger (a fire-and-forget final chunk save racing `onstop`) is narrow, so Med is fair, but the fix is cheap (await the final save, or pick whichever source is longer).

## Prioritized action list

1. Fix the `meeting-recordings` bucket RLS (owner-scope the four policies). Confirmed by both reviews and verified directly. Security plus data-loss, independent of everything else.
2. Verify and then fix Codex #2 and #4 (project-chat note leak, re-summarize index-ownership takeover). If real, these are S1-level.
3. Mobile app-kill deletion (true data loss) and the duplicate-note / double-billing path.
4. Stand up CI running the existing 529 tests plus lint.
5. Strangle `index.ts` route-by-route and extract the frontend data layer, adding tests at each seam. Gemini-wrapper consolidation and the duplicate-migration cleanup ride along.

## Status tracker

Updated as work proceeds.

| # | Item | Status |
| --- | --- | --- |
| 1 | audio bucket RLS fix | DONE 2026-10-09: migration `20261009120000_scope_meeting_recordings_rls.sql`, owner-scoped via `storage.objects.owner_id = auth.jwt()->>'sub'`. APPLIED to prod + verified (owner_sees=94, stranger_sees=0, real app upload OK). INSERT policy left bucket-only (owner_id assigned at insert, documented residual). NOTE: the first-shipped `file`-join SELECT policy BROKE uploads (confirm-before-record poll has no file row yet); replaced with owner_id. |
| A | recorder truncation / silent-drop fix | IMPLEMENTED (local) 2026-10-09: `src/context/RecorderContext.tsx`, picks the more-complete chunk source + surfaces an error on genuine empty-both. tsc clean. NOT committed. |
| A | idempotency / duplicate-note + transcript checkpoint | IMPLEMENTED (local) 2026-10-09: `workflow-server/src/index.ts` (upsert on note.id, orphan-sweep convergence, transcript checkpoint) + new migration `20261009120100_reliability_transcript_checkpoint_and_active_job_uniq.sql`. Build + 529 tests green. NOT committed, migration NOT applied. Client follow-up pending (web reuses noteId on retry, `src/pages/TranscriptionSummary.tsx:1234`). |
| 5 | index.ts strangle + frontend data layer | PLANNED 2026-10-09: see [2026-10-09-strangler-plan.md](./2026-10-09-strangler-plan.md). Start batch T2-1 + T1-1 + T1-2 (after T2-0/T1-0). Jobs/pipeline extractions wait for the two reliability fixes to merge. |
| B | Codex-only #2 / #3 / #4 / #10 | FIXED 2026-10-09 (code committed; see commits). #3: `foldNoteIntoMemory` now aborts on a user_memory read error and serializes folds per user in-process (memory.ts). #4: regenerate attributes the fold/insight to `note.user_id` not the requester (index.ts), and `writeNoteInsight` update-then-insert never flips an existing row's owner (memory.ts). #10: shared `_shared/msGraphAllowlist.ts` enforces the tenant/domain allowlist on the Graph fallback of generate-profile + identify-speakers, and supabase-token delegates to it (edge fns need a deploy). #2: project-chat restricts fed notes via the MCP `noteAccessFilterFor` so only caller-visible notes reach the model (index.ts + mcp/lib/supabase.ts). Backend built + 529 tests green; edge fns not deno-checked locally (deno absent). PROD E2E still owed (two-user scenarios + edge deploy). VERDICTS (verified 2026-10-09): #3 memory-fold loss = REAL (High): read-error clobber + concurrent lost-update in `foldNoteIntoMemory` (memory.ts:1210/1244). #4 re-summarize takeover = REAL (High): regenerate by a share recipient folds + writes note_insight under the REQUESTER (index.ts:2765), and `writeNoteInsight` upserts onConflict note_id only (memory.ts:550), flipping user_id; owner loses RLS-scoped index + content leaks into recipient memory. #10 edge-fn Graph auth = REAL (Med): `getMicrosoftUserId` `/me` with no tenant/domain allowlist (generate-profile + identify-speakers), `verify_jwt=false` -> any MS account can burn the org Gemini key (cost/DoS, no data exfil). #2 project-chat = PARTIAL (Med): project-membership-only note fetch is mostly intended (owner notes to project-shared users), genuine leak is narrow (third-party-owned notes added to the project also exposed); fix = reuse MCP `noteAccessFilter`. Fix order: #3, #4, #10, then #2. |
| C | mobile app-kill, CI, Gemini-wrapper consolidation, duplicate migration | DONE 2026-10-09 (code committed; 4 file-disjoint subagents). Mobile: recoverRecording no longer deletes an interrupted m4a, preserves + surfaces it (needs APK + on-device E2E). CI: Vitest + a blocking GitHub Actions gate (backend build+529 tests, frontend build+test); lint gate deferred (51 eslint errors), explicit follow-up. Gemini: shared isRetryableGeminiError + dedupeModels extracted (behavior-preserving, divergent loops left intact), build+529 green. Migration: one idempotent forward migration reconciles the two mcp_tracking schemas (apply manually). |
| Sibling vulns | tenant-blind Graph fallback in admin-controls / admin-analytics / mcp-token / note-audio-url | DONE 2026-10-09: all four routed through the shared `authorizeMicrosoftGraphToken` (tenant/domain allowlist, status-aware). admin-* also gate on an admin-id set; mcp-token was the real exposure. Needs an edge deploy. |
| R01 | note-audio-url signed arbitrary objects via client-editable note/file data (P1 proxy-signer) | DONE 2026-10-09: all signing paths gated on `storage.objects.owner_id` via a new service-role-only `storage_object_owner` RPC (migration 20261009130100), fails closed. Apply the migration BEFORE deploying the function; legacy null-owner objects stop resolving (run a blast-radius diagnostic first). |

See also the per-finding memory: [[meeting-recordings-bucket-rls-exposure]] for the confirmed S1 detail.
