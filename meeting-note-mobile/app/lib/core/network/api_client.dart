import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../features/auth/data/auth_token_store.dart';

/// Base URL per flavor: flutter run --dart-define=API_BASE_URL=https://meetingnote.tecace.com/api/v1
const _baseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'https://meetingnote.tecace.com/api/v1',
);

final apiClientProvider = Provider<Dio>((ref) {
  final dio = Dio(BaseOptions(
    baseUrl: _baseUrl,
    connectTimeout: const Duration(seconds: 15),
    receiveTimeout: const Duration(seconds: 30),
  ));
  dio.interceptors.add(AuthInterceptor(dio));
  return dio;
});

class AuthInterceptor extends Interceptor {
  AuthInterceptor(this._dio);

  final Dio _dio;
  static const _storage = FlutterSecureStorage();
  static const _kAccess = AuthTokenStore.accessTokenKey;
  static const _kRefresh = 'refresh_token';

  @override
  Future<void> onRequest(
      RequestOptions options, RequestInterceptorHandler handler) async {
    final token = await _storage.read(key: _kAccess);
    if (token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }

  @override
  Future<void> onError(
      DioException err, ErrorInterceptorHandler handler) async {
    // Refresh once on 401, then replay the original request.
    if (err.response?.statusCode == 401 &&
        err.requestOptions.extra['retried'] != true) {
      final refresh = await _storage.read(key: _kRefresh);
      if (refresh != null) {
        try {
          final res = await _dio.post('/auth/refresh',
              data: {'refreshToken': refresh},
              options: Options(extra: {'retried': true}));
          final newAccess = res.data['accessToken'] as String;
          await _storage.write(key: _kAccess, value: newAccess);

          final opts = err.requestOptions..extra['retried'] = true;
          opts.headers['Authorization'] = 'Bearer $newAccess';
          final replay = await _dio.fetch(opts);
          return handler.resolve(replay);
        } catch (_) {
          await _storage.deleteAll();
          // TODO: notify auth provider → router redirects to /signin.
        }
      }
    }
    handler.next(err);
  }
}
