import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../../core/network/supabase_config.dart';
import 'auth_token_store.dart';
import 'microsoft_auth_service.dart';
import 'supabase_token_service.dart';

class MobileSupabaseAuth {
  const MobileSupabaseAuth({
    required this.token,
    required this.userId,
  });

  final String token;
  final String userId;
}

class MobileSupabaseSession {
  MobileSupabaseSession({
    SupabaseTokenService? supabaseTokenService,
    MicrosoftAuthService? microsoftAuthService,
  })  : _supabaseTokenService = supabaseTokenService ?? SupabaseTokenService(),
        _microsoftAuthService =
            microsoftAuthService ?? createMicrosoftAuthService();

  static const _storage = FlutterSecureStorage();
  static const _store = AuthTokenStore();
  static Future<SupabaseTokenResult>? _refreshing;

  final SupabaseTokenService _supabaseTokenService;
  final MicrosoftAuthService _microsoftAuthService;

  static Future<String?> cachedUserId() async {
    final supabaseUserId =
        await _storage.read(key: AuthTokenStore.supabaseUserIdKey);
    final microsoftUserId =
        await _storage.read(key: AuthTokenStore.microsoftUserIdKey);
    final trimmed = supabaseUserId?.trim();
    if (trimmed != null && trimmed.isNotEmpty) return trimmed;
    final fallback = microsoftUserId?.trim();
    return fallback == null || fallback.isEmpty ? null : fallback;
  }

  Future<MobileSupabaseAuth> auth() async {
    if (!isSupabaseConfigured) {
      throw StateError('Supabase is not configured for mobile.');
    }

    var token = await _storage.read(key: AuthTokenStore.supabaseAccessTokenKey);
    var userId = await _storage.read(key: AuthTokenStore.supabaseUserIdKey);
    final expiresAt = await _storage.read(
        key: AuthTokenStore.supabaseAccessTokenExpiresAtKey);

    if (token == null || token.isEmpty || _expiresSoon(expiresAt)) {
      final refreshed = await _refreshSupabaseToken();
      token = refreshed.accessToken;
      userId = refreshed.userId ?? userId;
    }

    userId = _validUserId(userId) ??
        _validUserId(_jwtSubject(token)) ??
        _validUserId(
          await _storage.read(key: AuthTokenStore.microsoftUserIdKey),
        );
    if (userId == null) {
      throw StateError('Supabase user id is not available. Sign in again.');
    }
    return MobileSupabaseAuth(token: token, userId: userId);
  }

  Future<T> withAuthRetry<T>(
    Future<T> Function(MobileSupabaseAuth auth) request,
  ) async {
    try {
      return await request(await auth());
    } on DioException catch (error) {
      if (error.response?.statusCode != 401) rethrow;
      return request(await refreshAuth());
    }
  }

  Interceptor retryOnUnauthorizedInterceptor() {
    return InterceptorsWrapper(
      onError: (error, handler) async {
        final statusCode = error.response?.statusCode;
        final alreadyRetried =
            error.requestOptions.extra['supabaseAuthRetried'] == true;
        if (statusCode != 401 || alreadyRetried) {
          handler.next(error);
          return;
        }

        try {
          final refreshed = await refreshAuth();
          final request = error.requestOptions;
          request.extra['supabaseAuthRetried'] = true;
          request.headers['authorization'] = 'Bearer ${refreshed.token}';
          request.headers['apikey'] = supabaseAnonKey;
          final response = await _replayDio().fetch<dynamic>(request);
          handler.resolve(response);
        } catch (_) {
          handler.next(error);
        }
      },
    );
  }

  /// Retry interceptor for workflow-server calls, which authenticate with the
  /// raw Microsoft access token (not the Supabase app JWT). On a 401 the MS
  /// token has usually expired mid-job; re-acquire it silently and replay once.
  /// Without this a long transcription poll hard-fails on token expiry even
  /// though the job is fine server-side.
  Interceptor retryOnWorkflowUnauthorizedInterceptor() {
    return InterceptorsWrapper(
      onError: (error, handler) async {
        final statusCode = error.response?.statusCode;
        final alreadyRetried =
            error.requestOptions.extra['workflowAuthRetried'] == true;
        if (statusCode != 401 || alreadyRetried) {
          handler.next(error);
          return;
        }

        final freshToken = await refreshMicrosoftToken();
        if (freshToken == null || freshToken.isEmpty) {
          handler.next(error);
          return;
        }
        try {
          final request = error.requestOptions;
          request.extra['workflowAuthRetried'] = true;
          request.headers['authorization'] = 'Bearer $freshToken';
          final response = await _replayDio().fetch<dynamic>(request);
          handler.resolve(response);
        } catch (_) {
          handler.next(error);
        }
      },
    );
  }

