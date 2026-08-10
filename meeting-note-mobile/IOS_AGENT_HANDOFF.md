# Meeting Note Mobile iOS Agent Handoff

## Purpose

This document is for the next agent/developer working from macOS with the same repository. The goal is to take the current Android-first Flutter mobile app and get it running correctly on an iOS device.

The developer will be using Claude Code in an IDE on a MacBook.

## Current State

The mobile app lives here:

```text
meeting-note-mobile/app
```

The app is a Flutter app with Android and iOS folders present:

```text
meeting-note-mobile/app/android
meeting-note-mobile/app/ios
```

Android is the currently tested path. iOS exists as a Flutter-generated scaffold, but it has not been fully configured or validated on an iPhone.

Important current iOS facts:

- iOS bundle identifier is currently `com.tecace.meetingNoteMobile`.
- iOS `Info.plist` already has an MSAL URL scheme placeholder based on `$(PRODUCT_BUNDLE_IDENTIFIER)`.
- iOS `Info.plist` does **not** yet include microphone/camera usage descriptions.
- iOS `Info.plist` does **not** yet include background audio mode.
- Azure iOS/macOS platform redirect URI still needs to be registered.
- Apple Developer signing/team configuration still needs to be done on macOS/Xcode.

## Current Mobile App Tech Stack

- Flutter / Dart
- Riverpod
- GoRouter
- Dio
- MSAL Microsoft authentication via `msal_auth`
- Supabase REST API
- Supabase Storage
- Render-hosted workflow backend
- n8n project chat webhook
- Android foreground service for Android background recording

## Important Runtime Config

These values are currently used by the mobile app.

```text
Supabase URL:
https://smnnlamrwisqaquymsdl.supabase.co

Supabase anon/publishable key:
sb_publishable_xkdZSukdjjCSwD4TCuKrgA_Qnhz0h4D

Workflow API URL:
https://meeting-note-backend-njfb.onrender.com

Microsoft client ID:
f81ec595-e95f-4b99-8143-fb4b198df787

Microsoft tenant ID:
a141d6e8-fddb-4309-8b71-44753a78495a
```

Relevant config files:

```text
meeting-note-mobile/app/lib/core/network/supabase_config.dart
meeting-note-mobile/app/lib/core/network/workflow_config.dart
meeting-note-mobile/app/lib/features/auth/data/auth_config.dart
meeting-note-mobile/app/assets/msal_config.json
meeting-note-mobile/app/ios/Runner/Info.plist
meeting-note-mobile/app/ios/Meeting Note.xcodeproj/project.pbxproj
```

## Sensitive Credentials

Do not hardcode backend secrets into the mobile app.

The new developer/agent will need secure access to:

- Supabase dashboard
- Azure App Registration
- Render workflow backend
- n8n project chat workflow
- Apple Developer account/team
- AssemblyAI
- Gemini / Google AI
- OpenAI, if still used by backend tests/fallbacks
- Resend, if workflow alert emails are needed

Backend-only secrets include:

```text
SUPABASE_SERVICE_ROLE_KEY
GEMINI_API_KEY
OPENAI_API_KEY
ASSEMBLYAI_API_KEY
RESEND_API_KEY
```

These belong in backend hosting environments, not in Flutter.

## Microsoft Auth Current Setup

Current Dart config:

```text
meeting-note-mobile/app/lib/features/auth/data/auth_config.dart
```

Current values:

```dart
const microsoftClientId = 'f81ec595-e95f-4b99-8143-fb4b198df787';
const microsoftTenantId = 'a141d6e8-fddb-4309-8b71-44753a78495a';
const microsoftAuthority = 'https://login.microsoftonline.com/$microsoftTenantId';
```

The iOS MSAL config is initialized here:

```text
meeting-note-mobile/app/lib/features/auth/data/microsoft_auth_service_factory_msal.dart
```

Current Apple config:

```dart
appleConfig: AppleConfig(
  authority: microsoftAuthority,
  authorityType: AuthorityType.aad,
  broker: Broker.safariBrowser,
),
```

## Required iOS Microsoft Redirect URI

For iOS/macOS, Microsoft MSAL expects this default redirect URI format:

```text
msauth.<BUNDLE_ID>://auth
```

The current iOS bundle ID is:

```text
com.tecace.meetingNoteMobile
```

So the current iOS redirect URI would be:

```text
msauth.com.tecace.meetingNoteMobile://auth
```

If the bundle ID is changed before shipping, the redirect URI must change too.

The bundle ID was changed from `com.example.meetingNoteMobile` to
`com.tecace.meetingNoteMobile` on 2026-08-06, so the Azure iOS/macOS platform
entry must use the `msauth.com.tecace.meetingNoteMobile://auth` redirect above.
If a different production ID is chosen later (for example
`com.tecace.meetingnote`), register the matching redirect at that time.

## Azure Steps For iOS

In Microsoft Entra / Azure App Registration:

1. Open app registration for client ID:

