# Operations Backlog

Last updated: 2026-08-06.
Goal: make running and maintaining Meeting Note easier and calmer, at (near) zero cost.
Boss's actual ask, as understood: operational peace of mind (e.g. "when the Render server goes down, a warning email arrives at the company address").
So the backlog is ordered by that: visibility/alerting first (what the boss wants now), then removing the things that break (durable fixes), then distribution/maintenance chores.
The 2026-08-04 standup added a product-feature track (section F). The **2026-08-06 meeting** (Hansoo Lee, Andrew Yoo, Eun Seok Lee) set a hard sprint: memory (dynamic ontology), metadata indexing, and context-based diarization each need an **alpha/beta by 2026-08-13 (next Wed)**. Immediate this-week items: **200MB upload cap + 2-hour recording cutoff** (both due 2026-08-06), and the **app package rename to `com.tecace.*` + Azure auth**.

Priority tiers: P0 = boss-visible, low effort, do first. P1 = durable root-cause fixes. P2 = quality-of-life. F = product features (2026-08-04 standup).

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

## F — Product features

Feature track from the 2026-08-04 standup, expanded at the 2026-08-06 meeting (Hansoo Lee, Andrew Yoo, Eun Seok Lee).

> **SPRINT — alpha/beta by 2026-08-13 (next Wed):** F1' dynamic-ontology memory, F4 metadata index layer, F5 context-based diarization. These three are the committed near-term deliverables.

### F1 "Memory" feature — SHIPPED (F1a + F1b + F1c) 2026-08-05, verified E2E on prod
- Per-user accumulated context: F1a auto-accumulate speaker profiles, F1b auto speaker-ID suggestion (suggestion-only), F1c personal `user_memory` rollup (open action items / collaborators / active projects / recurring topics). Live on prod: `user_memory` table, `update-user-memory` edge fn, minimal read-only Memory tab in AccountSettings. Full detail in `MEMORY_FEATURE_DESIGN.md`.
- Minor polish TODO: collaborators sometimes include the user themselves (prompt says exclude).
- **F1' — dynamic relational memory [SPRINT, due 2026-08-13].** Owner: Andrew (all software). Boss feedback 2026-08-06: the shipped F1c memory is too fact-oriented (flat buckets); the boss wants "long-term memory like ChatGPT" that is context + relation oriented. Direction locked = **hybrid**: narrative memory notes (ChatGPT/Claude-MEMORY.md style) with **update/supersede** dynamic learning, backed later by a light entity-relation graph that feeds F4/F5. Alpha = narrative + supersede layer (no new UI design → Andrew-solo). Full design in `MEMORY_FEATURE_DESIGN.md` ("F1' — Dynamic relational memory").

### F4 Metadata index layer [SPRINT, due 2026-08-13]
- What: a metadata-based index layer over meeting-note data so search is efficient and token consumption drops (retrieve by index instead of feeding whole transcripts to the LLM).
- Why: turns stored notes into a queryable knowledge base and cuts Gemini token cost.
- Owner: Hansoo Lee is researching the approach; Andrew implements (all software). Eun Seok Lee is the designer, involved only if a screen needs new design.

### F5 Context-based diarization [SPRINT, due 2026-08-13] — CORE GOAL
- What: shift speaker separation from pure voice-pattern matching to **context-based** identification (infer who is speaking from conversational context, not only acoustic signature). Builds on F1b's text/context speaker-ID.
- Why: diarization accuracy is central to UX; the strategic move is voice-centric to context-centric.
- Owner: Andrew.

### F2 User feedback + support section, with AI bug-report analysis
- What: an in-app user feedback/support section. Boss's suggestion: feed submitted bug reports to an AI that produces actionable repair steps for engineers. Overlaps the self-healing/error-reporting direction (P0.3): the AI-analysis layer on top of raw error capture.
- Why: shortens the report-to-diagnosis-to-fix loop and gives users a support channel.
- Effort: medium (UI + intake pipeline + AI analysis step).
- Note: reality-check. AI can triage/summarize a report and suggest steps, but cannot auto-fix infra-class failures (e.g. quota/suspension). Scope it as triage assistance, not auto-remediation.

### F6 Personal voice-memo feature [new, exploratory]
- What: a personal voice-memo capture in the app. Discussed as a stepping stone toward agent-driven auto report generation (F7).
- Owner: TBD.

