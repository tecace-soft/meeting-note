import 'package:dio/dio.dart';

import '../../../core/network/supabase_config.dart';

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

  Future<SupabaseTokenResult> exchangeMicrosoftToken(
    String microsoftAccessToken,
  ) async {
    if (!isSupabaseConfigured) {
      throw StateError('Supabase is not configured for mobile history.');
    }

    final response = await _dio.post<Map<String, dynamic>>(
      '/functions/v1/supabase-token',
      data: const <String, dynamic>{},
      options: Options(
        headers: {
          'apikey': supabaseAnonKey,
          'content-type': 'application/json',
          'x-ms-access-token': microsoftAccessToken,
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
