# Meeting Note — Operations Runbook

Operator-facing guide: how to run, deploy, monitor, and troubleshoot the system.
For the WHY / decision history / backlog, see `OPS_BACKLOG.md`; this file is the "how do I operate it" companion.
Last updated: 2026-09-01.

---

## 1. What runs where

| Piece | Where | URL | Health check |
|---|---|---|---|
| Frontend (React/Vite) | Render **static site** | `meetingnote.tecace.com` (prev `meeting-note-fxms.onrender.com`) | load the page |
| **workflow-server** (Node; aka `meeting-note-backend`) | Render web service | `meeting-note-backend-njfb.onrender.com` | `GET /health`, `GET /version` |
| **MCP server** | **MERGED into workflow-server** (same process, code under `workflow-server/src/mcp/`). Owns `/mcp`, `/mcp-chatgpt`, `/.well-known/oauth-protected-resource*`, `/admin/*`. | served by the workflow-server host | `GET /version` (host) |
| MCP server — standalone (SUSPENDED, rollback) | old Render web service `meeting-note-mcp`, now **suspended** on Render (kept as a rollback, not deleted). Its URL no longer serves while suspended. | `meeting-note-mcp.onrender.com` (dead while suspended) | n/a |
| Supabase (Postgres + Storage + Edge Functions) | Supabase cloud | project `smnnlamrwisqaquymsdl` | Supabase dashboard |
| Android app (Flutter) | user devices | n/a | installed build / `adb` |

External APIs: **AssemblyAI** (transcription), **Gemini** (summary/insight/RCA, pinned to `gemini-2.5-flash-lite` for cost), **Azure MSAL / MS Graph** (login), **Resend** (alert/issue email).

Audio flow: client uploads audio DIRECTLY to Supabase Storage (`meeting-recordings`), then sends only a signed URL to workflow-server; AssemblyAI fetches that URL itself.
So audio upload keeps working even when the backend is down — only transcribe/summarize is blocked.

---

## 2. Deploy — each piece has a DIFFERENT target

> **Operational fact:** the deployables ship from different sources. Frontend + workflow-server (now including the merged MCP) deploy from `main`; Edge Functions deploy via the Supabase CLI; the mobile app is a manual APK build. (Historically the MCP was a separate `mcp-server`-branch service — now merged in and the standalone suspended as a rollback; see below.)

| Piece | Deploy trigger |
|---|---|
| **workflow-server** | auto-deploys on push to **`main`** |
| **MCP server** | **MERGED into workflow-server** → deploys from **`main`** with the backend (one process, one Render web service). ⚠️ Do NOT run `git push origin main:mcp-server` anymore: `main` no longer contains `mcp-server/`, so that push would break the still-live standalone service. The standalone `meeting-note-mcp` service (old `mcp-server` branch) is now **suspended** on Render as a rollback (merged MCP verified on the backend URL 2026-09-01: auth + tools/list + a real tool call); NOT deleted yet — delete only after it has proven stable across a full month. |
| **Frontend** | Render static site, auto-deploys from **`main`** (verify the connected branch on the Render dashboard) |
| **Edge Functions** | Supabase CLI: `supabase functions deploy <name>`, not tied to a git push. The 8: `supabase-token` (mints the app JWT, tenant-gated), `mcp-token` (mints MCP personal tokens), `note-audio-url` (signed audio URL), `generate-profile` ("the gate": auth-required speaker profile), `identify-speakers` (speaker suggestion), `update-user-memory` (memory fold), `admin-analytics`, `admin-controls`. |
| **Android app** | `meeting-note-mobile/build_apk.sh` → APK → `adb install` / manual share. Auto-tags `mobile-v<ver>` via GitHub Action on a pubspec version bump. |
| **iOS** | Owned by the Korea side (needs a Mac); not built here. |

**Confirm what is live:** `GET /version` on workflow-server returns `{ shortSha, branch, deployedAt }` (from `RENDER_GIT_COMMIT`). The merged MCP shares this host, so there is no separate MCP `/version`.
After any deploy, poll `/version` until the new SHA shows.