### F7 Agent-based auto report generation [future]
- What: an agent over accumulated memo/meeting data that auto-generates reports. Confirmed as a future expansion path of F6.

### F3 Meeting-series analysis / trend + frequent-topic tracking [future]
- What: metadata aggregation across a series of related meetings; track trends and frequently mentioned topics over time. Overlaps F4's index layer.
- Why: higher-level insight across recurring meetings, not just single-note summaries.
- Owner: Andrew to explore. Sequenced after the F1'/F4/F5 sprint.

---

## Recommended sequence
Current top priority (per 2026-08-06 meeting) is the product sprint due 2026-08-13: F1' (dynamic ontology), F4 (index layer), F5 (context diarization). The due-today items (R6 2-hour cutoff, R9 200MB cap) shipped + deployed 2026-08-06; what remains on them is E2E verification and a mobile device build. Also unblock R11 (Azure access via Gene).
Ops track runs in the background (the boss's peace-of-mind ask):
1. P0.1 + P0.2 now: cheap, and directly answers the boss's "warn me when it's down."
2. P1.2 (idle MCP): quick relief on the free-hour cap.
3. P1.1 (webhook-ization): the big one; schedule it deliberately, it removes most future ops pain.
4. P1.3 conversation + P2 chores alongside.

---

## Recently shipped (2026-08-04 → 08-06)

Condensed from full entries; details live in git history + `MEMORY_FEATURE_DESIGN.md` + Claude memory.
- **generate-profile auth gate** (was R1): deployed to prod, verified both directions (anon-key POST 401, app-JWT accepted). Unauth Gemini-quota burn blocked.
- **dark-mode theme + 32 kbps audio cap + iOS build skill** (was R2/R3): merged to main, live on web.
- **APK rollout** (was R4): Z Fold (vc2003), boss phone, and S23 on the JWT build.
- **Memory feature F1a+F1b+F1c**: per-user memory shipped + verified E2E on prod (see F1 above).
- **Admin dashboard access for Andrew Yoo** (`andrewyoo@tecace.com`, oid `31d79bfe-...`): granted in all 3 places (client `adminAccess.ts` + `admin-analytics` + `admin-controls`), deployed.
- **Supabase Pro**: paid; storage upload cap is now raiseable (see R9).
- **OPS_BACKLOG committed + tracked** (was R8).

---

## Active / near-term (non-ops)

### R6 Two-hour auto-stop recording — SHIPPED 2026-08-06 (web deployed; mobile needs build)
- Web + mobile: at 2h a recording auto-stops and saves, a non-blocking warning shows in the final 5 min, and the user starts a new recording to continue. Commit `e1f9629`, merged to main (`21a4f05`).
- Web (`RecorderContext` timer + `FloatingRecorderWidget`/`TranscriptionSummary` UI) is live via the Render redeploy. Mobile (Dart ticker in `recording_service.dart` + `ForegroundRecordingService.kt` `setMaxDuration(7200000)` native backstop for backgrounded Android) is in `main` but NOT on devices until an APK/IPA build ships (pair with the R11 rename build).
- Remaining: E2E verify (smoke-test by temporarily lowering `MAX_RECORDING_SECONDS`); measure real file-size/storage impact.

### R9 200MB upload limit + clear over-limit error — SHIPPED 2026-08-06 (E2E verify left)
- Decision (2026-08-06 meeting): cap uploads at 200MB for cost/perf; show a clear error when a file exceeds it. Root cause of the old ~50MB failure was the Supabase free-tier per-file storage cap (not Render, not code); Supabase Pro made it raiseable.
- DONE: prod caps set to 200MB (209715200) on BOTH the project-wide storage config AND the `meeting-recordings` bucket, applied via the Management API (`/config/storage` PATCH + a `storage.buckets` UPDATE) and verified. Web guard (`MAX_FILE_SIZE` 200MB) + `oversizedFileMessage` + Supabase-413 backstop + 64 kbps web recording, merged to main (`21a4f05`) and deployed.
- Remaining: E2E-verify a >50MB file uploads AND transcribes end to end. (Mobile 64 kbps + audio guard 200MB already shipped: `154ac33`, `b8f68e7`. Resumable upload moved to R12.)

### R12 Mobile upload/processing robustness (from the 2026-08-06 backgrounding analysis)
- Context: on Android the upload + job-submit path has NO background protection (no foreground service, wake lock, WorkManager, or notification — unlike recording, which has a foreground service). Pressing power during "Uploading..." (before the job is submitted) risks a throttled/killed upload with no resume, because `ActiveJob` is persisted only AFTER the jobId is returned. Once the job is submitted it is safe: the work is server-side and the app resumes to `/processing/{jobId}` on reopen (`main.dart`). The upload is also `file.readAsBytes()` (whole file in memory, single PUT).
- **R12.1 Keep the upload alive when the screen is off**: a wake lock or a short foreground service during upload so a backgrounded upload still completes.
- **R12.2 Real completion notification**: the processing screen says "we'll notify you" but there is NO notification code. Add a local notification (`flutter_local_notifications`) on job completion so the copy is honest and the user need not reopen the app. Cheapest of the three; pure honesty fix.
- **R12.3 Resumable/chunked upload**: replace `file.readAsBytes()` + single PUT with a streamed/resumable upload. Fixes both the RAM cost on large (up to 200MB) files and mid-upload interruption tolerance.
- All mobile; reach devices only via a build. Low urgency (the cold-start "Could not reach" was a first-in-months event, and phase-2 is already safe), but R12.2 is cheap and worth doing.

### R11 App package rename `com.example.*` → `com.tecace.*` + Azure auth — WAITING on the Korea dev's rename commit
- Why: `com.example.*` is rejected by both the App Store and Google Play, so it must change before either release. Nothing is store-published yet, so now is the cheapest time (no Play applicationId lock).
- IDs: iOS bundle `com.tecace.meetingNoteMobile`; Android applicationId/package `com.tecace.meeting_note_mobile`.
- **Azure redirects: DONE 2026-08-06.** The new redirects are registered on app registration `f81ec595-...` (tenant `a141d6e8-...`): iOS `msauth.com.tecace.meetingNoteMobile://auth` + Android `msauth://com.tecace.meeting_note_mobile/guC64kbNdu%2Bbu67b7Ujd62XWb3s%3D`. Old `com.example` redirects kept during migration, so the current build keeps working.
- **Source rename: the Korea-side dev will commit it** (Andrew's side waits, does not touch the package ids to avoid a double commit / conflict). As of 2026-08-06 the repo (main + `origin/mobile-app`) is still `com.example.*` everywhere. The 6 spots that must change together or Android login breaks: `build.gradle.kts` namespace + applicationId, `AndroidManifest.xml` `android:host`, kotlin `package` x2 (MainActivity + ForegroundRecordingService) + folder path, `auth_config.dart` redirect (package prefix only), iOS `project.pbxproj` + `Info.plist` bundle id.
- Signing unchanged: same debug keystore (verified: `keytool | openssl` on `meeting-note-debug.keystore` = `guC64kbNdu+bu67b7Ujd62XWb3s=`). The redirect **signature hash stays**; only the package prefix changes. No new keystore for a rename.
- After the rename lands: build APK/IPA and verify login works on the new `com.tecace.*` redirects. This build is also what carries the mobile 64 kbps + 2h cutoff + 200 MB guard to devices.
- **RISK to escalate**: prod auth (app registration `f81ec595-...`) still lives on the predecessor Gene's PERSONAL account. Push to transfer ownership to a TecAce org account.

### R5 iOS release path (via TGX)
- Runbook: `.claude/skills/build-ios-ipa/SKILL.md`. Free personal-team install is USB-tethered, 7-day, no paid account. Boss to coordinate with **TGX** for the iOS **release account** to replace the manual build. Bundle id finalizing under R11.

### R7 Correct the handoff doc
- `.claude/handoffs/2026-07-29-reliability-darkmode-handoff.md` records R5CWB1HN1XN as the boss's phone; it is actually the user's phone.

---

Deeper context (OPTIONAL): Claude auto-memory files `render-free-tier-suspend`, `reliability-effort`, `pending-generate-profile-gate`, `env-setup-local`, `ops-backlog-and-boss-priority`.
NOTE: those memories live in a machine-local folder (`.claude/projects/.../memory/`), NOT in this repo. They resolve only for a Claude session on the original author's machine — a human teammate or fresh clone cannot read them. Every fact needed to act on this backlog is already inlined above (System at a glance + Glossary), so the memories are a bonus, not a dependency.
