---
name: build-ios-ipa
description: >-
  Build the meeting-note Flutter app for iOS on a Mac (the Windows dev machine
  cannot build iOS). Hand this to the teammate with a MacBook. Covers pre-flight
  checks, running on the Simulator (works with no Apple account), free
  personal-team install on a physical iPhone (7-day, no paid account), and a
  distributable ad-hoc / TestFlight IPA (requires a paid Apple Developer account).
  Use when someone needs an iOS build of meeting-note-mobile.
---

# Build the meeting-note iOS app on a Mac

## Read this first (the one hard constraint)

iOS builds require macOS + Xcode.
The main dev machine is Windows, so this runs on the MacBook teammate's machine.

What is achievable depends entirely on the Apple account:

| Goal | Needs paid Apple Developer account ($99/yr)? | Status today |
|---|---|---|
| Run in the iOS **Simulator** (verify build, UI, dark mode, login) | No | ✅ works now |
| Install on **your own** iPhone, tethered by USB (7-day expiry) | No (free personal team) | ⚠️ works, limited |
| **Distributable IPA** (ad-hoc to registered devices, or TestFlight) | **Yes** | ❌ blocked until account exists |

As of 2026-07-30 the team has **no paid Apple Developer account and does not plan to get one soon**.
So the chosen plan is **Path B: free personal-team install** on a physical iPhone (7-day expiry, no cost).
Path A (Simulator) is a quick optional sanity check to run first.
Path C (distributable IPA) is deferred until a paid account exists.

**Whose Apple ID:** the free signing uses the Apple ID entered in Xcode on the **designer's Mac**. The designer's own free Apple ID is fine. Creating an Apple ID does **not** require a Mac, and nobody on the Windows side needs to supply one for this.

## 0. Pre-flight (run these, stop on the first failure)

```bash
# 1. Flutter/Dart version — this repo needs Flutter >= 3.44, Dart >= 3.12
flutter --version

# 2. Toolchain — Xcode and CocoaPods must both show a checkmark
flutter doctor -v

# 3. Xcode command-line tools + license
xcodebuild -version
sudo xcodebuild -license accept   # only if it complains about the license

# 4. CocoaPods present
pod --version                     # if missing: sudo gem install cocoapods
```

Then get the code onto the Mac:

```bash
git clone <repo-url> meeting-note      # or pull if already cloned
cd meeting-note
git checkout main                      # see "Which branch" in Gotchas
cd meeting-note-mobile/app
flutter pub get
```

Notes:
- The app reads its config from `String.fromEnvironment` with **production defaults**, so no `--dart-define` is needed. It points at the real prod Supabase (`smnnlamrwisqaquymsdl`) and backend by default. That means it writes to the live tester database. Do not delete notes or run destructive actions while testing.
- First `pod install` (run automatically by the build) can take several minutes.

## Path A — Run in the iOS Simulator (no Apple account, do this first)

```bash
open -a Simulator          # boots a simulator
flutter devices            # confirm the simulator appears
flutter run                # builds + installs + runs on the booted simulator
```

Build-only, without launching:

```bash
flutter build ios --simulator --debug
# output: build/ios/iphonesimulator/Runner.app
```

No signing and no Apple account are required for the Simulator.

What to verify while it runs:
- App launches, no crash.
- Dark mode looks correct on New Note / Summary / Processing screens (that was the recent fix).
- **Login**: MSAL uses the in-app browser (`ASWebAuthenticationSession`), which works in the Simulator. If login fails with a redirect / `AADSTS` error, see the MSAL note in Gotchas (Azure may be missing the iOS redirect).

## Path B — Install on a physical iPhone with a free personal team (chosen path, no paid account, 7-day)

This is the current plan. The iPhone being tested **must be physically connected by USB to the designer's Mac** at install time (no over-the-air install on a free account). So the tester is whoever plugs a phone into that Mac: usually the designer's own iPhone, or the boss's phone brought to the Mac. The install stops launching after 7 days and must be reinstalled the same way.

1. Open the workspace in Xcode:
   ```bash
   open ios/Runner.xcworkspace
   ```
