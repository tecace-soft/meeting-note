import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../../core/network/supabase_config.dart';
import '../../auth/data/auth_token_store.dart';

final settingsRepositoryProvider = Provider<SettingsRepository>(
  (ref) => SettingsRepository(),
);

final settingsCountsProvider = FutureProvider<SettingsCounts>(
  (ref) => ref.watch(settingsRepositoryProvider).counts(),
);

class SettingsRepository {
  SettingsRepository()
      : _supabase = Dio(
          BaseOptions(
            baseUrl: '${supabaseUrl.replaceAll(RegExp(r'/$'), '')}/rest/v1',
            connectTimeout: const Duration(seconds: 15),
            receiveTimeout: const Duration(seconds: 30),
          ),
        ),
        _supabaseRoot = Dio(
          BaseOptions(
            baseUrl: supabaseUrl.replaceAll(RegExp(r'/$'), ''),
            connectTimeout: const Duration(seconds: 15),
            receiveTimeout: const Duration(seconds: 30),
          ),
        );

  final Dio _supabase;
  final Dio _supabaseRoot;
  static const _storage = FlutterSecureStorage();
  static const _defaultPromptName = 'Default';
  static const _defaultPrompt = '''
You are an Insightful Meeting Notes Writer and Transcript extractor.
From a meeting voice file and available metadata, produce actionable, structured meeting notes.

The summary output must be markdown.
Use this structure when relevant:

## Meeting Summary
- Date, participants, and purpose when available.
- Concise overview of the meeting.

## Topic-Based Discussion
- Organize content by topic, not by speaker.
- Use speaker attributions only inside the relevant topic when helpful.
- Include key details, context, concerns, and important discussion points.

## Decisions
- List concrete decisions that were made.
- If no decisions were made, say so briefly.

## Schedule Summary
- Clearly summarize all schedule, deadline, and timeline discussions.
- Include dates, owners, changes, and next timing when available.
- Omit this section only if there was no schedule-related discussion.

## Action Items / Next Steps
- List action items with owners when available.
- If owners are unknown, use the speaker label from the transcript.

## Insights
- Include notable risks, open questions, dependencies, or strategic implications when relevant.

Rules:
- Base the notes only on the transcript and provided metadata.
- Do not hallucinate participants, organizations, decisions, dates, or action items.
- Preserve the meeting's original language unless the app explicitly requests another output language.
- Keep the result concise but specific enough to be useful.
''';

  Future<SettingsCounts> counts() async {
    final prompts = await summaryPrompts();
    final speakers = await speakerProfiles();
    final tokens = await mcpTokensOrEmpty();
    return SettingsCounts(
      summaryPrompts: prompts.length,
      speakerProfiles: speakers.length,
      activeMcpKeys: tokens.where((token) => token.isActive).length,
    );
  }

  Future<List<SettingsSummaryPrompt>> summaryPrompts() async {
    final auth = await _supabaseAuth();
    var rows = _promptRows(await _fetchSummaryPromptRows(auth));
    if (rows.isEmpty) {
      try {
        await _createDefaultSummaryPrompt(auth);
      } on DioException catch (error) {
        final message = error.response?.data?.toString().toLowerCase() ?? '';
        if (!message.contains('duplicate') &&
            !message.contains('unique') &&
            !message.contains('summary_prompt_one_default_per_user_idx')) {
          rethrow;
        }
      }
      rows = _promptRows(await _fetchSummaryPromptRows(auth));
    }
    return _dedupeDefaultPrompts(auth, rows);
  }