  /// Silently re-acquire a fresh Microsoft access token and persist it. Returns
  /// null when silent acquisition fails, so callers fall back to the original
  /// error instead of looping. Used by workflow-server 401 recovery.
  Future<String?> refreshMicrosoftToken() async {
    try {
      final microsoft = await _microsoftAuthService.acquireTokenSilent();
      await _store.saveMicrosoftTokens(
        accessToken: microsoft.accessToken,
        idToken: microsoft.idToken,
        expiresOn: microsoft.expiresOn,
        userId: microsoft.user.id,
      );
      return microsoft.accessToken;
    } catch (_) {
      return null;
    }
  }

  /// Short-lived Dio for replaying a single retried request. It must carry
  /// timeouts so a replay can never hang indefinitely (a bare `Dio()` has none).
  static Dio _replayDio() => Dio(
        BaseOptions(
          connectTimeout: const Duration(seconds: 30),
          receiveTimeout: const Duration(minutes: 2),
          sendTimeout: const Duration(minutes: 5),
        ),
      );

  Future<MobileSupabaseAuth> refreshAuth() async {
    final refreshed = await _refreshSupabaseToken();
    final userId = _validUserId(refreshed.userId) ??
        _validUserId(_jwtSubject(refreshed.accessToken)) ??
        _validUserId(
          await _storage.read(key: AuthTokenStore.microsoftUserIdKey),
        );
    if (userId == null) {
      throw StateError('Supabase user id is not available. Sign in again.');
    }
    return MobileSupabaseAuth(token: refreshed.accessToken, userId: userId);
  }

  Future<SupabaseTokenResult> _refreshSupabaseToken() {
    return _refreshing ??= _doRefresh().whenComplete(() => _refreshing = null);
  }

  Future<SupabaseTokenResult> _doRefresh() async {
    try {
      final microsoft = await _microsoftAuthService.acquireTokenSilent();
      await _store.saveMicrosoftTokens(
        accessToken: microsoft.accessToken,
        idToken: microsoft.idToken,
        expiresOn: microsoft.expiresOn,
        userId: microsoft.user.id,
      );
      return _exchange(microsoft.accessToken);
    } catch (_) {
      final cached = await _storage.read(key: AuthTokenStore.accessTokenKey);
      if (cached == null || cached.isEmpty) {
        throw StateError('Microsoft session expired. Sign in again.');
      }
      return _exchange(cached);
    }
  }

  Future<SupabaseTokenResult> _exchange(String microsoftAccessToken) async {
    final result = await _supabaseTokenService
        .exchangeMicrosoftToken(microsoftAccessToken);
    await _store.saveSupabaseToken(
      accessToken: result.accessToken,
      expiresOn: result.expiresOn,
      userId: result.userId,
    );
    return result;
  }

  bool _expiresSoon(String? value) {
    if (value == null || value.isEmpty) return true;
    final expiresAt = DateTime.tryParse(value);
    if (expiresAt == null) return true;
    return expiresAt.toUtc().isBefore(
          DateTime.now().toUtc().add(const Duration(minutes: 2)),
        );
  }

  String? _validUserId(String? value) {
    final trimmed = value?.trim();
    return trimmed == null || trimmed.isEmpty ? null : trimmed;
  }
}

String? _jwtSubject(String? token) {
  if (token == null || token.isEmpty) return null;
  final parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    final payload =
        utf8.decode(base64Url.decode(base64Url.normalize(parts[1])));
    final data = jsonDecode(payload);
    if (data is Map<String, dynamic>) {
      final sub = data['sub'];
      return sub is String && sub.isNotEmpty ? sub : null;
    }
  } catch (_) {
    return null;
  }
  return null;
}
