# Meeting Note Mobile — Flutter Architecture & UI Components

## 1. Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | Flutter 3.x (Dart 3) | Single codebase iOS/Android |
| State | flutter_riverpod | Testable, compile-safe DI + state |
| Navigation | go_router | Declarative, deep links, auth redirect |
| HTTP | dio | Interceptors (auth refresh), upload progress, retries |
| Recording | record | Simple, background-capable AAC recording |
| File picking | file_picker | Audio + document picking |
| Camera/gallery | image_picker | Whiteboard photos |
| Secure storage | flutter_secure_storage | Tokens in Keychain/Keystore |
| Local DB | drift (SQLite) | Offline queue + history cache |
| Markdown | flutter_markdown | Summary rendering |
| Auth (OneDrive) | msal_auth (or server-side) | Microsoft Graph |
| Push | firebase_messaging | Job-completion notifications |
| Env/config | flavors + --dart-define | dev/stage/prod base URLs |

## 2. Layered Architecture

```
lib/
├── main.dart                      # bootstrap, ProviderScope, flavor config
├── app/
│   ├── router.dart                # go_router, auth redirect
│   └── shell.dart                 # bottom-nav scaffold
├── core/
│   ├── theme/app_theme.dart       # white/navy design system, light+dark
│   ├── network/api_client.dart    # dio setup, auth interceptor
│   ├── network/api_exception.dart
│   └── utils/ (formatters, result type)
├── features/                      # feature-first modules
│   ├── auth/        data/ · providers/ · ui/
│   ├── record/      data/recording_service.dart · providers/ · ui/record_screen.dart
│   ├── notes/       data/notes_repository.dart · models/ · providers/
│   │                ui/ new_note_screen.dart · processing_screen.dart
│   │                    summary_screen.dart · history_screen.dart
│   ├── export/      data/onedrive_service.dart · ui/export_sheet.dart
│   └── settings/    providers/settings_provider.dart · ui/settings_screen.dart
└── shared/widgets/                # reusable UI (see §4)
```

Rules: UI → providers → repositories → (api_client | drift | platform services). UI never touches dio directly. Models are immutable (freezed optional).

## 3. Key Design Decisions

1. **Record-to-disk first.** RecordingService streams AAC to a local file; upload is a separate queued step. App kill/crash/offline never loses audio.
2. **Upload queue in SQLite.** Jobs created offline persist with status `pendingUpload`; a queue worker retries with exponential backoff when connectivity returns.
3. **Job polling + push.** Client polls `GET /jobs/{id}` while Processing screen is visible; FCM notification covers backgrounded app.
4. **Auth interceptor.** Dio interceptor injects access token, transparently refreshes on 401 once, then forces sign-out.
5. **Theme tokens, not ad-hoc colors.** All colors/radii/spacing from `AppTheme`; theme mode persisted.

## 4. UI Component List (shared/widgets)

| Component | Used in | Notes |
|---|---|---|
| `RecordButton` | Record | 96 dp circle, idle/recording/paused states, pulse animation |
| `WaveformBars` | Record | amplitude stream visualizer |
| `RecordingTimer` | Record | mm:ss, monospaced digits |
| `NoteCard` | History | title/date/duration/StatusChip, swipe-delete |
| `StatusChip` | History, Result | queued/processing/done/failed color-coded |
| `AudioSourceCard` | Setup | filename, duration, replace ✕ |
| `AttachmentChip` | Setup | file icon by type, remove ✕ |
| `PromptPickerSheet` | Setup | radio list bottom sheet |
| `PrimaryButton` | everywhere | filled navy, 56 dp, loading spinner state |
| `SecondaryActionTile` | Record | "Upload file", "Recent recordings" |
| `JobProgressStepper` | Processing | 4-step vertical stepper with % |
| `SummaryMarkdownView` | Result | themed flutter_markdown |
| `TranscriptSegmentTile` | Result | timestamp + text, tap-to-copy |
| `ExportSheet` | Result | format/content/folder pickers |
| `EmptyState` | History, Recent | illustration + CTA |
| `SearchField` | History | debounced |
| `SettingsTile` / `SegmentedThemeToggle` | Settings | |
| `ErrorView` | any | message + retry |

## 5. Design System (white/navy premium)

```
Primary (navy)     #0F2A4A     onPrimary #FFFFFF
Accent (action)    #2563EB     recording red #E5484D
Background light   #F7F8FA     surface #FFFFFF
Background dark    #0B1220     surface dark #111A2C
Text primary       #101828 / #F1F5F9(dark)   secondary #667085 / #94A3B8
Radius: cards 16, sheets 24, buttons 14      Elevation: 0–1 + subtle border
Type: Inter (or Pretendard for ko) — 28/20/16/14
Spacing scale: 4·8·12·16·24·32
```

## 6. Permissions

| Permission | When asked | Platform notes |
|---|---|---|
| Microphone | first record tap | iOS `NSMicrophoneUsageDescription`; Android `RECORD_AUDIO` |
| Background audio | with mic | iOS UIBackgroundModes `audio`; Android foreground service type `microphone` |
| Camera | first camera attach | `NSCameraUsageDescription` / `CAMERA` |
| Photos | gallery attach | scoped/photo picker (no broad storage) |
| Notifications | after first job submitted (contextual) | POST_NOTIFICATIONS (A13+) |
