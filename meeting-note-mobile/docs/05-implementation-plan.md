# Meeting Note Mobile — Step-by-Step Implementation Plan

Assumes 1–2 Flutter devs + part-time backend support. ~10–12 weeks to store release.

## Phase 0 — Foundations (week 1)
1. Confirm backend contract (auth, upload, jobs, prompts, OneDrive, push) — see 04 §6.
2. Create Flutter project with flavors (dev/stage/prod); CI (GitHub Actions: analyze, test, build).
3. Set up theme (app_theme.dart), go_router shell with 3 tabs, placeholder screens.
4. Set up Riverpod, dio ApiClient, secure storage, drift schema.
   **Exit:** app runs on both platforms with themed bottom nav.

## Phase 1 — Auth (week 2)
5. Sign-in screen + OIDC PKCE flow (or token endpoint) + token refresh interceptor.
6. Auth-gated routing (redirect to /signin), /me profile in Settings.
   **Exit:** sign in/out works against dev backend.

## Phase 2 — Recording core (weeks 3–4)
7. RecordingService with `record` package: start/pause/resume/stop → local AAC file; amplitude stream.
8. Record screen UI: RecordButton, timer, waveform; permission flow + denied state.
9. Background recording: iOS audio background mode; Android foreground service; interruption (call) handling.
10. Recent recordings list (local files + drift metadata).
    **Exit:** 1-hour background recording survives screen-off and app-switch on both platforms.

## Phase 3 — Job creation & processing (weeks 5–6)
11. New Note Setup screen: audio source card, title, instructions, prompt picker (GET /prompts), attachments (file_picker + image_picker).
12. Upload pipeline: chunked upload with progress; offline queue in drift; retry worker.
13. Create note (POST /notes), Processing screen with job polling + stepper.
    **Exit:** end-to-end record → summary done against staging.

## Phase 4 — Results & history (week 7)
14. Summary Result screen: markdown summary tab, transcript tab, copy/share.
15. History screen: pagination, search, swipe-delete, rename, offline cache, empty state.
    **Exit:** full core loop polished.

## Phase 5 — OneDrive export (week 8)
16. Link flow (server-side consent URL + deep link back), folder picker, export sheet, formats.
    **Exit:** export produces file visible in OneDrive.

## Phase 6 — Push & settings (week 9)
17. FCM integration, device registration, job-done deep link; contextual permission prompt.
18. Settings: theme toggle (persisted), default prompt, recording quality, about.
    **Exit:** backgrounded job completion notifies and deep-links.

## Phase 7 — Hardening & release (weeks 10–12)
19. Error/edge passes: airplane mode, kill during recording, 4-h recording, huge files, token expiry mid-upload.
20. Accessibility, ko/en localization, dark-mode audit.
21. Tests: unit (services/repos), widget (screens), one integration happy-path; crash reporting (Sentry/Crashlytics).
22. Store prep: icons, splash, screenshots, privacy manifests (iOS Privacy Nutrition, Play Data safety), permission strings, background-audio review notes for Apple.
23. Internal TestFlight/Play internal track → beta with existing web users → release.

## Risk register (top 3)
| Risk | Mitigation |
|---|---|
| Web backend not token-auth ready | Phase 0 contract work first; facade `/api/v1` if needed |
| iOS background recording review rejection | Genuine audio feature — document; test screen-lock thoroughly |
| Large-file upload flakiness | Chunked/resumable + offline queue from day 1 (Phase 3) |
