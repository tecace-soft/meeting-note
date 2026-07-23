# Meeting Note — agent guide

Audio transcription + summarization app (record/upload → transcribe → summarize → save), with MS Teams and OneDrive integration.

`CLAUDE.md` is a symlink to this file — edit `AGENTS.md` only. Windows teammates: see "Symlink note" below if `CLAUDE.md` shows up as plain text.

## Architecture
- `src/` — React 18 + Vite + TypeScript frontend. Auth via MSAL (Azure AD); data via Supabase (Postgres + RLS).
- `workflow-server/` — Node HTTP backend for the transcribe/summarize pipeline (AssemblyAI + Gemini). Deploys on Render.
- `supabase/functions/` — Deno edge functions (token exchange, audio URLs, profile generation, admin).
- `mcp-server/` — MCP server exposing notes/speakers/projects.

## Commands
- Frontend: `npm run dev` (:5174), `npm run build` (tsc + vite), `npm run lint`.
- Backend: `cd workflow-server && npm run dev` (:8787), `npm test`.
- Run locally with real auth + full E2E scenarios: see `LOCAL_DEV.md`.

## Conventions & gotchas
- **Secrets**: never commit `.env` (gitignored). Copy `.env.example` → `.env` in root and `workflow-server/`. Real values live in Render/Supabase/Azure dashboards. `SUPABASE_SERVICE_ROLE_KEY` is server-only — never in `VITE_*`/frontend.
- **Auth**: frontend acquires an MSAL token, exchanges it via the `supabase-token` edge function for a Supabase JWT (see `AuthContext.tsx` / `supabaseConfig.ts`). Data access is gated by RLS, so a missing token silently yields empty results — never treat that as "no data".
- **Deploys restart the backend**, which historically stranded in-flight jobs. A boot/periodic orphan sweep now fails stale jobs; still prefer deploy windows when testers are idle, and deploy backend changes before frontend ones that depend on them.
- **Prefer existing patterns.** Match the surrounding code; don't introduce new libraries/state patterns casually. Verify changes E2E in the real app, not just types.
- Follow the requirements-clarification skill before non-trivial features.

## Docs
- `DEV_NOTES.md` — feature history and schema.
- `RELIABILITY_AUDIT_KO.md` / `_EN.md` — known reliability/error-handling issues and roadmap.

## Symlink note (Windows)
`CLAUDE.md` is committed as a git symlink → `AGENTS.md` so both Claude Code and other agents read one source. Git here has `core.symlinks=false`, so on Windows `CLAUDE.md` may check out as a text file containing `AGENTS.md`. To get a real link, enable Developer Mode and run once: `git config core.symlinks true && git checkout -- CLAUDE.md`. Mac/Linux work out of the box.
