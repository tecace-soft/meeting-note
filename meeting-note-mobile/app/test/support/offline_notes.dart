import 'dart:convert';
import 'dart:typed_data';
import 'package:dio/dio.dart';

class Adapter implements HttpClientAdapter {
  Adapter(this.respond);
  final ResponseBody Function(RequestOptions) respond;
  final calls = <RequestOptions>[];
  @override
  Future<ResponseBody> fetch(
    RequestOptions request,
    Stream<Uint8List>? body,
    Future<void>? cancel,
  ) async {
    calls.add(request);
    return respond(request);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody jsonResponse(
  Object? data, {
  int status = 200,
  Map<String, List<String>> extraHeaders = const {},
}) => ResponseBody.fromString(
  jsonEncode(data),
  status,
  headers: {
    Headers.contentTypeHeader: [Headers.jsonContentType],
    ...extraHeaders,
  },
);
Dio fakeDio(Adapter adapter) =>
    Dio(BaseOptions(baseUrl: 'https://example.test'))
      ..httpClientAdapter = adapter;
