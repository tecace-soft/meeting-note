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
- `POST /mcp`
- `GET /mcp`
- `POST /mcp-chatgpt`
- `GET /mcp-chatgpt`
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp-chatgpt`

If `MCP_API_KEY` is set, clients must send:

```text
Authorization: Bearer <MCP_API_KEY>
```

Remote HTTP clients may also pass the user scope per request:

```text
x-meeting-note-user-id: <note/speaker/project user_id>
```

If this header is absent, the server falls back to `MEETING_NOTE_USER_ID`. For hosted use, prefer the header so one Render deployment can serve different user scopes without redeploying.

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

If neither works, `/mcp-chatgpt` falls back to `MEETING_NOTE_USER_ID` for single-user testing.

For a public app with self-service onboarding, replace `MCP_USER_TOKENS` with real OAuth and derive the Meeting Note user id from the authenticated account.

## Tools

- `list_recent_notes`
- `search_notes`
- `get_notes_by_date`
- `get_summaries_by_date`
- `get_transcripts_by_date`
- `get_note`
- `get_note_summary`
- `get_note_transcript`
- `get_note_speaker_segments`
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

## Resources

- `note://{noteId}`
- `speaker://{speakerId}`
- `project://{projectId}`
