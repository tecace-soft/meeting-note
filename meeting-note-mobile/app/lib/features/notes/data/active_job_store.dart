import '../../../core/cache/json_cache_store.dart';

/// A summarize job that is still in flight from this device's point of view.
///
/// Persisted so the client can resume polling and finish saving attachments
/// after a cold restart, instead of silently losing them when the in-memory
/// state is gone.
class ActiveJob {
  const ActiveJob({
    required this.jobId,
    required this.noteId,
    required this.userId,
    required this.attachmentPaths,
    required this.createdAtMillis,
  });

  final String jobId;
  final String noteId;
  final String userId;
  final List<String> attachmentPaths;
  final int createdAtMillis;

  Map<String, dynamic> toJson() => {
        'jobId': jobId,
        'noteId': noteId,
        'userId': userId,
        'attachmentPaths': attachmentPaths,
        'createdAtMillis': createdAtMillis,
      };

  static ActiveJob? fromJson(Map<String, dynamic> json) {
    final jobId = json['jobId'];
    final noteId = json['noteId'];
    final userId = json['userId'];
    if (jobId is! String || jobId.isEmpty) return null;
    if (noteId is! String || noteId.isEmpty) return null;
    if (userId is! String || userId.isEmpty) return null;
    final rawPaths = json['attachmentPaths'];
    final paths = rawPaths is List
        ? rawPaths.whereType<String>().toList()
        : const <String>[];
    final createdAt = json['createdAtMillis'];
    return ActiveJob(
      jobId: jobId,
      noteId: noteId,
      userId: userId,
      attachmentPaths: paths,
      createdAtMillis: createdAt is int ? createdAt : 0,
    );
  }
}

/// Disk-backed registry of in-flight summarize jobs, keyed by jobId so
/// concurrent submissions do not clobber one another. Entries are removed once
/// their job reaches a terminal state (completed with attachments handled, or
/// failed) so a resume never loops on a dead job.
class ActiveJobStore {
  const ActiveJobStore();

  static const _store = JsonCacheStore('active_jobs');
  static const _key = 'active';

  Future<void> put(ActiveJob job) async {
    final map = await _readMap();
    map[job.jobId] = job.toJson();
    await _store.writeMap(_key, map);
  }

  Future<void> remove(String jobId) async {
    final map = await _readMap();
    if (map.remove(jobId) != null) {
      await _store.writeMap(_key, map);
    }
  }

  Future<ActiveJob?> get(String jobId) async {
    final entry = (await _readMap())[jobId];
    return entry is Map ? ActiveJob.fromJson(entry.cast<String, dynamic>()) : null;
  }

  Future<List<ActiveJob>> all() async {
    final map = await _readMap();
    return map.values
        .whereType<Map>()
        .map((entry) => ActiveJob.fromJson(entry.cast<String, dynamic>()))
        .whereType<ActiveJob>()
        .toList();
  }

  /// The most recently created in-flight job for [userId], or null. Used on app
  /// launch to decide whether to resume the processing screen.
  Future<ActiveJob?> latestForUser(String userId) async {
    final jobs = (await all()).where((job) => job.userId == userId).toList()
      ..sort((a, b) => b.createdAtMillis.compareTo(a.createdAtMillis));
    return jobs.isEmpty ? null : jobs.first;
  }

  Future<Map<String, dynamic>> _readMap() async =>
      (await _store.readMap(_key)) ?? <String, dynamic>{};
}
