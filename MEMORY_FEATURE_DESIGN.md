# Memory Feature — Design & Decisions (F1)

Status: F1b + F1a implemented & verified on web 2026-08-04. F1c not started.
Branch: `memory/user-context`.

Progress (2026-08-04):
- F1b (suggestion-based ID): shipped. New edge function `identify-speakers` (deployed), client lib `src/lib/identifySpeakers.ts`, "Suggest" banner in `TranscriptDiarizedEditor.tsx`. Verified: identifies the logged-in user (self prior); other people were NOT identified — root cause diagnosed as EMPTY profiles (nothing to match against), not a prompt bug. Sends original-language transcript; "Apply all" removed (per-row confirm only) since LLM confidence is uncalibrated.
- F1a (auto-accumulation): shipped. On any real-name apply (manual pick / MS contact / accepting an F1b suggestion), `src/lib/accumulateSpeakerProfile.ts` updates that speaker's ontology profile from the note in the background (best-effort, deduped per note+name, anonymous labels skipped). Verified: profiles that were empty now fill on labeling. This is the fuel F1b needs — as the user labels meetings, profiles accumulate and F1b's identification of others should improve over subsequent meetings.
- Open expectation: even with profiles, same-topic team meetings may stay hard for text-only ID; on-device voice (Picovoice Eagle) remains the fallback if text proves insufficient after real use. Azure Speaker Recognition was retired Sept 2025.
Source: 2026-08-04 standup ("Memory feature — accumulate per-user context over time to auto-identify speakers and give personalized insights"; prioritized over meeting-series analysis).

## Guiding principle

The end goal is a durable, reusable per-user context base — like Claude's `MEMORY.md` — that the app keeps building up over time and can draw on for many purposes.
The stored context is the primary asset; any given screen, insight, or nudge is just one consumer of it.
So: keep the memory schema general and view-agnostic, expect its consumers to change, and treat "repurpose it differently later" as a supported outcome, not a rewrite.

## Context: what already exists (do NOT rebuild)

Per-speaker accumulating memory is already implemented end-to-end:
- Storage: `speaker.profile` (text) holds a structured ontology JSON per speaker, scoped by `user_id` (Microsoft `sub`). RLS `speaker_owner_all` isolates rows per user. No tenant/org column exists anywhere.
- Accumulation: the `generate-profile` Supabase edge function takes an `existingProfile` and MERGES the new transcript into it (keep old unless corrected, prefer newer on conflict, dedupe projects/relationships/responsibilities/open_threads, resolve threads, bump `last_updated_at`). So "context over time" already accrues.
- Ontology shape (`src/lib/speakerOntology.ts`, mirrored server-side): `professional_context {company, role, domains}`, `active_projects[]`, `relationships[]`, `responsibilities[]`, `open_threads[]`, `aliases[]`, `identity_confidence`, per-item `confidence`.
- UI: three places render/edit it — post-summary flow (`TranscriptionSummary.tsx`), History "Sync Profile" modal (`SummaryHistory.tsx`), and the Speaker tab in `AccountSettings.tsx`. Profiles are also fed back into summary generation via `buildSpeakerContextForSummary`.
- Trigger: MANUAL button only.

The "self" speaker: the `speaker` row whose name matches the logged-in user's MS display name is shown as "<name> (me)" (`ensureSelfSpeakerRow.ts`, `matchSpeakerIdentity.ts`). There is no separate user-level memory schema — the self row uses the same ontology as anyone else.

## The genuine gaps (= what the Memory feature adds)

- A: profiles update only on a manual button, not automatically after each meeting.
- B: no automatic identification of an unknown transcript speaker ("Speaker A") to a known person — always manual today.
- C: no per-app-user memory/insights distinct from the "self" speaker row.

## Decisions (2026-08-04)

| # | Decision | Choice |
|---|---|---|
| Scope | Which gaps in the Memory feature | All three (A + B + C), delivered in phases below |
| Identification signal (B) | How to match unknown speakers | Text/context LLM matching (reuse Gemini; no voice biometrics, no new infra) |
| Update trigger | When memory updates | Automatically right after the meeting summary completes |
| Privacy/retention | Data posture | Per-user isolation (same `user_id` RLS as `speaker`); user can view and delete their memory. No extra retention/expiry policy in v1. |

## Phased plan

Phases build on each other; each ships and is verified independently.

**Implementation order (revised 2026-08-04): F1b is being built FIRST.** The user's most acute pain is the manual, per-speaker relabeling required on every uploaded recording, so automatic speaker identification (F1b) is the first slice. F1b can run against the EXISTING (manually built) speaker profiles plus name-mention signals — it does not strictly require F1a. F1a will later auto-enrich the profiles that F1b matches against, improving its accuracy. F1c comes last.

**Voice-based identification — decided against for now (2026-08-04).** Azure Speaker Recognition was RETIRED in Sept 2025, so there is no longer a cheap managed cloud option. Remaining voice paths: paid cloud (money), open-source self-hosted (free software but needs always-on compute — clashes with the no-server-budget constraint), or on-device (Picovoice Eagle: no server cost, free dev tier with caps, but real app engineering). Decision: ship the FREE text/context approach first, measure how much it reduces manual work, and only revisit voice — via on-device (Eagle), not a paid cloud API — if text proves insufficient.

