import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/cache/json_cache_store.dart';
import '../../../core/network/supabase_config.dart';
import '../../../core/network/workflow_config.dart';
import '../../auth/data/auth_token_store.dart';
import '../../auth/data/mobile_supabase_session.dart';

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
        ) {
    _supabase.interceptors
        .add(MobileSupabaseSession().retryOnUnauthorizedInterceptor());
  }

  final Dio _supabase;
  final Dio _webhook;
  static const _storage = FlutterSecureStorage();
  static const _cache = JsonCacheStore('projects');

  Future<List<MeetingProject>?> cachedList() async {
    final userId = await MobileSupabaseSession.cachedUserId();
    if (userId == null) return null;
    final rows = await _cache.readList(_projectsCacheKey(userId));
    if (rows == null) return null;
    return _projectsFromRows(rows);
  }

  Future<List<MeetingProject>> refreshList() => list();

  Future<List<MeetingProject>> list() async {
    final auth = await MobileSupabaseSession().auth();
    final response = await _supabase.get<List<dynamic>>(
      '/project',
      queryParameters: {
        'select': 'id,name,user_id,shared_users',
        'order': 'name.asc',
      },
      options: Options(headers: _supabaseHeaders(auth.token)),
    );

    final rows = response.data ?? const [];
    await _cache.writeList(_projectsCacheKey(auth.userId), rows);
    return _projectsFromRows(rows);
  }

  List<MeetingProject> _projectsFromRows(List<dynamic> rows) {
    return rows
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
    final auth = await MobileSupabaseSession().auth();

    final response = await _supabase.post<List<dynamic>>(
      '/project',
      data: {
        'name': name,
        'user_id': auth.userId,
      },
      queryParameters: {'select': 'id,name,user_id,shared_users'},
      options: Options(headers: _supabaseInsertHeaders(auth.token)),
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
        options: Options(headers: _supabaseJsonHeaders(auth.token)),
      );
    }
    await _cache.delete(_projectsCacheKey(auth.userId));
    return project;
  }

  Future<MeetingProject> get(String projectId) async {
    final auth = await MobileSupabaseSession().auth();

    final response = await _supabase.get<List<dynamic>>(
      '/project',
      queryParameters: {
        'select': 'id,name,user_id,shared_users',
        'id': 'eq.$projectId',
        'limit': 1,
      },
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
    final rows = response.data?.whereType<Map>().toList() ?? const [];
    if (rows.isEmpty) throw StateError('Project not found.');
    final project = MeetingProject.fromJson(rows.first.cast<String, dynamic>());
    if (project == null) throw StateError('Could not parse project.');
    return project;
  }

  Future<MeetingProject?> cachedGet(String projectId) async {
    final projects = await cachedList();
    if (projects == null) return null;
    for (final project in projects) {
      if (project.id == projectId) return project;
    }
    return null;
  }

  Future<List<ProjectNoteSummary>?> cachedNotesForProject(
    String projectId,
  ) async {
    final rows = await _cache.readList(_projectNotesCacheKey(projectId));
    return rows == null ? null : _projectNotesFromRows(rows);
  }

  Future<List<ProjectNoteSummary>> notesForProject(String projectId) async {
    final auth = await MobileSupabaseSession().auth();

    final response = await _supabase.get<List<dynamic>>(
      '/note',
      queryParameters: {
        'select': '*',
        'projects': 'cs.{${_escapeArrayValue(projectId)}}',
        'order': 'created_at.desc',
      },
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
    final rows = response.data ?? const [];
    await _cache.writeList(_projectNotesCacheKey(projectId), rows);
    return _projectNotesFromRows(rows);
  }

  List<ProjectNoteSummary> _projectNotesFromRows(List<dynamic> rows) {
    return rows
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .map(ProjectNoteSummary.fromJson)
        .whereType<ProjectNoteSummary>()
        .toList();
  }

  Future<List<ProjectChatSession>?> cachedSessionsForProject(
    String projectId,
  ) async {
    final rows = await _cache.readList(_projectSessionsCacheKey(projectId));
    return rows == null ? null : _projectSessionsFromRows(rows);
  }

  Future<List<ProjectChatSession>> sessionsForProject(String projectId) async {
    final auth = await MobileSupabaseSession().auth();

    final response = await _supabase.get<List<dynamic>>(
      '/session',
      queryParameters: {
        'select': 'id,created_at,project_id',
        'project_id': 'eq.$projectId',
        'order': 'created_at.desc',
      },
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
    final rows = response.data ?? const [];
    await _cache.writeList(_projectSessionsCacheKey(projectId), rows);
    return _projectSessionsFromRows(rows);
  }

  List<ProjectChatSession> _projectSessionsFromRows(List<dynamic> rows) {
    return rows
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .map(ProjectChatSession.fromJson)
        .whereType<ProjectChatSession>()
        .toList();
  }

  Future<List<ProjectChatRow>?> cachedChatsForSessions(
    List<String> sessionIds,
  ) async {
    if (sessionIds.isEmpty) return const [];
    final rows = await _cache.readList(_projectChatsCacheKey(sessionIds));
    return rows == null ? null : _projectChatsFromRows(rows);
  }

  Future<List<ProjectChatRow>> chatsForSessions(List<String> sessionIds) async {
    if (sessionIds.isEmpty) return const [];
    final auth = await MobileSupabaseSession().auth();

    final response = await _supabase.get<List<dynamic>>(
      '/chat',
      queryParameters: {
        'select': '*',
        'session_id': 'in.(${sessionIds.map(_escapeInValue).join(',')})',
        'order': 'created_at.asc',
      },
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
    final rows = response.data ?? const [];
    await _cache.writeList(_projectChatsCacheKey(sessionIds), rows);
    return _projectChatsFromRows(rows);
  }

  List<ProjectChatRow> _projectChatsFromRows(List<dynamic> rows) {
    return rows
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
    void Function(String)? onDelta,
  }) async {
    final auth = await MobileSupabaseSession().auth();
    final microsoftToken =
        await _storage.read(key: AuthTokenStore.accessTokenKey);
    if (microsoftToken == null || microsoftToken.isEmpty) {
      throw StateError('Sign in with Microsoft before using project chat.');
    }

    final assistant = await _streamProjectChat(
      projectId: projectId,
      message: message,
      microsoftToken: microsoftToken,
      onDelta: onDelta,
    );
    if (assistant.isEmpty) {
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
        options: Options(headers: _supabaseJsonHeaders(auth.token)),
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
        options: Options(headers: _supabaseJsonHeaders(auth.token)),
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
        options: Options(headers: _supabaseJsonHeaders(auth.token)),
      );
    }

    await _cache.delete(_projectSessionsCacheKey(projectId));
    await _cache.delete(_projectChatsCacheKey([nextSessionId]));
    return ProjectChatSendResult(
      sessionId: nextSessionId,
      assistantResponse: assistant,
      createdAt: DateTime.now(),
      isNewSession: isNewSession,
    );
  }

  Future<String> _streamProjectChat({
    required String projectId,
    required String message,
    required String microsoftToken,
    void Function(String)? onDelta,
  }) async {
    try {
      final response = await _webhook.post<ResponseBody>(
        '${workflowApiUrl.replaceAll(RegExp(r'/$'), '')}/project-chat/stream',
        data: {
          'message': message,
          'project_id': projectId,
        },
        options: Options(headers: {
          'content-type': 'application/json',
          'accept': 'text/event-stream',
          'authorization': 'Bearer $microsoftToken',
        }, responseType: ResponseType.stream),
      );
      final body = response.data;
      if (body == null) return '';
      var buffer = '';
      var assistant = '';
      await for (final chunk
          in body.stream.cast<List<int>>().transform(utf8.decoder)) {
        buffer += chunk;
        final events = buffer.split(RegExp(r'\r?\n\r?\n'));
        buffer = events.removeLast();
        for (final event in events) {
          for (final line in event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            final raw = line.substring('data:'.length).trim();
            if (raw.isEmpty) continue;
            final delta = _projectChatStreamDelta(raw);
            if (delta.isEmpty) continue;
            assistant += delta;
            onDelta?.call(assistant);
          }
        }
      }
      if (buffer.trim().isNotEmpty) {
        for (final line in buffer.split('\n')) {
          if (!line.startsWith('data:')) continue;
          final raw = line.substring('data:'.length).trim();
          if (raw.isEmpty) continue;
          final delta = _projectChatStreamDelta(raw);
          if (delta.isNotEmpty) {
            assistant += delta;
            onDelta?.call(assistant);
          }
        }
      }
      if (assistant.trim().isNotEmpty) return assistant.trim();
    } on DioException {
      // Fall through to the non-stream endpoint when the deployed backend has
      // not picked up /project-chat/stream yet.
    }
    return _fallbackProjectChat(
      projectId: projectId,
      message: message,
      microsoftToken: microsoftToken,
      onDelta: onDelta,
    );
  }

  Future<String> _fallbackProjectChat({
    required String projectId,
    required String message,
    required String microsoftToken,
    void Function(String)? onDelta,
  }) async {
    final response = await _webhook.post<Object?>(
      '${workflowApiUrl.replaceAll(RegExp(r'/$'), '')}/project-chat',
      data: {
        'message': message,
        'project_id': projectId,
      },
      options: Options(headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer $microsoftToken',
      }),
    );
    final assistant = _extractWebhookResponse(response.data) ?? '';
    if (assistant.isNotEmpty) onDelta?.call(assistant);
    return assistant;
  }
}

String _projectChatStreamDelta(String raw) {
  final decoded = jsonDecode(raw);
  if (decoded is! Map) return '';
  final error = decoded['error'];
  if (error is String && error.trim().isNotEmpty) {
    throw StateError(error.trim());
  }
  final delta = decoded['delta'];
  return delta is String ? delta : '';
}

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

String _projectsCacheKey(String userId) => 'projects_$userId';

String _projectNotesCacheKey(String projectId) => 'project_notes_$projectId';

String _projectSessionsCacheKey(String projectId) =>
    'project_sessions_$projectId';

String _projectChatsCacheKey(List<String> sessionIds) {
  final sorted = [...sessionIds]..sort();
  return 'project_chats_${sorted.join('_')}';
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
