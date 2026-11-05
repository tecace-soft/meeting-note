# Decision Graph — design note (Phase 1 / P0)

Source of truth for requirements: the 2026-11-01 handoff from Hans Lee ("Meeting Note — Decision Graph 저장 기능 개발 요청": HANDOFF.md, schema.sql, Prompt A/B). This note maps the handoff onto the existing codebase and records what Phase 1 ships.

**Status**: Phase 1 code merged behind `DECISION_GRAPH_ENABLED` (default off). Not enabled in production. The migration has not been applied to the hosted DB yet. No eval has run on real notes yet.

## 1. Where it plugs in

| Handoff concept | Existing code | Decision Graph |
| --- | --- | --- |
| "transcript 확정" trigger | `pipeline/finalize.ts` `finalizeNoteMemory` (runs after the summarize job is marked completed; already hosts the `note_insight` extraction) | `runDecisionExtraction` is called last in `finalizeNoteMemory`, only when `env.decisionGraphEnabled` |
| Job runner / retries | Gemini JSON calls go through `callJsonModel` (`memory.ts`): 3 attempts per model on transient or unparseable output, then the next lite model | Same helper. Validation failure counts as unparseable, so it is retried; if every attempt fails, the run row is `failed` with the last validation error |
| DB access | service-role client `db/supabaseClient.ts`; RLS on `note` (owner, `shared_users`, shared project) | New `mn_*` tables; reads inherit `note` RLS; writes only through `public.mn_replace_note_extraction` (service_role) |
| Model registry | `gemini-models.ts`, lite-only (DEC-0005), no nested `responseSchema` (DEC-0006) | `DECISION_EXTRACTION_MODEL` (default `gemini-3.1-flash-lite`), env `DECISION_GRAPH_MODEL` through `liteModelFromEnv` |
| Existing per-note index | `note_insight` (actions, firm decisions with rationale, events). Unchanged | Separate tables. `note_insight` and the existing summary are not modified |
| AXKH meeting-knowledge pipeline (`workflow-server/src/knowledge/`) | Default off; contract files must stay byte-identical with AXKH (DEC-0018) | Not reused. See DEC-0026 |

## 2. Schema mapping (handoff `schema.sql` → migration `20261104120000_create_decision_graph.sql`)

Table names keep the handoff's `mn_` prefix. Differences:

- `note_id` is a real FK to `public.note(id)` with `on delete cascade` (handoff: free text). Deleting a note deletes its decision data.
- `user_id` (note owner) added to `mn_extraction_runs`, `mn_meeting_records`, `mn_entities`, for RLS and ownership checks.
- `mn_entities` is scoped per owner (`unique (user_id, type, canonical_name)`). The handoff's seed alias list lives in code (`decisions/normalize.ts`) and applies to everyone. A global, team-curated alias table is a later step.
- Added on `mn_decisions`: `project` (canonical name, denormalized so shared readers do not need `mn_entities`), `evidence_match`, `prompt_version`, `source`, `updated_at`, `unique (note_id, seq)`.
- `mn_actions` and `mn_issues` also get `seq`, `evidence_segment_ids`, `evidence_match`, `source`, `human_verified`, so a human edit is protected the same way as on decisions.
- `mn_meeting_records` gets `references_to_past` (jsonb, input for Phase 2), `prompt_version`, `source`, `human_verified`.
- `mn_extraction_runs` gets `alias_candidates` and `metrics` (monitoring), and `finished_at`.
- `from_decision` uses `on delete set null`, so replacing unverified decisions never breaks a human-verified action.
- `mn_decision_links` is created now (empty until Phase 2) with the handoff columns.

## 3. Rules from the handoff and how they are enforced