**Prod DB schema changes:** apply via the **Supabase SQL Editor** (paste SQL), then record the migration.
The migration ledger (`supabase_migrations.schema_migrations`) was backfilled to 34 rows on 2026-08-17; going forward, prefer `supabase db push` so it self-records (see OPS_BACKLOG P1.4).
There is no Management-API token wired into automation — schema DDL is a human SQL-Editor step.

---

## 3. Monitoring & alerting — where warnings come from

| Signal | Source | Goes to |
|---|---|---|
| Service down / deploy failed / free-tier suspended | **Render's own emails** | the Render **account owner** (currently Gene's PERSONAL account) |
| A summarize job failed / uncaught server error | `sendWorkflowAlert` (P0.3) | `WORKFLOW_ALERT_TO` (default `genekim@tecace.com,andrewyoo@tecace.com`) via Resend |
| App-level failure, with an auto-RCA | **F9 ops agent** → F2 board ticket + email | `/issues` board (see §4) + `WORKFLOW_ALERT_TO` |

**Not covered (parked):** an external uptime monitor for "server is up but not responding" and company-address routing (OPS_BACKLOG P0.1/P0.2). CAUTION if you add one: do NOT ping the free Render backend on a schedule — it burns the shared 750h budget.

---

## 4. Operating the F9 ops agent

F9 watches the workflow-server's OWN error events (job failure, HTTP 500, uncaught/unhandled) and, for each new failure class, drafts an RCA and files a ticket. It NEVER edits or deploys code (diagnosis only; auto-fix was permanently dropped).

- **Where the tickets are:** the F2 board at `/issues`. Filter by `area = 'ops'` / author `Ops Agent (F9)`. The RCA (summary / root causes / checks / fix plan / verification) shows in the ticket's "AI 해결책" block.
- **De-dup:** a repeat of the SAME failure only bumps the ticket's occurrence counter (no new ticket, no new email).
- **Storm cap:** at most `F9_MAX_NEW_TICKETS_PER_HOUR` (default 10) NEW tickets per hour; beyond that, new classes are dropped with a log line (bounds board/inbox/Gemini cost).
- **Turn it off:** set `F9_OPS_AGENT_ENABLED=false` on the workflow-server (Render), redeploy/restart. Default is on.
- **A ticket appeared — what to do:** read the RCA, run its "checks", fix by hand, then set the ticket status to DONE/CLOSED. F9 never fixes anything itself.

---

## 5. Key env vars (Render → workflow-server)

| Var | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | DB/Storage (service role, bypasses RLS) |
| `GEMINI_API_KEY` | summary / insight / F9 RCA |
| `GEMINI_SUMMARY_MODEL` | model (prod = a real value; keep non-empty — empty falls back to `gemini-2.5-flash-lite`) |
| `ASSEMBLYAI_API_KEY` | transcription |
| `RESEND_API_KEY`, `WORKFLOW_ALERT_FROM`, `WORKFLOW_ALERT_TO` | alert + issue + F9 email (Resend, `tecace.com` verified sender) |
| `F9_OPS_AGENT_ENABLED`, `F9_MAX_NEW_TICKETS_PER_HOUR` | F9 on/off + storm cap |
| `MEMORY_CONSOLIDATION_ENABLED` | F1'' memory dedup consolidation pass (default on; one extra flash-lite call per fold when memory has ≥6 items) |

MCP env vars are now **live on the workflow-server service** (copied over from the old `meeting-note-mcp` service 2026-09-01, since the MCP is merged there): `MCP_API_KEY` (static-key auth; keep secret), `MCP_ALLOW_ANON_CHATGPT_FALLBACK` (default off), `MCP_TOKEN_PEPPER`, `MCP_OAUTH_RESOURCE`/`MCP_OAUTH_SCOPE`/`MCP_AZURE_TENANT_ID` (ChatGPT OAuth), `MCP_ADMIN_EMAILS`/`MCP_ADMIN_MICROSOFT_IDS`/`MCP_ADMIN_CLIENT_ID` (admin dashboard), plus the same Supabase creds.

