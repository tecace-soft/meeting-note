import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:meeting_note_mobile/main.dart';

void main() {
  testWidgets('Meeting Note mobile opens on Microsoft sign-in', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: MeetingNoteApp()));
    await tester.pumpAndSettle();

    expect(find.text('Meeting Note'), findsOneWidget);
    expect(find.text('Sign in with Microsoft'), findsOneWidget);
  });
}
