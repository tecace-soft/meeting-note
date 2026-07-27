# Meeting Note Mobile — Integration Checklist (Handoff)

> Goal: the app skeleton is done. Plug in the values below and it works.
> Every item maps to a `// TODO(backend)` or config constant in the code.

## 1. One config value to set

| What | Where in code | Value needed |
|---|---|---|
| API base URL | `--dart-define=API_BASE_URL=...` (read in `core/network/api_client.dart`) | e.g. `https://meetingnote.tecace.com/api/v1` |

## 2. Auth (blocker — everything else depends on this)

| What | Where in code | Needed from backend |
|---|---|---|
| Sign-in flow | add `features/auth/` (router TODO at `/signin`) | Microsoft OIDC client ID + redirect URI (mobile app registration in Azure AD) |
| Token refresh | `api_client.dart` → `AuthInterceptor` (already written) | `POST /auth/refresh` endpoint confirmed |
| Profile | `settings_screen.dart` account card | `GET /me` |

## 3. Notes pipeline (`features/notes/data/notes_repository.dart`)

Each method has a mock body + TODO. Replace with:

| Method | Endpoint to wire |
|---|---|
| `list()` | `GET /notes?query=&cursor=` |
| `get(id)` | `GET /notes/{id}` |
| `prompts()` | `GET /prompts` |
| `createNote(...)` | `POST /uploads` (chunked) → `POST /notes` |
| `jobStatus(jobId)` | `GET /jobs/{jobId}` (poll 3–5 s; used by `processing_screen.dart`) |
| `delete(id)` | `DELETE /notes/{id}` |
| `exportToOneDrive(...)` | `POST /notes/{id}/export` |

`processing_screen.dart` currently advances steps on a demo timer — swap for
`jobStatus` polling (TODO marked in file).

## 4. Ask feature (`features/ask/data/ask_repository.dart`)

| What | Needed |
|---|---|
| `ask(question)` | `POST /ask {question, projectId?}` → `{answer, sources[]}` — commented dio call is ready in the file; delete the mock |
| Backend work | RAG over transcripts/summaries (reuse project-chat pipeline, no project filter). Must return source note IDs — the UI deep-links them. |
| Model | Whatever the web app's summarizer uses (same LLM account); answer language should follow app language setting |

## 5. OneDrive

Server-side flow assumed (backend holds Graph tokens, same as web):
`GET /integrations/onedrive/status`, `GET .../connect` (consent URL + deep link back),
`GET .../folders`, `POST /notes/{id}/export`. No mobile MSAL needed if backend confirms.

## 6. Push notifications (job done → notify)

1. Create Firebase project, add `google-services.json` / `GoogleService-Info.plist`.
2. Add `firebase_messaging` package; register token via `POST /devices {fcmToken, platform}` (new backend endpoint ⚠).
3. Backend calls FCM on job completion with `{type:'job_done', noteId}`; app deep-links to `/note/{id}`.

## 7. Fonts

Drop into `app/assets/fonts/` and uncomment the `fonts:` block in `pubspec.yaml`:
Poppins (Regular/Medium/SemiBold/Bold — fonts.google.com) and
Pretendard (Regular/Medium/SemiBold/Bold — github.com/orioncactus/pretendard).
Theme already set: `fontFamily: 'Poppins'`, fallback `'Pretendard'`.

## 8. Platform files (one-time)

`flutter create . --platforms=ios,android` inside `app/`, then add the permission
strings and background modes listed in README.md.

## Definition of "working"

1. Sign in with Microsoft → 2. record 1 min → 3. Generate → job completes →
push arrives → 4. summary + transcript visible → 5. Ask "방금 회의에서 뭐 정했지?"
returns an answer citing the note → 6. Export lands in OneDrive.
