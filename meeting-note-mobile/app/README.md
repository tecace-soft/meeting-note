# Meeting Note Mobile App

Flutter app for Meeting Note mobile UI and native Microsoft sign-in.

## Run

```bash
flutter pub get
flutter run \
  --dart-define=API_BASE_URL=https://meetingnote.tecace.com/api/v1
```

## Microsoft Login Setup

Create or update an Azure app registration with the same delegated Graph scopes
used by the web app:

- `User.Read`
- `Chat.Read`
- `Chat.ReadWrite`
- `ChatMessage.Read`
- `Files.ReadWrite`
- `Files.ReadWrite.All`
- `User.ReadBasic.All`
- `Calendars.Read`

The mobile login request starts with `https://graph.microsoft.com/user.read`
only. Request the broader Teams, calendar, and OneDrive scopes when those
features are wired.

Android needs a platform entry for package
`com.tecace.meeting_note_mobile` and the debug/release signature hash.

Debug signature hash:

```text
guC64kbNdu+bu67b7Ujd62XWb3s=
```

Debug redirect URI:

```text
msauth://com.tecace.meeting_note_mobile/guC64kbNdu%2Bbu67b7Ujd62XWb3s%3D
```

iOS needs a platform entry for the bundle ID `com.tecace.meetingNoteMobile`,
i.e. redirect URI `msauth.com.tecace.meetingNoteMobile://auth`. The app already
declares the MSAL URL scheme `msauth.$(PRODUCT_BUNDLE_IDENTIFIER)` in
`Info.plist`.

> **2026-08-06 — app ID change.** Both IDs moved from `com.example.*` to
> `com.tecace.*`. The Azure app registration `f81ec595-e95f-4b99-8143-fb4b198df787`
> must have the redirect URIs above added (the old `com.example.*` ones no longer
> match), otherwise Microsoft sign-in fails on both platforms. The Android
> signature hash is unchanged — it comes from the keystore, not the package name.
