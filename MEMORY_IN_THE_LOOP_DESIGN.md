# Memory-in-the-loop — Phase 2 Design

Status: DRAFT, decisions locked 2026-09-02.
Owner: Andrew.
Sibling docs: `MEMORY_FEATURE_DESIGN.md` (F1 / F1' foundation).

This document covers the "core" the beta was delayed for: making accumulated personal memory actually useful inside the product, beyond the read-only "My Memory" screen.
The write path (accumulation) and the substrate (F1 `user_memory`, F1' relational memory) already exist.
This is about consumption.

## Where we are (measured 2026-09-02)

Core v1 is already merged to `main` and, since backend auto-deploys from `main`, is presumed live in prod.
Two consumers are wired:

- **Summary generation** reads `user_memory` (`index.ts` `getPersonalMemoryContext`) and injects it into the fresh-summary prompt as a `PERSONAL MEMORY CONTEXT` block with a fact-drift guard (`prompts.ts`).
- **MCP `recall_personal_context`** returns active memory items for the scoped user (`mcp/tools/memory.ts`), registered on the MCP server.

Everything else still runs memory-blind:

- **Regenerate summary** does NOT inject memory (`buildRegenerateSummaryPrompt` takes no memory context); it only folds memory afterward, so a regenerated summary loses the cross-meeting context a fresh one gets.
- **Insight extraction** is per-meeting only; it never reads memory.
- **Speaker ID at ingest** ignores memory (and an A/B already proved memory gives 0.0pt there, so this stays out of scope).
- **Mobile** surfaces nothing beyond the read-only screen (consumption is server-side at summarize time, which is fine for the summary, but mobile shows no memory-driven value).
- **Legacy write stack is dead but present**: `supabase/functions/update-user-memory` and `src/lib/userMemory.ts` `updateUserMemoryFromNote` are superseded and unreferenced.

Net: memory is genuinely in-the-loop in exactly two places (fresh summary, MCP recall).

## Decisions locked (2026-09-02)

1. **Flagship = all four directions, sequenced.**
   Not a single bet; a prioritized roadmap covering value surface, MCP expansion, gap-closing, and automatic quality (below).

2. **Editability = memory stays auto-managed.**
   Delete remains the only user write.
   No confirm/reject review queue: it forces the user to inspect and approve memory on every meeting, which conflicts with the minimize-input direction and most users won't bother.
   Quality comes from automatic mechanisms (supersede / consolidation), not from a human review step.
   A full edit UI is optional, revisited only if automatic quality proves insufficient.

3. **First deliverable = measure the live impact before building more.**
   Same "measure first" discipline that just paid off in speaker ID.
   We do not assume the shipped summary injection helps (the speaker-ID memory A/B was 0.0pt); we measure it.

## Guiding principles

- Minimize user input. Memory works silently and self-corrects; the user is never asked to curate it.
- Measurement-gate every change. Reuse the F8 eval harness; grow a golden set.
- Consume memory wherever it helps, and keep it invisible.
- Prefer the existing v2 `user_memory` substrate and the `mcp/tools/memory.ts` pattern over new stores.

## Phase 2 roadmap

### Step 0 — Measure live impact (gate, do first)

Build an A/B over real notes: summaries generated with vs without the personal-memory injection that is already live.

- Metrics: does injection improve cross-meeting continuity and personalization (owner/collaborator/project carry-over) WITHOUT introducing fact-drift?
- Reuse the summary eval harness; extend the golden set with memory-sensitive cases.
- Gate: if the lift is ~0 or drift appears, fix the injection (prompt, rendering, cap) before building anything on top of it.

Rationale: v1 shipped without an impact measurement. We close that first.

### Step 1 — Close the memory-blind gaps (cheap reliability)

- **Regenerate summary**: thread `personalMemoryContext` into `buildRegenerateSummaryPrompt` so a regenerated summary is as memory-aware as a fresh one. Gate on the Step 0 harness.
- **Insight extraction**: decide, by measurement, whether injecting memory into `extractInsight` helps or just costs tokens. Ship only if it clears the gate.
- **Retire the legacy write stack**: remove `update-user-memory` edge fn and `userMemory.ts` `updateUserMemoryFromNote` (dead, superseded), to prevent a future caller from reintroducing the old shape.

### Step 2 — Value surface (the flagship payoff)

A user-facing, memory-driven artifact that makes accumulation visibly worth it.
Candidate (decide at kickoff): a **meeting brief** that pulls accumulated memory (open action items, collaborators, recurring topics) into a "what changed / what to prep" view around a meeting.

- Server-side generation; web + mobile display.
- This is the demonstrable value the beta waited for; it is the reason accumulation exists.

### Step 3 — MCP expansion (memory as agent substrate)

Beyond `recall_personal_context`:

- Query memory by entity / topic (not just recency).
- Relational / event recall (F1' cause-to-effect chains) when it earns its place.
- A write / update tool, agent-initiated but still auto-managed (guardrails: what an agent may write unattended).

Reuse the `mcp/tools/memory.ts` pattern.

### Step 4 — Automatic quality (no user review)

The mechanism that lets us skip confirm/reject.

- Strengthen supersede / consolidation so memory self-corrects as new meetings arrive.
- Better dedup, staleness / archival, and the fact-drift guard.
- Gate on stability metrics (the F8 `eval:stability` line).

## Explicitly out of scope (this phase)

- Speaker-ID memory injection (proven 0.0pt).
- Confirm/reject review queue (rejected: too much user friction).
- Full manual memory editing beyond delete (conflicts with minimize-input; revisit only if Step 4 automation is insufficient).

## Open questions (resolve at each step kickoff)

- Step 0: what is the primary summary-quality metric that a golden set can score without a human each run?
- Step 2: which artifact exactly (pre-meeting brief vs proactive insights vs cross-meeting timeline)?
- Step 3: what can an agent safely write to memory unattended, and how is it bounded?
