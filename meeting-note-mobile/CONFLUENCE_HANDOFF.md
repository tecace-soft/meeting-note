# Meeting Note Mobile Developer Handoff

## Overview

Meeting Note Mobile is a Flutter mobile app for the existing Meeting Note product. It currently targets Android first, with iOS scaffolded but not production-configured yet.

The app connects to the same Supabase data layer and workflow backend used by the Meeting Note web app.

## Repository Locations

| Area | Path |
|---|---|
| Mobile app | `meeting-note-mobile/app` |
| Mobile source | `meeting-note-mobile/app/lib` |
| Android native config | `meeting-note-mobile/app/android` |
| iOS scaffold | `meeting-note-mobile/app/ios` |
| Workflow backend | `workflow-server` |
| Web app reference | `src` |

## Tech Stack

- Flutter / Dart
- Riverpod
- GoRouter
- Dio
- MSAL Microsoft authentication
- Supabase REST API
- Supabase Storage
- Render-hosted workflow backend
- n8n project chat webhook
- Android foreground service for background recording

## Public Runtime Config

These values are public client/runtime config and are currently present in the mobile app.

| Item | Value |
|---|---|
| Supabase URL | `https://smnnlamrwisqaquymsdl.supabase.co` |
| Supabase anon/publishable key | `sb_publishable_xkdZSukdjjCSwD4TCuKrgA_Qnhz0h4D` |
| Workflow API URL | `https://meeting-note-backend-njfb.onrender.com` |
| Microsoft client ID | `f81ec595-e95f-4b99-8143-fb4b198df787` |
| Microsoft tenant ID | `a141d6e8-fddb-4309-8b71-44753a78495a` |
| Android package name | `com.tecace.meeting_note_mobile` |
| Android redirect URI | `msauth://com.tecace.meeting_note_mobile/guC64kbNdu%2Bbu67b7Ujd62XWb3s%3D` |

Relevant files:

- `meeting-note-mobile/app/lib/core/network/supabase_config.dart`
- `meeting-note-mobile/app/lib/core/network/workflow_config.dart`
- `meeting-note-mobile/app/lib/features/auth/data/auth_config.dart`
- `meeting-note-mobile/app/assets/msal_config.json`
- `meeting-note-mobile/app/android/app/build.gradle.kts`
- `meeting-note-mobile/app/android/app/src/main/AndroidManifest.xml`

## Sensitive Credentials To Transfer Securely

Do not paste these raw values into Confluence unless the page is access-restricted. Prefer a password manager, Render dashboard access, Supabase dashboard access, or another secure secret handoff.

| Service | Required Secret / Env Var |
|---|---|
| Supabase backend access | `SUPABASE_SERVICE_ROLE_KEY` |
| Gemini / Google AI | `GEMINI_API_KEY` |
| Gemini model config | `GEMINI_SUMMARY_MODEL`, `GEMINI_REGENERATE_SUMMARY_MODEL`, optional pricing/model env vars |
| OpenAI | `OPENAI_API_KEY` if still used by workflow tests or fallback paths |
| AssemblyAI | `ASSEMBLYAI_API_KEY`, `ASSEMBLYAI_SPEECH_MODEL` |
| Resend alerts | `RESEND_API_KEY`, `WORKFLOW_ALERT_TO`, `WORKFLOW_ALERT_FROM` |
| Workflow server | `SUPABASE_URL`, `PORT`, timeout env vars |

Recommended: rotate any keys that were copied into chats, screenshots, logs, or unsecured local files.

## Microsoft / Azure Setup

The Azure App Registration must include the Android platform configuration below.

| Field | Value |
|---|---|
| Package name | `com.tecace.meeting_note_mobile` |
| Signature hash | `guC64kbNdu+bu67b7Ujd62XWb3s=` |
| Redirect URI | `msauth://com.tecace.meeting_note_mobile/guC64kbNdu%2Bbu67b7Ujd62XWb3s%3D` |

Authority must be tenant-specific:

```text
https://login.microsoftonline.com/a141d6e8-fddb-4309-8b71-44753a78495a
```

Do not use `/common`; this app registration is not configured as multi-tenant.

Current mobile login scopes:

```text
https://graph.microsoft.com/user.read
https://graph.microsoft.com/User.ReadBasic.All
```

Additional Graph scopes listed for future integrations:

```text
Chat.Read
Chat.ReadWrite
ChatMessage.Read
Files.ReadWrite
Files.ReadWrite.All
User.ReadBasic.All
Calendars.Read
```

## Supabase Dependencies

The mobile app uses Supabase REST and Storage with a Supabase JWT exchanged from the Microsoft access token.

Token exchange function:

```text
/functions/v1/supabase-token
```

Important Supabase tables:

```text
note
file
summary_prompt
speaker
project
session
chat
note_image
mcp_token
workflow_job
workflow_usage
```

Important Supabase Edge Functions / RPCs:

```text
/functions/v1/supabase-token
/functions/v1/mcp-token
/functions/v1/generate-profile
/rpc/add_accessible_note_to_project
```

Storage buckets:

```text
meeting-recordings
meeting-note-images
recording-drafts
```

## Transcription / Summary Flow

1. User records audio or selects an audio file.
2. Mobile uploads audio to Supabase Storage bucket `meeting-recordings`.
3. Mobile inserts a `file` row.
4. Mobile creates a signed Supabase Storage URL.
5. Mobile submits the signed URL to the workflow backend.
6. Workflow backend runs transcription and summary generation.
7. Mobile polls the workflow job endpoint.
8. Workflow backend creates/updates the final `note` data.
9. Mobile navigates to the summary/transcript detail screen.

Workflow endpoints:

```text
POST /summarize-audio/jobs
GET  /summarize-audio/jobs/:jobId
```