| Rule | Enforcement |
| --- | --- |
| Status is one of 8 fixed values; a proposal is never stored as decided | DB `check` constraint, and strict zod enum in `decisions/schema.ts` (unknown value → invalid → retry → fail). Semantic mislabeling (a real proposal labeled decided) can only be measured, via the gold set |
| `evidence_quote` required, verbatim | Prompt rule. `decisions/evidence.ts` checks every quote against the transcript (exact after whitespace/case/quote-mark normalization) and stores `evidence_match` and `evidence_segment_ids` (`s<index>` into `note.diarization`) |
| Numbers verbatim | Prompt rule only; measured by the gold set |
| Bi-temporal | `valid_from = meeting_date`; `invalid_at` column exists, set by Phase 2. Rows are never deleted for supersession |
| Visibility inherits the note; sensitive data restricted | RLS: a meeting record is visible iff the caller can see the note (the policy queries `public.note` as the caller, so the note's own policies decide) **and** (`sensitivity = 'normal'` or caller is the note owner). Child rows are visible iff their record is. Covered by `decision-graph-sql.test.ts` |
| `human_verified` rows never overwritten | `mn_replace_note_extraction` deletes and re-inserts only unverified rows; new rows are numbered after the highest verified `seq`; a verified meeting record keeps its fields. Tested |
| Idempotent on (note_id, prompt_version) | The job skips a note with a `done` run for the current `DECISION_PROMPT_VERSION` (unless `force`). A `running` row younger than 15 minutes blocks a concurrent run. The replace is one SQL transaction; the same payload gives the same ids |
| Out-of-scope meetings | Prompt rule 8, and the payload builder drops decisions when `meeting_kind = 'out-of-scope'` |
| Full transcript input | The whole diarized transcript is sent (cap 600k characters, about a third of a lite model's window; truncation is recorded in `quality_notes` and the run metrics). Summary (`summary_edit` preferred) is secondary input |
| Feature flag, default off | `DECISION_GRAPH_ENABLED` must equal `true` |

### Deliberate deviations (stricter or narrower than the handoff)

1. **Sensitive rows are owner-only, not "owner + participants".** There is no verified participant identity (Microsoft oid) per meeting yet; speaker names are display data and must not be used for authorization (AGENTS.md "Identity trust"). Revisit when attendees are stored by oid.
2. **Model comparison is between the two lite models only.** The handoff asks to compare 2–3 models; DEC-0005 allows only `gemini-2.5-flash-lite` and `gemini-3.1-flash-lite` in production. Using a non-lite model needs a decision that supersedes DEC-0005.
3. **"Retry once"** is "up to 3 attempts per model, then the fallback lite model", because that is the project's measured reliability policy for flash-lite JSON (`callJsonModel`, API_LESSONS).
4. **Meeting date** comes from `note.meeting_at` (else `created_at`) in `DECISION_GRAPH_TIMEZONE` (default `Asia/Seoul`), never from the model, because summaries have had wrong dates.
5. **Only the JSON output of Prompt A is requested.** The AXKH Markdown (Prompt A "Output 2") will be rendered from stored rows in Phase 3, so the two cannot disagree.

## 4. Code map

- `supabase/migrations/20261104120000_create_decision_graph.sql`: tables, indexes, RLS, `mn_replace_note_extraction`
- `workflow-server/src/decisions/prompt.ts`: Prompt A + `DECISION_PROMPT_VERSION` (bump on any prompt change)
- `workflow-server/src/decisions/schema.ts`: strict output validation
- `workflow-server/src/decisions/normalize.ts`: seed aliases, resolver, alias candidates (F2)
- `workflow-server/src/decisions/evidence.ts`: quote matching and segment ids
- `workflow-server/src/decisions/store.ts`: payload builder, metrics, RPC write
- `workflow-server/src/decisions/verify.ts`: status refinement after extraction (guards + verifier pass; only lowers a status)
- `workflow-server/src/decisions/job.ts`: Job A (load, idempotency, extract, refine, store, run log)
- `workflow-server/eval/decision-graph.ts` (`npm run eval:decisions`): eval on a note list (local, needs service-role + Gemini keys)
- MCP read tools `get_decisions` and `explain_decision`, plus the `decisions` block in `get_meeting_brief` (`workflow-server/src/mcp/tools/decisionRead.ts`). They go through the service_role-only SQL functions in `20261105120000_decision_graph_read_functions.sql`, which mirror RLS; parity is tested in `decision-graph-read-sql.test.ts`
- MCP tool `run_decision_extraction` (`workflow-server/src/mcp/tools/decisions.ts`): the same eval from any MCP client with no local setup. Owner's notes only, up to 3 per call, dry run by default (`dryRun:false` stores through the real job). Works while `DECISION_GRAPH_ENABLED` is off
- Tests: `src/decisions/decisions.test.ts` (unit), `src/decisions/decision-graph-sql.test.ts` (migration on PGlite: RLS, sensitivity, idempotency, human_verified, cascade)

## 5. Rollout (in order)

1. Apply the migration to the hosted DB. It only adds tables; nothing writes to them while the flag is off.
2. Deploy the backend with the flag still off.
3. Run the eval on the 20 gold meetings with each lite model: through the MCP tool `run_decision_extraction` (dry run), or locally with `npm run eval:decisions -- --file gold.txt --model <model>`. Neither stores anything.
4. Score the run against the gold set (§5.1). The review workbook computes decided precision and recall.
5. Pick the model, set `DECISION_GRAPH_MODEL`, set `DECISION_GRAPH_ENABLED=true`.
6. Optional: backfill recent notes with `--write` (uses the production job with `force`).

### 5.0 Definition of `decided` (strict, chosen by Hans 2026-11-05)

`decided` requires an explicit commitment or acceptance that is not qualified by uncertainty.
- **Hedged commitments are `direction`.** Examples: "그런 식으로 결정될 것 같아요", "저는 그렇게 보고 있어요", "아마 그렇게 될 거예요", "20% or something".
- **Polite advice that the other side accepts is `decided`.** Example: "~하는 게 좋을 것 같아요" answered with "알겠습니다".
- **Lines read from a pitch rehearsal or presentation script are not decisions.** Example: "~하겠습니다".

The extraction prompt, the verifier and the deterministic agreement guard (`verify.ts` step 4) all implement this definition. Gold labels are judged against it.

### 5.1 Acceptance criteria (revised 2026-11-04, approved by Hans)

The handoff's "evidence match ≥ 0.95 over all items" is replaced as follows.

| Criterion | Gate | How |
| --- | --- | --- |
| Every `decided` / `customer_decided` row has a verbatim transcript quote | **Required, 100%** | Guaranteed by the evidence guard (`verify.ts`); a decided item without a matching quote cannot be stored |
| Decided precision on the gold set | **Required, ≥ 0.85** | Gold-set review: final `decided` rows that the reviewer also marks `decided` |
| Decision recall on the gold set | **Required, ≥ 0.80** | Gold-set review: extracted valid items / (extracted valid + missing) |
| Schema failure rate | **Required, < 2%** | Run metrics |
| Evidence match over all items (decisions, actions, issues) | Monitoring, ≥ 0.9 | Run metrics `evidence_match_rate`. It is no longer a gate: a non-matching quote on a non-decided item cannot create a false decision |
| Per-meeting decided ratio > 0.7 | Monitoring | Logged warning |

Gold set: 20 notes owned by Hans, extracted on 2026-11-04 with `decision-extract-v2+verify-v1`. The review workbook stays outside the repo because it contains meeting content.

Monitoring: `mn_extraction_runs.metrics` has `status_counts`, `decided_ratio` (a warning is logged above 0.7 with at least 4 decisions), `evidence_match_rate`, `evidence_summary_rate`, latency, tokens and estimated cost. `alias_candidates` lists unknown names and the model's "alias 후보" hints for curating aliases.

## 6. Not in Phase 1

- Phase 2 (P1): Job B linking (Prompt B, ≥ 0.7 confidence, `invalid_at`, owner notification), MCP read and verify tools (plan: `docs/decision-graph-mcp-plan.md`), the "Decisions" tab with inline edit (sets `human_verified`, needs owner UPDATE policies).
- Phase 3 (P2): Markdown export for AXKH, backfill import (`source = 'backfill'`).
- Duplicate-recording detection (`duplicate_of`).

## 7. Open questions for Hans (from handoff §9, still open)

1. Extraction model: gemini-3.1-flash-lite after the pilot (§8). Cost is about $0.005 per meeting including the verifier; no cap has been set yet.
2. Gold set: the 20 notes in §5.1 have been chosen. Hans reviews them.
3. Sharing default: implemented as "inherit note visibility, sensitive → owner only". Owner + participants needs attendee oids.

## 8. Eval log

Aggregate numbers only. Meeting content stays out of the repo.

### 2026-11-04 pilot: prompt v1, 5 notes owned by Hans, dry run through `run_decision_extraction`

The 5 notes: a partner/customer meeting, a partner handover, an internal exec meeting, a partner intro and an internal dev meeting. All transcripts are 16–23k characters.

| Metric | gemini-3.1-flash-lite | gemini-2.5-flash-lite | Target |
| --- | --- | --- | --- |
| Schema/call failures | 0/5 | 0/5 | < 2% |
| Decisions extracted | 10 | 41 | — |
| Share labeled `decided` | 70% | 80% (two notes 100%: 8/8, 15/15) | flag > 70% per meeting |
| Evidence verbatim match | 20/29 = 0.69 | 67/110 = 0.61 | ≥ 0.95 |
| Latency per note | 3.1–4.6 s | 9.8–47 s | — |
| Est. cost per note | about $0.0048 | about $0.0030 | — |

Findings, all addressed in prompt v2 (`decision-extract-v2`) and code:
- **Date bug (code).** The fixed `Asia/Seoul` zone shifted LA meetings by one day in 3 of 5 notes. The model then reported false "summary date" discrepancies. Fix: use the note-name `yymmdd` prefix, which is computed in the recorder's zone, and the recorder's zone in finalize.
- **Evidence.**
  - Fragments were joined with " / " or stitched into new sentences.
  - Twice, the "quote" was a paraphrase of the decision itself.
  - v2 asks for one verbatim span, or fragments joined by " ... ", and never a summary or the decision text. The matcher now also splits on " / ".
- **Over-classification.**
  - 2.5-flash-lite labeled opinions, experiences and "keep discussing" as `decided`.
  - Both models put a partner speaker's statement under `side=tecace`.
  - v2 adds explicit negative examples and requires the side to follow the speaker's organization.
- **Output language.** 3.1-flash-lite answered in English for 3 Korean meetings. v2 asks for the meeting's language.
- **Names.**
  - Romanized names were unresolved: Hansoo Lee, Chang Han, Yung Kim. These are now aliases.
  - Company and team names appeared as owners. These now become null.
  - 2.5-flash-lite assigned speaker labels to seed-alias people with no basis. v2 forbids this.

Model call after the pilot: **gemini-3.1-flash-lite**. Status discipline is the top requirement, and it was clearly better there; it was also about 10x faster. Not enabled yet: rerun v2 on the same 5 notes, then the gold set.

### 2026-11-04 rerun: prompt v2, same 5 notes, gemini-3.1-flash-lite

| Metric | v1 | v2 | Target |
| --- | --- | --- | --- |
| Meeting date correct | 2/5 | 5/5 | — |
| Company/team names as owners | several | 0 | — |
| Evidence verbatim match | 0.69 (20/29) | 0.83 (20/24) | ≥ 0.95 |
| Share labeled `decided` | 70% | 88% (7/8) | flag > 70% |
| Output in meeting language | 2/5 | 3/5 | 5/5 |

The model still labels "keep discussing" and "I'll prepare it" as `decided`, despite the v2 negative examples. One quote was copied from the summary; the matcher flagged it.

Response: a status-refinement step (`decisions/verify.ts`, `verify-v1`). It runs after extraction and can only lower a status, never raise one.
1. **Deterministic guards.**
   - The side and the status must agree.
   - A `decided` or `customer_decided` item whose quote is not verbatim in the transcript drops to `direction` or `customer_stated`.
2. **Verifier pass.** One lite call per meeting re-judges each remaining decided item against ±4 transcript segments around its evidence. A verdict is applied only when it is lower and valid for the item's side. If the verifier fails, the guard result stands.

The original model output stays in `output_json`. Every change is listed in the run metrics as `status_adjustments`, and the counts before refinement as `status_counts_before_refine`. Runs are versioned as `DECISION_PIPELINE_VERSION` = `decision-extract-v2+verify-v1`.

### 2026-11-04: v2 + verify-v1, same 5 notes, then the 20-note gold set

| Metric | v1 | v2 | v2+verify (5 notes) | v2+verify (20 notes) |
| --- | --- | --- | --- | --- |
| Schema/call failures | 0/5 | 0/5 | 0/5 | 0/20 |
| Decisions extracted | 10 | 8 | 8 | 32 |
| Labeled `decided` before refinement | 70% | 88% | 88% (7/8) | 91% (29/32) |
| Stored as `decided` | 70% | 88% | **25% (2/8)** | **38% (12/32)** |
| Decided rows with a verbatim quote | n/a | n/a | 2/2 | 12/12 |
| Evidence match, all items | 0.69 | 0.83 | 0.83 | 0.80 (73/91) |
| Cost per meeting | about $0.005 | about $0.005 | about $0.0055 | $0.003–0.011 |

On the 5 notes, the reviewer-agent reading (not yet the human gold) is:
- 5 of 6 downgrades look right.
- One "already done" item went to `proposed`; `status_report` would be more accurate.
- The 2 kept `decided` items are real instructions that were accepted.

Human precision and recall are pending the gold-set review.

### 2026-11-05: v3 + verify-v2 on the 20-note gold set (scored against Hans's labels)

Items were matched to the gold labels by content. Two notes produced items that are not in the gold set; these are unlabeled and excluded.

| Metric | v2+verify-v1 (reviewed run) | v3+verify-v2 | Target |
| --- | --- | --- | --- |
| Decided precision | 0.83 (10/12) | 0.79 (11/14) | ≥ 0.85 |
| Decided recall (gold decided found as decided) | 0.83 (10/12) | **0.92 (11/12)** | — |
| Gold items extracted at all | 32/32 | 30/32 | ≥ 0.80 |
| Status accuracy on gold items | 0.69 | 0.66 | — |
| Meeting kind fixed (Samsung → customer) | — | 3/3 | — |
| Sensitivity → financial (2 gold cases) | — | 0/2 | — |

- **The three v2 false negatives are fixed.**
  - A re-quote rescued two items: "documented and agreed" and "맞아요, 그렇게 쓰셔야겠네요".
  - The verifier now keeps "지원팀에서 결정을 냈다" as `customer_decided`.
- **The remaining false positives** are single-speaker statements kept as `decided`: an opinion ("직접 하는 게 효과가 좋다고 생각합니다"), a pitch to the customer, and a customer system explanation that the model reattributed to TecAce.
- **Run-to-run variance.** Two re-runs of the same notes produced different item sets: items appeared and disappeared, and item texts changed. With 12–14 decided items, one item moves precision by about 0.07. Treat differences under about 0.1 as noise.

Response, verify-v3: a deterministic **agreement guard**. A final status needs an explicit decision or agreement marker in the verbatim quote, or a quote spanning at least two speakers. On this run it would lower the opinion and the pitch, giving an estimated precision of 11/12. This estimate was made by hand from the quotes and has not been measured. Validate it on the held-out notes, not this set.

### 2026-11-05: held-out 10 notes (new to all tuning), v3 + verify-v3, labeled by Hans (strict)

| Metric | Result | Target |
| --- | --- | --- |
| Schema/call failures | 0/10 | < 2% |
| Decided precision | **0.50 (3/6)** | ≥ 0.85 |
| Critical errors: a proposal, info or invalid item stored as `decided` | **0/6** | — |
| Decision recall (no missing decisions entered) | 1.0 | ≥ 0.80 |
| Status accuracy | 0.67 | — |
| Items judged invalid | 3/15: two pitch-rehearsal lines with non-verbatim quotes, one personal resignation remark | — |
| Meeting kind wrong: internal pitch prep labeled `customer` | 2/10 | — |
| Sensitivity under-flagged: pilot/POC talks should be `customer-commercial` | 2/10 | — |

- **All three false positives were hedged commitments**, judged `direction` under the strict definition:
  - "저는 그렇게 보고 있어요"
  - "그런 식으로 결정될 것 같아요"
  - "like 20 or something … I totally agree"
- **The gold set and the held-out set were labeled with slightly different strictness.** "맞아요, 그렇게 쓰셔야겠네요" was labeled `decided` in the gold set. The similar "맞아요 … 그렇게 보고 있어요" was labeled `direction` here. Hans then fixed the strict definition (§5.0).

Response, prompt `decision-extract-v4` + verify-v4:
- **Commitment-hedge veto in the agreement guard.** It is narrow on purpose. Generic "~것 같아요" is not vetoed, because 5 reviewed true decisions have the shape "polite advice + 알겠습니다".
- Pitch-rehearsal lines are excluded.
- Personal matters such as resignation are not extracted.
- `customer` requires a customer person to actually participate.
- Pilot/POC/commission talks are `customer-commercial`.

By hand on the held-out quotes, the veto would lower all 3 false positives and keep the 3 true positives. That would be precision 3/3, but it is not yet measured. The next held-out run must use notes that are new to all tuning so far.
