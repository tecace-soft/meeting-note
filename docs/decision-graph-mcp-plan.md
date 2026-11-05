# Decision Graph: MCP plan (Phase 2)

Status: plan only, nothing built yet (2026-11-04). Requirements: handoff §5 (F4) and §3 rule 4. Design context: `docs/decision-graph.md`.

## 1. Summary

The goal is for MCP clients (Claude, ChatGPT) to answer three kinds of question correctly:
- "What did we decide about X, and why?"
- "How did that change over time?"
- "What is still open or contradictory?"

The answer must never present a proposal as a decision.

What we add:
- Three read tools.
- One verify tool, so Hans can correct a record from chat.
- Decision data in two existing tools: `get_meeting_brief` and `find_action_items`.

We add tools only where no existing tool can carry the data. There are already 31 tools, and every new tool makes tool choice harder for the client.

Order: data first, then tools. A tool over an empty table teaches users that the feature does not work.

| Milestone | Content | Depends on |
| --- | --- | --- |
| M0 Data | Gold-set review passes → `DECISION_GRAPH_ENABLED=true` → backfill Hans's notes | Gold review |
| M1 Read | SQL read function, `get_decisions`, `explain_decision`, decisions inside `get_meeting_brief` | M0 |
| M2 Change over time | Job B linking, `get_decision_timeline`, conflicts inside `get_decision_timeline` and `get_decisions` | M1 |
| M3 Human in the loop | `verify_decision` (sets `human_verified`), `find_action_items` reads `mn_actions` | M1 |

## 2. Principles

1. **Status always travels with the text.** Every decision in every response carries:
   - `status`
   - `statusLabel`, a fixed human phrase such as "확정 (decided)" or "제안 (proposed, 확정 아님)"
   - `isFinal: status === 'decided' || status === 'customer_decided'`

   Tool descriptions tell the client to quote `statusLabel` and never to restate a non-final item as decided. This is the handoff's main requirement.
2. **Evidence and source on every item.** Each item carries:
   - `evidenceQuote` and `evidenceVerified` (the evidence-match flag)
   - the meeting date and title, and `noteUrl` (same format as `buildNoteUrl`)
   - `humanVerified`
3. **Same visibility as the app.** Today MCP reads with service_role and filters notes in TypeScript (`noteAccessFilter`). That would re-implement the RLS rule for decisions, including "sensitive is owner-only", and two copies of a rule drift apart. Instead, add one SQL function, `mn_visible_decisions(p_user_id text, filters…)`:
   - `security definer`
   - executable by service_role only
   - It applies the same predicate as the RLS policies: the note is visible to the user (owner, `shared_users`, shared project) **and** (`sensitivity = 'normal'` or the user owns the note).
   - It is tested on PGlite next to `decision-graph-sql.test.ts`, with the same cases (owner, direct share, project share, unrelated, sensitive).

   All read tools go through it.
4. **Owner-scoped writes only.** `verify_decision` changes only rows on notes the caller owns. That matches the future UI rule.
5. **Bounded output.** Each tool has a default limit (20), a hard cap (50) and a `nextCursor`. Responses are compact: text is truncated at 300 characters and evidence at 200, with the full text available from `explain_decision`.
6. **Flag-aware.** If the tables are empty for the caller (feature off or not backfilled), the tool says so explicitly ("decision data not available for these notes yet") instead of returning `[]`. AGENTS.md warns that an empty result is not "no data".

## 3. Tools

### M1. `get_decisions` (new, read)

List decisions across the caller's visible meetings.

- **Input** (all optional):
  - `projectId`: the existing `project` table. Matches notes in that project.
  - `projectName`: free text, matched against `mn_entities` project names and aliases.
  - `person`: decided_by or participant. Canonical name or alias.
  - `status`: an array. Default `['decided', 'customer_decided', 'direction']`. Pass all 8 for everything.
  - `from`, `to`: dates.
  - `query`: text match on decision text and why.
  - `includeSuperseded`: default false. Hides rows with `invalid_at`.
  - `limit`, `cursor`.
- **Output**: `{ decisions: [{ id, date, meetingTitle, noteId, noteUrl, status, statusLabel, isFinal, side, decidedBy, text, why, project, evidenceQuote, evidenceVerified, humanVerified, supersededBy? }], counts: { byStatus }, coverage: { notesInScope, notesExtracted }, nextCursor }`
  - `coverage` lets the client say "12 of 40 meetings in this project have decision data".
- **Description hint**: "Use for 'what did we decide about X'. Present status with statusLabel; never call a non-final item a decision."

### M1. `explain_decision` (new, read)

- **Input**: `decisionId`.
- **Output**:
  - the full row: why, trigger, alternatives_rejected, assumptions, effective_date, evidence quote, evidence segment ids, and a ±3 segment transcript window around the evidence
  - the related actions (`from_decision`)
  - from M2, the link chain: earlier and later decisions with rel and reason
