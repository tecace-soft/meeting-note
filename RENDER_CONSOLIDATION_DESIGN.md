# Render Cost Consolidation — Design

Status: CODE MERGE DONE (2026-08-31), infra cutover pending.
Owner: Andrew Yoo.

## 0. Status update (2026-08-31)

Decision (from the 3-service reality Gene Kim confirmed: `meeting-note` = frontend, PAID; `meeting-note-backend` + `meeting-note-mcp` = FREE Node web services that split the 750h and suspend at month-end):

- **Shape 2 chosen.** Frontend (`meeting-note`, a pure Vite SPA) → free Render **Static Site** (CDN, no cold-start, no hours). The **paid** instance is repurposed for the merged **backend + MCP** (no 750h limit → month-end suspension gone). This avoids coupling frontend uptime to a backend crash and stops paying a web service just to `serve` static files.
- **Code merge = DONE and verified locally (Option A).** MCP moved from `mcp-server/` to `workflow-server/src/mcp/`; `startHttpServer()` refactored to `handleMcpRequest(req, res, url): Promise<boolean>`; dispatched FIRST in the workflow-server `node:http` handler. One npm package, unioned deps, one build/start. `npm run build` clean, `npm test` 67/67. E2E on a local `node build/index.js`:
  - host owns `/health` + `/version` (MCP falls through) ✓
  - `POST /mcp` no-auth → 401 (fail-closed) ✓; `POST /mcp-chatgpt` no-auth → 401 + `WWW-Authenticate` resource-metadata ✓
  - `/.well-known/oauth-protected-resource` → metadata JSON ✓; `/admin` → 200 ✓
  - workflow routes intact; unknown → host 404 ✓
- Standalone `mcp-server/` dir removed on `main`; rollback lives on the **`mcp-server` branch** (untouched). ⚠️ Never `git push origin main:mcp-server` again (main has no `mcp-server/`; it would break the live standalone).

**Remaining (infra / console — Andrew, cannot be done from code):**
1. Convert `meeting-note` (frontend) to a Render **Static Site** (build `npm run build`, publish `dist/`, SPA rewrite `/* → /index.html`). Keep its custom domain.
2. On the **paid** service, deploy the merged workflow-server from `main` (build+start = workflow-server). Copy the union of both services' env vars (workflow + all `MCP_*`) onto it.
3. URL decision (Section 3): custom domains (`api.` + `mcp.`) vs one-time subdomain change + connector re-point. Update web `VITE_WORKFLOW_API_URL` + rebuild APK to the backend URL; point MCP connectors at the MCP URL.
4. Verify merged `/mcp` (Claude) + `/mcp-chatgpt` (ChatGPT) + a real summarize job on the cutover URL, THEN delete the two free services (`meeting-note-backend`, `meeting-note-mcp`).
5. At cutover, also: drop the `mcp-server` row in `scripts/versions.cjs`, and update the MCP connector URL shown to users in `src/pages/AccountSettings.tsx` + `meeting-note-mobile/.../settings_screen.dart`.

---

Problem: the account runs out of Render's shared **750 free instance-hours/month** and the backend gets SUSPENDED near month-end (observed 2026-08-28: `/version` → 503 "Service Suspended"). See `render-free-tier-suspend`, `OPS_BACKLOG.md`.

## 1. Why we're over 750h

Three deploy targets, only TWO of which consume instance-hours:

| service | Render type | hours? | URL | referenced by |
| --- | --- | --- | --- | --- |
| Frontend (Vite build) | **Static site** | NO (free) | `meetingnote.tecace.com` | browsers |
| **workflow-server** (Node) | Web service | YES | `meeting-note-backend-njfb.onrender.com` | web (`VITE_WORKFLOW_API_URL`), mobile (compiled) |
| **MCP server** (Node) | Web service | YES | `meeting-note-mcp.onrender.com` | ChatGPT / Claude connectors (user-configured), web, mobile |

Two always-active Node web services ≈ 2 × ~730h ≈ **1460h ≫ 750h** shared → suspension.
History (git): the split ACCRETED — frontend first (2025-12), MCP added (2026-05-19 "MCP server init"), backend created (2026-06-01) by moving the workflow OUT of n8n into a custom Node server. Nobody sized the combined footprint for the free tier. So this is cost-optimization, not fixing a bug.

Goal: get to **≤ 1 always-active Node web service on Render** → one 24/7 service ≈ 730h < 750h → survives the month.

## 2. Two ways to get there

### Option A — CONSOLIDATE: merge MCP into the workflow-server (one Render web service) — RECOMMENDED
Both servers are raw `node:http` `createServer` with path routing (backend `index.ts:3232`, MCP `transports/http.ts:362`), so merging is a **routing dispatch**, not a rewrite.

