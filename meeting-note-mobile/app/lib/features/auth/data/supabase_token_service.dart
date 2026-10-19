import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../../core/network/supabase_config.dart';

/// Server limits (supabase/functions/_shared/verified-microsoft-identity.ts):
/// the ID token must be unexpired and at most 2 hours old. The margins keep a
/// token that would expire mid-flight (or a nearly expired app JWT, whose
/// lifetime is capped at the ID token's) from being sent.
const _idTokenMinRemaining = Duration(minutes: 10);
const _idTokenMaxAge = Duration(minutes: 100);

/// Returns [idToken] when it is a JWT that still has at least 10 minutes left
/// and was issued less than 100 minutes ago (by this device's clock), else
/// null so the exchange goes without it. Only reads `exp` / `iat`; the server
/// verifies the signature.
@visibleForTesting
String? usableMicrosoftIdToken(String? idToken, {DateTime? now}) {
  final value = idToken?.trim();
  if (value == null || value.isEmpty) return null;
  final parts = value.split('.');
  if (parts.length != 3) return null;
  try {
    final payload = jsonDecode(
      utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
    );
    if (payload is! Map<String, dynamic>) return null;
    final exp = payload['exp'];
    final iat = payload['iat'];
    if (exp is! num || iat is! num) return null;
    final at = (now ?? DateTime.now()).toUtc();
    final expiresAt =
        DateTime.fromMillisecondsSinceEpoch(exp.toInt() * 1000, isUtc: true);
    final issuedAt =
        DateTime.fromMillisecondsSinceEpoch(iat.toInt() * 1000, isUtc: true);
    if (expiresAt.difference(at) < _idTokenMinRemaining) return null;
    if (at.difference(issuedAt) > _idTokenMaxAge) return null;
    return value;
  } catch (_) {
    return null;
  }
}

class SupabaseTokenResult {
  const SupabaseTokenResult({
    required this.accessToken,
    required this.expiresOn,
    this.userId,
  });

  final String accessToken;
  final DateTime expiresOn;
  final String? userId;
}

class SupabaseTokenService {
  SupabaseTokenService({
    Dio? dio,
  }) : _dio = dio ??
            Dio(
              BaseOptions(
                baseUrl: supabaseUrl.replaceAll(RegExp(r'/$'), ''),
                connectTimeout: const Duration(seconds: 15),
                receiveTimeout: const Duration(seconds: 30),
              ),
            );

  final Dio _dio;

  /// Exchanges the Microsoft tokens for the app (Supabase) JWT.
  ///
  /// [microsoftIdToken] comes from the same MSAL result as the access token
  /// (app registration `f81ec595-...`, TecAce tenant authority, so its `aud`
  /// and `iss` match what supabase-token verifies). It is sent only while it
  /// is fresh enough for the server's checks (see [usableMicrosoftIdToken]);
  /// msal_auth has no forceRefresh, so a cached one can be close to expiry.
  /// If the server rejects it (401, e.g. device clock skew), the exchange is
  /// retried once without it, which works while the server still accepts
  /// legacy exchanges (SUPABASE_TOKEN_REQUIRE_ID_TOKEN off).
  Future<SupabaseTokenResult> exchangeMicrosoftToken(
    String microsoftAccessToken, {
    String? microsoftIdToken,
  }) async {
    if (!isSupabaseConfigured) {
      throw StateError('Supabase is not configured for mobile history.');
    }

    final idToken = usableMicrosoftIdToken(microsoftIdToken);
    if (idToken != null) {
      try {
        return await _postExchange(microsoftAccessToken, idToken);
      } on DioException catch (error) {
        if (error.response?.statusCode != 401) rethrow;
      }
    }
    return _postExchange(microsoftAccessToken, null);
  }

  Future<SupabaseTokenResult> _postExchange(
    String microsoftAccessToken,
    String? microsoftIdToken,
  ) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/functions/v1/supabase-token',
      data: const <String, dynamic>{},
      options: Options(
        headers: {
          'apikey': supabaseAnonKey,
          'content-type': 'application/json',
          'x-ms-access-token': microsoftAccessToken,
          if (microsoftIdToken != null) 'x-ms-id-token': microsoftIdToken,
        },
      ),
    );

    final data = response.data ?? const <String, dynamic>{};
    final token = data['access_token'];
    if (token is! String || token.isEmpty) {
      final error = data['error'];
      throw StateError(
        error is String ? error : 'Could not get Supabase access token.',
      );
    }

    final expiresAt = data['expires_at'];
    final expiresOn = expiresAt is num
        ? DateTime.fromMillisecondsSinceEpoch(expiresAt.toInt() * 1000)
        : DateTime.now().add(const Duration(minutes: 55));

    final user = data['user'];
    final userId = user is Map<String, dynamic> ? user['id'] : null;

    return SupabaseTokenResult(
      accessToken: token,
      expiresOn: expiresOn,
      userId: userId is String ? userId : null,
    );
  }
}
