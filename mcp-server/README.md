# Meeting Note MCP Server

Read-only MCP server for Meeting Note data in Supabase.

## Environment

Create `mcp-server/.env` or set environment variables in your shell/deployment:

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
MEETING_NOTE_USER_ID=... # optional, strongly recommended for single-user scoping
MCP_API_KEY=...          # required only for HTTP auth
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

If `MCP_API_KEY` is set, clients must send:

```text
Authorization: Bearer <MCP_API_KEY>
```

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
