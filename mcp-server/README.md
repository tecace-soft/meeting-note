# Meeting Note MCP Server

Read-only MCP server for Meeting Note data in Supabase.

## Environment

Create `mcp-server/.env` or set environment variables in your shell/deployment:

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
MEETING_NOTE_USER_ID=... # optional, strongly recommended for single-user scoping
MCP_API_KEY=...          # required only for HTTP auth
MCP_USER_TOKENS='{"opaque-user-token":"meeting-note-user-id"}' # optional multi-user token map
MCP_PUBLIC_BASE_URL=https://meeting-note-mcp.onrender.com # recommended for OAuth metadata
MCP_OAUTH_RESOURCE=api://<AZURE_APPLICATION_CLIENT_ID>
MCP_OAUTH_SCOPE=api://<AZURE_APPLICATION_CLIENT_ID>/access_as_user
MCP_AZURE_TENANT_ID=<AZURE_TENANT_ID> # validates ChatGPT OAuth JWTs and reads oid as user_id
PORT=3000               # HTTP only
```

Use the Supabase service role key only in this server-side MCP process. Do not expose it to the React app.

## Local stdio

```bash
npm install
npm run build
npm run inspect
```

Client command:

```text
node C:/Users/Gene Kim/Repositories/meeting-note/mcp-server/build/index.js
```

## Remote HTTP

```bash
npm run build
npm run start:http
```

Endpoints:

- `GET /health`
- `GET /health?deep=1` checks Supabase connectivity as well as process health
- `POST /mcp`
- `GET /mcp`
- `POST /mcp-chatgpt`
- `GET /mcp-chatgpt`
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp-chatgpt`

`/mcp` is **fail-closed**: a request is authorized only by a matching `MCP_API_KEY`
(static key) or a valid personal MCP token (`mn_live_...`). If `MCP_API_KEY` is not
set and no valid personal token is presented, `/mcp` returns 401. Set `MCP_API_KEY`
in any hosted deployment.

Clients send:

```text
Authorization: Bearer <MCP_API_KEY>
```

Remote HTTP clients may also pass the user scope per request:

```text
x-meeting-note-user-id: <note/speaker/project user_id>
```

If this header is absent, the server falls back to `MEETING_NOTE_USER_ID`. For hosted use, prefer the header so one Render deployment can serve different user scopes without redeploying.

## Render diagnostics and alerts

The HTTP server writes structured JSON logs to stdout/stderr so Render logs can be filtered by `event`, `level`, `requestId`, `path`, and `statusCode`.

Useful events include:

- `mcp_http_server_started`
- `mcp_heartbeat`
- `mcp_request_started`
- `mcp_request_finished`
- `mcp_response_closed_before_finish`
- `mcp_request_aborted`
- `mcp_http_request_failed`
- `mcp_dependency_health_failed`
- `mcp_uncaught_exception`
- `mcp_unhandled_rejection`
- `mcp_shutdown_signal`

Email alerts use Resend over HTTPS. Configure these in Render:

```text
RESEND_API_KEY=<resend-api-key>
MCP_ALERT_TO=you@example.com
MCP_ALERT_FROM="Meeting Note MCP Alerts <alerts@your-domain.com>"
MCP_ALERT_COOLDOWN_MS=900000
MCP_HEALTH_CHECK_INTERVAL_MS=60000
MCP_HEARTBEAT_LOG_INTERVAL_MS=300000
MCP_DISCONNECT_ALERT_THRESHOLD=5
```

The server can alert while it is still alive: startup, shutdown signals, fatal process errors, request failures, and failed Supabase health checks. A process cannot send email after it is already fully dead, so use an external uptime check against `GET /health?deep=1` for true “not running” alerts.

## ChatGPT web setup

Claude Desktop should continue using `/mcp` with `MCP_API_KEY` and `x-meeting-note-user-id`.

For ChatGPT web Developer Mode, use:

```text
https://<your-render-service>.onrender.com/mcp-chatgpt
```

