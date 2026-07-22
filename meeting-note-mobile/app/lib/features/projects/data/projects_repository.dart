import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../../core/network/supabase_config.dart';
import '../../auth/data/auth_token_store.dart';

final projectsRepositoryProvider = Provider<ProjectsRepository>(
  (ref) => ProjectsRepository(),
);

final projectsProvider = FutureProvider<List<MeetingProject>>(
  (ref) => ref.watch(projectsRepositoryProvider).list(),
);

class ProjectsRepository {
  ProjectsRepository()
      : _supabase = Dio(
          BaseOptions(
            baseUrl: '${supabaseUrl.replaceAll(RegExp(r'/$'), '')}/rest/v1',
            connectTimeout: const Duration(seconds: 15),
            receiveTimeout: const Duration(seconds: 30),
          ),
        ),
        _webhook = Dio(
          BaseOptions(
            connectTimeout: const Duration(seconds: 20),
            receiveTimeout: const Duration(minutes: 2),
          ),
        );

  final Dio _supabase;
  final Dio _webhook;
  static const _storage = FlutterSecureStorage();
  static const _projectChatWebhookUrl =
      'https://n8n.srv1153481.hstgr.cloud/webhook/9fe1b3b5-9e2e-4b23-8775-b38fc21e4b4d';

  Future<List<MeetingProject>> list() async {
    final token = await _storage.read(key: AuthTokenStore.supabaseAccessTokenKey);
    if (!isSupabaseConfigured || token == null || token.isEmpty) {
      throw StateError('Supabase mobile token is not available yet.');
    }
    final response = await _supabase.get<List<dynamic>>(
      '/project',
      queryParameters: {
        'select': 'id,name,user_id,shared_users',
        'order': 'name.asc',
      },
      options: Options(headers: _supabaseHeaders(token)),
    );

    return (response.data ?? const [])
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .map(MeetingProject.fromJson)
        .whereType<MeetingProject>()
        .toList();
  }

  Future<MeetingProject> create({
    required String name,
    required List<String> noteIds,
  }) async {
    final token = await _storage.read(key: AuthTokenStore.supabaseAccessTokenKey);
    final userId = await _currentSupabaseUserId(token);
    if (!isSupabaseConfigured ||
        token == null ||
        token.isEmpty ||
        userId == null) {
      throw StateError('Supabase mobile token is not available yet.');
    }

    final response = await _supabase.post<List<dynamic>>(
      '/project',
      data: {
        'name': name,
        'user_id': userId,
      },
      queryParameters: {'select': 'id,name,user_id,shared_users'},
      options: Options(headers: _supabaseInsertHeaders(token)),
    );
    Map? row;
    for (final item in response.data ?? const []) {
      if (item is Map) {
        row = item;
        break;
      }
    }
    if (row == null) throw StateError('Failed to create project.');
    final project = MeetingProject.fromJson(row.cast<String, dynamic>());
    if (project == null) throw StateError('Failed to parse created project.');

    for (final noteId in noteIds) {
      await _supabase.post<void>(
        '/rpc/add_accessible_note_to_project',
        data: {
          'p_note_id': noteId,
          'p_project_id': project.id,
        },
        options: Options(headers: _supabaseJsonHeaders(token)),
      );
    }
    return project;
  }

  Future<MeetingProject> get(String projectId) async {
    final token = await _storage.read(key: AuthTokenStore.supabaseAccessTokenKey);
    if (!isSupabaseConfigured || token == null || token.isEmpty) {
      throw StateError('Supabase mobile token is not available yet.');
    }

    final response = await _supabase.get<List<dynamic>>(
      '/project',
      queryParameters: {
        'select': 'id,name,user_id,shared_users',
        'id': 'eq.$projectId',
        'limit': 1,
      },
      options: Options(headers: _supabaseHeaders(token)),
    );
    final rows = response.data?.whereType<Map>().toList() ?? const [];
    if (rows.isEmpty) throw StateError('Project not found.');
    final project = MeetingProject.fromJson(rows.first.cast<String, dynamic>());
    if (project == null) throw StateError('Could not parse project.');
    return project;
  }

