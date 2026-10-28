import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_note_mobile/core/network/dio_factory.dart';
import 'package:meeting_note_mobile/core/network/error_message.dart';
import 'package:meeting_note_mobile/core/network/retry_interceptor.dart';

/// Answers each call from [script]; an Exception step is thrown to simulate a
/// socket failure, an int step is returned as the HTTP status.
class _ScriptedAdapter implements HttpClientAdapter {
  _ScriptedAdapter(this.script);

  final List<Object> script;
  int calls = 0;
  final List<Map<String, dynamic>> headers = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    headers.add(Map<String, dynamic>.from(options.headers));
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

/// Dio whose nested fetch throws a non-Dio error.
class _ThrowingDio extends Fake implements Dio {
  @override
  Future<Response<T>> fetch<T>(RequestOptions requestOptions) =>
      throw StateError('boom');
}

Dio _dio(_ScriptedAdapter adapter, List<Duration> delays) {
  return createAppDio(
    BaseOptions(baseUrl: 'https://example.test'),
    adapter: adapter,
    retryBuilder: (dio) =>
        NetworkRetryInterceptor(dio, delay: (d) async => delays.add(d)),
  );
}

Future<DioException?> _failure(Future<Response<dynamic>> Function() f) async {
  try {
    await f();
    return null;
  } on DioException catch (e) {
    return e;
  }
}

void main() {
  const abort = SocketException('Software caused connection abort');

  test('SocketException once then success: 2 calls, backoff 400ms', () async {
    final a = _ScriptedAdapter([abort, 200]);
    final delays = <Duration>[];
    final res = await _dio(a, delays).get<dynamic>('/x');
    expect(res.statusCode, 200);
    expect(a.calls, 2);
    expect(delays, [const Duration(milliseconds: 400)]);
  });

  test('HttpException once then success', () async {
    final a = _ScriptedAdapter([const HttpException('Connection closed'), 200]);
    final res = await _dio(a, []).get<dynamic>('/x');
    expect(res.statusCode, 200);
    expect(a.calls, 2);
  });

  test('fails every time: error surfaces after exactly 3 attempts', () async {
    final a = _ScriptedAdapter([abort]);
    final delays = <Duration>[];
    final err = await _failure(() => _dio(a, delays).get<dynamic>('/x'));
    expect(err, isNotNull);
    expect(a.calls, 3);
    expect(delays, [
      const Duration(milliseconds: 400),
      const Duration(seconds: 1),
    ]);
  });

  test('HEAD is retried', () async {
    final a = _ScriptedAdapter([abort, 200]);
    final res = await _dio(a, []).head<dynamic>('/x');
    expect(res.statusCode, 200);
    expect(a.calls, 2);
  });

  for (final method in ['POST', 'PATCH', 'PUT', 'DELETE']) {
    test('$method is never retried', () async {
      final a = _ScriptedAdapter([abort, 200]);
      final err = await _failure(
        () => _dio(
          a,
          [],
        ).request<dynamic>('/x', options: Options(method: method)),
      );
      expect(err, isNotNull);
      expect(a.calls, 1);
    });
  }

  for (final status in [400, 404, 500, 503]) {
    test('HTTP $status is never retried', () async {
      final a = _ScriptedAdapter([status, 200]);
      final err = await _failure(() => _dio(a, []).get<dynamic>('/x'));
      expect(err?.response?.statusCode, status);
      expect(a.calls, 1);
    });
  }

  test('receiveTimeout is not retried', () async {
    final a = _ScriptedAdapter([
      DioException.receiveTimeout(
        timeout: const Duration(seconds: 1),
        requestOptions: RequestOptions(path: '/x'),
      ),
      200,
    ]);
    await _failure(() => _dio(a, []).get<dynamic>('/x'));
    expect(a.calls, 1);
  });

  test(
    '401 replay carries refreshed auth and does not multiply retries',
    () async {
      // Mirrors the production order: network retry first, then auth replay.
      final a = _ScriptedAdapter([abort, 401, 200]);
      final dio = _dio(a, []);
      dio.interceptors.add(
        InterceptorsWrapper(
          onError: (error, handler) async {
            if (error.response?.statusCode != 401) return handler.next(error);
            error.requestOptions.headers['authorization'] = 'Bearer fresh';
            handler.resolve(await dio.fetch<dynamic>(error.requestOptions));
          },
        ),
      );
      final res = await dio.get<dynamic>(
        '/x',
        options: Options(headers: {'authorization': 'Bearer stale'}),
      );
      expect(res.statusCode, 200);
      expect(a.calls, 3);
      expect(a.headers.last['authorization'], 'Bearer fresh');
    },
  );

  test(
    'retries stay bounded with a second error interceptor present',
    () async {
      final a = _ScriptedAdapter([abort]);
      final dio = _dio(a, []);
      dio.interceptors.add(
        InterceptorsWrapper(onError: (error, handler) => handler.next(error)),
      );
      await _failure(() => dio.get<dynamic>('/x'));
      expect(a.calls, 3);
    },
  );

  test(
    'non-Dio exception from the nested fetch is wrapped, not leaked',
    () async {
      final dio = Dio(BaseOptions(baseUrl: 'https://example.test'))
        ..httpClientAdapter = _ScriptedAdapter([abort]);
      dio.interceptors.add(
        NetworkRetryInterceptor(_ThrowingDio(), delay: (_) async {}),
      );
      final err = await _failure(() => dio.get<dynamic>('/x'));
      expect(err?.type, DioExceptionType.unknown);
      expect(err?.error, isA<StateError>());
    },
  );

  test(
    'cancel during the backoff rejects immediately with a cancel error',
    () async {
      final a = _ScriptedAdapter([abort, 200]);
      final never = Completer<void>();
      final token = CancelToken();
      final dio = createAppDio(
        BaseOptions(baseUrl: 'https://example.test'),
        adapter: a,
        retryBuilder: (d) =>
            NetworkRetryInterceptor(d, delay: (_) => never.future),
      );
      final future = _failure(() => dio.get<dynamic>('/x', cancelToken: token));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      token.cancel('user left');
      final err = await future.timeout(const Duration(seconds: 2));
      expect(err?.type, DioExceptionType.cancel);
      expect(a.calls, 1);
    },
  );

  test('exhausted retries keep the original type and inner error', () async {
    final a = _ScriptedAdapter([abort]);
    final err = await _failure(() => _dio(a, []).get<dynamic>('/x'));
    expect(err?.type, DioExceptionType.unknown);
    expect(err?.error, isA<SocketException>());
    expect(
      (err?.error as SocketException).message,
      'Software caused connection abort',
    );
  });

  test('HttpException error also survives exhaustion', () async {
    final a = _ScriptedAdapter([const HttpException('closed')]);
    final err = await _failure(() => _dio(a, []).get<dynamic>('/x'));
    expect(err?.error, isA<HttpException>());
  });

  group('friendlyErrorMessage', () {
    String t(String k) => k;
    DioException dioErr(DioExceptionType type, [Object? inner]) => DioException(
      requestOptions: RequestOptions(path: '/x'),
      type: type,
      error: inner,
    );

    test('connection-level errors map to error.network', () {
      for (final e in [
        dioErr(DioExceptionType.connectionError),
        dioErr(DioExceptionType.connectionTimeout),
        dioErr(DioExceptionType.unknown, abort),
        dioErr(DioExceptionType.unknown, const HttpException('x')),
      ]) {
        expect(friendlyErrorMessage(e, t, showDetails: false), 'error.network');
      }
    });

    test('other errors map to error.generic', () {
      expect(
        friendlyErrorMessage(StateError('boom'), t, showDetails: false),
        'error.generic',
      );
      expect(
        friendlyErrorMessage(
          dioErr(DioExceptionType.badResponse),
          t,
          showDetails: false,
        ),
        'error.generic',
      );
    });

    test('raw text only with showDetails', () {
      final e = StateError('secret-detail');
      expect(
        friendlyErrorMessage(e, t, showDetails: false),
        isNot(contains('secret-detail')),
      );
      expect(
        friendlyErrorMessage(e, t, showDetails: true),
        contains('secret-detail'),
      );
    });
  });
}
