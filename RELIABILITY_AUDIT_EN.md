# Summary: Why Demos Keep Breaking

There are 3 root patterns.

1. **Errors are silently swallowed**: On failure, only `console.error` fires and the UI pretends everything is fine. Users just see "where did my data go?" or "why isn't this button working?"
2. **Zero retries on transient failures**: A single network blip or one Graph API 429 marks the entire workflow as failed.
3. **Giant files + logic triplicated**: The same logic is copy-pasted 3 times across 4,000-line pages, so fixing one copy leaves the others broken.

---

## Critical (instant demo killers)

| # | Location | Problem |
|---|---|---|
| C1 | `src/context/RecorderContext.tsx:836-844` | **Starting a second recording kills the new recording.** The effect cleanup runs on every `recordedAudioUrl` change and stops the freshly created stream/timer. |
| C2 | `workflow-server/src/index.ts:1826,1915` | On server restart/deploy/crash, in-flight jobs are **stuck in `processing` forever.** The client polls uselessly for a full hour. |
| C3 | `TranscriptionSummary.tsx:894-901` + `index.ts:1966,559` | Polling runs every 2.5s but **a single failed poll fails the whole job.** Worse, the backend calls Graph `/me` on every poll, so one Graph hiccup marks a healthy job as "failed." |
| C4 | `src/main.tsx`, `App.tsx` | **No React Error Boundary anywhere in the app.** One render error in a 4,000-line page = white screen. |
| C5 | `src/config/supabaseConfig.ts:37-56` | If the token isn't ready within 5 seconds, queries **silently proceed with the anon key** → RLS returns empty results → "No notes found" with no error. The main culprit behind "my data disappeared during the demo." |
| C6 | `src/context/AuthContext.tsx:90-133` + `supabaseConfig.ts:62` | When the token exchange (MSAL → Graph → edge function) fails, there is no retry and **every DB query cascades into failure.** In redirect mode, it triggers a **full page reload**, destroying all state including in-progress recordings. |
| C7 | `AuthContext.tsx:108` + `supabase-token` | The Supabase JWT lives exactly 60 minutes and refreshes only when less than 60s remain. The refresh chain (MSAL → Graph → edge fn) has no timeout, retry, or dedup. **A 1-hour demo hits a cliff at ~59 minutes.** |
| C8 | `TranscriptionSummary.tsx:891-1096` | **Refreshing mid-summary loses the job entirely** (jobId never persisted). Navigating away leaves the polling loop calling setState on an unmounted component. |
| C9 | `src/lib/msalRedirect.ts:12-14` | A touch-capable laptop with viewport ≤1024px (projector, split-screen) is **misclassified as mobile and switched to redirect mode** → combined with C6, token refresh = page reload. Exactly the live-demo hardware profile. |

## High (likely to occur during a demo)

**Reliability (no retries/checkpoints)**

- `index.ts:1150` The AssemblyAI poll loop has no try/catch; one network error = entire job dead.
- `index.ts:1601-1783` No checkpoints between stages: if summarization fails, the already-paid-for transcript is discarded and everything reruns from scratch.
- `index.ts:1684` + `parsers.ts:25` The production summary path has no recovery when `JSON.parse` on Gemini output fails (the test path does).
- `index.ts:673` Zero retries on Gemini 429/500/503.
- `index.ts:1586` Job status write failures are swallowed with `console.warn`: even completed jobs can be left as `processing`.
- `RecorderContext.tsx:485,597` Final chunk saves are fire-and-forget, so **the last ~2 seconds of a recording can be lost.**

**Silent failures (UI shows false success)**

- `SummaryHistory.tsx:875,1799,1765` Title/summary edits on shared notes are **0-row updates shown as success**; they vanish on refresh.
- `SummaryHistory.tsx:749` Notes fetch failure = empty list rendered, no error UI.
- `SummaryHistory.tsx:1745` Audio playback error messages are built, then dumped to console only.
- `SummaryHistory.tsx:1608` Signed audio URLs cached forever, ignoring expiry.
- `TranscriptionSummary.tsx:1891` Upload failure reason is stored but the screen shows only a generic "Error" pill.

**Config/Security**

- `msalConfig.ts:17`, `supabaseConfig.ts:13` Missing env vars boot silently with placeholders, failing later with cryptic errors. No `.env.example`; Supabase vars undocumented in the README.
- `supabase-token`: `verify_jwt=false` + no tenant validation means **any Microsoft account worldwide can mint an authenticated JWT.**
- `generate-profile`: No authentication at all; anyone can burn the Gemini quota → summaries die mid-demo.
- `Project.tsx:552` n8n webhook has no timeout (a hang = spinner forever) and a hardcoded URL.

## Medium (summary)

- `alert()`/`confirm()` everywhere (6 in SaveSummary, 3 in TranscriptionSummary): browser modals on the demo screen.
- No duplicate-submission protection: a double-click = paying for the pipeline twice.
- Every search keystroke runs a full-table `select('*')` (including transcripts), with no debounce.
- Speaker profile generation uses `Promise.all`: one speaker failing fails all of them.
- Several useEffects lack cancelled flags (stale responses clobber fresh data).
- `stopRecording` awaits the `onstop` event with no timeout: if it never fires, the Stop button hangs forever.
- The synchronous `/summarize-audio` endpoint holds an HTTP request open 30+ minutes (fragile against proxy timeouts).

## Structural Issues

- **`SummaryHistory.tsx` at 4,175 lines** = data layer + calendar engine + audio playback engine + 12 mutation handlers + UI (the note detail pane is copied 3 times), with ~50 useState hooks.
- **Identical logic copied verbatim across 3 pages**: profile-sync modal, forward-to-Teams modal, playback engine, transcript persistence, etc. The 0-row-update bug is actually fixed in one copy but not the other two.
- **`workflow-server/src/index.ts` at 2,164 lines** = routing + multipart parsing + 3 vendor clients + job orchestration + persistence in one file.
- No shared data-access layer: every page hand-rolls its own Supabase queries and optimistic updates.

---

# Improvement Proposal (Prioritized Roadmap)

**Phase 1: Demo survival kit (maximum impact for minimum work)**

1. Add Error Boundaries (global + per-route).
2. Fix the C1 recording cleanup bug.
3. Polling resilience: tolerate N consecutive failures + persist jobId to localStorage for refresh recovery.
4. Remove the anon fallback: show an explicit "authenticating" state when auth isn't ready.
5. Proactive token refresh (at ~50 min, in the background) + retry on exchange failure.
6. Clean up orphaned jobs at server boot + retry job status writes.

**Phase 2: Make errors visible**

- Wire swallowed catches to UI error states (error + retry button instead of an empty list).
- Remove `alert()`; standardize on inline errors/toasts.
- Treat 0-row updates as failures (propagate the `.select().maybeSingle()` pattern).
- Fail-fast env validation + add `.env.example`.

**Phase 3: Structural improvements**

- Stage checkpoints in the pipeline + a retry wrapper for vendor calls.
- Extract a shared data layer (`useNotes`/`useNoteActions`); remove the triplication.
- Break up the giant pages.
- Close the edge-function auth holes (tenant validation, generate-profile auth).
- **[Backlog, found 2026-07-24 deploy]** Prod frontend serves the Vite **dev** server (`meetingnote.tecace.com` returns `/@vite/client` + raw `/src/main.tsx`): source is publicly readable, unminified, with the HMR client live in prod. Switch the Render frontend to `vite build` + static serve (or `vite preview` / a static host).

Phase 1 alone will noticeably change perceived demo stability.
The security issue (missing tenant validation in supabase-token) should be addressed soon, independently of demo concerns.
