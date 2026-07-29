import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/router.dart';
import 'core/theme/app_theme.dart';
import 'features/auth/providers/auth_provider.dart';
import 'features/notes/data/notes_repository.dart';
import 'features/settings/providers/settings_provider.dart';

void main() {
  runApp(const ProviderScope(child: MeetingNoteApp()));
}

class MeetingNoteApp extends ConsumerStatefulWidget {
  const MeetingNoteApp({super.key});

  @override
  ConsumerState<MeetingNoteApp> createState() => _MeetingNoteAppState();
}

class _MeetingNoteAppState extends ConsumerState<MeetingNoteApp> {
  // Resume is attempted once per app launch. Without this guard a later auth
  // refresh could yank the user back to the processing screen.
  bool _resumeHandled = false;

  @override
  Widget build(BuildContext context) {
    final themeMode = ref.watch(themeModeProvider);
    final router = ref.watch(routerProvider);

    // Resume any in-flight summarize job once the user is authenticated, so a
    // job that was processing when the app was killed reconnects to its
    // progress and still saves its attachments.
    ref.listen<AuthState>(authControllerProvider, (previous, next) {
      if (next.isAuthenticated) {
        _maybeResumePendingJob();
      } else {
        // Sign-out: allow the next signed-in user to resume their own job.
        _resumeHandled = false;
      }
    });
    if (ref.read(authControllerProvider).isAuthenticated) {
      _maybeResumePendingJob();
    }

    return MaterialApp.router(
      title: 'Meeting Note',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      themeMode: themeMode,
      routerConfig: router,
    );
  }

  Future<void> _maybeResumePendingJob() async {
    if (_resumeHandled) return;
    _resumeHandled = true;
    try {
      final job =
          await ref.read(notesRepositoryProvider).pendingJobForCurrentUser();
      if (job == null || !mounted) return;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        ref.read(routerProvider).go('/processing/${job.jobId}');
      });
    } catch (_) {
      // A failed resume must never block app startup; the note still completes
      // server-side and appears in history.
    }
  }
}