  Future<List<ProjectNoteSummary>> notesForProject(String projectId) async {
    final token = await _storage.read(key: AuthTokenStore.supabaseAccessTokenKey);
    if (!isSupabaseConfigured || token == null || token.isEmpty) {
      throw StateError('Supabase mobile token is not available yet.');
    }

    final response = await _supabase.get<List<dynamic>>(
      '/note',
      queryParameters: {
        'select': '*',
        'projects': 'cs.{${_escapeArrayValue(projectId)}}',
        'order': 'created_at.desc',
      },
      options: Options(headers: _supabaseHeaders(token)),
    );
    return (response.data ?? const [])
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .map(ProjectNoteSummary.fromJson)
        .whereType<ProjectNoteSummary>()
        .toList();
  }

  Future<List<ProjectChatSession>> sessionsForProject(String projectId) async {
    final token = await _storage.read(key: AuthTokenStore.supabaseAccessTokenKey);
    if (!isSupabaseConfigured || token == null || token.isEmpty) {
      throw StateError('Supabase mobile token is not available yet.');
    }

    final response = await _supabase.get<List<dynamic>>(
      '/session',
      queryParameters: {
        'select': 'id,created_at,project_id',
        'project_id': 'eq.$projectId',
        'order': 'created_at.desc',
      },
      options: Options(headers: _supabaseHeaders(token)),
    );
    return (response.data ?? const [])
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .map(ProjectChatSession.fromJson)
        .whereType<ProjectChatSession>()
        .toList();
  }

  Future<List<ProjectChatRow>> chatsForSessions(List<String> sessionIds) async {
    if (sessionIds.isEmpty) return const [];
    final token = await _storage.read(key: AuthTokenStore.supabaseAccessTokenKey);
    if (!isSupabaseConfigured || token == null || token.isEmpty) {
      throw StateError('Supabase mobile token is not available yet.');
    }

    final response = await _supabase.get<List<dynamic>>(
      '/chat',
      queryParameters: {
        'select': '*',
        'session_id': 'in.(${sessionIds.map(_escapeInValue).join(',')})',
        'order': 'created_at.asc',
      },
      options: Options(headers: _supabaseHeaders(token)),
    );
    return (response.data ?? const [])
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .map(ProjectChatRow.fromJson)
        .whereType<ProjectChatRow>()
        .toList();
  }

  Future<ProjectChatSendResult> sendChat({
    required String projectId,
    required String message,
    required String userId,
    String? sessionId,
  }) async {
    final token = await _storage.read(key: AuthTokenStore.supabaseAccessTokenKey);
    if (!isSupabaseConfigured || token == null || token.isEmpty) {
      throw StateError('Supabase mobile token is not available yet.');
    }

    final webhookResponse = await _webhook.post<dynamic>(
      _projectChatWebhookUrl,
      data: {
        'message': message,
        'project_id': projectId,
      },
      options: Options(headers: {'content-type': 'application/json'}),
    );
    final assistant = _extractWebhookResponse(webhookResponse.data);
    if (assistant == null || assistant.isEmpty) {
      throw StateError('Webhook response missing "response" field.');
    }

    final nextSessionId = sessionId ?? _generateSessionId();
    final isNewSession = sessionId == null;
    if (isNewSession) {
      await _supabase.post<void>(
        '/session',
        data: {
          'id': nextSessionId,
          'project_id': projectId,
        },
        options: Options(headers: _supabaseJsonHeaders(token)),
      );
    }

    final basePayload = {
      'message': message,
      'user_id': userId,
      'session_id': nextSessionId,
      'project_id': projectId,
    };
    try {
      await _supabase.post<void>(
        '/chat',
        data: [
          {
            ...basePayload,
            'response': assistant,
          }
        ],
        options: Options(headers: _supabaseJsonHeaders(token)),
      );
    } on DioException catch (error) {
      final details = error.response?.data?.toString() ?? error.message ?? '';
      if (!details.toLowerCase().contains('response')) rethrow;
      await _supabase.post<void>(
        '/chat',
        data: [
          {
            ...basePayload,
            'repsonse': assistant,
          }
        ],
        options: Options(headers: _supabaseJsonHeaders(token)),
      );
    }

    return ProjectChatSendResult(
      sessionId: nextSessionId,
      assistantResponse: assistant,
      createdAt: DateTime.now(),
      isNewSession: isNewSession,
    );
  }
}