- Refactor the MCP HTTP layer to export `handleMcpRequest(req, res, url): Promise<boolean>` (returns true when it owned the route). Move its per-request logic (auth, `runWithScopedUserId`, `StreamableHTTPServerTransport`) behind that function; drop the always-on `startDiagnostics` timers (they only matter for a dedicated process).
- In the workflow-server `createServer` handler, dispatch FIRST: `if (await handleMcpRequest(req, res, url)) return;` then fall through to the existing backend routes.
- Own the MCP paths: `/mcp`, `/mcp-chatgpt`, `/.well-known/oauth-protected-resource*`. Resolve collisions — both define `/health`, `/version`, `/admin`: keep the backend's `/health` + `/version`, move the MCP admin dashboard under `/mcp/admin`.
- Packaging: consolidate into ONE npm package (move `mcp-server/src` under `workflow-server/src/mcp/` and union the deps: `@modelcontextprotocol/sdk`, `jose`, `zod`, `@azure/msal-browser`), so Render builds + starts one process.
- Env: union both services' env vars on the surviving service.
- Deploy: everything from `main` (retire the `mcp-server` branch pipeline).

Pros: lowest effort, no new platform, deterministic ≤750h, reuses all code.
Cons: the heavy summary jobs and MCP share ONE 512MB instance (marginal OOM risk — MCP is light); one deploy cadence (an MCP change now restarts the backend — already survives restarts via `failOrphanedJobs`).

### Option B — MOVE: MCP off Render to a Node serverless host (Vercel Functions / Cloudflare Workers)
MCP is already STATELESS per request (`sessionIdGenerator: undefined`), the key prerequisite. A Node-runtime serverless host can run the existing `node:http`-based transport with a thin handler adapter (Supabase edge / Deno needs a Fetch rewrite of the transport — more work, so NOT the first choice).

Pros: keeps the heavy backend ISOLATED on Render; MCP gets free auto-scaling serverless.
Cons: new platform + deploy pipeline + env migration; edge/serverless request-time limits (long tool calls); the node:http→serverless-handler adapter; connector URL migration.

### Not now — Option C: webhook-ize the backend so it needn't be always-on (`OPS_BACKLOG` P1.1)
The structural fix (async/webhook summarization → the backend can spin down) removes the always-on requirement entirely. Bigger effort; the real long-term answer, out of scope for this pass.

## 3. The hard part either way — URL stability

The **MCP URL is the expensive one to change**: `meeting-note-mcp.onrender.com/mcp` + `/mcp-chatgpt` are configured by USERS inside their ChatGPT/Claude connectors, so a URL change means every user reconfigures. The backend URL is referenced only by web (env var → redeploy) and mobile (compiled → APK rebuild), which WE control.

Recommended URL strategy (do this ONCE, then never again): put **stable custom domains** on the surviving service, leveraging the `tecace.com` DNS the frontend already uses:
- `api.meetingnote.tecace.com` → backend routes (point web `VITE_WORKFLOW_API_URL` + mobile at this).
- `mcp.meetingnote.tecace.com` → MCP routes (`/mcp`, `/mcp-chatgpt`).

Render allows multiple custom domains on one service, both routed by path. After this, the service can be renamed/moved/merged freely without ever touching a connector again.
Cheap fallback (no DNS work): accept a one-time change to the surviving onrender subdomain, update web env + rebuild the APK, and tell connector users to re-point once.

## 4. Recommended plan (Option A + custom domains)

1. Add `api.` and `mcp.` custom domains (TecAce DNS → the merged service) BEFORE cutover, so the connector URL is decoupled from the onrender subdomain.
2. Refactor MCP into `handleMcpRequest(...)`; merge into `workflow-server` (one package, unioned deps, path dispatch, `/mcp/admin`, dropped diagnostics timers).
3. Update `scripts/versions.cjs` (drop the separate MCP `/version` row or point it at the merged host) and `RUNBOOK.md`.
4. Point web (`VITE_WORKFLOW_API_URL`) + mobile at `api.meetingnote.tecace.com`; keep MCP connectors on `mcp.meetingnote.tecace.com`.
5. Deploy the merged service from `main`; verify `/health`, `/version`, `/mcp` (Claude), `/mcp-chatgpt`, and a real summarize job. Then DELETE the standalone MCP Render service (frees its hours).

Rollback: keep the `mcp-server` service definition until verified; if the merged MCP misbehaves, redeploy the standalone MCP service and re-point `mcp.` back to it.

## 5. Verification / done

- Render usage graph shows ONE active Node web service; projected monthly hours < 750.
- Claude + ChatGPT connectors still work against `mcp.meetingnote.tecace.com` (no user reconfiguration).
- Web + mobile summarize/transcribe work against `api.meetingnote.tecace.com`.
- Survives a full month with no month-end suspension (the real test).

## 6. Open decisions (confirm before building)

- **Approach: A (merge, recommended) vs B (MCP → serverless).** A is least effort and no new platform; pick B if keeping the heavy backend isolated from MCP matters more than effort.
- **URL: custom domains (permanent, needs TecAce DNS access) vs one-time onrender-subdomain change (no DNS, but connector users re-point once).**
- Who has the Render dashboard + TecAce DNS access to do the domain + service changes (infra steps I cannot do from code).
