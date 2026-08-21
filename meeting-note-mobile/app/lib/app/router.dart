import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/auth/providers/auth_provider.dart';
import '../features/auth/ui/sign_in_screen.dart';
import '../features/notes/ui/history_screen.dart';
import '../features/notes/ui/new_note_screen.dart';
import '../features/notes/ui/processing_screen.dart';
import '../features/issues/ui/issues_screen.dart';
import '../features/notes/ui/summary_screen.dart';
import '../features/projects/ui/projects_screen.dart';
import '../features/record/ui/record_screen.dart';
import '../features/settings/ui/settings_screen.dart';
import 'shell.dart';

final routerProvider = Provider<GoRouter>((ref) {
  final auth = ref.watch(authControllerProvider);

  return GoRouter(
    initialLocation: '/record',
    errorBuilder: (context, state) => RouteErrorScreen(error: state.error),
    redirect: (context, state) {
      final isSigningIn = state.matchedLocation == '/signin';
      final isLoading = state.matchedLocation == '/loading';
      if (auth.loading) {
        return isLoading ? '/record' : null;
      }
      if (isLoading) return auth.isAuthenticated ? '/record' : '/signin';
      if (!auth.isAuthenticated && !isSigningIn) return '/signin';
      if (auth.isAuthenticated && isSigningIn) return '/record';
      return null;
    },
    routes: [
      StatefulShellRoute.indexedStack(
        builder: (context, state, shell) => AppShell(
          shell: shell,
          showBottomNav: state.uri.path != '/record/new-note',
        ),
        branches: [
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/record',
              builder: (context, state) => const RecordScreen(),
              routes: [
                GoRoute(
                  path: 'new-note',
                  builder: (context, state) {
                    final extra = state.extra;
                    return NewNoteScreen(
                      audioPath: extra is NewNoteDraft
                          ? extra.audioPath
                          : extra is String
                              ? extra
                              : null,
                      initialAttachmentPaths:
                          extra is NewNoteDraft ? extra.attachmentPaths : const [],
                    );
                  },
                ),
              ],
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/history',
              builder: (context, state) => const HistoryScreen(),
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/projects',
              builder: (context, state) => const ProjectsScreen(),
              routes: [
                GoRoute(
                  path: ':projectId',
                  builder: (context, state) => ProjectDetailScreen(
                    projectId: state.pathParameters['projectId']!,
                    projectName:
                        state.extra is String ? state.extra as String : null,
                  ),
                ),
              ],
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/settings',
              builder: (context, state) => const SettingsScreen(),
              routes: [
                GoRoute(
                  path: 'summary-prompts',
                  builder: (context, state) => const SummaryPromptsScreen(),
                ),
                GoRoute(
                  path: 'speaker-profiles',
                  builder: (context, state) => const SpeakerProfilesScreen(),
                ),
                GoRoute(
                  path: 'my-memory',
                  builder: (context, state) => const MyMemoryScreen(),
                ),
                GoRoute(
                  path: 'mcp-setup',
                  builder: (context, state) => const McpSetupScreen(),
                ),
                GoRoute(
                  path: 'issues',
                  builder: (context, state) => const IssuesScreen(),
                ),
              ],
            ),
          ]),
        ],
      ),
      GoRoute(
        path: '/processing/:jobId',
        builder: (context, state) => ProcessingScreen(
          jobId: state.pathParameters['jobId']!,
          pendingJob: state.extra is PendingProcessingJob
              ? state.extra as PendingProcessingJob
              : null,
        ),
      ),
      GoRoute(
        path: '/note/:id',
        builder: (context, state) =>
            SummaryScreen(noteId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/signin',
        builder: (context, state) => const SignInScreen(),
      ),
      GoRoute(
        path: '/loading',
        builder: (context, state) => const LoadingScreen(),
      ),
    ],
  );
});

class LoadingScreen extends StatelessWidget {
  const LoadingScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: SafeArea(
        child: Center(child: CircularProgressIndicator()),
      ),
    );
  }
}

class RouteErrorScreen extends StatelessWidget {
  const RouteErrorScreen({super.key, this.error});

  final Exception? error;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(title: const Text('Meeting Note')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Icon(
                Icons.error_outline_rounded,
                size: 48,
                color: scheme.error,
              ),
              const SizedBox(height: 16),
              Text(
                'Something went wrong',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 8),
              Text(
                error?.toString() ?? 'The app could not open that screen.',
                textAlign: TextAlign.center,
                style: TextStyle(color: scheme.onSurfaceVariant),
              ),
              const SizedBox(height: 24),
              FilledButton.icon(
                onPressed: () => context.go('/record'),
                icon: const Icon(Icons.mic_rounded),
                label: const Text('Back to Record'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
