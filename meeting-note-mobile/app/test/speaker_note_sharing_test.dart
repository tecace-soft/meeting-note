import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_note_mobile/features/auth/data/microsoft_auth_models.dart';
import 'package:meeting_note_mobile/features/auth/providers/auth_provider.dart';
import 'package:meeting_note_mobile/features/notes/data/notes_repository.dart';
import 'package:meeting_note_mobile/features/notes/models/meeting_note.dart';
import 'package:meeting_note_mobile/features/notes/ui/summary_screen.dart';

class _OwnerAuth extends AuthController {
  @override
  AuthState build() => const AuthState(user: MicrosoftUser(
    id: 'owner', displayName: 'Owner', email: 'owner@example.test',
  ));
}

class _Notes extends NotesRepository {
  _Notes() : super(Dio());
  int shares = 0;
  int saves = 0;
  @override
  Future<String?> currentUserId() async => 'owner';
  @override
  Future<List<SavedSpeaker>> savedSpeakers() async => const [
    SavedSpeaker(id: 'person-1', name: 'Colleague', microsoftId: 'colleague-oid'),
  ];
  @override
  Future<List<TecAceContact>> tecAceContacts() async => [];
  @override
  Future<void> saveDiarization(String noteId, List<TranscriptSegment> segments) async { saves++; }
  @override
  Future<void> shareNoteWithMicrosoftUser(String noteId, String microsoftId, List<String> currentSharedUserIds) async { shares++; }
  @override
  Future<void> logSpeakerFeedback({required String noteId, required String label, required String chosenName, String? chosenSpeakerId, required String source, SpeakerSuggestion? suggestion}) async {}
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  testWidgets('naming a saved speaker saves the name without sharing the note', (tester) async {
    tester.view.physicalSize = const Size(430, 1100);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final repository = _Notes();
    final note = MeetingNote(id: 'note-1', ownerId: 'owner', title: 'Fixture',
      createdAt: DateTime.utc(2026, 10, 29), durationSec: 60, status: NoteStatus.done,
      transcript: const [TranscriptSegment(startMs: 0, text: 'An update.', speaker: 'Speaker A', speakerKey: 'Speaker A')]);
    await tester.pumpWidget(ProviderScope(overrides: [
      authControllerProvider.overrideWith(_OwnerAuth.new),
      notesRepositoryProvider.overrideWithValue(repository),
      noteProvider.overrideWith((ref, id) async => note),
    ], child: const MaterialApp(home: SummaryScreen(noteId: 'note-1'))));
    await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 3));
    await tester.tap(find.text('Transcript'));
    await tester.pump();
    await tester.tap(find.text('Speaker A').last);
    await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 3));
    await tester.tap(find.text('Colleague'));
    await tester.tap(find.text('Change').last);
    await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 3));
    expect(repository.saves, 1);
    expect(repository.shares, 0);
    expect(find.text('Share this note with this person'), findsOneWidget);
  }, timeout: const Timeout(Duration(seconds: 10)));
}
