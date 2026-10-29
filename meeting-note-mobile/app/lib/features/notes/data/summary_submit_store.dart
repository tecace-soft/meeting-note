import 'dart:async';
import '../../../core/cache/json_cache_store.dart';
import '../../../shared/util/uuid.dart';

/// S11: durable idempotency keys before upload and the first job POST.
/// Only source identities are stored, never signed URLs or credentials.
class SummarySubmitRecord {
  const SummarySubmitRecord({
    required this.userId,
    required this.fileKey,
    required this.noteId,
    required this.fileId,
    required this.createdAtMillis,
  });
  final String userId;
  final String fileKey;
  final String noteId;
  final String fileId;
  final int createdAtMillis;
  Map<String, dynamic> toJson() => {
    'userId': userId,
    'fileKey': fileKey,
    'noteId': noteId,
    'fileId': fileId,
    'createdAtMillis': createdAtMillis,
  };
}

String summarySourceKey(String audioPath) {
  final uri = Uri.tryParse(audioPath);
  if (uri?.scheme == 'storage') {
    final fileId = uri!.queryParameters['fileId'];
    return fileId != null && fileId.isNotEmpty
        ? 'file:$fileId'
        : 'storage:${uri.host}${uri.path}';
  }
  if (uri?.scheme == 'http' || uri?.scheme == 'https') {
    return 'remote:${uri!.origin}${uri.path}';
  }
  return 'local:$audioPath';
}

class SummarySubmitStore {
  const SummarySubmitStore({
    this.cache = const JsonCacheStore('summary_submits', atomicWrites: true),
  });
  final JsonCacheStore cache;
  static Future<void> _tail = Future.value();
  static const _key = 'pending';
  static const maxAge = Duration(hours: 24);

  // Serialize the read/modify/write sequence across repository instances.
  Future<T> _locked<T>(Future<T> Function() action) async {
    final previous = _tail;
    final done = Completer<void>();
    _tail = done.future;
    await previous;
    try {
      return await action();
    } finally {
      done.complete();
    }
  }

  Future<SummarySubmitRecord> getOrCreate({
    required String userId,
    required String fileKey,
    String? noteId,
    String? fileId,
    DateTime? now,
  }) => _locked(() async {
    if (userId.trim().isEmpty || fileKey.trim().isEmpty) {
      throw StateError('Missing summary submission identity.');
    }
    final timestamp = (now ?? DateTime.now()).millisecondsSinceEpoch;
    final records = await cache.readMap(_key) ?? <String, dynamic>{};
    final identity = '$userId\u0000$fileKey';
    var old = records[identity];
    // A recording picked from Recents after its upload is the same original.
    // The preassigned file id joins its earlier local-path record to this source.
    if (old == null && fileKey.startsWith('file:')) {
      final sourceFileId = fileKey.substring('file:'.length);
      for (final candidate in records.values) {
        if (candidate is Map &&
            candidate['userId'] == userId &&
            candidate['fileId'] == sourceFileId) {
          old = candidate;
          break;
        }
      }
    }
    if (old is Map &&
        old['userId'] == userId &&
        (old['fileKey'] == fileKey ||
            (fileKey.startsWith('file:') &&
                old['fileId'] == fileKey.substring(5))) &&
        old['noteId'] is String &&
        (old['noteId'] as String).isNotEmpty &&
        old['fileId'] is String &&
        (old['fileId'] as String).isNotEmpty &&
        old['createdAtMillis'] is int) {
      final age = timestamp - (old['createdAtMillis'] as int);
      if (age >= 0 && age <= maxAge.inMilliseconds) {
        return SummarySubmitRecord(
          userId: userId,
          fileKey: fileKey,
          noteId: old['noteId'] as String,
          fileId: old['fileId'] as String,
          createdAtMillis: old['createdAtMillis'] as int,
        );
      }
    }
    final record = SummarySubmitRecord(
      userId: userId,
      fileKey: fileKey,
      noteId: noteId?.trim().isNotEmpty == true ? noteId!.trim() : uuidV4(),
      fileId: fileId?.trim().isNotEmpty == true ? fileId!.trim() : uuidV4(),
      createdAtMillis: timestamp,
    );
    records[identity] = record.toJson();
    // A failed write prevents submission rather than losing its idempotency key.
    await cache.writeMap(_key, records);
    return record;
  });

  Future<void> clearCompleted(String userId, String noteId) =>
      _locked(() async {
        final records = await cache.readMap(_key) ?? <String, dynamic>{};
        records.removeWhere(
          (_, value) =>
              value is Map &&
              value['userId'] == userId &&
              value['noteId'] == noteId,
        );
        await cache.writeMap(_key, records);
      });
}