```text
f81ec595-e95f-4b99-8143-fb4b198df787
```

2. Go to:

```text
Authentication > Add a platform > iOS/macOS
```

3. Enter the chosen iOS bundle ID.

4. Azure will compute the redirect URI:

```text
msauth.<BUNDLE_ID>://auth
```

5. Save.

6. Confirm app uses tenant-specific authority:

```text
https://login.microsoftonline.com/a141d6e8-fddb-4309-8b71-44753a78495a
```

Do not switch to `/common`; this app registration is tenant-specific.

## iOS Info.plist Changes Needed

File:

```text
meeting-note-mobile/app/ios/Runner/Info.plist
```

Currently, URL scheme exists:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>msauth.$(PRODUCT_BUNDLE_IDENTIFIER)</string>
    </array>
  </dict>
</array>
```

This should work if the Azure redirect URI matches the final bundle ID.

Add these permissions:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Meeting Note records meeting audio you choose to capture.</string>

<key>NSCameraUsageDescription</key>
<string>Meeting Note lets you attach meeting photos to your notes.</string>

<key>NSPhotoLibraryUsageDescription</key>
<string>Meeting Note lets you choose files and images to attach to meeting notes.</string>

<key>NSPhotoLibraryAddUsageDescription</key>
<string>Meeting Note may save generated or captured meeting files when needed.</string>
```

Add background audio mode for recording continuity:

```xml
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
</array>
```

Optional MSAL broker query schemes, if using broker/Auth app support later:

```xml
<key>LSApplicationQueriesSchemes</key>
<array>
  <string>msauthv2</string>
  <string>msauthv3</string>
</array>
```

The current code uses:

```dart
broker: Broker.safariBrowser
```

So broker-specific testing may not be necessary immediately, but this should be revisited if Microsoft Authenticator broker/Conditional Access support is required.

## Bundle Identifier / Signing Steps

Open the workspace on macOS:

```bash
cd meeting-note-mobile/app
open "ios/Meeting Note.xcworkspace"
```

In Xcode:

1. Select `Runner`.
2. Select the `Runner` target.
3. Go to `Signing & Capabilities`.
4. Set Apple Developer Team.
5. Set a real Bundle Identifier.
6. If Bundle Identifier changes, update Azure iOS/macOS redirect URI.
7. Confirm automatic signing works for the physical iPhone.

Current bundle ID in `project.pbxproj`:

```text
com.tecace.meetingNoteMobile
```

Recommended: pick the final bundle ID before doing Azure/iPhone validation, because MSAL redirect URI depends on it.

## iOS Background Recording Notes

Current `RecordingNotifier` behavior:

- Android uses native foreground recorder through method channel:

```text
meeting_note_mobile/foreground_recorder
```

- iOS/non-Android uses the Flutter `record` package directly.
- iOS records either Opus `.ogg` if supported, otherwise AAC `.m4a`.
- The app persists a local recoverable recording session in secure storage.

Relevant file:

```text
meeting-note-mobile/app/lib/features/record/data/recording_service.dart
```

iOS still needs real-device validation for:

- Starting recording
- Continuing recording when app backgrounds
- Continuing recording when screen locks
- Recovering interrupted recordings
- Uploading recovered files to Supabase
- Processing recovered files through workflow server

If iOS background recording is unreliable, the next agent should investigate:

- Whether `UIBackgroundModes` with `audio` is enough for the `record` package
- Whether native iOS audio session configuration is needed
- Whether an iOS-specific recording service should be added, similar to Android native foreground recording

## Local Setup On Mac

Install prerequisites:

- Xcode from App Store
- Xcode command line tools
- Flutter SDK
- CocoaPods
- Valid Apple Developer account/team access

Recommended checks:

```bash
flutter doctor -v
xcodebuild -version
pod --version
```

If CocoaPods is missing:

```bash
sudo gem install cocoapods
```

Or use Homebrew if that is the machine standard.

## First Run On iOS Simulator

From the mobile app folder:

```bash
cd meeting-note-mobile/app
flutter clean
flutter pub get
cd ios
pod install
cd ..
flutter devices
flutter run -d "iPhone Simulator Name"
```

Simulator can validate UI and basic navigation, but it is not enough for final recording/camera/auth validation.

## First Run On Physical iPhone

1. Connect iPhone by USB.
2. Trust the Mac on the iPhone.
3. Open:

```bash
open "ios/Meeting Note.xcworkspace"
```

4. Configure signing in Xcode.
5. Select the connected iPhone.
6. Run from Xcode once to resolve signing/provisioning issues.

Then try from terminal:

```bash
cd meeting-note-mobile/app
flutter devices
flutter run -d DEVICE_ID
```

## Build For iOS Device

Debug:

```bash
flutter build ios --debug
```

Release, no codesign:

```bash
flutter build ios --release --no-codesign
```

Release with signing should usually be done through Xcode archive once the Apple team/profile is configured:

```text
Xcode > Product > Archive
```

