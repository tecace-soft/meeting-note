# Meeting Note — Operations Runbook

Operator-facing guide: how to run, deploy, monitor, and troubleshoot the system.
For the WHY / decision history / backlog, see `OPS_BACKLOG.md`; this file is the "how do I operate it" companion.
Last updated: 2026-08-17.

---

## 1. What runs where

| Piece | Where | URL | Health check |
|---|---|---|---|
| Frontend (React/Vite) | Render **static site** | `meetingnote.tecace.com` (prev `meeting-note-fxms.onrender.com`) | load the page |
| **workflow-server** (Node; aka `meeting-note-backend`) | Render web service | `meeting-note-backend-njfb.onrender.com` | `GET /health`, `GET /version` |
| **MCP server** (`meeting-note-mcp`) | Render web service | `meeting-note-mcp.onrender.com` | `GET /version` |
| Supabase (Postgres + Storage + Edge Functions) | Supabase cloud | project `smnnlamrwisqaquymsdl` | Supabase dashboard |
| Android app (Flutter) | user devices | n/a | installed build / `adb` |

External APIs: **AssemblyAI** (transcription), **Gemini** (summary/insight/RCA, pinned to `gemini-2.5-flash-lite` for cost), **Azure MSAL / MS Graph** (login), **Resend** (alert/issue email).

Audio flow: client uploads audio DIRECTLY to Supabase Storage (`meeting-recordings`), then sends only a signed URL to workflow-server; AssemblyAI fetches that URL itself.
So audio upload keeps working even when the backend is down — only transcribe/summarize is blocked.

---

## 2. Deploy — each piece has a DIFFERENT target

> **The single most important operational fact:** the three services deploy from three different sources. Pushing to `main` does NOT redeploy the MCP server.

| Piece | Deploy trigger |
|---|---|
| **workflow-server** | auto-deploys on push to **`main`** |
| **MCP server** | auto-deploys on push to the **`mcp-server`** branch → ship with `git push origin main:mcp-server` (fast-forward). Root Directory = `mcp-server/`. |
| **Frontend** | Render static site, auto-deploys from **`main`** (verify the connected branch on the Render dashboard) |
| **Edge Functions** | Supabase CLI: `supabase functions deploy <name>`, not tied to a git push. The 8: `supabase-token` (mints the app JWT, tenant-gated), `mcp-token` (mints MCP personal tokens), `note-audio-url` (signed audio URL), `generate-profile` ("the gate": auth-required speaker profile), `identify-speakers` (speaker suggestion), `update-user-memory` (memory fold), `admin-analytics`, `admin-controls`. |
| **Android app** | `meeting-note-mobile/build_apk.sh` → APK → `adb install` / manual share. Auto-tags `mobile-v<ver>` via GitHub Action on a pubspec version bump. |
| **iOS** | Owned by the Korea side (needs a Mac); not built here. |

**Confirm what is live:** `GET /version` on workflow-server and MCP returns `{ shortSha, branch, deployedAt }` (from `RENDER_GIT_COMMIT`).
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

MCP server (Render → `meeting-note-mcp`): `MCP_API_KEY` (static-key auth; keep secret), `MCP_ALLOW_ANON_CHATGPT_FALLBACK` (default off), plus the same Supabase creds.

---

## 6. Common incidents

**"The site / backend is down."**
First check the Render dashboard Usage tab.
The most common cause is the free-tier **750h monthly suspension**: two always-on Node services (backend + MCP) exceed the shared 750h, so both suspend partway through the billing cycle and auto-resume at the next monthly reset.
The static frontend and Supabase are unaffected (and audio upload still works).
Options: wait for the reset, or take the paid-host decision (OPS_BACKLOG P1.3, on hold).

**"A meeting failed to process."**
Look for an F9 ops ticket on `/issues` (it has the RCA), and/or the job-failure email.
Check the `workflow_job` row status in Supabase.
Jobs are safe once submitted (server-side); the client resumes to `/processing/{jobId}` on reopen.

**"Which commit is live?"**
`GET /version` on workflow-server and MCP. Frontend: check the Render deploy.

**"Deployed to main but the MCP server didn't change."**
Expected — MCP deploys from the `mcp-server` branch. Run `git push origin main:mcp-server`.

**"Schema-dependent code broke after deploy."**
A repo migration may not be applied in prod. Verify the column/table/function exists (Supabase SQL Editor / `information_schema`), apply the missing migration idempotently, and record it. See OPS_BACKLOG P1.4.

---

## 7. Known fragilities / accounts to watch

- **Free-tier 750h cap** → monthly suspension of both Node services (above). The durable fix (webhook-ize the backend to remove the always-on service) is OPS_BACKLOG P1.1, on hold.
- **Azure auth app registration `f81ec595-…` is on Gene's PERSONAL account** (tenant `a141d6e8-…`). Escalate transfer to a TecAce org account — losing that account risks login for the whole app.
- **Supabase Pro is paid** (storage). Render services are free-tier (hence the cap).
- **Devices:** Z Fold (`adb R3CY405BXYW`) on `com.tecace` build; S23 (`R5CWB1HN1XN`). Boss has an Android.
- **iOS** is Korea-owned; auth redirects for `com.tecace` are registered in Azure.

---

## 8. Local dev quickstart

- Frontend: root `.env` (`VITE_WORKFLOW_API_URL`, Supabase, MSAL) → `npm run dev`.
- workflow-server: `workflow-server/.env` (Supabase service role + Gemini at minimum) → `npm run dev`; `npm run build`; `npm test`; `npm run env:check` (doctor that flags placeholder values); `npm run eval` / `eval:gate` (F8 memory/insight quality gate).
- Do NOT commit real secrets; keep `.env` out of git.
