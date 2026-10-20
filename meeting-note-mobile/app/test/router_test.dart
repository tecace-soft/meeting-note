import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:meeting_note_mobile/app/router.dart';
import 'package:meeting_note_mobile/features/auth/data/microsoft_auth_models.dart';
import 'package:meeting_note_mobile/features/auth/providers/auth_provider.dart';
import 'package:meeting_note_mobile/features/auth/ui/sign_in_screen.dart';
import 'package:meeting_note_mobile/features/record/ui/record_screen.dart';

/// Auth controller fixed to a given state, so routing is tested in isolation
/// from MSAL and secure storage.
class _FixedAuth extends AuthController {
  _FixedAuth(this._initial);

  final AuthState _initial;

  @override
  AuthState build() => _initial;
}

Future<String> _pumpRouter(WidgetTester tester, AuthState auth) async {
  tester.view.physicalSize = const Size(430, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  final container = ProviderContainer(
    overrides: [authControllerProvider.overrideWith(() => _FixedAuth(auth))],
  );
  addTearDown(container.dispose);
  final router = container.read(routerProvider);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  await tester.pump();
  return router.routerDelegate.currentConfiguration.uri.path;
}

void main() {
  testWidgets('shows the loading screen while the session is restoring',
      (tester) async {
    final path = await _pumpRouter(tester, const AuthState(loading: true));

    expect(path, '/loading');
    expect(find.byType(LoadingScreen), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets('goes to sign-in when restore finished signed out',
      (tester) async {
    final path = await _pumpRouter(tester, const AuthState());

    expect(path, '/signin');
    expect(find.byType(SignInScreen), findsOneWidget);
    expect(find.byType(LoadingScreen), findsNothing);
  });

  testWidgets('goes to the record route when restore finished signed in',
      (tester) async {
    final path = await _pumpRouter(
      tester,
      const AuthState(
        user: MicrosoftUser(id: 'u1', displayName: 'Test User', email: 't@x.y'),
      ),
    );

    expect(path, '/record');
    expect(find.byType(RecordScreen), findsOneWidget);
    expect(find.byType(LoadingScreen), findsNothing);
    expect(find.byType(SignInScreen), findsNothing);
  });
}
