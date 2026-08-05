# Operations Backlog

Last updated: 2026-08-05.
Goal: make running and maintaining Meeting Note easier and calmer, at (near) zero cost.
Cost posture update (2026-08-05): the project now pays for **Supabase Pro**. Render is still the free-tier concern; the "near zero cost" goal now means "Render free + a small paid Supabase floor," not strictly $0.
Boss's actual ask, as understood: operational peace of mind — e.g. "when the Render server goes down, a warning email arrives at the company address."
So the backlog is ordered by that: visibility/alerting first (what the boss wants now), then removing the things that break (durable fixes), then distribution/maintenance chores.
The 2026-08-04 standup added a product-feature track (section F) and re-prioritized: the "Memory" feature is now prioritized over meeting-series analysis, and the 2-hour recording cutoff is promoted from deferred to immediate.
The 2026-08-05 standup added: the 50 MB upload limit fix (ASAP, now unblocked by Supabase Pro — see R9), a knowledge-base/wiki auto-generation direction (F4), an admin-dashboard access task (R10), and a clearer two-part framing of the Memory feature (see F1).

Priority tiers: P0 = boss-visible, low effort, do first. P1 = durable root-cause fixes. P2 = quality-of-life. F = product features (2026-08-04 / 2026-08-05 standups).

> Time-sensitive facts below (backend suspended, unpushed commits, device versions, Render reset date) reflect 2026-07-31. Before acting on any of them, re-verify against the live source: `git status`/`git log` for commit state, the Render dashboard for service/usage state, and `adb devices` + the installed app version for phones.

---

## System at a glance

What Meeting Note is: an AI meeting-notes app. A user records or uploads meeting audio; the system transcribes it (speaker-labeled), summarizes it with an LLM, and stores a note. There is a web app and an Android app (iOS not yet shipped).

| Piece | Where it runs | Role | Status (2026-07-31) |
|---|---|---|---|
| Frontend (React/Vite) | Render **static site** | Web UI. Reads Supabase directly; calls the backend + edge functions. | Up |
| **workflow-server** (Node HTTP, aka `meeting-note-backend`) | Render web service | The summarize pipeline: submit audio to AssemblyAI, **poll up to 30 min**, run Gemini summary, write the note. Also accepts Android multipart audio uploads. | **Suspended** (free-hour cap) |
| **MCP server** (`meeting-note-mcp`) | Render web service | Exposes meeting notes to Claude / claude.ai via MCP. | **Suspended** (free-hour cap) |
| Supabase | Supabase cloud | Postgres DB (`note`, `file`, `summary_prompt`, `workflow_usage`, ...), Storage (`meeting-recordings` bucket), and Edge Functions (below). | Up (independent of Render) |
| Supabase Edge Functions | Supabase cloud | `supabase-token` (mints the app JWT, tenant-gated), `note-audio-url` (auth-gated signed audio URL), `generate-profile` (speaker profile via Gemini — "the gate"). | Up |
| Android app (Flutter) | User devices | Native recording + upload. | Manual APK distribution |

Audio data flow: the client uploads audio **directly to the Supabase Storage `meeting-recordings` bucket**, then sends only a signed URL (JSON) to workflow-server. AssemblyAI fetches that URL itself, so the server never streams the audio (exception: the current Android path multiparts the file through workflow-server to temp disk first). This is why audio still uploads even while the backend is down — only the transcribe/summarize step is blocked.

External APIs: **AssemblyAI** (transcription, `universal-2`), **Gemini** (summary + speaker profile), **Azure MSAL / Microsoft Graph** (login).

## Glossary / key facts (self-contained, so this file needs no external notes)

