import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/app_theme.dart';
import '../../../shared/widgets/widgets.dart';
import '../providers/auth_provider.dart';

class SignInScreen extends ConsumerWidget {
  const SignInScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    final scheme = Theme.of(context).colorScheme;

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            children: [
              const Spacer(),
              Container(
                width: 84,
                height: 84,
                decoration: BoxDecoration(
                  color: scheme.primary,
                  borderRadius: BorderRadius.circular(24),
                  boxShadow: [
                    BoxShadow(
                      color: scheme.primary.withValues(alpha: 0.24),
                      blurRadius: 28,
                      offset: const Offset(0, 14),
                    ),
                  ],
                ),
                child: const Icon(
                  Icons.graphic_eq_rounded,
                  color: Colors.white,
                  size: 42,
                ),
              ),
              const SizedBox(height: 24),
              Text(
                'Meeting Note',
                style: TextStyle(
                  fontSize: 28,
                  fontWeight: FontWeight.w700,
                  color: scheme.onSurface,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Sign in with your Microsoft account to capture, summarize, and export your meeting notes.',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 15,
                  height: 1.45,
                  color: scheme.onSurfaceVariant,
                ),
              ),
              if (auth.error != null) ...[
                const SizedBox(height: 24),
                _ErrorMessage(message: auth.error!),
              ],
              const Spacer(),
              PrimaryButton(
                label: 'Sign in with Microsoft',
                icon: Icons.login_rounded,
                loading: auth.loading,
                onPressed: () =>
                    ref.read(authControllerProvider.notifier).signIn(),
              ),
              const SizedBox(height: 12),
              Text(
                'Meeting Note uses Microsoft authentication to access your workspace and OneDrive permissions.',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 12,
                  color: scheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ErrorMessage extends StatelessWidget {
  const _ErrorMessage({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.recording.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(AppRadius.button),
        border: Border.all(color: AppColors.recording.withValues(alpha: 0.28)),
      ),
      child: Text(
        message,
        textAlign: TextAlign.center,
        style: TextStyle(
          color: scheme.error,
          fontSize: 13,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