Workflow request shape:

```json
{
  "downloadUrl": "...signed Supabase audio URL...",
  "fileName": "meeting.m4a",
  "fileId": "file table id",
  "meetingAt": "ISO timestamp",
  "userTimeZone": "device timezone",
  "instructions": "",
  "promptId": "summary_prompt id",
  "userId": "authenticated user id",
  "userName": "display name",
  "noteId": "uuid generated by app",
  "language": "en or ko",
  "attachments": []
}
```

## Attachments

Mobile supports file attachments and camera photos during note creation.

Current behavior:

- Attachments are sent to the workflow backend as base64 objects.
- After the workflow job completes, attachments are saved to Supabase Storage bucket `meeting-note-images`.
- Attachment metadata is inserted into `note_image`.

Attachment limits currently enforced by mobile:

- Up to 10 attachments per note
- Max 25 MB per attachment sent to workflow
- Max 50 MB total attachments sent to workflow
- Max 50 MB per attachment stored after completion

Supported attachment types include PDFs, text files, images, audio, and video.

## Project Chat

Project chat currently posts to this n8n webhook:

```text
https://n8n.srv1153481.hstgr.cloud/webhook/9fe1b3b5-9e2e-4b23-8775-b38fc21e4b4d
```

Defined in:

```text
meeting-note-mobile/app/lib/features/projects/data/projects_repository.dart
```

After the webhook response returns, mobile stores chat data in Supabase:

```text
session
chat
```

Note: the mobile code supports both `response` and the legacy typo fallback `repsonse`.

## Settings Features

The Settings tab includes:

- Microsoft signed-in user information
- App language: English / Korean
- Theme toggle: Light / Dark
- Summary prompt templates
- Speaker profiles
- MCP setup and API key generation

Relevant Supabase-backed areas:

- Summary prompts: `summary_prompt`
- Speaker profiles: `speaker`
- MCP keys: `/functions/v1/mcp-token`, `mcp_token`

## Local Cache

The app uses JSON file caching to improve perceived load time.

Cache implementation:

```text
meeting-note-mobile/app/lib/core/cache/json_cache_store.dart
```

Cached areas include:

- Notes/history
- Projects
- Project notes
- Project chat sessions
- Project chats
- Summary prompts
- Speaker profiles

The app generally displays cached data first, then refreshes from Supabase.

## Android Recording

Android recording uses the Flutter `record` package plus native foreground-service support.

Important files:

```text
meeting-note-mobile/app/lib/features/record/data/recording_service.dart
meeting-note-mobile/app/android/app/src/main/kotlin/com/tecace/meeting_note_mobile/ForegroundRecordingService.kt
meeting-note-mobile/app/android/app/src/main/AndroidManifest.xml
```

Android permissions include:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

## Build Commands

From:

```powershell
cd meeting-note-mobile/app
```

Install debug build to connected Android device:

```powershell
flutter build apk --debug
flutter install -d DEVICE_ID --debug
```

Build lightweight release APKs for sharing:

```powershell
flutter build apk --release --split-per-abi
```

For most modern Android phones, share:

```text
build/app/outputs/flutter-apk/app-arm64-v8a-release.apk
```

## Production Build Caveats

Current Android release signing still uses debug signing in:

```text
meeting-note-mobile/app/android/app/build.gradle.kts
```

Before Play Store or production distribution:

1. Create a real Android release keystore.
2. Configure `signingConfigs.release`.
3. Build a signed release APK or AAB.
4. Package name is `com.tecace.meeting_note_mobile` (changed from `com.example.*` on 2026-08-06).
5. The Azure Android redirect URI must match this package name — see the redirect URI above.

## iOS Status

iOS scaffold exists but is not production-ready.

Before iOS validation/release:

1. Use macOS + Xcode.
2. Configure Apple Developer Team.
3. Set a production bundle ID.
4. Configure MSAL iOS redirect scheme.
5. Confirm microphone/camera/background audio permissions.
6. Test Microsoft login on simulator and physical device.
7. Build through Xcode or Flutter on macOS.

## Known Caveats / Risks

- Android package name is `com.tecace.meeting_note_mobile`; the Azure app registration must carry the matching `msauth://com.tecace.meeting_note_mobile/...` redirect URI or sign-in fails.
- Android release signing is not production-ready.
- iOS has not been fully configured or validated.
- Project chat depends on an external n8n webhook.
- Workflow processing depends on Render backend availability.
- Supabase auth depends on Microsoft token exchange through `supabase-token`.
- Some old README/handoff docs may still describe the original mock-data starter app and are stale.

## Developer First-Day Checklist

1. Get access to:
   - Supabase project
   - Azure App Registration
   - Render workflow backend
   - n8n workflow
   - AssemblyAI
   - Gemini / Google AI
   - OpenAI, if still used
   - Resend, if alerting is needed

2. Install Flutter and Android tooling.

3. Run:

```powershell
cd meeting-note-mobile/app
flutter pub get
flutter devices
flutter run -d DEVICE_ID
```

4. Confirm:
   - Microsoft login works.
   - History loads notes.
   - Projects load.
   - Summary prompts load.
   - Speaker profiles load.
   - Recording creates a usable audio file.
   - Generate Summary reaches the workflow backend.
   - Processing completes and opens summary/transcript.
   - Attachments/photos are saved.
   - Project chat returns and stores responses.
   - MCP key generation works from Settings.

5. Before production:
   - Rename package/bundle ID if needed.
   - Register production Android/iOS redirect URIs in Azure.
   - Add real Android release signing.
   - Configure iOS signing.
   - Rotate exposed secrets.
   - Move all secrets to managed secret storage.
   - Build signed release artifacts.

