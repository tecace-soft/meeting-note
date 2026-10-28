import 'dart:io';

import 'package:dio/dio.dart';
import 'package:dio/io.dart';

import 'retry_interceptor.dart';

/// Idle pooled sockets older than this are dropped instead of reused, so a
/// socket the OS killed in the background is not picked for the next request.
const staleSocketIdleTimeout = Duration(seconds: 5);

/// The single place every app Dio is built, so network robustness is never
/// configured differently by accident. Timeouts, base URL and headers come
/// from [options] untouched.
///
/// Interceptor order: the network retry is added first; callers then add
/// their auth-replay interceptor after it (see [NetworkRetryInterceptor]).
Dio createAppDio(
  BaseOptions options, {
  HttpClientAdapter? adapter,
  NetworkRetryInterceptor Function(Dio dio)? retryBuilder,
}) {
  final dio = Dio(options);
  dio.httpClientAdapter =
      adapter ??
      IOHttpClientAdapter(
        createHttpClient: () =>
            HttpClient()..idleTimeout = staleSocketIdleTimeout,
      );
  dio.interceptors.add(
    retryBuilder != null ? retryBuilder(dio) : NetworkRetryInterceptor(dio),
  );
  return dio;
}