- ⚠️ **`MCP_TOKEN_PEPPER` must match the value the standalone used** — personal MCP tokens are hashed with it (`sha256(pepper:token)`), so a different pepper 401s every existing token. If the standalone had no explicit pepper it falls back to `SUPABASE_SERVICE_ROLE_KEY`; in that case leave it unset here too (don't add one).
- **`MCP_PUBLIC_BASE_URL` + `MCP_OAUTH_RESOURCE` are URL-specific** — set them to the workflow-server (backend) URL, not the old mcp URL.
- ⚠️ **Env-wipe footgun (hit 2026-09-01):** MCP_* env added on Render vanished (unsaved changes / env group not linked). Always click **Save Changes** and reload to confirm they persisted. Note: the `.well-known/oauth-protected-resource*` payload is all code defaults/host-derivation, so it looks correct even with NO MCP env set — do NOT use it as proof the env is present; test `GET /mcp` with a real token instead.

---

## 6. Common incidents

**"The site / backend is down."**
First check the Render dashboard Usage tab.
Historically the free-tier **750h monthly suspension**: two free Node services (backend + MCP) drew against the shared 750 instance-hour/month HARD CAP; their combined draw exhausted it near **month-end**, so they suspended on the last day(s) of the cycle and auto-resumed at the next monthly reset. (Free services spin down when idle, so the draw is usage-driven — not a flat 24/7 2× figure.)
As of 2026-09-01 the MCP is merged into workflow-server and the standalone `meeting-note-mcp` is **suspended**, leaving ONE always-on free Node service (~730h) which should stay under 750h — check the Usage tab; a suspension should no longer happen once this holds through month-end.
The static frontend and Supabase are unaffected (and audio upload still works).
Options: wait for the reset, or take the paid-host decision (OPS_BACKLOG P1.3, on hold).

**"A meeting failed to process."**
Look for an F9 ops ticket on `/issues` (it has the RCA), and/or the job-failure email.
Check the `workflow_job` row status in Supabase.
Jobs are safe once submitted (server-side); the client resumes to `/processing/{jobId}` on reopen.

**"Which commit is live?"**
`GET /version` on workflow-server (the merged MCP shares this host). Frontend: check the Render deploy.

**"Deployed to main but the MCP server didn't change."**
No longer applicable — the MCP is merged into workflow-server and deploys from `main` with the backend. Do NOT run `git push origin main:mcp-server` (the `mcp-server` branch is the rollback for the suspended standalone; pushing `main` there would clobber it). Verify the merged MCP with `GET /mcp` (expect 401 without a token) on the workflow-server host. The user-facing connector URL is now `meeting-note-backend-njfb.onrender.com/mcp` (Claude) and `/mcp-chatgpt` (ChatGPT).

**"Schema-dependent code broke after deploy."**
A repo migration may not be applied in prod. Verify the column/table/function exists (Supabase SQL Editor / `information_schema`), apply the missing migration idempotently, and record it. See OPS_BACKLOG P1.4.

---

## 7. Known fragilities / accounts to watch

- **Free-tier 750h cap** → historically suspended both Node services monthly. Mitigated 2026-09-01 by merging the MCP into workflow-server + suspending the standalone `meeting-note-mcp`, leaving ONE free Node service. NOT yet proven across a full month. The durable fix (webhook-ize the backend to remove the always-on service) is OPS_BACKLOG P1.1, on hold.
- **Azure auth app registration `f81ec595-…` is on Gene's PERSONAL account** (tenant `a141d6e8-…`). Escalate transfer to a TecAce org account — losing that account risks login for the whole app.
- **Supabase Pro is paid** (storage). Render services are free-tier (hence the cap).
- **Devices:** Z Fold (`adb R3CY405BXYW`) on `com.tecace` build; S23 (`R5CWB1HN1XN`). Boss has an Android.
- **iOS** is Korea-owned; auth redirects for `com.tecace` are registered in Azure.

---

## 8. Local dev quickstart

- Frontend: root `.env` (`VITE_WORKFLOW_API_URL`, Supabase, MSAL) → `npm run dev`.
- workflow-server: `workflow-server/.env` (Supabase service role + Gemini at minimum) → `npm run dev`; `npm run build`; `npm test`; `npm run env:check` (doctor that flags placeholder values); `npm run eval` / `eval:gate` (F8 memory/insight quality gate).
- Do NOT commit real secrets; keep `.env` out of git.
