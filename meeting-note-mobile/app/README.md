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
`com.example.meeting_note_mobile` and the debug/release signature hash.

Debug signature hash:

```text
guC64kbNdu+bu67b7Ujd62XWb3s=
```

Debug redirect URI:

```text
msauth://com.example.meeting_note_mobile/guC64kbNdu%2Bbu67b7Ujd62XWb3s%3D
```

iOS needs a platform entry for the final bundle ID. The app already declares the
MSAL URL scheme `msauth.$(PRODUCT_BUNDLE_IDENTIFIER)` in `Info.plist`.
