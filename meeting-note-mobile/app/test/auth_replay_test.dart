import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_note_mobile/core/network/dio_factory.dart';
import 'package:meeting_note_mobile/core/network/retry_interceptor.dart';
import 'package:meeting_note_mobile/features/auth/data/microsoft_auth_models.dart';
import 'package:meeting_note_mobile/features/auth/data/microsoft_auth_service.dart';
import 'package:meeting_note_mobile/features/auth/data/mobile_supabase_session.dart';

class _NoAuth implements MicrosoftAuthService {
  @override
  Future<MicrosoftAuthResult> acquireTokenSilent() =>
      Future<MicrosoftAuthResult>.error(StateError('unused'));

  @override
  Future<MicrosoftAuthResult> signIn() =>
      Future<MicrosoftAuthResult>.error(StateError('unused'));

  @override
  Future<void> signOut() async {}
}

/// Session whose token refresh is stubbed, so the REAL
/// retryOnUnauthorizedInterceptor can run without platform channels.
class _Session extends MobileSupabaseSession {
  _Session({required super.replayDioBuilder, this.refreshThrows = false})
    : super(microsoftAuthService: _NoAuth());

  final bool refreshThrows;

  @override
  Future<MobileSupabaseAuth> refreshAuth() async {
    if (refreshThrows) throw StateError('refresh failed');
    return const MobileSupabaseAuth(token: 'fresh', userId: 'u1');
  }
}

class _Adapter implements HttpClientAdapter {
  _Adapter(this.script);

  final List<Object> script;
  int calls = 0;
  Map<String, dynamic>? lastHeaders;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    lastHeaders = Map<String, dynamic>.from(options.headers);
    final step = script[calls < script.length ? calls : script.length - 1];
    calls++;
    if (step is Exception) throw step;
    return ResponseBody.fromString(
      '{}',
      step as int,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

Dio _dio(_Adapter adapter) => createAppDio(
  BaseOptions(baseUrl: 'https://example.test'),
  adapter: adapter,
  retryBuilder: (d) => NetworkRetryInterceptor(d, delay: (_) async {}),
);

void main() {
  const abort = SocketException('Software caused connection abort');

  test('replay failing with a connection error forwards that error', () async {
    final main = _Adapter([401]);
    final replay = _Adapter([abort]);
    final session = _Session(replayDioBuilder: () => _dio(replay));
    final dio = _dio(main)
      ..interceptors.add(session.retryOnUnauthorizedInterceptor());

    try {
      await dio.get<dynamic>('/x');
      fail('expected failure');
    } on DioException catch (e) {
      expect(e.response?.statusCode, isNull);
      expect(NetworkRetryInterceptor.isConnectionLevel(e), isTrue);
    }
    expect(main.calls, 1);
  });

  test('successful replay carries the refreshed auth header', () async {
    final main = _Adapter([401]);
    final replay = _Adapter([200]);
    final session = _Session(replayDioBuilder: () => _dio(replay));
    final dio = _dio(main)
      ..interceptors.add(session.retryOnUnauthorizedInterceptor());

    final res = await dio.get<dynamic>('/x');
    expect(res.statusCode, 200);
    expect(replay.lastHeaders?['authorization'], 'Bearer fresh');
  });

  test('refresh failure keeps the original 401', () async {
    final main = _Adapter([401]);
    final replay = _Adapter([200]);
    final session = _Session(
      replayDioBuilder: () => _dio(replay),
      refreshThrows: true,
    );
    final dio = _dio(main)
      ..interceptors.add(session.retryOnUnauthorizedInterceptor());

    try {
      await dio.get<dynamic>('/x');
      fail('expected failure');
    } on DioException catch (e) {
      expect(e.response?.statusCode, 401);
    }
    expect(replay.calls, 0);
  });
}
