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
  AuthState build() => const AuthState(
    user: MicrosoftUser(
      id: 'owner',
      displayName: 'Owner',
      email: 'owner@example.test',
    ),
  );
}

class _Notes extends NotesRepository {
  _Notes() : super(Dio());
  int shares = 0;
  int saves = 0;
  int fullShares = 0;
  bool failShare = false;
  bool failSave = false;
  String owner = 'owner';
  String? microsoftId = 'colleague-oid';
  String? lastTarget;
  List<String> shared = ['legacy-recipient'];
  List<TecAceContact> contacts = [];
  @override
  Future<String?> currentUserId() async => 'owner';
  @override
  Future<List<SavedSpeaker>> savedSpeakers() async => [
    SavedSpeaker(id: 'person-1', name: 'Colleague', microsoftId: microsoftId),
  ];
  @override
  Future<SavedSpeaker> ensureSavedSpeaker({
    required String name,
    String? email,
    String? microsoftId,
  }) async => SavedSpeaker(
    id: 'person-1',
    name: name,
    microsoftId: microsoftId ?? this.microsoftId,
  );
  @override
  Future<List<TecAceContact>> tecAceContacts() async => contacts;
  @override
  Future<void> saveDiarization(
    String noteId,
    List<TranscriptSegment> segments,
  ) async {
    if (failSave) throw StateError('Synthetic name save failure');
    saves++;
  }

  @override
  Future<List<String>> shareNoteWithMicrosoftUser(
    String noteId,
    String microsoftId, {
    bool Function()? isCurrent,
  }) async {
    shares++;
    if (failShare) throw const NoteSharingChangedError();
    lastTarget = microsoftId;
    shared = {...shared, microsoftId}.toList();
    return shared;
  }

  @override
  Future<void> shareNote(String id, List<String> ids) async {
    fullShares++;
    if (failShare) throw StateError('Synthetic zero-row write');
    shared = ids;
  }

  @override
  Future<NoteSharingSnapshot> getNoteSharing(String noteId) async =>
      NoteSharingSnapshot(ownerId: owner, sharedUsers: shared);
  @override
  Future<List<SpeakerSuggestion>> requestSpeakerSuggestions({
    required List<TranscriptSegment> segments,
    required String? selfName,
  }) async => const [
    SpeakerSuggestion(
      label: 'Speaker A',
      name: 'Colleague',
      speakerId: 'person-1',
      confidence: 0.9,
      isSelf: false,
      rationale: 'Fixture',
    ),
  ];
  @override
  Future<void> logSpeakerFeedback({
    required String? noteId,
    required String label,
    required String chosenName,
    String? chosenSpeakerId,
    required String source,
    SpeakerSuggestion? suggestion,
  }) async {}
}

Future<void> settle(WidgetTester tester) => tester.pumpAndSettle(
  const Duration(milliseconds: 100),
  EnginePhase.sendSemanticsUpdate,
  const Duration(seconds: 3),
);
Future<void> _mount(WidgetTester tester, _Notes repository) async {
  // Ahem test glyphs are wider than the shipped font; retain the existing layout.
  tester.view.physicalSize = const Size(900, 1100);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final note = MeetingNote(
    id: 'note-1',
    ownerId: repository.owner,
    title: 'Fixture',
    createdAt: DateTime.utc(2026, 10, 29),
    durationSec: 60,
    status: NoteStatus.done,
    sharedUserIds: repository.shared,
    transcript: const [
      TranscriptSegment(
        startMs: 0,
        text: 'An update.',
        speaker: 'Speaker A',
        speakerKey: 'Speaker A',
      ),
    ],
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        authControllerProvider.overrideWith(_OwnerAuth.new),
        notesRepositoryProvider.overrideWithValue(repository),
        noteProvider.overrideWith((ref, id) async => note),
      ],
      child: const MaterialApp(home: SummaryScreen(noteId: 'note-1')),
    ),
  );
  await settle(tester);
  await tester.tap(find.text('Transcript'));
  await tester.pump();
}

