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
  dio.interceptors.add(AuthInterceptor());
  return dio;
});

/// Attaches the Microsoft access token as a Bearer header.
///
/// NOTE: this client is currently unused for live requests (workflow calls go
/// through NotesRepository's own `_workflow` Dio, which has its own 401 recovery
/// in `retryOnWorkflowUnauthorizedInterceptor`). The previous 401-refresh branch
/// here was dead and unsafe: it read a `refresh_token` key that is never written
/// and posted to an `/auth/refresh` endpoint this backend does not expose, and
/// its unreachable failure path wiped every token via `deleteAll()` with no
/// redirect. It was removed rather than left as misleading dead code.
class AuthInterceptor extends Interceptor {
  static const _storage = FlutterSecureStorage();
  static const _kAccess = AuthTokenStore.accessTokenKey;

  @override
  Future<void> onRequest(
      RequestOptions options, RequestInterceptorHandler handler) async {
    final token = await _storage.read(key: _kAccess);
    if (token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }
}
