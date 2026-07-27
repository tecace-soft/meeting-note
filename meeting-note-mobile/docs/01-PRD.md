# Meeting Note Mobile — Product Requirements Document

**Version:** 1.0 · **Date:** 2026-07-09 · **Platforms:** iOS 15+, Android 8+ (API 26)
**Parent product:** Meeting Note (AX Pro) web app — https://meetingnote.tecace.com

---

## 1. Overview

Meeting Note Mobile brings the existing Meeting Note web app to iOS and Android as a native-quality Flutter app. The core value: **capture any meeting in under 3 seconds, get an AI transcription and summary, and export to OneDrive** — from anywhere, not just a desk.

### Why mobile (summary)
- Meetings happen away from desks; browser recording on mobile is unreliable (screen-off/app-switch kills the mic, especially iOS Safari).
- Native app enables background recording, offline capture with deferred upload, push notifications ("summary ready"), and OS integration (calendar, share sheet, widgets).
- Competitors (Otter, Clova Note) are mobile-first; app-store presence is an acquisition channel.

## 2. Goals & Non-Goals

### Goals (v1)
1. Record meeting audio natively, including background recording and interruption recovery.
2. Upload existing audio files; reuse recent recordings.
3. Configure a summarization job: optional instructions, prompt template selection, file attachments (documents, camera photos of whiteboards).
4. Generate AI transcription + summary via the existing backend API.
5. View, search, and manage history.
6. Export/save results to OneDrive.
7. Account settings, sign in/out, light/dark theme toggle.

### Non-Goals (v1)
- Real-time live transcription during recording (v2 candidate).
- In-app editing of transcripts/summaries (view + copy/share only).
- Team/shared workspaces, admin features.
- Calendar auto-record (v2), widgets/Siri shortcuts (v2).

## 3. Target Users

| Persona | Need |
|---|---|
| Field sales / consultants | Record client meetings on the go, summary before follow-up email |
| Managers / execs | Back-to-back meetings, action items extracted automatically |
| Enterprise employees (existing web users) | Same account, same history, OneDrive workflow on phone |

## 4. Functional Requirements

### FR-1 Recording
- Big primary record button on home; start ≤ 3 s from app open.
- Pause/resume; live elapsed timer; waveform level indicator.
- Continues in background (Android foreground service; iOS background audio mode).
- Survives interruptions (phone call → auto-pause, resume prompt).
- Local storage first (m4a/aac 64 kbps mono default); upload after stop. Nothing is lost on network failure.
- Max duration configurable (default 4 h); low-storage warning.

### FR-2 Audio input alternatives
- Upload audio file via system file picker (mp3, m4a, wav, aac, ogg; ≤ 500 MB).
- "Recent recordings" list: local recordings not yet processed, reusable for a new job.

### FR-3 Job configuration
- Optional free-text instructions (e.g., "focus on action items, output in Korean").
- Summarization prompt selector — templates fetched from backend (e.g., General, Standup, Sales call, Interview) + remembers last used.
- File attachments: documents (pdf/docx/pptx/xlsx/txt) via file picker, photos via camera or gallery (e.g., whiteboard shots). Max 10 files / 50 MB total.

### FR-4 AI processing
- Submit job to existing backend; show progress states: Uploading → Queued → Transcribing → Summarizing → Done/Failed.
- Push notification when done (job may take minutes; user can leave app).
- Retry on failure; resumable/chunked upload for large audio.

### FR-5 Results
- Summary tab (rendered markdown) + Transcript tab (timestamped segments).
- Copy, share (OS share sheet), export to OneDrive.
- Playback of source audio synced to transcript segments (v1.1 nice-to-have).

### FR-6 History
- Reverse-chronological list; search by title/content; pull-to-refresh; pagination.
- Item: title (auto or user-set), date, duration, status chip.
- Swipe to delete (confirm dialog); rename.

### FR-7 OneDrive export
- Microsoft OAuth (MSAL) — reuse backend's existing OneDrive integration if server-side; otherwise device MSAL flow.
- Choose folder, export summary (.md/.docx) and/or transcript (.txt/.docx); success toast with "Open in OneDrive" link.

### FR-8 Account & settings
- Sign in with existing Meeting Note account (same auth as web; assume OAuth2/OIDC — confirm with backend team).
- Profile display, sign out, delete local data.
- Theme: system / light / dark. Language: follow system (ko/en at minimum).

## 5. Non-Functional Requirements

- **Reliability:** zero audio loss — write-to-disk streaming while recording; crash-safe file finalization.
- **Performance:** cold start < 2 s; record start < 500 ms after tap.
- **Security:** tokens in secure storage (Keychain/Keystore); TLS only; optional biometric app lock (v1.1); local audio encrypted at rest (v1.1).
- **Offline:** record and configure jobs offline; queue uploads; history cached read-only.
- **Accessibility:** WCAG AA contrast, dynamic type, TalkBack/VoiceOver labels.
- **Store compliance:** mic/camera/storage permission rationale strings; iOS background-audio justification.

## 6. Success Metrics

- ≥ 40% of web MAU installs app within 3 months (existing-user activation).
- Median time app-open → recording started < 5 s.
- Job success rate ≥ 99% (excluding user cancellation).
- D30 retention ≥ 35%; push opt-in ≥ 60%.

## 7. Assumptions / Open Questions

1. Backend exposes (or will expose) a mobile-usable REST API with token auth — endpoint inventory needed (see 04-api-integration.md for proposed contract).
2. Auth provider: confirm (Azure AD? custom?) — affects sign-in SDK choice.
3. OneDrive export: server-side (backend holds Graph token) vs client-side MSAL — server-side preferred.
4. Prompt templates: served by API or hardcoded v1 list?
5. Push notifications require backend to send FCM/APNs on job completion — new backend work item.
