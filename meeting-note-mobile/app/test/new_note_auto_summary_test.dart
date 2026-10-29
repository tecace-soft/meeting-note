import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:meeting_note_mobile/features/auth/data/microsoft_auth_models.dart';
import 'package:meeting_note_mobile/features/auth/providers/auth_provider.dart';
import 'package:meeting_note_mobile/features/notes/data/notes_repository.dart';
import 'package:meeting_note_mobile/features/notes/ui/new_note_screen.dart';
import 'package:meeting_note_mobile/features/notes/ui/processing_screen.dart';
import 'package:meeting_note_mobile/features/settings/data/settings_repository.dart';

class FixedAuth extends AuthController {
  @override
  AuthState build() => const AuthState(
    user: MicrosoftUser(
      id: 'owner',
      displayName: 'Owner',
      email: 'owner@example.test',
    ),
  );
}

class Settings extends SettingsRepository {
  static const defaults = [
    SettingsSummaryPrompt(
      id: 'prompt-default',
      name: 'Default',
      prompt: 'Summarize.',
    ),
  ];
  @override
  Future<List<SettingsSummaryPrompt>?> cachedSummaryPrompts() async => defaults;
  @override
  Future<List<SettingsSummaryPrompt>> refreshSummaryPrompts() async => defaults;
}

class Notes extends NotesRepository {
  Notes() : super(Dio());
  String? existing;
  bool fail = false;
  int checks = 0;
  @override
  Future<String?> referencingNote(String audioPath) async {
    checks++;
    if (fail) throw StateError('Synthetic reference failure');
    return existing;
  }
}

Future<void> pumpFrames(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.pump();
  }
}

