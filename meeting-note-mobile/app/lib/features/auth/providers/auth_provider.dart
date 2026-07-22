import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/auth_token_store.dart';
import '../data/microsoft_auth_models.dart';
import '../data/microsoft_auth_service.dart';
import '../data/supabase_token_service.dart';
import '../../notes/data/notes_repository.dart';

final microsoftAuthServiceProvider = Provider<MicrosoftAuthService>((ref) {
  return createMicrosoftAuthService();
});

final supabaseTokenServiceProvider = Provider<SupabaseTokenService>((ref) {
  return SupabaseTokenService();
});

final authControllerProvider =
    NotifierProvider<AuthController, AuthState>(AuthController.new);

class AuthState {
  const AuthState({
    this.user,
    this.loading = false,
    this.error,
  });

  final MicrosoftUser? user;
  final bool loading;
  final String? error;

  bool get isAuthenticated => user != null;

  AuthState copyWith({
    MicrosoftUser? user,
    bool? loading,
    String? error,
    bool clearUser = false,
    bool clearError = false,
  }) {
    return AuthState(
      user: clearUser ? null : user ?? this.user,
      loading: loading ?? this.loading,
      error: clearError ? null : error ?? this.error,
    );
  }
}

class AuthController extends Notifier<AuthState> {
  static const _tokens = AuthTokenStore();

  @override
  AuthState build() {
    Future.microtask(_restoreSession);
    return const AuthState(loading: true);
  }

  Future<void> _restoreSession() async {
    try {
      final result =
          await ref.read(microsoftAuthServiceProvider).acquireTokenSilent();
      await _tokens.saveMicrosoftTokens(
        accessToken: result.accessToken,
        idToken: result.idToken,
        expiresOn: result.expiresOn,
        userId: result.user.id,
      );
      final canonicalUserId = await _saveSupabaseToken(result.accessToken);
      await _ensureSelfSpeaker(result.user, microsoftId: canonicalUserId);
      ref.invalidate(promptsProvider);
      state = AuthState(user: result.user);
    } catch (_) {
      state = const AuthState();
    }
  }

  Future<void> signIn() async {
    state = state.copyWith(loading: true, clearError: true);
    try {
      final result = await ref.read(microsoftAuthServiceProvider).signIn();
      await _tokens.saveMicrosoftTokens(
        accessToken: result.accessToken,
        idToken: result.idToken,
        expiresOn: result.expiresOn,
        userId: result.user.id,
      );
      final canonicalUserId = await _saveSupabaseToken(result.accessToken);
      await _ensureSelfSpeaker(result.user, microsoftId: canonicalUserId);
      ref.invalidate(promptsProvider);
      state = AuthState(user: result.user);
    } catch (error) {
      state = AuthState(error: _messageFor(error));
    }
  }

  Future<void> signOut() async {
    state = state.copyWith(loading: true, clearError: true);
    try {
      await ref.read(microsoftAuthServiceProvider).signOut();
    } finally {
      await _tokens.clear();
      state = const AuthState();
    }
  }

  Future<String?> _saveSupabaseToken(String microsoftAccessToken) async {
    final result = await ref
        .read(supabaseTokenServiceProvider)
        .exchangeMicrosoftToken(microsoftAccessToken);
    await _tokens.saveSupabaseToken(
      accessToken: result.accessToken,
      expiresOn: result.expiresOn,
      userId: result.userId,
    );
    return result.userId;
  }

  Future<void> _ensureSelfSpeaker(
    MicrosoftUser user, {
    String? microsoftId,
  }) async {
    final name = _deriveSelfSpeakerName(user.displayName);
    if (name == null) return;
    try {
      await ref.read(notesRepositoryProvider).ensureSavedSpeaker(
            name: name,
            email: user.email,
            microsoftId: microsoftId ?? user.id,
          );
    } catch (_) {
      // Match the web app behavior: speaker bootstrap should not block sign-in.
    }
  }

  String? _deriveSelfSpeakerName(String raw) {
    var value = raw.replaceAll(RegExp(r'\([^)]*\)'), ' ');
    value = value.replaceAll(RegExp(r'[^a-zA-Z]+'), ' ');
    value = value.trim().replaceAll(RegExp(r'\s+'), ' ');
    if (value.isEmpty) return null;
    return value
        .split(' ')
        .where((part) => part.isNotEmpty)
        .map((part) => part.substring(0, 1).toUpperCase() +
            part.substring(1).toLowerCase())
        .join(' ');
  }

  String _messageFor(Object error) {
    final message = error.toString();
    if (message.contains('MSAL_CLIENT_ID') ||
        message.contains('MSAL_ANDROID_REDIRECT_URI')) {
      return 'Microsoft sign-in needs the mobile Azure app configuration. Use the app README values for the Android package and redirect URI.';
    }
    if (message.contains('not configured')) {
      return 'Microsoft sign-in needs the Android redirect URI registered in Azure.';
    }
    if (message.contains('AADSTS50194') ||
        message.contains('/common endpoint') ||
        message.contains('multi-tenant')) {
      return 'Microsoft rejected the sign-in authority. This app must use the Meeting Note tenant endpoint, not /common. Details: $message';
    }
    if (message.contains('invalid_request') ||
        message.contains('redirect_uri') ||
        message.contains('redirect uri')) {
      return 'Microsoft rejected the Android sign-in request. Check the Azure Android platform package/signature hash and scopes. Details: $message';
    }
    if (message.contains('Unsupported')) {
      return 'Microsoft sign-in is available on Android and iOS builds.';
    }
    return 'Could not sign in with Microsoft. Details: $message';
  }
}
