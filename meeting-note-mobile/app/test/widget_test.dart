import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:meeting_note_mobile/features/auth/data/microsoft_auth_models.dart';
import 'package:meeting_note_mobile/features/auth/data/microsoft_auth_service.dart';
import 'package:meeting_note_mobile/features/auth/providers/auth_provider.dart';
import 'package:meeting_note_mobile/main.dart';

/// Signed-out fake: no cached account, so session restore ends immediately
/// without touching MSAL or secure-storage platform channels.
class _SignedOutAuthService implements MicrosoftAuthService {
  @override
  Future<MicrosoftAuthResult> acquireTokenSilent() =>
      Future<MicrosoftAuthResult>.error(StateError('no cached account'));

  @override
  Future<MicrosoftAuthResult> signIn() =>
      Future<MicrosoftAuthResult>.error(StateError('not used in this test'));

  @override
  Future<void> signOut() async {}
}

void main() {
  testWidgets('Meeting Note mobile opens on Microsoft sign-in', (tester) async {
    // Phone-sized surface. The test font (Ahem) renders wider than real fonts,
    // so use a 430dp-wide (large phone) surface to keep the button label in one row.
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          microsoftAuthServiceProvider
              .overrideWithValue(_SignedOutAuthService()),
        ],
        child: const MeetingNoteApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Meeting Note'), findsOneWidget);
    expect(find.text('Sign in with Microsoft'), findsOneWidget);
  });
}
