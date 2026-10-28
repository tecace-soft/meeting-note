import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_note_mobile/core/network/error_message.dart';
import 'package:meeting_note_mobile/features/notes/data/notes_repository.dart';
import 'package:meeting_note_mobile/features/notes/models/meeting_note.dart';
import 'package:meeting_note_mobile/features/notes/ui/summary_screen.dart';

void main() {
  testWidgets('note load failure shows friendly text and retry works', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(900, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    var calls = 0;
    final note = MeetingNote(
      id: 'n1',
      title: 'Weekly sync',
      createdAt: DateTime.utc(2026, 10, 28),
      durationSec: 60,
      status: NoteStatus.done,
    );
    const friendly =
        "Can't reach the server. Check your connection and try again.";

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          noteProvider.overrideWith((ref, id) async {
            calls++;
            if (calls == 1) {
              throw DioException(
                requestOptions: RequestOptions(path: '/note'),
                type: DioExceptionType.unknown,
                error: const SocketException(
                  'Software caused connection abort',
                ),
              );
            }
            return note;
          }),
        ],
        child: const MaterialApp(home: SummaryScreen(noteId: 'n1')),
      ),
    );
    await tester.pumpAndSettle();

    // flutter test runs in debug mode, where details are appended after the
    // friendly message. Release behavior (no raw text) is covered by the
    // showDetails: false mapper test.
    expect(find.textContaining(friendly), findsOneWidget);
    expect(
      friendlyErrorMessage(StateError('x'), (k) => k, showDetails: false),
      isNot(contains('StateError')),
    );
    expect(find.text('Try again'), findsOneWidget);

    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();

    expect(calls, 2);
    expect(find.text('Try again'), findsNothing);
    expect(find.textContaining(friendly), findsNothing);
    expect(find.textContaining('Weekly sync'), findsWidgets);
  });
}
