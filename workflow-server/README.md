# Meeting Note Workflow Server

Dedicated backend for app-owned transcription and summarization workflows.

## Environment

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY`
- `GEMINI_SUMMARY_MODEL` defaults to `gemini-2.5-flash-lite`
- `ASSEMBLYAI_API_KEY`
- `ASSEMBLYAI_SPEECH_MODEL` optional, defaults to `universal-3-pro`
- `ASSEMBLYAI_TRANSCRIPTION_PRICE_PER_HOUR_USD` optional, defaults to `0.21`
- `GEMINI_INPUT_PRICE_PER_1M_TOKENS` optional global input price override
- `GEMINI_TEXT_INPUT_PRICE_PER_1M_TOKENS` optional text input price override
- `GEMINI_AUDIO_INPUT_PRICE_PER_1M_TOKENS` optional audio input price override
- `GEMINI_OUTPUT_PRICE_PER_1M_TOKENS` optional output price override
- `APP_FRONTEND_ORIGIN` optional CORS origin, defaults to `*`
- `WORKFLOW_FETCH_HEADERS_TIMEOUT_MS` optional, defaults to `1200000` (20 minutes)
- `WORKFLOW_FETCH_BODY_TIMEOUT_MS` optional, defaults to `1200000` (20 minutes)
- `PORT` optional, defaults to `8787`

AssemblyAI transcription latency/cost and Gemini summary token counts/cost are recorded in `public.workflow_usage`.
Estimated Gemini summary cost defaults cover the common Flash models used here and can be overridden with the price env vars above.

## Endpoint

`POST /summarize-audio`

Requires `Authorization: Bearer <Microsoft access token>`.

```json
{
  "downloadUrl": "https://...",
  "fileName": "meeting.m4a",
  "instructions": "",
  "promptId": "summary_prompt_id",
  "userId": "microsoft_user_id",
  "userName": "User Name",
  "noteId": "uuid",
  "speakerContext": "optional speaker context"
}
```

Returns:

```json
{
  "transcript": [{ "speaker": "Speaker 1", "text": "..." }],
  "summary": "..."
}
```

## Async job endpoints

`POST /summarize-audio/jobs`

Creates a background summarization job and returns:

```json
{
  "jobId": "uuid",
  "status": "queued",
  "stage": "queued",
  "progress": 0
}
```

`GET /summarize-audio/jobs/:jobId`

Returns job progress. Completed jobs include `result` in the same shape as `/summarize-audio`.