- The transcript window means the client can check the claim without another `get_note_transcript` call.

### M1. `get_meeting_brief` (existing, extended)

- Add a `decisions` block. It holds that meeting's decisions with status, label and evidence-verified, plus counts by status.
- No new tool: "what happened in meeting X" already routes here.

### M2. `get_decision_timeline` (new, read)

- **Input**: `projectId` or `projectName` (one is required); `includeNonFinal` (default true).
- **Output**:
  - Decisions in date order, each with its links (supersedes, revises, refines, confirms, resolves, conflicts_with) and confidence.
  - `current`: the decisions still in force, meaning final and not superseded.
  - `openConflicts`: `conflicts_with` pairs, and reversed decisions that still have open actions.
- **Why there is no separate `get_open_conflicts` tool**: the handoff lists one. Conflicts are almost always asked about for a project, so they are part of the timeline. `get_decisions` also gains `conflictsOnly: true` for the cross-project view. This keeps the tool count down.
- **Prerequisite: Job B** (Prompt B linking, confidence ≥ 0.7, `invalid_at` on supersede, owner notification). It is built in M2 before this tool.

### M3. `verify_decision` (new, write, owner only)

- **Input**:
  - `decisionId`
  - optional `status` (one of the 8), `text`, `side`
  - `note` (why the change)
- **Effect**:
  - Updates the row and sets `human_verified = true`, so re-extraction never overwrites it.
  - Records who changed it and when, in a small `mn_decision_reviews` log.
  - It is in `WRITE_TOOL_NAMES`, so clients ask for confirmation before calling it.
- **Why**: Hans can review decisions in chat ("이건 확정 아니야, 제안으로 바꿔") without waiting for the UI tab. Each correction also becomes new gold data. This is the human-in-the-loop part of the recursive improvement loop.

### M3. `find_action_items` (existing, extended)

- Prefer `mn_actions` (owner, due, `from_decision`, evidence) when the note has decision data, and fall back to `note_insight`.
- Each action shows its source decision's status. An action whose decision was superseded is flagged.

## 4. Data readiness (M0)

1. Gold review passes the §5.1 criteria in `docs/decision-graph.md`.
2. Set `DECISION_GRAPH_MODEL=gemini-3.1-flash-lite` and `DECISION_GRAPH_ENABLED=true`. New notes are then extracted after each summary.
3. Backfill existing notes.
   - Add an owner-scoped batch path. One option is `run_decision_extraction` with `dryRun:false` in a loop, but it is capped at 3 notes per call. Better: an admin route like `/admin/backfill-insight`, limited to the caller's own notes, with 25 notes per call.
   - Estimated cost: about $0.005 × number of notes, so about $2 for 400 notes.
4. Optionally import the 2026-10-31 backfill (F7) with `source = 'backfill'`, only for notes without a live extraction.

## 5. Verification

- **SQL**: tests for `mn_visible_decisions` on PGlite, covering visibility and sensitivity, with the same matrix as the RLS tests.
- **Tool contract tests**:
  - Status fields are present on every item.
  - Limits and cursor work.
  - An empty-coverage message is returned.
  - `verify_decision` refuses notes the caller does not own.
  - `verify_decision` is not `readOnlyHint`.
- **Answer eval**: 10 fixed questions over the gold-set notes, answered by Claude through the connector. Examples:
  - "삼성 입찰 단가 어떻게 정했지?"
  - "Repler 인수인계 일정은 확정됐어?"
  - "FD 인력 배치는 결정된 거야?"

  Each answer is scored on three checks:
  1. Status stated correctly, with no proposal called a decision.
  2. A source meeting cited.
  3. Nothing invented.

  `log_final_answer` captures the answers.
- **Product docs**: regenerate `mcp-tools-reference.md`, and add a "decisions" section to `guide-for-ai-agents.md` explaining how to present status.

## 6. Effort and order (estimate)

| Step | Size |
| --- | --- |
| M1: SQL function + tests, `get_decisions`, `explain_decision`, brief extension, docs | 1–2 days |
| M2: Job B (Prompt B, linking job, notification) + `get_decision_timeline` | 2–3 days |
| M3: `verify_decision` + review log migration, `find_action_items` on `mn_actions` | 1 day |

M1 can be built and merged while the gold review is in progress. With the flag off, the tools return the "no data yet" message.

## 7. Open questions

1. **Notifications for conflicts (M2).** The handoff says to notify the note owner. Options are Teams, email or an in-app badge. Recommendation: start with an in-app badge, plus the `openConflicts` field in MCP, and add Teams later.
2. **Project scope.** Model-extracted project names (`mn_entities`) and the user's own projects (`project` table) differ. Recommendation: treat `projectId` (user projects) as primary and `projectName` (extracted) as a fallback. Revisit after backfill shows how messy the extracted names are.
