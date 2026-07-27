# Meeting Note Mobile

Flutter (iOS + Android) app for the existing Meeting Note web app (https://meetingnote.tecace.com).

## Contents

```
docs/
  01-PRD.md                        Product requirements
  02-screens-and-flows.md          Screen structure & user flows
  03-architecture-and-components.md Flutter architecture & UI component list
  04-api-integration.md            API integration plan (proposed contract)
  05-implementation-plan.md        Step-by-step 12-week plan
app/                               Starter Flutter code (runnable with mock data)
```

## Running the starter app

```bash
cd app
flutter create . --platforms=ios,android   # generates ios/ & android/ around lib/
flutter pub get
flutter run --dart-define=API_BASE_URL=https://meetingnote.tecace.com/api/v1
```

`flutter create .` is needed once — this repo ships only `lib/` + `pubspec.yaml`.

### Platform setup after `flutter create .`

**iOS (`ios/Runner/Info.plist`):**
```xml
<key>NSMicrophoneUsageDescription</key>
<string>Meeting Note records meeting audio you choose to capture.</string>
<key>NSCameraUsageDescription</key>
<string>Attach whiteboard photos to your meeting notes.</string>
<key>UIBackgroundModes</key>
<array><string>audio</string></array>
```

**Android (`android/app/src/main/AndroidManifest.xml`):**
```xml
<uses-permission android:name="android.permission.RECORD_AUDIO"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE"/>
<uses-permission android:name="android.permission.CAMERA"/>
```

## What works out of the box
Recording (real, native), file/camera picking (real), bottom nav, theme toggle,
history/summary/processing screens (mock data via `NotesRepository`).

## What to wire next
Every `// TODO:` in `notes_repository.dart` and `api_client.dart` maps to an
endpoint in `docs/04-api-integration.md`. Follow `docs/05-implementation-plan.md`.
