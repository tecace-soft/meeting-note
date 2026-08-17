# Local development & E2E verification

Runbook for running the app locally with real authentication, so reliability
changes (especially auth/token work) can be verified end-to-end the way a real
user hits them.

## 1. Prerequisites (one-time)

Fill in real credentials. Copy the example files and edit:

```bash
cp .env.example .env
cp workflow-server/.env.example workflow-server/.env
```

Where to get the values:

- **MSAL** (`VITE_MSAL_CLIENT_ID`, `VITE_MSAL_AUTHORITY`): Azure Portal > App
  registrations > your app. Ensure `http://localhost:5174` is a registered SPA
  redirect URI.
- **Supabase** (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and the server's
  `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`): Supabase dashboard > Project
  Settings > API. The service role key is server-only — never put it in the
  frontend `.env`.
- **AssemblyAI / Gemini** (`ASSEMBLYAI_API_KEY`, `GEMINI_API_KEY`): from the
  respective provider dashboards, or copy from the Render service env if you own
  the internal-test deployment.

Install deps (root deps already present; workflow-server installed):

```bash
npm install
cd workflow-server && npm install && cd ..
```

## 2. Run both servers

Two terminals:

```bash
# Terminal 1 — frontend (http://localhost:5174)
npm run dev

# Terminal 2 — workflow backend (http://localhost:8787)
cd workflow-server && npm run dev
```

`VITE_WORKFLOW_API_URL` in the frontend `.env` must point at the backend
(`http://localhost:8787`).

## 3. Baseline checks (no secrets needed)

```bash
npx tsc --noEmit                      # frontend typecheck
npx vite build                        # frontend build
cd workflow-server && npm test        # backend unit tests (parsers)
```

## 4. E2E verification scenarios

Run these in the real browser against the two local servers. These are the
flows the reliability work targets — verify the fix by reproducing the failure
first, then confirming it no longer happens.

### Core pipeline
1. **Record → summarize**: record audio, stop, summarize. Confirm the summary
   appears and the note is saved.
2. **Second recording** (regression for the recorder cleanup fix): after a first
   recording completes, start a second one. The timer must advance and the new
   recording must produce audio (previously the second recording died).
3. **Poll resilience** (resilient-polling fix): start a summarize job, then
   briefly kill the backend (`Ctrl+C` in terminal 2) for a few seconds and bring
   it back with `npm run dev`. The job should recover on the next poll rather
   than immediately reporting "failed".

### Auth / session (token-readiness + refresh fixes SHIPPED — run as regression checks)
4. **Fresh login**: sign in with a real Microsoft account; confirm notes load
   (not an empty list). An empty list here usually means the Supabase token
   wasn't ready and the query silently fell back to the anon key.
5. **~1-hour session**: keep the app open past ~55 minutes (or shorten the
   Supabase JWT TTL in a test project to force it faster) and perform an action.
   The session must refresh transparently without a page reload or an empty UI.
6. **Token exchange failure**: with the app open, temporarily block the
   `supabase-token` edge function (or go offline briefly) and trigger a query.
   The app should show an explicit "reconnecting/auth" state and recover, not
   cascade every query into failure or silently show no data.

### Error surfacing (Error Boundary fix)
7. Force a render error in a page (temporarily throw in a component) and confirm
   the per-route Error Boundary shows a "Something went wrong / Try again" panel
   instead of white-screening the whole app.

## Notes

- `.env` files are gitignored; only `.env.example` is committed.
- Deploying the workflow-server restarts it. The boot-time orphan-job cleanup
  (`failOrphanedJobs` in `workflow-server/src/index.ts`) is now SHIPPED, so a
  restart fails any stale in-flight job cleanly on boot (the client gets a
  prompt, retryable error) instead of stranding it (was RELIABILITY_AUDIT C2).
  Still prefer deploy windows when internal testers are idle.