  Future<List<dynamic>?> _fetchSummaryPromptRows(_SupabaseAuth auth) async {
    final response = await _supabase.get<List<dynamic>>(
      '/summary_prompt',
      queryParameters: {
        'select': 'id,name,prompt,created_at',
        'user_id': 'eq.${auth.userId}',
        'order': 'name.asc,created_at.asc',
      },
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
    return response.data;
  }

  Future<void> _createDefaultSummaryPrompt(_SupabaseAuth auth) {
    return _supabase.post<void>(
      '/summary_prompt',
      data: {
        'user_id': auth.userId,
        'name': _defaultPromptName,
        'prompt': _defaultPrompt,
      },
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
  }

  Future<List<SettingsSummaryPrompt>> _dedupeDefaultPrompts(
    _SupabaseAuth auth,
    List<SettingsSummaryPrompt> rows,
  ) async {
    final defaults = rows.where((row) => row.isDefault).toList();
    if (defaults.length <= 1) return rows;

    defaults.sort((a, b) {
      final createdCompare = (a.createdAt ?? DateTime.fromMillisecondsSinceEpoch(0))
          .compareTo(b.createdAt ?? DateTime.fromMillisecondsSinceEpoch(0));
      if (createdCompare != 0) return createdCompare;
      return a.id.compareTo(b.id);
    });
    final keepId = defaults.first.id;
    final deleteIds = defaults
        .where((prompt) => prompt.id != keepId)
        .map((prompt) => prompt.id)
        .toList();
    if (deleteIds.isNotEmpty) {
      await _supabase.delete<void>(
        '/summary_prompt',
        queryParameters: {
          'id': 'in.(${deleteIds.join(',')})',
          'user_id': 'eq.${auth.userId}',
        },
        options: Options(headers: _supabaseHeaders(auth.token)),
      );
    }
    return rows.where((row) => !deleteIds.contains(row.id)).toList();
  }

  Future<SettingsSummaryPrompt> createSummaryPrompt({
    required String name,
    required String prompt,
  }) async {
    final auth = await _supabaseAuth();
    final cleanName = name.trim();
    if (_isDefaultPromptName(cleanName)) {
      final existingDefaults = _promptRows(await _fetchSummaryPromptRows(auth))
          .where((row) => row.isDefault)
          .toList();
      if (existingDefaults.isNotEmpty) {
        throw StateError('A default prompt already exists.');
      }
    }
    final response = await _supabase.post<List<dynamic>>(
      '/summary_prompt',
      data: {
        'user_id': auth.userId,
        'name': cleanName,
        'prompt': prompt.trim(),
      },
      queryParameters: {'select': 'id,name,prompt,created_at'},
      options: Options(headers: {
        ..._supabaseHeaders(auth.token),
        'Prefer': 'return=representation',
      }),
    );
    final rows = _promptRows(response.data);
    if (rows.isEmpty) throw StateError('Prompt was not created.');
    return rows.first;
  }

  Future<void> updateSummaryPrompt(SettingsSummaryPrompt prompt) async {
    final auth = await _supabaseAuth();
    if (prompt.isDefault) {
      final existingDefaults = _promptRows(await _fetchSummaryPromptRows(auth))
          .where((row) => row.isDefault && row.id != prompt.id)
          .toList();
      if (existingDefaults.isNotEmpty) {
        throw StateError('A default prompt already exists.');
      }
    }
    await _supabase.patch<void>(
      '/summary_prompt',
      data: {
        'name': prompt.name.trim(),
        'prompt': prompt.prompt.trim(),
      },
      queryParameters: {
        'id': 'eq.${prompt.id}',
        'user_id': 'eq.${auth.userId}',
      },
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
  }

  Future<void> deleteSummaryPrompt(SettingsSummaryPrompt prompt) async {
    final auth = await _supabaseAuth();
    if (prompt.isDefault) {
      final rows = _promptRows(await _fetchSummaryPromptRows(auth));
      final defaults = rows.where((row) => row.isDefault).toList();
      if (defaults.length <= 1) {
        throw StateError('At least one default prompt must remain.');
      }
    }
    await _supabase.delete<void>(
      '/summary_prompt',
      queryParameters: {
        'id': 'eq.${prompt.id}',
        'user_id': 'eq.${auth.userId}',
      },
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
  }

  Future<List<SettingsSpeakerProfile>> speakerProfiles() async {
    final auth = await _supabaseAuth();
    final response = await _supabase.get<List<dynamic>>(
      '/speaker',
      queryParameters: {
        'select': 'id,name,profile,email,microsoft_id',
        'user_id': 'eq.${auth.userId}',
        'order': 'name.asc',
      },
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
    return (response.data ?? const [])
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .map(SettingsSpeakerProfile.fromJson)
        .whereType<SettingsSpeakerProfile>()
        .toList();
  }

  Future<void> updateSpeakerProfile({
    required String id,
    required String profile,
  }) async {
    final auth = await _supabaseAuth();
    await _supabase.patch<void>(
      '/speaker',
      data: {'profile': _cleanProfile(profile)},
      queryParameters: {
        'id': 'eq.$id',
        'user_id': 'eq.${auth.userId}',
      },
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
  }

  SettingsSpeakerProfile? findSelfSpeaker(
    List<SettingsSpeakerProfile> speakers,
    String displayName,
  ) {
    final normalizedDisplay = _normalizeSpeakerName(displayName);
    if (normalizedDisplay.isEmpty) return null;
    for (final speaker in speakers) {
      if (_normalizeSpeakerName(speaker.name) == normalizedDisplay) {
        return speaker;
      }
    }
    final displayParts = normalizedDisplay.split(' ').toSet();
    for (final speaker in speakers) {
      final parts = _normalizeSpeakerName(speaker.name).split(' ').toSet();
      if (parts.isNotEmpty &&
          displayParts.isNotEmpty &&
          parts.intersection(displayParts).length >= 2) {
        return speaker;
      }
    }
    return null;
  }

  Future<List<McpTokenRow>> mcpTokensOrEmpty() async {
    try {
      return await mcpTokens();
    } catch (_) {
      return const [];
    }
  }

  Future<List<McpTokenRow>> mcpTokens() async {
    final data = await _callMcpTokenFunction({'action': 'list'});
    final rows = data['tokens'];
    if (rows is! List) return const [];
    return rows
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .map(McpTokenRow.fromJson)
        .whereType<McpTokenRow>()
        .toList();
  }

  Future<McpCreateResult> createMcpToken() async {
    final data = await _callMcpTokenFunction({
      'action': 'create',
      'name': 'Claude Desktop',
    });
    final token = _stringValue(data['token']);
    final row = data['tokenRecord'] is Map
        ? McpTokenRow.fromJson((data['tokenRecord'] as Map).cast<String, dynamic>())
        : null;
    if (token == null || row == null) {
      throw StateError('MCP key was not returned.');
    }
    return McpCreateResult(token: token, row: row);
  }

  Future<void> revokeMcpToken(String tokenId) async {
    await _callMcpTokenFunction({
      'action': 'revoke',
      'tokenId': tokenId,
    });
  }

  Future<Map<String, dynamic>> _callMcpTokenFunction(
    Map<String, dynamic> body,
  ) async {
    final microsoftToken = await _storage.read(key: AuthTokenStore.accessTokenKey);
    if (microsoftToken == null || microsoftToken.isEmpty) {
      throw StateError('Microsoft access token is unavailable. Sign in again.');
    }
    final response = await _supabaseRoot.post<Map<String, dynamic>>(
      '/functions/v1/mcp-token',
      data: body,
      options: Options(headers: {
        'apikey': supabaseAnonKey,
        'authorization': 'Bearer $supabaseAnonKey',
        'content-type': 'application/json',
        'x-ms-access-token': microsoftToken,
      }),
    );
    final data = response.data ?? const <String, dynamic>{};
    final error = data['error'];
    if (error is String && error.isNotEmpty) throw StateError(error);
    return data;
  }

  Future<_SupabaseAuth> _supabaseAuth() async {
    final token = await _storage.read(key: AuthTokenStore.supabaseAccessTokenKey);
    final userId = await _storage.read(key: AuthTokenStore.supabaseUserIdKey);
    if (!isSupabaseConfigured ||
        token == null ||
        token.isEmpty ||
        userId == null ||
        userId.isEmpty) {
      throw StateError('Supabase mobile token is not available yet.');
    }
    return _SupabaseAuth(token: token, userId: userId);
  }

  List<SettingsSummaryPrompt> _promptRows(List<dynamic>? data) =>
      (data ?? const [])
          .whereType<Map>()
          .map((row) => row.cast<String, dynamic>())
          .map(SettingsSummaryPrompt.fromJson)
          .whereType<SettingsSummaryPrompt>()
          .toList();
}

class SettingsCounts {
  const SettingsCounts({
    required this.summaryPrompts,
    required this.speakerProfiles,
    required this.activeMcpKeys,
  });

  final int summaryPrompts;
  final int speakerProfiles;
  final int activeMcpKeys;
}

class SettingsSummaryPrompt {
  const SettingsSummaryPrompt({
    required this.id,
    required this.name,
    required this.prompt,
    this.createdAt,
  });

  final String id;
  final String name;
  final String prompt;
  final DateTime? createdAt;

  bool get isDefault => _isDefaultPromptName(name);

  SettingsSummaryPrompt copyWith({String? name, String? prompt}) =>
      SettingsSummaryPrompt(
        id: id,
        name: name ?? this.name,
        prompt: prompt ?? this.prompt,
        createdAt: createdAt,
      );

  static SettingsSummaryPrompt? fromJson(Map<String, dynamic> json) {
    final id = _stringValue(json['id']);
    final name = _stringValue(json['name']);
    final prompt = _stringValue(json['prompt']);
    if (id == null || name == null || prompt == null) return null;
    return SettingsSummaryPrompt(
      id: id,
      name: name,
      prompt: prompt,
      createdAt: _dateValue(json['created_at']),
    );
  }
}

class SettingsSpeakerProfile {
  const SettingsSpeakerProfile({
    required this.id,
    required this.name,
    this.profile,
    this.email,
    this.microsoftId,
  });

  final String id;
  final String name;
  final String? profile;
  final String? email;
  final String? microsoftId;

  SettingsSpeakerProfile copyWith({String? profile}) => SettingsSpeakerProfile(
        id: id,
        name: name,
        profile: profile ?? this.profile,
        email: email,
        microsoftId: microsoftId,
      );

  static SettingsSpeakerProfile? fromJson(Map<String, dynamic> json) {
    final id = _stringValue(json['id']);
    final name = _stringValue(json['name']);
    if (id == null || name == null) return null;
    return SettingsSpeakerProfile(
      id: id,
      name: name,
      profile: _stringValue(json['profile']),
      email: _stringValue(json['email']),
      microsoftId: _stringValue(json['microsoft_id']),
    );
  }
}

class McpTokenRow {
  const McpTokenRow({
    required this.id,
    required this.name,
    required this.tokenPrefix,
    required this.createdAt,
    this.lastUsedAt,
    this.revokedAt,
    this.expiresAt,
    this.scopes = const [],
  });

  final String id;
  final String name;
  final String tokenPrefix;
  final DateTime createdAt;
  final DateTime? lastUsedAt;
  final DateTime? revokedAt;
  final DateTime? expiresAt;
  final List<String> scopes;

  bool get isActive =>
      revokedAt == null && (expiresAt == null || expiresAt!.isAfter(DateTime.now()));

  static McpTokenRow? fromJson(Map<String, dynamic> json) {
    final id = _stringValue(json['id']);
    final name = _stringValue(json['name']) ?? 'Claude Desktop';
    final prefix = _stringValue(json['tokenPrefix']) ??
        _stringValue(json['token_prefix']) ??
        'mcp_...';
    final created = _dateValue(json['createdAt'] ?? json['created_at']);
    if (id == null || created == null) return null;
    final scopesRaw = json['scopes'];
    return McpTokenRow(
      id: id,
      name: name,
      tokenPrefix: prefix,
      createdAt: created,
      lastUsedAt: _dateValue(json['lastUsedAt'] ?? json['last_used_at']),
      revokedAt: _dateValue(json['revokedAt'] ?? json['revoked_at']),
      expiresAt: _dateValue(json['expiresAt'] ?? json['expires_at']),
      scopes: scopesRaw is List
          ? scopesRaw.map((value) => value.toString()).toList()
          : const [],
    );
  }
}

class McpCreateResult {
  const McpCreateResult({required this.token, required this.row});

  final String token;
  final McpTokenRow row;
}

class _SupabaseAuth {
  const _SupabaseAuth({required this.token, required this.userId});

  final String token;
  final String userId;
}

Map<String, String> _supabaseHeaders(String token) => {
      'apikey': supabaseAnonKey,
      'authorization': 'Bearer $token',
      'content-type': 'application/json',
    };

String? _stringValue(Object? value) {
  final text = value?.toString().trim();
  return text == null || text.isEmpty ? null : text;
}

bool _isDefaultPromptName(String value) =>
    value.trim().toLowerCase() ==
    SettingsRepository._defaultPromptName.toLowerCase();

DateTime? _dateValue(Object? value) {
  final text = _stringValue(value);
  return text == null ? null : DateTime.tryParse(text);
}

String _cleanProfile(String value) {
  final trimmed = value.trim();
  if (trimmed.isEmpty) return '';
  try {
    return const JsonEncoder.withIndent('  ').convert(jsonDecode(trimmed));
  } catch (_) {
    return trimmed;
  }
}

String _normalizeSpeakerName(String value) {
  var next = value.replaceAll(RegExp(r'\([^)]*\)'), ' ');
  next = next.replaceAll(RegExp(r'[^a-zA-Z0-9]+'), ' ');
  return next.trim().replaceAll(RegExp(r'\s+'), ' ').toLowerCase();
}
