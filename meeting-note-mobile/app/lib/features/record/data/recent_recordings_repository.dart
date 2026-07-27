import 'dart:io';

import 'package:dio/dio.dart';

import '../../../core/cache/json_cache_store.dart';
import '../../../core/network/supabase_config.dart';
import '../../auth/data/mobile_supabase_session.dart';

class RecentRecording {
  const RecentRecording({
    required this.id,
    required this.name,
    required this.audioPath,
    required this.createdAt,
    this.bucket,
    this.storagePath,
    this.mimeType,
    this.sizeBytes,
    this.source,
    this.recordedAt,
    this.local = false,
  });

  final String id;
  final String name;
  final String audioPath;
  final DateTime createdAt;
  final String? bucket;
  final String? storagePath;
  final String? mimeType;
  final int? sizeBytes;
  final String? source;
  final DateTime? recordedAt;
  final bool local;

  DateTime get displayDate => recordedAt ?? createdAt;

  String get detailLabel {
    final parts = <String>[
      if (sizeBytes != null) _formatBytes(sizeBytes!),
      if (createdAt.millisecondsSinceEpoch > 0) 'Uploaded ${_formatDate(createdAt)}',
      if (recordedAt != null) 'Meeting date: ${_formatExactDate(recordedAt!)}',
    ];
    return parts.join(' - ');
  }

  static String _formatBytes(int bytes) {
    if (bytes < 1024) return '$bytes B';
    final kb = bytes / 1024;
    if (kb < 1024) return '${kb.toStringAsFixed(kb < 10 ? 1 : 0)} KB';
    final mb = kb / 1024;
    return '${mb.toStringAsFixed(mb < 10 ? 1 : 0)} MB';
  }

  static String _formatDate(DateTime value) =>
      '${value.month}/${value.day}/${value.year}';

  static String _formatExactDate(DateTime value) {
    final hour = value.hour % 12 == 0 ? 12 : value.hour % 12;
    final minute = value.minute.toString().padLeft(2, '0');
    final suffix = value.hour >= 12 ? 'PM' : 'AM';
    return '${value.month}/${value.day}/${value.year} $hour:$minute $suffix';
  }
}

class RecentRecordingsRepository {
  RecentRecordingsRepository()
      : _supabase = Dio(
          BaseOptions(
            baseUrl: supabaseUrl.replaceAll(RegExp(r'/$'), ''),
            connectTimeout: const Duration(seconds: 15),
            receiveTimeout: const Duration(seconds: 30),
          ),
        ) {
    _supabase.interceptors
        .add(MobileSupabaseSession().retryOnUnauthorizedInterceptor());
  }

  final Dio _supabase;
  static const _cache = JsonCacheStore('recent_recordings');

  Future<List<RecentRecording>?> cachedList() async {
    final userId = await MobileSupabaseSession.cachedUserId();
    if (userId == null) return null;
    final rows = await _cache.readList(_recentRecordingsCacheKey(userId));
    if (rows == null) return null;
    return _recordingsFromRows(rows);
  }

  Future<List<RecentRecording>> refreshList() => _listCloudRecordings();

  Future<List<RecentRecording>> list() async {
    try {
      return await _listCloudRecordings();
    } catch (_) {
      // Match the web app: recent recordings are Supabase file rows only.
      // If the cloud query is unavailable, show an empty list rather than
      // unrelated local recorder cache files.
      return const [];
    }
  }

  Future<void> delete(RecentRecording recording) async {
    if (recording.local) {
      final file = File(recording.audioPath);
      if (await file.exists()) await file.delete();
      return;
    }

    final auth = await MobileSupabaseSession().auth();

    if (recording.bucket != null && recording.storagePath != null) {
      try {
        await _supabase.delete<void>(
          '/storage/v1/object/${recording.bucket}/${_encodeStoragePath(recording.storagePath!)}',
          options: Options(headers: _headers(auth.token)),
        );
      } on DioException catch (error) {
        // If the object was already removed, still delete the stale file row.
        if (error.response?.statusCode != 404) rethrow;
      }
    }

    await _supabase.delete<void>(
      '/rest/v1/file',
      queryParameters: {
        'id': 'eq.${recording.id}',
        'user_id': 'eq.${auth.userId}',
      },
      options: Options(headers: _headers(auth.token)),
    );
    await _cache.delete(_recentRecordingsCacheKey(auth.userId));
  }

