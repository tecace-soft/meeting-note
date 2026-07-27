# Meeting Note Mobile — Screen Structure & User Flows

## 1. Navigation Model

Bottom navigation with 3 tabs + modal/pushed screens.

```
AppShell (bottom nav)
├── Tab 1: Record (home)          /record
├── Tab 2: History                /history
└── Tab 3: Settings               /settings

Pushed / modal screens
├── New Note Setup (job config)   /new-note        ← after recording stops or file picked
├── Processing                    /processing/:jobId
├── Summary Result                /note/:id        (Summary | Transcript tabs)
├── OneDrive Export sheet         (bottom sheet over result)
├── Prompt Picker sheet           (bottom sheet over setup)
├── Recent Recordings             /recent
├── Sign In                       /signin          (shown when unauthenticated)
└── Account                       /settings/account
```

## 2. Screen Specs

### S1. Record (Home)
- App bar: logo/title, connectivity indicator.
- Center: **large circular record button** (navy, 96 dp) with label "Tap to record".
- Below: secondary actions row — "Upload file" · "Recent recordings".
- While recording: timer (mm:ss), waveform bars, Pause / Stop buttons; nav bar hidden or disabled.
- On Stop → navigates to S2 with the new recording preloaded.

### S2. New Note Setup
- Audio source card (filename, duration, replace ✕).
- Title field (auto default: "Meeting YYYY-MM-DD HH:mm").
- "Instructions (optional)" multiline field.
- "Summary prompt" selector row → opens Prompt Picker sheet (radio list from API).
- Attachments section: chips for added files; "+ File" (picker) and "+ Camera" buttons.
- Primary button: **Generate Summary** (disabled until audio present).

### S3. Processing
- Job state stepper: Uploading (with %) → Queued → Transcribing → Summarizing.
- "You can leave — we'll notify you." + Cancel job.
- Auto-navigates to S4 on completion.

### S4. Summary Result
- Title, date, duration; status.
- Tabs: **Summary** (markdown) | **Transcript** (timestamped segments).
- Action bar: Copy · Share · **Export to OneDrive** · Delete.

### S5. History
- Search bar; list of note cards (title, date, duration, status chip).
- Tap → S4. Swipe left → delete (confirm). Pull-to-refresh; infinite scroll.
- Empty state: illustration + "Record your first meeting" CTA → Tab 1.

### S6. Settings
- Account card (avatar, name, email) → Account screen (sign out, delete account link).
- Theme: System / Light / Dark segmented control.
- Notifications toggle. Default prompt. Recording quality. About/version.

### S7. Sign In
- Logo, "Sign in to Meeting Note", SSO button (web-view/OIDC), legal links.

## 3. User Flows

### Flow A — Record → Summary (core loop)
```
Open app → [Record tab] tap ● → (permission on first use) → recording
→ Pause/Resume as needed → Stop
→ New Note Setup (audio attached) → optionally add instructions/prompt/files
→ Generate Summary → Processing (may background the app)
→ Push notification "Summary ready" → Summary Result
→ Copy / Share / Export to OneDrive
```

### Flow B — Existing audio file
```
Record tab → "Upload file" → system picker → New Note Setup → (same as Flow A)
```

### Flow C — Reuse recent recording
```
Record tab → "Recent recordings" → pick item → New Note Setup → (same as Flow A)
```

### Flow D — OneDrive export
```
Summary Result → "Export to OneDrive"
→ if not linked: Microsoft OAuth → consent
→ Export sheet: format (.docx/.md/.txt), content (summary/transcript/both), folder
→ Export → success toast + "Open in OneDrive"
```

### Flow E — Failure & recovery
```
Upload fails (offline) → job stays "Pending upload" in History with retry badge
→ auto-retry on connectivity; manual "Retry" on card
Processing fails → Result screen shows error + Retry job
Recording interrupted (call) → auto-pause → banner "Recording paused" → Resume
```

### Flow F — First run
```
Install → open → Sign In → (optional 2-card intro: background recording, notifications permission)
→ Record tab
```

## 4. State & Edge Cases (per screen)

| Screen | States |
|---|---|
| Record | idle · recording · paused · error(no mic permission → settings deeplink) |
| Setup | valid · missing audio · attachment over limit (inline error) |
| Processing | uploading(%) · queued · transcribing · summarizing · failed(retry) |
| Result | loaded · partial(transcript only) · failed |
| History | loading · loaded · empty · offline(cached) |