## Core Feature Validation Checklist

After the app launches on iPhone, validate these in order.

### Authentication

- Microsoft sign-in opens.
- User can complete Microsoft login and MFA.
- App returns from MSAL redirect successfully.
- Supabase token exchange works.
- User stays signed in after closing/reopening app.

### Record Tab

- Microphone permission prompt appears.
- Recording starts.
- Timer updates.
- Pause works.
- Done stops recording and opens New Meeting Note.
- Recording continues when app is backgrounded.
- Recording continues when screen locks.
- If app is force-closed mid-recording, recovered recording appears only after reopen.

### Upload / Camera / Attachments

- File picker works on iOS.
- Camera permission prompt appears.
- Camera capture works from New Note.
- Camera capture works while recording, if UI button is available.
- Attachments are included in workflow generation.
- Attachments are saved to `meeting-note-images`.
- Attachment metadata is inserted into `note_image`.

### Generate Summary

- Summary prompts load.
- Selected prompt is sent as `promptId`.
- Audio uploads to Supabase bucket `meeting-recordings`.
- `file` row is created.
- Signed URL is created.
- Workflow job is created at:

```text
https://meeting-note-backend-njfb.onrender.com/summarize-audio/jobs
```

- Processing screen polls job status.
- Completed job opens Summary/Transcript detail.
- Transcript timestamps display correctly.
- Speaker labels and diarization display correctly.

### History

- Notes load from Supabase.
- Mine/shared/all filters work.
- List view works.
- Calendar month/week/day views work.
- Note actions work:
  - Share
  - Add to project
  - Sync Profile
  - Regenerate
  - Rename
  - Delete

### Projects

- Project list loads.
- New project modal creates projects.
- Project notes display.
- Project chat sends to n8n webhook.
- Chat sessions and chat rows persist in Supabase.

### Settings

- User info displays.
- Language toggle works.
- Light/dark theme toggle works.
- Summary prompts load/create/update/delete.
- Speaker profiles load/update.
- MCP setup page can create/revoke/list MCP keys.

## Backend Objects The iOS App Depends On

Supabase tables:

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

Supabase Storage buckets:

```text
meeting-recordings
meeting-note-images
recording-drafts
```

Supabase Edge Functions / RPC:

```text
/functions/v1/supabase-token
/functions/v1/mcp-token
/functions/v1/generate-profile
/rpc/add_accessible_note_to_project
```

External backend endpoints:

```text
https://meeting-note-backend-njfb.onrender.com/summarize-audio/jobs
https://meeting-note-backend-njfb.onrender.com/summarize-audio/jobs/:jobId
```

Project chat webhook:

```text
https://n8n.srv1153481.hstgr.cloud/webhook/9fe1b3b5-9e2e-4b23-8775-b38fc21e4b4d
```

## Likely Code Changes Needed For iOS

### 1. Bundle ID (done)

The bundle ID is now:

```text
com.tecace.meetingNoteMobile
```

(changed from `com.example.meetingNoteMobile` on 2026-08-06). Azure iOS/macOS
platform registration still needs the matching
`msauth.com.tecace.meetingNoteMobile://auth` redirect URI.

### 2. Add iOS Permissions

Update:

```text
meeting-note-mobile/app/ios/Runner/Info.plist
```

Add microphone, camera, photo library, and background audio entries.

### 3. Validate MSAL Redirect

Ensure `CFBundleURLSchemes` is:

```text
msauth.<BUNDLE_ID>
```

Ensure Azure redirect URI is:

```text
msauth.<BUNDLE_ID>://auth
```

### 4. Confirm iOS Recording

Test `record` package behavior on physical iPhone with:

- App foreground
- App background
- Screen locked
- Force-closed app

If needed, implement native iOS audio session handling.

### 5. Confirm File Picker / Camera

Validate `file_picker` and `image_picker` on physical iPhone.

### 6. Confirm Release Signing

Configure Apple Developer signing and archive flow.

## Useful Commands

```bash
cd meeting-note-mobile/app
flutter doctor -v
flutter clean
flutter pub get
cd ios && pod install && cd ..
flutter devices
flutter run -d DEVICE_ID
flutter build ios --debug
flutter build ios --release --no-codesign
```

## Notes For Claude Code

When working on this repo from macOS:

- Keep Android behavior intact.
- Do not change Supabase schema unless explicitly required.
- Do not change workflow server behavior unless confirmed safe for the web app.
- Prefer iOS-specific platform config or native iOS additions over altering Android recording code.
- If package/bundle IDs change, update Microsoft/Azure redirect URI documentation immediately.
- Do not commit local secrets or generated signing files.

## Reference Docs

Microsoft MSAL iOS/macOS redirect URI format:

```text
https://learn.microsoft.com/en-us/entra/msal/objc/redirect-uris-ios
```

Microsoft mobile app platform configuration:

```text
https://learn.microsoft.com/en-us/entra/identity-platform/scenario-mobile-app-configuration
```