- **The 750h cap / why the backend is suspended**: Render's free web-service tier gives ~750 instance-hours per **month, shared across the whole workspace**. One always-on service alone is ~744h. Two always-on Node services (backend + MCP) need ~1,400h > 750h, so both get suspended partway through the billing cycle and auto-resume at the next monthly reset. The static frontend and Supabase are unaffected. (Not a bandwidth issue — audio bypasses the server.)
- **"The gate"**: the auth check at the top of `supabase/functions/generate-profile/index.ts`. It requires an authenticated user — primarily the **app JWT** minted by `supabase-token` (tenant-gated), or a Microsoft Graph token as fallback. Without it, anyone holding the public Supabase anon key could call generate-profile and burn the org's Gemini quota. **Deployed live 2026-08-04** (see R1); anon-key-only calls now 401.
- **"JWT build" vs "anon-key app"**: the current client build sends the minted app JWT with its requests (passes the gate). An older build sent only the Supabase anon key (would get 401 once the gate is live). All active clients must be on the JWT build before the gate is deployed.
- **Devices**: `Z Fold` (adb id `R3CY405BXYW`) = the user's phone, running **vc2003** (versionCode 2003 = the JWT build; app version `0.1.1+2003`). `S23` (adb id `R5CWB1HN1XN`) = the user's other phone. `boss phone` = the boss's Android. "vcNNNN" = Android versionCode.
- **Render reset date**: unconfirmed — check the service's Usage tab on the Render dashboard. The suspended backends auto-resume at the next monthly cycle.

---

## P0 — Operational visibility / alerting (what the boss wants)

### P0.1 Turn on Render failure/suspension emails to the company address
- What: Render already emails the account owner on service failure, deploy failure, and free-tier suspension. Point/extend those notifications to the company email (add team members or set the notification email).
- Why: This is most of the boss's ask ("warn me when it goes down") with almost no work. The current suspension likely already generated an email to the account owner that just is not going to the company inbox.
- Effort: minutes (dashboard settings).
- Cost: $0.
- Note: verify exactly which events Render emails on (failure vs. free-hour suspension may differ).

### P0.2 External uptime monitor with email alert
- What: UptimeRobot free (or Better Stack free) pings the frontend URL and a backend health endpoint every ~5 min; emails on down.
- Why: Independent of the host; catches "site not responding" even when Render's own alerts miss it. Gives the boss a status page link.
- Effort: ~30 min.
- Cost: $0 (UptimeRobot free = 50 monitors, 5-min interval).
- CAUTION: pinging a Render free service keeps it awake and burns the shared 750 instance-hours/month (see render-free-tier suspension). So either (a) only monitor the static frontend + Supabase, not the sleepy backend, or (b) accept this once the always-on backend is removed (P1.1). Do NOT add a keep-alive pinger to the free backend.

### P0.3 Job-level failure alert (already partially built)
- What: workflow-server has `src/alerts.ts` (`sendWorkflowAlert`). Confirm where it sends and make it notify the company email on a failed/stranded summarize job.
- Why: "A meeting failed to process" is more useful to the boss than raw uptime. Reuses existing code.
- Effort: small (verify + wire recipient).
- Cost: $0–low (depends on the email channel already in alerts.ts).
- Status 2026-08-04: recipients now default to BOTH `genekim@tecace.com` and `andrewyoo@tecace.com` (`WORKFLOW_ALERT_TO` overrides). Coverage confirmed comprehensive (500 handler, unhandledRejection, uncaughtException, job failure). ACTIVATION GAP (config, not code): `RESEND_API_KEY` must be set on Render, Resend sender domain must be verified to send to tecace.com addresses, and the backend must be un-suspended. Standup validated the direction (automated error reporting via email). See section F self-healing note (F2) for the AI-analysis extension.

---

## P1 — Remove the things that break (durable root-cause fixes)

### P1.1 Kill the always-on polling backend → event-driven (webhook) on Supabase [BIGGEST LEVER]
- What: Replace the 30-minute AssemblyAI polling loop in workflow-server with AssemblyAI's webhook callback.
  1. Submit the transcript job to AssemblyAI with a `webhook_url` pointing at a Supabase Edge Function.
  2. AssemblyAI calls that function on completion.
  3. The function runs the single Gemini summarization call and writes the note.