### F1a — Automatic accumulation (foundation)
- Turn the manual "generate/sync profile" into an automatic step after summary generation: for each speaker present in the finished note, call `generate-profile` with the current `existingProfile` and save the merged result.
- Reuses the existing edge function and ontology. Smallest change; mostly pipeline wiring + idempotency (don't double-update the same note twice).
- Decisions to honor: auto-trigger after summary (Q3); per-user isolation already holds.
- Open: cost/rate — one Gemini call per distinct speaker per meeting; batch or cap. Handle failures without blocking the summary (memory update is best-effort, alert on failure per existing `alerts.ts`).

### F1b — Automatic speaker identification (suggestion-based) — FIRST TO BUILD

Goal: when a note's transcript has anonymous labels ("Speaker A/B/C"), suggest which known person each is, so the user confirms instead of typing every one.

Signals (text-only, no voice):
1. Direct address / name mentions — vocatives in the transcript ("Thanks, Hansoo", "Andrew, what do you think?"), self-intro ("this is Jin"). Often the strongest textual signal.
2. Profile/topic matching — compare each anonymous speaker's aggregated utterances (projects, responsibilities, relationships) against the user's known `speaker` ontologies; best match + confidence.
3. Self prior — the logged-in user is almost always present and is the uploader; bias toward labeling one speaker as the self-speaker when address/among signals support it.

Approach: one LLM call (Gemini, as generate-profile already uses). Input = transcript with anonymous labels + candidate roster (the user's known speakers with brief profile summaries) + the logged-in user's identity. Output = per anonymous label: suggested speakerId/name (or "unknown/new"), confidence 0..1, short rationale.

v1 behavior (defaults; confirm before coding):
- Run location: NEW Supabase edge function `identify-speakers`, called client → Supabase direct and auth-gated like generate-profile (works even while the Render backend is suspended).
- Trigger: auto right after summary generation (Q3), store the suggestions on the note so the diarized editor can pre-fill instantly; also expose an on-demand "re-suggest" action.
- UI: SUGGESTION-first, never silent relabel. A "suggested roster" banner atop the diarized transcript — per speaker "Speaker A → Hansoo (85%) [accept]" — plus "Apply all" that only auto-applies high-confidence rows; low-confidence left for manual pick. Reuses the existing `applySpeakerReplacements` path in `TranscriptDiarizedEditor.tsx`.
- Confidence handling: show suggestions ≥ a floor (e.g. 0.5); "Apply all" only for ≥ a high bar (e.g. 0.75). Tune after measuring.

Out of scope (v1): voice-fingerprint/biometric matching; silent auto-relabel without user confirmation; identifying first-time speakers who have no profile and are never named (left "unknown/new").

First E2E slice: existing note with anonymous labels + user's known speakers → `identify-speakers` returns suggestions → banner shows them → user taps accept → labels update via existing replacement logic. Verify on web against a real saved note.

### F1c — Per-user personal memory (durable context base + personalized insights)
Direction confirmed 2026-08-04.

**The real deliverable is a durable, reusable per-user context base — analogous to Claude's `MEMORY.md`, not a fixed dashboard.** The store is the primary asset; the dashboard/insights below are just the FIRST consumer of it. Design the storage as a general-purpose, structured context base so future consumers (real-time in-meeting context surfacing, series analysis, export, etc.) can read the same base. Do NOT hardcode the schema to one screen. It is also explicitly OK to repurpose the base for different uses later.

What it aggregates (user-centered, ACROSS all the user's meetings — this is what makes it distinct from the per-speaker "self" profile, which only captures what the user personally said):
- The user's open action items / commitments, gathered from many meetings into one list — including items assigned to the user even when someone else stated them.
- Frequent collaborators (people across all the user's meetings, by frequency/recency).
- The user's active projects and their status.
- Recurring topics / decisions made in the user's meetings.

First consumer — a personal "Memory" screen + personalized nudges built on the base, e.g. "3 open commitments from last week," "Project X not discussed in 2 weeks," "you said you'd follow up with Jin — still open."

Boundary vs. F3: F1c is USER-centered across all their meetings; F3 (meeting-series analysis) is trend analysis WITHIN a specific recurring meeting. F1c's base can later feed F3.

Schema decision (deferred to F1c kickoff): a new `user_memory` table keyed by `microsoft_id`/`user_id` (RLS-isolated), holding a structured context base (not view-specific), vs. reusing the self-speaker ontology with a flag. Lean toward a dedicated general-purpose store given the "reusable base" principle.
- Privacy (Q4): user can view and delete this record.

## Explicitly out of scope (v1)
- Voice biometrics / speaker embeddings for identification.
- Cross-user or tenant/org-level shared memory (no tenant column exists; keep everything `user_id`-scoped).
- Automatic silent relabeling of speakers without user confirmation (F1b is suggestion-only).
- Retention/auto-expiry policies (Q4 = not in v1).
- Meeting-series trend analysis (that is a separate standup item, F3, sequenced AFTER this).

## Open questions to resolve at each phase kickoff
- F1a: per-speaker Gemini call cost/batching; idempotency key for "already accumulated this note".
- F1b: confidence threshold to show a suggestion; UI placement (Change-Speaker menu vs. a review banner).
- F1c: exact definition of "personalized insights"; new table vs. self-speaker extension; how it relates to the existing self-speaker row.

## References
- Existing ontology: `src/lib/speakerOntology.ts`, `src/components/SpeakerOntologyView.tsx`.
- Edge function (merge engine): `supabase/functions/generate-profile/index.ts`.
- Speaker identity helpers: `src/lib/matchSpeakerIdentity.ts`, `src/lib/ensureSelfSpeakerRow.ts`.
- Manual trigger UIs: `src/pages/TranscriptionSummary.tsx`, `src/pages/SummaryHistory.tsx`, `src/pages/AccountSettings.tsx` (Speaker tab).
- Standup roadmap: `OPS_BACKLOG.md` section F.