  Future<String> resolveAudioPath(RecentRecording recording) async {
    if (recording.local) return recording.audioPath;
    if (recording.bucket == null || recording.storagePath == null) {
      return recording.audioPath;
    }
    return Uri(
      scheme: 'storage',
      host: recording.bucket,
      path: '/${Uri.encodeComponent(recording.storagePath!)}',
      queryParameters: {
        'fileId': recording.id,
        'name': recording.name,
        if (recording.recordedAt != null)
          'recordedAt': recording.recordedAt!.toUtc().toIso8601String(),
      },
    ).toString();
  }

  Future<List<RecentRecording>> _listCloudRecordings() async {
    final auth = await MobileSupabaseSession().auth();
    if (!isSupabaseConfigured) {
      return const [];
    }

    Response<List<dynamic>> response;
    try {
      response = await _supabase.get<List<dynamic>>(
        '/rest/v1/file',
        queryParameters: {
          'select':
              'id,name,bucket,storage_path,public_url,mime_type,size_bytes,source,recorded_at,created_at',
          'user_id': 'eq.${auth.userId}',
          'order': 'recorded_at.desc.nullslast,created_at.desc',
          'limit': 10,
        },
        options: Options(headers: _headers(auth.token)),
      );
    } on DioException catch (error) {
      final message = error.response?.data?.toString() ?? error.message ?? '';
      if (!message.toLowerCase().contains('recorded_at')) rethrow;
      response = await _supabase.get<List<dynamic>>(
        '/rest/v1/file',
        queryParameters: {
          'select':
              'id,name,bucket,storage_path,public_url,mime_type,size_bytes,source,created_at',
          'user_id': 'eq.${auth.userId}',
          'order': 'created_at.desc',
          'limit': 10,
        },
        options: Options(headers: _headers(auth.token)),
      );
    }

    final rows = response.data ?? const [];
    await _cache.writeList(_recentRecordingsCacheKey(auth.userId), rows);
    return _recordingsFromRows(rows);
  }

  List<RecentRecording> _recordingsFromRows(List<dynamic> rows) {
    return rows
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .map(_fromCloudRow)
        .whereType<RecentRecording>()
        .toList();
  }

  RecentRecording? _fromCloudRow(Map<String, dynamic> row) {
    final id = row['id'];
    final name = row['name'];
    final bucket = row['bucket'];
    final storagePath = row['storage_path'];
    if (id is! String || name is! String) return null;
    if (bucket is! String || storagePath is! String) return null;

    return RecentRecording(
      id: id,
      name: name,
      bucket: bucket,
      storagePath: storagePath,
      audioPath: row['public_url'] is String ? row['public_url'] as String : '',
      mimeType: row['mime_type'] as String?,
      sizeBytes: _int(row['size_bytes']),
      source: row['source'] as String?,
      recordedAt: _date(row['recorded_at']),
      createdAt: _date(row['created_at']) ?? DateTime.fromMillisecondsSinceEpoch(0),
    );
  }

  Map<String, String> _headers(String token) => {
        'apikey': supabaseAnonKey,
        'authorization': 'Bearer $token',
        'content-type': 'application/json',
      };

  String _recentRecordingsCacheKey(String userId) => 'recent_recordings_$userId';

  String _encodeStoragePath(String path) =>
      path.split('/').map(Uri.encodeComponent).join('/');

  int? _int(Object? value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    if (value is String) return int.tryParse(value);
    return null;
  }

  DateTime? _date(Object? value) {
    if (value is! String || value.isEmpty) return null;
    return DateTime.tryParse(value);
  }
}
