# Meeting Note MCP Server

Read-only MCP server for Meeting Note data in Supabase.

## Environment

Create `mcp-server/.env` or set environment variables in your shell/deployment:

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
MEETING_NOTE_USER_ID=... # local/dev identity only when MCP_ALLOW_DEV_IDENTITY=true
MCP_ALLOW_DEV_IDENTITY=false
MCP_API_KEY=...          # optional local/dev static key, not a production identity source
MCP_USER_TOKENS='{"opaque-user-token":"meeting-note-user-id"}' # optional multi-user token map
MCP_PUBLIC_BASE_URL=https://meeting-note-mcp.onrender.com # recommended for OAuth metadata
MCP_OAUTH_RESOURCE=api://<AZURE_APPLICATION_CLIENT_ID> # Azure JWT audience, not the protected-resource metadata URL
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

For production `/mcp` use a personal MCP token issued by the app:

```text
Authorization: Bearer <personal MCP token>
```

The server does not trust caller-supplied user ids. Do not send `x-meeting-note-user-id`; identity is resolved server-side from the bearer token or OAuth token.

`MCP_API_KEY` plus `MEETING_NOTE_USER_ID` is supported only when `MCP_ALLOW_DEV_IDENTITY=true`, and should be kept to local/dev testing.

## ChatGPT web setup

Claude Desktop should use `/mcp` with a personal MCP bearer token.

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
MCP_OAUTH_RESOURCE=api://<AZURE_APPLICATION_CLIENT_ID> # Azure JWT audience, not the protected-resource metadata URL
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
- a personal MCP token from the `mcp_token` table
- an opaque token from `MCP_USER_TOKENS`

If none works, `/mcp-chatgpt` returns `401`. Set `MCP_ALLOW_DEV_IDENTITY=true` only for local/dev single-user testing.

For a public app with self-service onboarding, replace `MCP_USER_TOKENS` with real OAuth and derive the Meeting Note user id from the authenticated account.

## Personal MCP token scopes

Personal MCP tokens are stored hashed in `public.mcp_token`, can expire, and can be revoked. Supported scopes are:

- `notes:metadata` for note/project/speaker lists and metadata.
- `notes:summary` for summaries and speaker profiles.
- `notes:transcript` for transcript retrieval and transcript-backed search.

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
