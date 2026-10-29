import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_note_mobile/app/router.dart';
import 'package:meeting_note_mobile/features/auth/providers/auth_provider.dart';
import 'package:meeting_note_mobile/features/notes/data/notes_repository.dart';
import 'package:meeting_note_mobile/features/notes/ui/new_note_screen.dart';
import 'package:meeting_note_mobile/features/record/data/recording_service.dart';
import 'package:meeting_note_mobile/features/settings/data/settings_repository.dart';
import 'new_note_auto_summary_test.dart'
    show FixedAuth, Settings, Notes, pumpFrames;

class Recording extends RecordingNotifier {
  Recording(this.duration);
  final Duration duration;
  @override
  RecordingState build() => RecordingState(
    state: RecordState.recording,
    elapsed: duration,
    loadingRecovery: false,
  );
  @override
  Future<String?> stop() async {
    state = const RecordingState(loadingRecovery: false);
    return '/fixture.m4a';
  }

  void autoStop() {
    state = const RecordingState(
      loadingRecovery: false,
      autoStoppedFilePath: '/auto.m4a',
    );
  }
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  const timeout = Timeout(Duration(seconds: 10));
  for (final seconds in [4, 60]) {
    testWidgets(
      'normal stop carries the actual $seconds second duration through the real router',
      (tester) async {
        tester.view.physicalSize = const Size(900, 1100);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final container = ProviderContainer(
          overrides: [
            authControllerProvider.overrideWith(FixedAuth.new),
            recordingProvider.overrideWith(
              () => Recording(Duration(seconds: seconds)),
            ),
            settingsRepositoryProvider.overrideWithValue(Settings()),
            notesRepositoryProvider.overrideWithValue(Notes()),
          ],
        );
        addTearDown(container.dispose);
        final router = container.read(routerProvider);
        addTearDown(router.dispose);
        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: MaterialApp.router(routerConfig: router),
          ),
        );
        await pumpFrames(tester);
        await tester.tap(find.text('Done'));
        await tester.pump(const Duration(milliseconds: 500));
        await pumpFrames(tester);
        final screen = tester.widget<NewNoteScreen>(find.byType(NewNoteScreen));
        expect(screen.autoSummarize, isTrue);
        expect(screen.recordingDuration, Duration(seconds: seconds));
        expect(
          find.textContaining('Summary starts'),
          seconds < 5 ? findsNothing : findsOneWidget,
        );
      },
      timeout: timeout,
    );
  }
  testWidgets(
    'two-hour auto-stop carries its automatic intent without changing the recording service',
    (tester) async {
      tester.view.physicalSize = const Size(900, 1100);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final recording = Recording(const Duration(hours: 2));
      final container = ProviderContainer(
        overrides: [
          authControllerProvider.overrideWith(FixedAuth.new),
          recordingProvider.overrideWith(() => recording),
          settingsRepositoryProvider.overrideWithValue(Settings()),
          notesRepositoryProvider.overrideWithValue(Notes()),
        ],
      );
      addTearDown(container.dispose);
      final router = container.read(routerProvider);
      addTearDown(router.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await pumpFrames(tester);
      recording.autoStop();
      await tester.pump(const Duration(milliseconds: 500));
      await pumpFrames(tester);
      final screen = tester.widget<NewNoteScreen>(find.byType(NewNoteScreen));
      expect(screen.autoSummarize, isTrue);
      expect(screen.recordingDuration, const Duration(hours: 2));
      expect(find.textContaining('Summary starts'), findsOneWidget);
    },
    timeout: timeout,
  );
}
