# Meeting Note Mobile — API Integration Plan

> The existing backend serves the web app; its exact contract must be confirmed.
> Below is the **proposed mobile contract** — either map to existing endpoints or add a
> versioned mobile-friendly facade (`/api/v1`). Items marked ⚠ are likely new backend work.

## 1. Auth

| Endpoint | Notes |
|---|---|
| OIDC/OAuth2 (same IdP as web) | Authorization Code + PKCE via system browser; no passwords in-app |
| `POST /api/v1/auth/token` | code → access + refresh token (if custom auth) |
| `POST /api/v1/auth/refresh` | dio interceptor calls on 401 |
| `GET  /api/v1/me` | profile for Settings |

Tokens: `flutter_secure_storage`. Access token in `Authorization: Bearer`.

## 2. Notes / Jobs

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/v1/uploads` ⚠ | Init chunked/resumable upload → `uploadUrl`, `uploadId` (or presigned S3/Azure Blob URL) |
| PUT | uploadUrl (chunks) | Audio + attachments, progress via dio `onSendProgress` |
| POST | `/api/v1/notes` | Create job: `{title, audioUploadId, instructions?, promptId?, attachmentUploadIds[]}` → `{noteId, jobId}` |
| GET | `/api/v1/jobs/{jobId}` | `{status: uploading|queued|transcribing|summarizing|done|failed, progress?, error?}` — poll every 3–5 s |
| GET | `/api/v1/notes?query=&cursor=&limit=20` | History (cursor pagination, server search) |
| GET | `/api/v1/notes/{id}` | `{title, createdAt, durationSec, summaryMarkdown, transcript:[{startMs,endMs,speaker?,text}]}` |
| PATCH | `/api/v1/notes/{id}` | rename |
| DELETE | `/api/v1/notes/{id}` | delete (soft) |
| GET | `/api/v1/prompts` | Summarization templates `[{id, name, description}]` |
| POST | `/api/v1/notes/{id}/retry` | retry failed job |

## 2.5 Ask (cross-meeting Q&A) ⚠

Natural-language questions answered from the user's meeting history
("지난주에 결정된 사항은?", "Acme 언급 찾아줘", "내 액션 아이템 뭐야?").

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/v1/ask` | `{question, projectId?}` → `{answer, sources:[{noteId, title, date}]}` |

Backend implementation: RAG over transcripts + summaries (embed on note creation,
vector search + LLM answer at query time). The existing per-project chat backend
can likely be generalized — global Ask = same pipeline without the project filter.
Answers must cite source notes; the app renders tappable source chips that deep-link
to the note detail screen.

## 3. OneDrive Export

**Preferred — server-side (backend already integrates OneDrive for web):**

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/v1/integrations/onedrive/status` | linked? |
| GET | `/api/v1/integrations/onedrive/connect` | returns Microsoft consent URL (open in browser, deep-link back) |
| GET | `/api/v1/integrations/onedrive/folders?parentId=` | folder browser |
| POST | `/api/v1/notes/{id}/export` | `{target:"onedrive", format:"docx|md|txt", content:"summary|transcript|both", folderId}` → `{webUrl}` |

Fallback — client-side MSAL (`msal_auth`) + Microsoft Graph `PUT /me/drive/items/{folder}:/name:/content` if backend can't hold Graph tokens.

## 4. Push Notifications ⚠

- App registers FCM token: `POST /api/v1/devices {fcmToken, platform}`.
- Backend sends push on job completion/failure: payload `{type:"job_done", noteId}` → deep link to result screen.
- iOS: APNs via FCM.

## 5. Client-Side Plumbing

```
dio BaseOptions(baseUrl: flavor URL, connectTimeout 15s)
Interceptors:
  1. AuthInterceptor    — attach token; on 401 refresh-once-then-logout
  2. RetryInterceptor   — idempotent GETs, 3 tries, expo backoff
  3. LogInterceptor     — dev flavor only, redact Authorization
Error mapping → ApiException {network, unauthorized, validation(field errors),
                              server, payloadTooLarge}
Upload queue (drift table upload_jobs):
  states pendingUpload → uploading → submitted → done/failed
  connectivity_plus listener triggers queue drain
```

## 6. Contract Questions for Backend Team

1. Current auth mechanism for web (cookies? JWT?) — mobile needs token-based; CORS/cookie auth won't work well.
2. Is there an existing upload path and size limit? Chunked/resumable support?
3. Can job status be exposed via polling endpoint (or SSE/WebSocket)?
4. Prompt templates: API-served or static?
5. OneDrive: server-side Graph tokens available per user?
6. Push: can backend call FCM on job completion?