Future<GoRouter> mount(
  WidgetTester tester,
  NewNoteScreen screen,
  List<PendingProcessingJob> submissions, {
  Notes? notes,
}) async {
  tester.view.physicalSize = const Size(430, 1000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final router = GoRouter(
    routes: [
      GoRoute(path: '/', builder: (_, __) => screen),
      GoRoute(
        path: '/record',
        builder: (_, __) => const Scaffold(body: Text('Record fixture')),
      ),
      GoRoute(
        path: '/note/:id',
        builder: (_, __) => const Scaffold(body: Text('Existing note fixture')),
      ),
      GoRoute(
        path: '/processing/:id',
        builder: (_, state) {
          final pending = state.extra as PendingProcessingJob;
          if (!submissions.contains(pending)) submissions.add(pending);
          return const Scaffold(body: Text('Processing fixture'));
        },
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        authControllerProvider.overrideWith(FixedAuth.new),
        settingsRepositoryProvider.overrideWithValue(Settings()),
        notesRepositoryProvider.overrideWithValue(notes ?? Notes()),
      ],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  await pumpFrames(tester);
  return router;
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  const timeout = Timeout(Duration(seconds: 10));
  testWidgets(
    'a completed recording waits five seconds then submits once with a snapshot',
    (tester) async {
      final submissions = <PendingProcessingJob>[];
      await mount(
        tester,
        const NewNoteScreen(
          audioPath: '/fixture.m4a',
          autoSummarize: true,
          recordingDuration: Duration(seconds: 60),
          initialAttachmentPaths: ['/image.jpg'],
        ),
        submissions,
      );
      expect(find.text('Summary starts in 5 seconds'), findsOneWidget);
      await tester.enterText(
        find.byType(TextField).at(1),
        'Use the decisions.',
      );
      await tester.pump(const Duration(seconds: 4));
      expect(submissions, isEmpty);
      expect(find.text('Summary starts in 1 seconds'), findsOneWidget);
      await tester.pump(const Duration(seconds: 1));
      await pumpFrames(tester);
      expect(submissions, hasLength(1));
      expect(submissions.single.instructions, 'Use the decisions.');
      expect(submissions.single.attachmentPaths, ['/image.jpg']);
      expect(submissions.single.promptId, 'prompt-default');
      await tester.pump(const Duration(seconds: 10));
      expect(submissions, hasLength(1));
    },
    timeout: timeout,
  );
  testWidgets(
    'cancel preserves audio and submits nothing even after the deadline',
    (tester) async {
      final submissions = <PendingProcessingJob>[];
      await mount(
        tester,
        const NewNoteScreen(
          audioPath: '/fixture.m4a',
          autoSummarize: true,
          recordingDuration: Duration(seconds: 60),
        ),
        submissions,
      );
      await tester.tap(find.text('Cancel'));
      await tester.pump(const Duration(seconds: 10));
      expect(submissions, isEmpty);
      expect(find.text('fixture.m4a'), findsOneWidget);
      expect(find.textContaining('Summary starts'), findsNothing);
    },
    timeout: timeout,
  );
  testWidgets(
    'a recording below five seconds stays manual and preserves the original',
    (tester) async {
      final submissions = <PendingProcessingJob>[];
      await mount(
        tester,
        const NewNoteScreen(
          audioPath: '/short.m4a',
          autoSummarize: true,
          recordingDuration: Duration(milliseconds: 4999),
        ),
        submissions,
      );
      expect(
        find.text('This recording is too short to start automatically.'),
        findsOneWidget,
      );
      await tester.pump(const Duration(seconds: 10));
      expect(submissions, isEmpty);
      expect(find.text('short.m4a'), findsOneWidget);
    },
    timeout: timeout,
  );
  testWidgets(
    'exactly five seconds is eligible and restored recordings stay manual',
    (tester) async {
      final submissions = <PendingProcessingJob>[];
      await mount(
        tester,
        const NewNoteScreen(
          audioPath: '/five.m4a',
          autoSummarize: true,
          recordingDuration: Duration(seconds: 5),
        ),
        submissions,
      );
      expect(find.text('Summary starts in 5 seconds'), findsOneWidget);
      await tester.pump(const Duration(seconds: 5));
      await pumpFrames(tester);
      expect(submissions, hasLength(1));
      await tester.pumpWidget(const SizedBox.shrink());
      final recoveredSubmissions = <PendingProcessingJob>[];
      await mount(
        tester,
        const NewNoteScreen(audioPath: '/recovered.m4a'),
        recoveredSubmissions,
      );
      await tester.pump(const Duration(seconds: 10));
      expect(recoveredSubmissions, isEmpty);
      expect(find.textContaining('Summary starts'), findsNothing);
    },
    timeout: timeout,
  );
  testWidgets('leaving the screen cancels the grace timer', (tester) async {
    final submissions = <PendingProcessingJob>[];
    await mount(
      tester,
      const NewNoteScreen(audioPath: '/fixture.m4a', autoSummarize: true),
      submissions,
    );
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 10));
    expect(submissions, isEmpty);
    expect(tester.takeException(), isNull);
  }, timeout: timeout);
  testWidgets(
    'a manual start during grace submits once and clears the timer',
    (tester) async {
      final submissions = <PendingProcessingJob>[];
      await mount(
        tester,
        const NewNoteScreen(audioPath: '/fixture.m4a', autoSummarize: true),
        submissions,
      );
      final submit = find.text('Generate Summary');
      await tester.ensureVisible(submit);
      await tester.tap(submit);
      await tester.tap(submit);
      await pumpFrames(tester);
      await tester.pump(const Duration(seconds: 10));
      expect(submissions, hasLength(1));
    },
    timeout: timeout,
  );
  testWidgets('file selection is eligible without a recorded duration', (
    tester,
  ) async {
    final submissions = <PendingProcessingJob>[];
    await mount(
      tester,
      const NewNoteScreen(audioPath: '/picked.mp3', autoSummarize: true),
      submissions,
    );
    await tester.pump(const Duration(seconds: 5));
    await pumpFrames(tester);
    expect(submissions, hasLength(1));
  }, timeout: timeout);
  testWidgets(
    'recent recording with a note opens it without auto-submitting',
    (tester) async {
      final notes = Notes()..existing = 'existing-1';
      final submissions = <PendingProcessingJob>[];
      await mount(
        tester,
        const NewNoteScreen(
          audioPath: 'storage://bucket/file?fileId=f',
          autoSummarize: true,
          checkReferences: true,
        ),
        submissions,
        notes: notes,
      );
      expect(notes.checks, 1);
      expect(find.text('A note already uses this recording.'), findsOneWidget);
      await tester.pump(const Duration(seconds: 10));
      expect(submissions, isEmpty);
      await tester.tap(find.text('Open note'));
      await pumpFrames(tester);
      expect(find.text('Existing note fixture'), findsOneWidget);
    },
    timeout: timeout,
  );
  testWidgets(
    'an incomplete recent reference check fails closed without losing audio',
    (tester) async {
      final notes = Notes()..fail = true;
      final submissions = <PendingProcessingJob>[];
      await mount(
        tester,
        const NewNoteScreen(
          audioPath: 'storage://bucket/file?fileId=f',
          autoSummarize: true,
          checkReferences: true,
        ),
        submissions,
        notes: notes,
      );
      expect(
        find.text('Could not check existing notes. Start a summary manually.'),
        findsOneWidget,
      );
      await tester.pump(const Duration(seconds: 10));
      expect(submissions, isEmpty);
    },
    timeout: timeout,
  );
  testWidgets(
    'a recent recording with no references starts after its own grace',
    (tester) async {
      final submissions = <PendingProcessingJob>[];
      final notes = Notes();
      await mount(
        tester,
        const NewNoteScreen(
          audioPath: 'storage://bucket/file?fileId=f',
          autoSummarize: true,
          checkReferences: true,
        ),
        submissions,
        notes: notes,
      );
      expect(notes.checks, 1);
      await tester.pump(const Duration(seconds: 5));
      await pumpFrames(tester);
      expect(submissions, hasLength(1));
    },
    timeout: timeout,
  );
}