class MeetingProject {
  const MeetingProject({
    required this.id,
    required this.name,
    this.ownerId,
    this.sharedUserIds = const [],
  });

  final String id;
  final String name;
  final String? ownerId;
  final List<String> sharedUserIds;

  static MeetingProject? fromJson(Map<String, dynamic> json) {
    final id = _stringValue(json['id']);
    final name = _stringValue(json['name']);
    if (id == null || name == null) return null;
    return MeetingProject(
      id: id,
      name: name,
      ownerId: _stringValue(json['user_id']),
      sharedUserIds: _stringList(json['shared_users']),
    );
  }
}

class ProjectNoteSummary {
  const ProjectNoteSummary({
    required this.id,
    required this.title,
    required this.createdAt,
    required this.durationSec,
    this.summary,
    this.transcription,
    this.tags = const [],
  });

  final String id;
  final String title;
  final DateTime createdAt;
  final int durationSec;
  final String? summary;
  final String? transcription;
  final List<String> tags;

  static ProjectNoteSummary? fromJson(Map<String, dynamic> json) {
    final id = _stringValue(json['id']);
    if (id == null) return null;
    final summaryTranslations = _stringMap(json['summary_translations']);
    return ProjectNoteSummary(
      id: id,
      title: _stringValue(json['name']) ?? 'Untitled note',
      createdAt: _dateValue(json['meeting_at'] ?? json['created_at']) ??
          DateTime.fromMillisecondsSinceEpoch(0),
      durationSec: _intValue(json['duration_seconds']) ?? 0,
      summary: _stringValue(json['summary_edit']) ??
          summaryTranslations['en'] ??
          summaryTranslations['ko'] ??
          _stringValue(json['summary']),
      transcription: _stringValue(json['transcription']),
      tags: _stringList(json['tags'] ?? json['tag']),
    );
  }

  String get durationLabel {
    final minutes = durationSec ~/ 60;
    if (minutes <= 0) return '';
    return '$minutes min';
  }
}

class ProjectChatSession {
  const ProjectChatSession({
    required this.id,
    required this.createdAt,
    this.projectId,
  });

  final String id;
  final DateTime createdAt;
  final String? projectId;

  static ProjectChatSession? fromJson(Map<String, dynamic> json) {
    final id = _stringValue(json['id']);
    if (id == null) return null;
    return ProjectChatSession(
      id: id,
      createdAt: _dateValue(json['created_at']) ?? DateTime.now(),
      projectId: _stringValue(json['project_id']),
    );
  }
}

class ProjectChatRow {
  const ProjectChatRow({
    required this.id,
    required this.sessionId,
    required this.createdAt,
    this.message,
    this.response,
  });

  final String id;
  final String sessionId;
  final DateTime createdAt;
  final String? message;
  final String? response;

  static ProjectChatRow? fromJson(Map<String, dynamic> json) {
    final id = _stringValue(json['id']);
    final sessionId = _stringValue(json['session_id']);
    if (id == null || sessionId == null) return null;
    return ProjectChatRow(
      id: id,
      sessionId: sessionId,
      createdAt: _dateValue(json['created_at']) ?? DateTime.now(),
      message: _stringValue(json['message']),
      response: _stringValue(json['response']) ?? _stringValue(json['repsonse']),
    );
  }
}

