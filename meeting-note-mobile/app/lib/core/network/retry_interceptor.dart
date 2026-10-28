import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';

/// Retries idempotent reads that died on a stale or dropped socket.
///
/// Android/iOS kill pooled keep-alive sockets after background, sleep or a
/// Wi-Fi/4G switch, which surfaces as `SocketException: Software caused
/// connection abort`. A fresh connection almost always succeeds.
///
/// Rules (all must hold to retry):
///  * method is GET or HEAD (never POST/PATCH/PUT/DELETE, so uploads and
///    writes are never replayed),
///  * the failure is connection-level: `connectionError`, `connectionTimeout`,
///    or `unknown` wrapping a [SocketException] / [HttpException].
/// Never retried: `badResponse` (any HTTP status), `cancel`, `receiveTimeout`.
///
/// Ordering with the 401 replay: add this interceptor BEFORE
/// `retryOnUnauthorizedInterceptor`. Errors reach interceptors in insertion
/// order, so a connection error is retried here first. The replay goes through
/// the same Dio and therefore through the 401 interceptor too, which refreshes
/// auth and carries the new header on its own replay. A 401 is a `badResponse`
/// and is never retried here, so the two never multiply: the attempt count
/// lives in `requestOptions.extra`, which both the nested fetch and any 401
/// replay share, bounding total network retries to [maxRetries] per request.
class NetworkRetryInterceptor extends Interceptor {
  NetworkRetryInterceptor(
    this._dio, {
    this.maxRetries = 2,
    this.backoffs = const [Duration(milliseconds: 400), Duration(seconds: 1)],
    Future<void> Function(Duration)? delay,
  }) : _delay = delay ?? Future<void>.delayed;

  static const attemptKey = 'networkRetryAttempt';

  final Dio _dio;
  final int maxRetries;
  final List<Duration> backoffs;
  final Future<void> Function(Duration) _delay;

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final options = err.requestOptions;
    final attempt = (options.extra[attemptKey] as int?) ?? 0;
    if (attempt >= maxRetries || !isRetryable(err)) {
      handler.next(err);
      return;
    }
    options.extra[attemptKey] = attempt + 1;
    final index = attempt < backoffs.length ? attempt : backoffs.length - 1;
    final cancelled = await _waitOrCancel(backoffs[index], options.cancelToken);
    if (cancelled) {
      handler.reject(
        DioException.requestCancelled(
          requestOptions: options,
          reason: options.cancelToken?.cancelError?.error,
        ),
      );
      return;
    }
    try {
      handler.resolve(await _dio.fetch<dynamic>(options));
    } on DioException catch (e) {
      // The nested fetch already exhausted its own retries and ran the other
      // error interceptors, so surface its result as final.
      handler.reject(e);
    } catch (e) {
      // Nothing may escape the interceptor chain as a non-Dio exception.
      handler.next(
        DioException(
          requestOptions: options,
          error: e,
          type: DioExceptionType.unknown,
        ),
      );
    }
  }

  /// Waits [duration]; returns true early if [token] is cancelled meanwhile.
  Future<bool> _waitOrCancel(Duration duration, CancelToken? token) async {
    if (token == null) {
      await _delay(duration);
      return false;
    }
    if (token.isCancelled) return true;
    final cancelled = token.whenCancel.then((_) => true);
    final waited = _delay(duration).then((_) => false);
    return Future.any<bool>([cancelled, waited]);
  }

  /// True for connection-level failures on idempotent methods.
  static bool isRetryable(DioException err) {
    final method = err.requestOptions.method.toUpperCase();
    if (method != 'GET' && method != 'HEAD') return false;
    return isConnectionLevel(err);
  }

  /// True when the failure is the connection itself, not a server answer.
  static bool isConnectionLevel(Object? err) {
    if (err is! DioException) return err is SocketException;
    switch (err.type) {
      case DioExceptionType.connectionError:
      case DioExceptionType.connectionTimeout:
        return true;
      case DioExceptionType.unknown:
        return err.error is SocketException || err.error is HttpException;
      case DioExceptionType.badResponse:
      case DioExceptionType.cancel:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.badCertificate:
      case DioExceptionType.transformTimeout:
        return false;
    }
  }
}