Future<void> pickSaved(
  WidgetTester tester, {
  String label = 'Speaker A',
}) async {
  await tester.tap(find.text(label).last);
  await settle(tester);
  await tester.tap(find.text('Colleague').last);
  await tester.tap(find.text('Change').last);
  await settle(tester);
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  const timeout = Timeout(Duration(seconds: 10));
  testWidgets(
    'naming a saved speaker saves the name without sharing, then an explicit click shares',
    (tester) async {
      final repository = _Notes();
      await _mount(tester, repository);
      await pickSaved(tester);
      expect(repository.saves, 1);
      expect(repository.shares, 0);
      expect(repository.shared, ['legacy-recipient']);
      await tester.tap(find.text('Share this note with this person'));
      await settle(tester);
      expect(repository.shares, 1);
      expect(repository.lastTarget, 'colleague-oid');
      expect(repository.shared, ['legacy-recipient', 'colleague-oid']);
      expect(find.text('Already shared'), findsOneWidget);
    },
    timeout: timeout,
  );
  testWidgets(
    'typing a known name does not infer its Microsoft identity and opens the existing share picker',
    (tester) async {
      final repository = _Notes();
      await _mount(tester, repository);
      await tester.tap(find.text('Speaker A').last);
      await settle(tester);
      await tester.enterText(find.byType(TextField).last, 'Colleague');
      await tester.tap(find.text('Change').last);
      await settle(tester);
      expect(repository.shares, 0);
      expect(find.text('Share this note with this person'), findsNothing);
      await tester.tap(find.text('Choose who to share with'));
      await settle(tester);
      expect(find.text('Share note'), findsOneWidget);
      expect(repository.fullShares, 0);
      expect(repository.shared, ['legacy-recipient']);
    },
    timeout: timeout,
  );
  testWidgets(
    'an explicitly selected contact uses its object id and does not share while naming',
    (tester) async {
      final repository = _Notes()
        ..contacts = const [
          TecAceContact(
            id: 'selected-contact',
            displayName: 'Directory Person',
            email: 'person@example.test',
            userPrincipalName: 'person@example.test',
          ),
        ];
      await _mount(tester, repository);
      await tester.tap(find.text('Speaker A').last);
      await settle(tester);
      await tester.tap(find.text('Directory Person'));
      await settle(tester);
      expect(repository.saves, 1);
      expect(repository.shares, 0);
      await tester.tap(find.text('Share this note with this person'));
      await settle(tester);
      expect(repository.lastTarget, 'selected-contact');
    },
    timeout: timeout,
  );
  testWidgets(
    'accepting suggestions requires a separate share click and keeps the last speaker offer',
    (tester) async {
      final repository = _Notes();
      await _mount(tester, repository);
      await tester.tap(find.text('Suggest speakers'));
      await settle(tester);
      await tester.tap(find.text('Apply'));
      await settle(tester);
      expect(repository.saves, 1);
      expect(repository.shares, 0);
      expect(find.text('Suggest speakers'), findsNothing);
      expect(find.text('Share this note with this person'), findsOneWidget);
    },
    timeout: timeout,
  );
  testWidgets(
    'zero-row failures preserve the name and existing shares and permit explicit retry',
    (tester) async {
      final repository = _Notes()..failShare = true;
      await _mount(tester, repository);
      await pickSaved(tester);
      await tester.tap(find.text('Share this note with this person'));
      await settle(tester);
      expect(find.textContaining('Could not share'), findsOneWidget);
      expect(repository.shared, ['legacy-recipient']);
      repository.failShare = false;
      await tester.tap(find.text('Share this note with this person'));
      await settle(tester);
      expect(find.text('Already shared'), findsOneWidget);
    },
    timeout: timeout,
  );
  testWidgets('nonowners get an error without a sharing button or write', (
    tester,
  ) async {
    final repository = _Notes()..owner = 'different-owner';
    await _mount(tester, repository);
    await pickSaved(tester);
    expect(find.textContaining('Only the note owner'), findsOneWidget);
    expect(find.text('Share this note with this person'), findsNothing);
    expect(repository.shares, 0);
  }, timeout: timeout);
  testWidgets('a failed name save never exposes a share action', (
    tester,
  ) async {
    final repository = _Notes()..failSave = true;
    await _mount(tester, repository);
    await pickSaved(tester);
    expect(find.textContaining('Synthetic name save failure'), findsOneWidget);
    expect(repository.shares, 0);
    expect(find.text('Share this note with this person'), findsNothing);
  }, timeout: timeout);
  testWidgets(
    'reset clears the offer without revoking previously shared users',
    (tester) async {
      final repository = _Notes();
      await _mount(tester, repository);
      await pickSaved(tester);
      await tester.tap(find.text('Colleague').last);
      await settle(tester);
      await tester.tap(find.text('Reset A/B'));
      await settle(tester);
      expect(find.text('Share this note with this person'), findsNothing);
      expect(repository.shared, ['legacy-recipient']);
      expect(repository.shares, 0);
    },
    timeout: timeout,
  );
  testWidgets('the owner is not offered as a sharing target', (tester) async {
    final repository = _Notes()..microsoftId = 'owner';
    await _mount(tester, repository);
    await pickSaved(tester);
    expect(find.text('Share this note with this person'), findsNothing);
    expect(find.text('Choose who to share with'), findsNothing);
  }, timeout: timeout);
}