class ProjectChatSendResult {
  const ProjectChatSendResult({
    required this.sessionId,
    required this.assistantResponse,
    required this.createdAt,
    required this.isNewSession,
  });

  final String sessionId;
  final String assistantResponse;
  final DateTime createdAt;
  final bool isNewSession;
}

Map<String, String> _supabaseHeaders(String token) => {
      'apikey': supabaseAnonKey,
      'authorization': 'Bearer $token',
      'content-type': 'application/json',
      'prefer': 'return=minimal',
    };

Map<String, String> _supabaseJsonHeaders(String token) => {
      'apikey': supabaseAnonKey,
      'authorization': 'Bearer $token',
      'content-type': 'application/json',
    };

Map<String, String> _supabaseInsertHeaders(String token) => {
      'apikey': supabaseAnonKey,
      'authorization': 'Bearer $token',
      'content-type': 'application/json',
      'prefer': 'return=representation',
    };

Future<String?> _currentSupabaseUserId(String? token) async {
  final jwtUserId = _jwtSubject(token);
  if (jwtUserId != null && jwtUserId.isNotEmpty) return jwtUserId;
  final storedUserId =
      await ProjectsRepository._storage.read(key: AuthTokenStore.supabaseUserIdKey);
  if (storedUserId != null && storedUserId.isNotEmpty) return storedUserId;
  final microsoftUserId =
      await ProjectsRepository._storage.read(key: AuthTokenStore.microsoftUserIdKey);
  if (microsoftUserId != null && microsoftUserId.isNotEmpty) {
    return microsoftUserId;
  }
  return null;
}

String? _jwtSubject(String? token) {
  if (token == null || token.isEmpty) return null;
  final parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    final payload = utf8.decode(base64Url.decode(base64Url.normalize(parts[1])));
    final json = jsonDecode(payload);
    if (json is Map) {
      final sub = json['sub'];
      if (sub is String && sub.trim().isNotEmpty) return sub.trim();
    }
  } catch (_) {
    return null;
  }
  return null;
}

String? _stringValue(Object? value) {
  final text = value?.toString().trim();
  if (text != null && text.isNotEmpty) return text;
  return null;
}

List<String> _stringList(Object? value) {
  if (value is List) {
    return value
        .map((item) => item?.toString().trim() ?? '')
        .where((item) => item.isNotEmpty)
        .toList();
  }
  return const [];
}

Map<String, String> _stringMap(Object? value) {
  if (value is! Map) return const {};
  final result = <String, String>{};
  for (final entry in value.entries) {
    final key = entry.key?.toString().trim();
    final text = _stringValue(entry.value);
    if (key != null && key.isNotEmpty && text != null) {
      result[key] = text;
    }
  }
  return result;
}

int? _intValue(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value);
  return null;
}

DateTime? _dateValue(Object? value) {
  final text = _stringValue(value);
  return text == null ? null : DateTime.tryParse(text);
}

String _escapeArrayValue(String value) => value.replaceAll('"', r'\"');

String _escapeInValue(String value) => '"${value.replaceAll('"', r'\"')}"';

String? _extractWebhookResponse(Object? data) {
  if (data is Map) return _stringValue(data['response']);
  if (data is String && data.trim().isNotEmpty) {
    try {
      final decoded = jsonDecode(data);
      if (decoded is Map) return _stringValue(decoded['response']);
    } catch (_) {
      return null;
    }
  }
  return null;
}

String _generateSessionId() {
  final now = DateTime.now();
  final yy = (now.year % 100).toString().padLeft(2, '0');
  final mm = now.month.toString().padLeft(2, '0');
  final dd = now.day.toString().padLeft(2, '0');
  final hh = now.hour.toString().padLeft(2, '0');
  final min = now.minute.toString().padLeft(2, '0');
  final ss = now.second.toString().padLeft(2, '0');
  final random = DateTime.now().microsecondsSinceEpoch
      .remainder(100000000)
      .toString()
      .padLeft(8, '0');
  return '$yy$mm$dd$hh$min$ss' '_$random';
}
