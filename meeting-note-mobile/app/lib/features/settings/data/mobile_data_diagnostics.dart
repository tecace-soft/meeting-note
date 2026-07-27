import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../../core/network/supabase_config.dart';
import '../../auth/data/auth_token_store.dart';

class MobileDataDiagnostics {
  MobileDataDiagnostics()
      : _supabase = Dio(
          BaseOptions(
            baseUrl: '${supabaseUrl.replaceAll(RegExp(r'/$'), '')}/rest/v1',
            connectTimeout: const Duration(seconds: 15),
            receiveTimeout: const Duration(seconds: 30),
          ),
        );

  final Dio _supabase;
  static const _storage = FlutterSecureStorage();

  Future<MobileDataDiagnosticSnapshot> load() async {
    final microsoftUserId =
        await _storage.read(key: AuthTokenStore.microsoftUserIdKey);
    final storedSupabaseUserId =
        await _storage.read(key: AuthTokenStore.supabaseUserIdKey);
    final microsoftAccessToken =
        await _storage.read(key: AuthTokenStore.accessTokenKey);
    final idToken = await _storage.read(key: AuthTokenStore.idTokenKey);
    final supabaseToken =
        await _storage.read(key: AuthTokenStore.supabaseAccessTokenKey);

    final accessClaims = _jwtClaims(microsoftAccessToken);
    final idClaims = _jwtClaims(idToken);
    final supabaseClaims = _jwtClaims(supabaseToken);
    final candidateIds = <String>[
      if (microsoftUserId?.trim().isNotEmpty == true) microsoftUserId!.trim(),
      if (_stringClaim(accessClaims, 'oid') != null)
        _stringClaim(accessClaims, 'oid')!,
      if (_stringClaim(idClaims, 'oid') != null) _stringClaim(idClaims, 'oid')!,
      if (_stringClaim(idClaims, 'sub') != null) _stringClaim(idClaims, 'sub')!,
      if (storedSupabaseUserId?.trim().isNotEmpty == true)
        storedSupabaseUserId!.trim(),
      if (_stringClaim(supabaseClaims, 'sub') != null)
        _stringClaim(supabaseClaims, 'sub')!,
    ].toSet().toList();

    final token = supabaseToken;
    final rawProjects = token == null || token.isEmpty
        ? const <Map<String, dynamic>>[]
        : await _getRows(
            token: token,
            path: '/project',
            queryParameters: {
              'select': 'id,name,user_id,shared_users',
              'order': 'name.asc',
            },
          );
    final rawSpeakers = token == null || token.isEmpty
        ? const <Map<String, dynamic>>[]
        : await _getRows(
            token: token,
            path: '/speaker',
            queryParameters: {
              'select': 'id,name,user_id,email,microsoft_id',
              'order': 'name.asc',
            },
          );

    final projectMatches = <String, int>{};
    final speakerMatches = <String, int>{};
    if (token != null && token.isNotEmpty) {
      for (final id in candidateIds) {
        projectMatches[id] = (await _getRows(
          token: token,
          path: '/project',
          queryParameters: {
            'select': 'id',
            'or': '(user_id.eq.$id,shared_users.cs.{$id})',
          },
        ))
            .length;
        speakerMatches[id] = (await _getRows(
          token: token,
          path: '/speaker',
          queryParameters: {
            'select': 'id',
            'user_id': 'eq.$id',
          },
        ))
            .length;
      }
    }

    return MobileDataDiagnosticSnapshot(
      microsoftUserId: microsoftUserId,
      storedSupabaseUserId: storedSupabaseUserId,
      accessTokenOid: _stringClaim(accessClaims, 'oid'),
      accessTokenSub: _stringClaim(accessClaims, 'sub'),
      idTokenOid: _stringClaim(idClaims, 'oid'),
      idTokenSub: _stringClaim(idClaims, 'sub'),
      supabaseJwtSub: _stringClaim(supabaseClaims, 'sub'),
      visibleProjectCount: rawProjects.length,
      visibleSpeakerCount: rawSpeakers.length,
      firstVisibleProjectUserId:
          rawProjects.isEmpty ? null : _stringValue(rawProjects.first['user_id']),
      firstVisibleSpeakerUserId:
          rawSpeakers.isEmpty ? null : _stringValue(rawSpeakers.first['user_id']),
      projectMatchesById: projectMatches,
      speakerMatchesById: speakerMatches,
    );
  }

  Future<List<Map<String, dynamic>>> _getRows({
    required String token,
    required String path,
    required Map<String, dynamic> queryParameters,
  }) async {
    final response = await _supabase.get<List<dynamic>>(
      path,
      queryParameters: queryParameters,
      options: Options(headers: {
        'apikey': supabaseAnonKey,
        'authorization': 'Bearer $token',
        'content-type': 'application/json',
      }),
    );
    return (response.data ?? const [])
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .toList();
  }
}

class MobileDataDiagnosticSnapshot {
  const MobileDataDiagnosticSnapshot({
    required this.microsoftUserId,
    required this.storedSupabaseUserId,
    required this.accessTokenOid,
    required this.accessTokenSub,
    required this.idTokenOid,
    required this.idTokenSub,
    required this.supabaseJwtSub,
    required this.visibleProjectCount,
    required this.visibleSpeakerCount,
    required this.firstVisibleProjectUserId,
    required this.firstVisibleSpeakerUserId,
    required this.projectMatchesById,
    required this.speakerMatchesById,
  });

  final String? microsoftUserId;
  final String? storedSupabaseUserId;
  final String? accessTokenOid;
  final String? accessTokenSub;
  final String? idTokenOid;
  final String? idTokenSub;
  final String? supabaseJwtSub;
  final int visibleProjectCount;
  final int visibleSpeakerCount;
  final String? firstVisibleProjectUserId;
  final String? firstVisibleSpeakerUserId;
  final Map<String, int> projectMatchesById;
  final Map<String, int> speakerMatchesById;
}

Map<String, dynamic> _jwtClaims(String? token) {
  if (token == null || token.isEmpty) return const {};
  final parts = token.split('.');
  if (parts.length < 2) return const {};
  try {
    final payload = utf8.decode(base64Url.decode(base64Url.normalize(parts[1])));
    final json = jsonDecode(payload);
    return json is Map ? json.cast<String, dynamic>() : const {};
  } catch (_) {
    return const {};
  }
}

String? _stringClaim(Map<String, dynamic> claims, String key) =>
    _stringValue(claims[key]);

String? _stringValue(Object? value) {
  if (value is String && value.trim().isNotEmpty) return value.trim();
  return null;
}