- Why: Eliminates the always-on Render backend entirely. That one change removes, at once:
  - monthly free-hour suspension (nothing always-on left to exceed 750h),
  - stranded jobs on deploy/restart (the wait is now AssemblyAI's async problem, not ours),
  - one of the two Node services (halves what must be deployed/monitored),
  - most of the P0 monitoring worry (little left to go down).
- Effort: real re-architecture (days, needs testing). NOT free in dev time.
- Cost to run: $0 (moves onto Supabase, already a dependency).
- Validate first:
  - AssemblyAI webhook support (yes) + how it authenticates callbacks.
  - Gemini summarization + attachment handling fits Supabase Edge Function execution-time limits (summary is ~1 call, usually < 1 min → likely fits; attachments/large transcripts need a check).
  - Where the current Android multipart upload path (buffers to temp disk in workflow-server) moves — likely client → Supabase Storage direct, same as web.

### P1.2 Consolidate or idle the MCP server
- What: `meeting-note-mcp` runs always-on and shares the free-hour budget. Decide: is it needed in prod 24/7? If low-traffic, make it on-demand, fold it in, or drop it.
- Why: A second always-on free service is half the reason the 750h cap blew. Removing/idling it eases the cap even before P1.1 lands.
- Effort: small–medium.
- Cost: $0.

### P1.3 Decide the honest hosting posture (bring to boss)
- What: Present the free-but-fragile vs. cheap-but-solid choice. A ~$5–7/mo VPS (Hetzner) or Render paid instance removes fragility and self-management. Oracle Cloud Always Free is powerful but self-managed with idle-reclamation/capacity/account caveats (details in the render-free-tier memory).
- Why: If the boss wants "calm operations," the cheapest reliable answer is often coffee-money hosting, not more free-tier gymnastics.
- Effort: one conversation.
- Cost: $0 (free path) or ~$5–7/mo (paid path).

---

## P2 — Distribution & maintenance quality-of-life

### P2.1 Mobile distribution channel (stop manual adb)
- What: Firebase App Distribution (free) — upload the APK, testers (boss/S23) get an install+update link. iOS can ride the same tool later (still needs an Apple account + Mac to build).
- Why: Replaces build → adb install → copy-to-desktop with a link. Makes the "everyone on the JWT build" precondition (blocks the generate-profile gate) trivial to satisfy and verify.
- Effort: ~half day first setup, trivial after.
- Cost: $0.

### P2.2 Unify / document deploys
- What: After P1.1, deploy targets drop from 4 (frontend, backend, MCP, edge functions) + manual APK to ~3. Document the one-command deploy for each; add push-to-deploy where missing.
- Why: Fewer manual, order-sensitive steps (the generate-profile gate coordination is a symptom of this).
- Effort: small, ongoing.
- Cost: $0.

### P2.3 Clean up env/secret sprawl
- What: One documented source of truth per environment; remove placeholder/template .env confusion (workflow-server/.env was once a template with `your-project-ref`). See env-setup-local memory.
- Why: Prevents "which key is real" incidents during ops/debugging.
- Effort: small.
- Cost: $0.

---

## F — Product features (from 2026-08-04 standup)

Feature track surfaced at the 2026-08-04 standup. Ordered by the standup's stated priority: Memory feature first (explicitly prioritized over meeting-series analysis), then the support/feedback loop, then series-level analytics. Speaker A = the user (Andrew); Speaker B = the boss.

### F1 "Memory" feature — per-user accumulated context [IMMEDIATE, prioritized over meeting analysis]
- What: accumulate individual user context over time (across their meetings) so the system can (a) automatically identify/label speakers and (b) surface personalized insights. A durable per-user memory store that grows with each meeting.
- Why: standup called this the near-term priority, ahead of meeting-series analysis. Auto speaker identification directly improves the transcript/summary quality and reduces manual speaker labeling.
- Owner / next step: Speaker A (user) begins architecture research + initiates development.
- Effort: feature-scale (research → design → build). Needs a requirements-clarification pass before coding.
- Open questions to resolve first: where the memory lives (Supabase table vs. vector store), scope (per-user vs. per-tenant), how speaker identity is keyed and matched, privacy/retention.
- 2026-08-05 framing (Hansoo): treat Memory as TWO kinds — (1) personal profile/preference memory (per-user traits; the auto-accumulating speaker profile already covers this) and (2) meeting context/knowledge memory (facts, decisions, threads across meetings; feeds F4 knowledge-base/wiki). Keep the store general enough to serve both. Status: F1a (auto-accumulate profile) + F1b (auto speaker suggest) shipped on branch `memory/user-context` (committed, not pushed); F1c (per-user personal memory table) designed, not built. See MEMORY_FEATURE_DESIGN.md.

### F2 User feedback + support section, with AI bug-report analysis
- What: an in-app user feedback/support section. Speaker B's suggestion: feed submitted bug reports to an AI that produces actionable repair steps for engineers. Overlaps the self-healing/error-reporting direction (P0.3) — the AI-analysis layer on top of raw error capture.
- Why: shortens the report → diagnosis → fix loop; gives users a support channel.
- Effort: medium (UI + intake pipeline + AI analysis step).
- Note: reality-check from prior discussion — AI can triage/summarize a report and suggest steps, but cannot auto-fix infra-class failures (e.g. quota/suspension). Scope it as triage assistance, not auto-remediation.

### F3 Meeting-series analysis / trend + frequent-topic tracking [future]
- What: metadata aggregation across a series of related meetings — track trends and frequently mentioned topics over time.
- Why: higher-level insight across recurring meetings, not just single-note summaries.
- Owner: Speaker A to explore metadata aggregation.
- Effort: feature-scale. Explicitly sequenced AFTER F1 per standup.

### F4 Knowledge base / wiki auto-generation (2026-08-05 standup)
- What: auto-generate wiki-style knowledge pages from meeting notes, using the speaker/meeting ontology. Builds on the Memory feature's meeting-context/knowledge side (F1, kind 2).
- Why: turns accumulated meeting knowledge into a browsable, durable KB instead of isolated note summaries.
- Owner / next step: Hansoo to share reference LLM-wiki materials (video shared 2026-08-05). Speaker A to fold into Memory design.
- Effort: feature-scale. Sequenced with/after F1's knowledge-memory half.

---

## Recommended sequence
1. P0.1 + P0.2 now — cheap, and directly answers the boss's "warn me when it's down."
2. P1.2 (idle MCP) — quick relief on the free-hour cap.
3. P1.1 (webhook-ization) — the big one; schedule it deliberately, it removes most future ops pain.
4. P1.3 conversation + P2 chores alongside.

Standup 2026-08-04 immediate work (parallel to ops track): R6 (2-hour cutoff + measure impact), R1 web positive test (deploy done), and F1 (Memory feature research/architecture — the standup's top feature priority).

---

## Outstanding project items (non-ops, parked here for one source of truth)

These are feature/deploy/cleanup items already in flight or deferred, unrelated to the ops-simplification themes above but tracked here so nothing is lost.

### R1 Deploy the generate-profile auth gate — DONE 2026-08-04
- DEPLOYED 2026-08-04 to project `smnnlamrwisqaquymsdl` via `npx supabase functions deploy generate-profile --project-ref smnnlamrwisqaquymsdl`. Standup 2026-08-04 approved.
- Deploy auth note: Windows Credential Manager keyring read was broken (`supabase login` stored a token the CLI could not read back), so deploy required a Personal Access Token in the `SUPABASE_ACCESS_TOKEN` env var. If redeploying, use a PAT.
- Verified BOTH directions: negative — anon-key-only POST → HTTP 401 `{"error":"Invalid JWT format."}` from our own gate; positive — logged-in web session (Sync Profile on an existing note) generated speaker profiles successfully. Unauth Gemini-quota burn is now blocked; real app JWT is accepted. R1 CLOSED.
- Rollback if ever needed: `git checkout <prev> -- supabase/functions/generate-profile/index.ts && npx supabase functions deploy generate-profile`.
- Residual risk: any active phone still on the old anon-key build gets 401 on profile-gen only (rest of app unaffected). Web ✅, Z Fold ✅ (vc2003). Boss phone / S23 = still unconfirmed → see R4.
- See pending-generate-profile-gate memory.

### R2 Merge ui/dark-mode-theming → main
- Do before/with R1. Branch head 8db861c pushed to origin. This branch now also carries the recording-bitrate fix (99b336f) and the iOS skill (fed1b06).

### R3 Push the two unpushed commits
- `99b336f` (recording 32 kbps cap) and `fed1b06` (iOS IPA skill + .gitignore) are committed on ui/dark-mode-theming but not pushed. Web bitrate cap only reaches web testers after a merge-to-main deploy (blocked while Render backend is suspended anyway).

### R4 APK rollout to boss phone + S23
- Z Fold has vc2003 (JWT app). Boss phone and the user's S23 need the new APK. Ties into R1's precondition and P2.1 (Firebase App Distribution would make this a link).

### R5 iOS test build (free 7-day personal team)
- Runbook exists: `.claude/skills/build-ios-ipa/SKILL.md`. Needs a Mac (hand to the designer) + an Apple ID; free personal-team install is USB-tethered, 7-day. No paid account (boss won't pay $99/yr).
- Standup 2026-08-04: Speaker B (boss) will coordinate with **TGX** for the iOS **release account** to streamline the current manual build process. So a proper (paid/managed) iOS release path may be unblocked via TGX rather than the free personal-team route above.

### R6 Two-hour auto-stop recording — PROMOTED to immediate (2026-08-04 standup)
- No longer deferred. Standup made this an immediate task; Speaker A (user) to implement the 2-hour cutoff AND measure the file-size / storage-cost impact on Supabase. Motivation restated at standup: optimize file size and storage cost.
- Auto-stop recording at 2h on app + web. Suggested: Android `MediaRecorder.setMaxDuration(7200000)` + OnInfoListener (works in background); web/iOS timer. Behavior: auto-stop + save, light on-stop notification.
- Pairs with the recent 32 kbps audio cap (commit 99b336f) — both are storage-cost levers.

### R7 Correct the handoff doc
- `.claude/handoffs/2026-07-29-reliability-darkmode-handoff.md` records R5CWB1HN1XN as the boss's phone; it is actually the user's phone.

### R8 Commit OPS_BACKLOG.md
- This file is currently untracked/uncommitted. Commit when ready.

### R9 Raise the 50 MB upload limit (Supabase Pro) — IN PROGRESS 2026-08-05
- Problem (2026-08-05 standup, ASAP): recordings/uploads over ~50 MB fail. Root cause is NOT in code and NOT Render — it is the **Supabase free-tier per-file storage upload cap (50 MB)**. Both web and mobile upload the audio to the `meeting-recordings` bucket, then hand only a signed URL to workflow-server; AssemblyAI fetches the URL itself, so Render never touches the bytes. So the only limiter is Supabase storage.
- Now unblocked: project moved to **Supabase Pro** (cap raisable to 50 GB).
- Work on branch `fix/supabase-upload-limit`:
  1. Migration `20260805120000_raise_meeting_recordings_upload_limit.sql` → bucket `meeting-recordings` file_size_limit = 200 MB (209715200).
  2. Web client `MAX_FILE_SIZE` 100→200 MB, single `oversizedFileMessage` helper, size check enforced in `uploadToSupabase` for BOTH file-picker and recording paths + a Supabase-413 backstop → clear "File too large" message to the user.
  3. Web recording bitrate 32→64 kbps (`RecorderContext.tsx`) — the 32 kbps was only to fit the old 50 MB cap; 64 kbps improves transcription fidelity (esp. AAC/Safari, noisy rooms), transcription cost is per-hour not per-byte, and 200 MB ≈ 7 h at 64 kbps.
- REQUIRED external step (dashboard, not code): raise the **project-wide** storage Upload file size limit to ≥ 200 MB (Storage > Settings). The effective cap is min(project, bucket); until this is done the migration has no effect.
- Follow-up (mobile, separate release): bump `recording_service.dart` bitrate 32→64 kbps and the audio guard (`notes_repository.dart:443`, currently 100 MB) to 200 MB, and consider resumable upload — mobile currently `readAsBytes()` buffers the whole file in memory (unsafe for very large files).
- Verify E2E after the dashboard step: a >50 MB recording/upload uploads AND transcribes.

### R10 Admin dashboard access (2026-08-05 standup)
- What: Speaker A (Andrew) cannot access the admin dashboard; a permission/role setup issue. Owner: Hansoo to confirm the account's role/permission.
- Why: needed to operate/monitor via the dashboard (`AdminControls` / `AdminAnalytics` gated by `adminAccess`).
- Effort: small (permission/config).

---

Deeper context (OPTIONAL): Claude auto-memory files `render-free-tier-suspend`, `reliability-effort`, `pending-generate-profile-gate`, `env-setup-local`, `ops-backlog-and-boss-priority`.
NOTE: those memories live in a machine-local folder (`.claude/projects/.../memory/`), NOT in this repo. They resolve only for a Claude session on the original author's machine — a human teammate or fresh clone cannot read them. Every fact needed to act on this backlog is already inlined above (System at a glance + Glossary), so the memories are a bonus, not a dependency.
