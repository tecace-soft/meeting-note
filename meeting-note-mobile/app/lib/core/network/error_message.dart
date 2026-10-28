import 'package:flutter/foundation.dart';

import 'retry_interceptor.dart';

/// Maps an error to text safe to show a user. Connection-level failures get
/// the localized network message; everything else a generic localized one.
/// The raw exception text is appended only in debug builds.
///
/// [t] is the app translator (`AppText.call`).
String friendlyErrorMessage(
  Object? error,
  String Function(String key) t, {
  bool? showDetails,
}) {
  final base = NetworkRetryInterceptor.isConnectionLevel(error)
      ? t('error.network')
      : t('error.generic');
  if (showDetails ?? kDebugMode) return '$base\n\n$error';
  return base;
}
