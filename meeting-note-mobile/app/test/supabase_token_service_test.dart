import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_note_mobile/features/auth/data/supabase_token_service.dart';

String _jwt(Map<String, Object?> claims) {
  String part(Object value) =>
      base64Url.encode(utf8.encode(jsonEncode(value))).replaceAll('=', '');
  return '${part({'alg': 'RS256', 'typ': 'JWT'})}.${part(claims)}.sig';
}

/// Records each supabase-token request and answers from [statusFor].
class _FakeAdapter implements HttpClientAdapter {
  _FakeAdapter(this.statusFor);

  final int Function(RequestOptions options) statusFor;
  final List<Map<String, dynamic>> headers = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    headers.add(Map<String, dynamic>.from(options.headers));
    final status = statusFor(options);
    final body = status == 200
        ? {
            'access_token': 'app-jwt',
            'expires_at': 2000000000,
            'user': {'id': 'oid-1'},
          }
        : {'error': 'Microsoft identity verification failed.'};
    return ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  final now = DateTime.utc(2026, 10, 15, 12);
  int secs(DateTime t) => t.millisecondsSinceEpoch ~/ 1000;

  group('usableMicrosoftIdToken', () {
    test('fresh token is sent', () {
      final token = _jwt({
        'iat': secs(now.subtract(const Duration(minutes: 5))),
        'exp': secs(now.add(const Duration(minutes: 55))),
      });
      expect(usableMicrosoftIdToken(token, now: now), token);
    });

    test('nearly expired, too old, malformed or missing tokens are not sent',
        () {
      final nearlyExpired = _jwt({
        'iat': secs(now.subtract(const Duration(minutes: 55))),
        'exp': secs(now.add(const Duration(minutes: 5))),
      });
      final tooOld = _jwt({
        'iat': secs(now.subtract(const Duration(hours: 2))),
        'exp': secs(now.add(const Duration(hours: 1))),
      });
      final noExp = _jwt({'iat': secs(now)});
      expect(usableMicrosoftIdToken(nearlyExpired, now: now), isNull);
      expect(usableMicrosoftIdToken(tooOld, now: now), isNull);
      expect(usableMicrosoftIdToken(noExp, now: now), isNull);
      expect(usableMicrosoftIdToken('not-a-jwt', now: now), isNull);
      expect(usableMicrosoftIdToken(null, now: now), isNull);
    });
  });

  group('exchangeMicrosoftToken', () {
    final freshIdToken = _jwt({
      'iat': secs(DateTime.now().toUtc()),
      'exp': secs(DateTime.now().toUtc().add(const Duration(hours: 1))),
    });

    SupabaseTokenService serviceWith(_FakeAdapter adapter) {
      final dio = Dio(BaseOptions(baseUrl: 'https://edge.example.test'));
      dio.httpClientAdapter = adapter;
      return SupabaseTokenService(dio: dio);
    }

    test('sends the ID token with the access token', () async {
      final adapter = _FakeAdapter((_) => 200);
      final result = await serviceWith(adapter)
          .exchangeMicrosoftToken('graph', microsoftIdToken: freshIdToken);
      expect(result.accessToken, 'app-jwt');
      expect(adapter.headers, hasLength(1));
      expect(adapter.headers.single['x-ms-access-token'], 'graph');
      expect(adapter.headers.single['x-ms-id-token'], freshIdToken);
    });

    test('a rejected ID token falls back once to the legacy exchange',
        () async {
      final adapter = _FakeAdapter(
        (options) => options.headers.containsKey('x-ms-id-token') ? 401 : 200,
      );
      final result = await serviceWith(adapter)
          .exchangeMicrosoftToken('graph', microsoftIdToken: freshIdToken);
      expect(result.accessToken, 'app-jwt');
      expect(adapter.headers, hasLength(2));
      expect(adapter.headers.last.containsKey('x-ms-id-token'), isFalse);
    });

    test('without a usable ID token only the legacy exchange is made',
        () async {
      final adapter = _FakeAdapter((_) => 200);
      await serviceWith(adapter).exchangeMicrosoftToken('graph');
      expect(adapter.headers, hasLength(1));
      expect(adapter.headers.single.containsKey('x-ms-id-token'), isFalse);
    });

    test('a non-401 failure is not retried', () async {
      final adapter = _FakeAdapter((_) => 503);
      await expectLater(
        serviceWith(adapter)
            .exchangeMicrosoftToken('graph', microsoftIdToken: freshIdToken),
        throwsA(isA<DioException>()),
      );
      expect(adapter.headers, hasLength(1));
    });
  });
}