2. Select the **Runner** target → **Signing & Capabilities**.
3. Team → **Add an Account** → sign in with a personal Apple ID → select it as the Team.
4. Check **Automatically manage signing**.
5. Connect the iPhone by USB, trust the Mac, pick the device in Xcode's device menu, press Run (▶).
6. On the iPhone: Settings → General → VPN & Device Management → trust the developer profile.

Caveats:
- **Bundle id collision:** a free personal team needs a bundle id unique to that Apple ID. `com.example.meetingNoteMobile` may be rejected as already taken. If so you must change it (for example `com.tecace.meetingnote.test`), which **breaks MSAL login** because the redirect scheme is derived from the bundle id. To still log in after changing it, add the matching `msauth.<newid>://auth` redirect to the Azure app registration `f81ec595-e95f-4b99-8143-fb4b198df787` (iOS/macOS platform). For a build-and-UI-only smoke test that skips login, changing the id is fine as-is.
- 7-day expiry, one Mac, USB-tethered devices only. Not a distribution method. For ongoing boss testing without re-tethering every week, a paid account + TestFlight (Path C) is the real answer.

## Path C — Distributable IPA (requires the paid Apple Developer account)

Do this once the team has a paid Apple Developer Program membership. Same skill, real signing.

1. In Xcode → Runner → Signing & Capabilities: set **Team** to the paid team, keep **Automatically manage signing**.
2. For **ad-hoc** (install on specific test devices): register each device's UDID in the Apple Developer portal first.
3. Build the IPA:
   ```bash
   # ad-hoc (hand the .ipa to registered testers)
   flutter build ipa --release --export-method ad-hoc

   # OR for TestFlight / App Store review
   flutter build ipa --release --export-method app-store
   ```
   Output: `build/ios/ipa/*.ipa`
4. Distribute:
   - **ad-hoc**: send the `.ipa` (AirDrop, link, MDM). Only registered UDIDs can install it.
   - **TestFlight**: upload to App Store Connect via Xcode Organizer, the Transporter app, or `xcrun altool`. Then invite testers in App Store Connect. This is the clean equivalent of the Android sideload and is the recommended path once the account exists.

Build numbers:
- iOS `CFBundleVersion` comes from Flutter's build number. `pubspec.yaml` is `0.1.0+1`.
- iOS build numbers are a **separate namespace from Android** (Android was bumped to 2002; iOS can start clean).
- TestFlight rejects a re-used build number, so bump it per upload: `flutter build ipa --release --build-number N`.

## Gotchas / prerequisites specific to this app

- **MSAL Azure iOS redirect (login blocker to verify):** the iOS URL scheme is already wired in `ios/Runner/Info.plist` (`msauth.$(PRODUCT_BUNDLE_IDENTIFIER)`), but the Azure app registration `f81ec595-e95f-4b99-8143-fb4b198df787` (TecAce tenant) must have an **iOS/macOS platform** redirect `msauth.com.example.meetingNoteMobile://auth`. iOS does **not** need a signature hash like Android did; the bundle id is enough. If login fails, check this in the Azure portal first.
- **Bundle id is a placeholder** (`com.example.meetingNoteMobile`). For a real TestFlight/App Store release under the paid account, register a proper id (for example `com.tecace.meetingnote`), update it in Xcode, and add the matching `msauth.<newid>://auth` redirect in Azure. Do this once, at the paid-account switch, not before.
- **Config writes to prod.** Same live Supabase and backend as the Android testers. Creating a note is fine; do not delete or bulk-edit data.
- **Which branch:** reliability fixes and P4 are on `main`. The dark-mode fix is on `ui/dark-mode-theming` (pending merge to `main` as of 2026-07-30). To include dark mode, build from `ui/dark-mode-theming`; otherwise `main`. After the merge, always build from `main`.
- If a build gets into a weird state: `flutter clean && flutter pub get`, then rebuild.

## What to report back

- `flutter doctor -v` output (so toolchain issues are visible).
- Whether the build succeeded and on which path (Simulator / device / IPA).
- Screenshots of the running app, especially the dark-mode screens.
- Any login error text verbatim (points at the Azure redirect item above).