For multi-user use, there are two supported paths.

### Microsoft OAuth

Recommended for ChatGPT web if your Meeting Note `user_id` values are Microsoft user ids.

Configure ChatGPT OAuth with Microsoft identity:

```text
Authorization URL:
https://login.microsoftonline.com/common/oauth2/v2.0/authorize

Token URL:
https://login.microsoftonline.com/common/oauth2/v2.0/token

Scope:
api://<AZURE_APPLICATION_CLIENT_ID>/access_as_user offline_access
```

In Azure, expose an API scope named `access_as_user`. The protected resource metadata must use the same Application ID URI as the scope resource:

```text
MCP_OAUTH_RESOURCE=api://<AZURE_APPLICATION_CLIENT_ID>
MCP_OAUTH_SCOPE=api://<AZURE_APPLICATION_CLIENT_ID>/access_as_user
MCP_AZURE_TENANT_ID=<AZURE_TENANT_ID>
```

This avoids Azure `AADSTS9010010` resource/scope mismatch errors.

When ChatGPT calls `/mcp-chatgpt` with a Microsoft OAuth access token, the MCP server validates the Azure JWT, reads the `oid` claim, and scopes queries to that Meeting Note `user_id`.

Set this in Render so OAuth metadata is stable:

```text
MCP_PUBLIC_BASE_URL=https://meeting-note-mcp.onrender.com
```

### Opaque token map

For controlled/manual multi-user use, set `MCP_USER_TOKENS` in Render as a JSON object whose keys are opaque bearer tokens and whose values are Meeting Note `user_id` values:

```json
{
  "mcp_u_alice_random_32_plus_chars": "alice-meeting-note-user-id",
  "mcp_u_bob_random_32_plus_chars": "bob-meeting-note-user-id"
}
```

Each ChatGPT user should connect with:

```text
Authorization: Bearer <their opaque token>
```

The server never trusts a raw `user_id` from ChatGPT. It accepts either:

- a Microsoft OAuth access token resolvable through Microsoft Graph `/me`
- an opaque token from `MCP_USER_TOKENS`

If a bearer token is presented but does not resolve to a user (invalid/expired/unknown),
`/mcp-chatgpt` returns 401 — it does **not** fall back to the default user. When no token
is presented at all, it also returns 401 by default. To allow the single-user
`MEETING_NOTE_USER_ID` fallback for local testing, set:

```text
MCP_ALLOW_ANON_CHATGPT_FALLBACK=true
```

Leave this unset in any deployment where `/mcp-chatgpt` is publicly reachable.

Personal MCP tokens (`mn_live_...`, issued by the `mcp-token` edge function) expire
90 days after creation and are rejected in code once expired or revoked.

For a public app with self-service onboarding, replace `MCP_USER_TOKENS` with real OAuth and derive the Meeting Note user id from the authenticated account.

## Tools

- `list_recent_notes`
- `list_personal_notes`
- `list_shared_notes`
- `get_shared_notes_by_owner`
- `search_notes`
- `get_notes_by_date`
- `get_summaries_by_date`
- `get_transcripts_by_date`
- `get_note`
- `get_note_summary`
- `get_note_transcript`
- `get_note_speaker_segments`
- `get_speaker_segments`
- `list_speakers`
- `get_speaker_profile`
- `list_projects`
- `get_project_context`

Date-aware tools accept:

```json
{ "date": "2026-05-19" }
```

or:

```json
{ "startDate": "2026-05-01", "endDate": "2026-05-19" }
```

`YYYY-MM-DD` values are treated as UTC calendar days. ISO date-times are also accepted for `startDate` and `endDate`.

Date filtering and ordering use `note.meeting_at` (the meeting date), falling back to `note.created_at` for notes whose `meeting_at` is null. Results are ordered by `meeting_at` descending, with `created_at` as a tiebreaker; notes without a `meeting_at` sort after those that have one.

## Resources

- `note://{noteId}`
- `speaker://{speakerId}`
- `project://{projectId}`
