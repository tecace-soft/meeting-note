import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_note_mobile/core/cache/json_cache_store.dart';
import 'package:meeting_note_mobile/features/notes/data/summary_submit_store.dart';

class MemoryCache extends JsonCacheStore {
  MemoryCache() : super('fixture');
  Map<String, dynamic> data = {};
  bool failWrites = false;
  @override
  Future<Map<String, dynamic>?> readMap(String key) async =>
      (jsonDecode(jsonEncode(data)) as Map).cast<String, dynamic>();
  @override
  Future<void> writeMap(String key, Map<String, dynamic> value) async {
    if (failWrites) throw StateError('Synthetic disk full');
    data = (jsonDecode(jsonEncode(value)) as Map).cast<String, dynamic>();
  }
}

void main() {
  const timeout = Timeout(Duration(seconds: 5));
  test(
    'relaunch and a retry reuse both durable keys for the same user and original',
    () async {
      final cache = MemoryCache();
      final first = await SummarySubmitStore(
        cache: cache,
      ).getOrCreate(userId: 'owner', fileKey: 'local:/a.m4a');
      final resumed = await SummarySubmitStore(cache: cache).getOrCreate(
        userId: 'owner',
        fileKey: 'local:/a.m4a',
        noteId: 'new-id',
        fileId: 'new-file',
      );
      expect(resumed.noteId, first.noteId);
      expect(resumed.fileId, first.fileId);
      expect(cache.data, isNotEmpty);
    },
    timeout: timeout,
  );
  test(
    'a recent cloud recording reuses the pending local original through its file id',
    () async {
      final cache = MemoryCache();
      final local = await SummarySubmitStore(cache: cache).getOrCreate(
        userId: 'owner',
        fileKey: 'local:/recording.m4a',
        fileId: 'uploaded-file',
      );
      final recent = await SummarySubmitStore(cache: cache).getOrCreate(
        userId: 'owner',
        fileKey: 'file:uploaded-file',
        noteId: 'new-note',
      );
      expect(recent.noteId, local.noteId);
      expect(recent.fileId, local.fileId);
      expect(cache.data, hasLength(1));
    },
    timeout: timeout,
  );
  test(
    'does not reuse another user or another source and isolates completed cleanup',
    () async {
      final store = SummarySubmitStore(cache: MemoryCache());
      final a = await store.getOrCreate(userId: 'a', fileKey: 'file:one');
      final b = await store.getOrCreate(userId: 'b', fileKey: 'file:one');
      final c = await store.getOrCreate(userId: 'a', fileKey: 'file:two');
      expect({a.noteId, b.noteId, c.noteId}, hasLength(3));
      await store.clearCompleted('a', a.noteId);
      expect(
        (await store.getOrCreate(userId: 'b', fileKey: 'file:one')).noteId,
        b.noteId,
      );
      expect(
        (await store.getOrCreate(userId: 'a', fileKey: 'file:two')).noteId,
        c.noteId,
      );
      expect(
        (await store.getOrCreate(userId: 'a', fileKey: 'file:one')).noteId,
        isNot(a.noteId),
      );
    },
    timeout: timeout,
  );
  for (final delta in [
    const Duration(hours: 24, seconds: 1),
    const Duration(seconds: -1),
  ]) {
    test('ignores expired or future-dated records ($delta)', () async {
      final store = SummarySubmitStore(cache: MemoryCache());
      final now = DateTime.utc(2026, 10, 29);
      final a = await store.getOrCreate(
        userId: 'owner',
        fileKey: 'a',
        now: now,
      );
      final b = await store.getOrCreate(
        userId: 'owner',
        fileKey: 'a',
        now: now.add(delta),
      );
      expect(b.noteId, isNot(a.noteId));
    }, timeout: timeout);
  }
  test(
    'simultaneous submissions and different sources do not overwrite records',
    () async {
      final cache = MemoryCache();
      final results = await Future.wait([
        SummarySubmitStore(
          cache: cache,
        ).getOrCreate(userId: 'owner', fileKey: 'a'),
        SummarySubmitStore(
          cache: cache,
        ).getOrCreate(userId: 'owner', fileKey: 'a'),
        SummarySubmitStore(
          cache: cache,
        ).getOrCreate(userId: 'owner', fileKey: 'b'),
      ]);
      expect(results[0].noteId, results[1].noteId);
      expect(results[2].noteId, isNot(results[0].noteId));
      expect(cache.data, hasLength(2));
    },
    timeout: timeout,
  );
  test('a persistence failure blocks submission', () async {
    final cache = MemoryCache()..failWrites = true;
    await expectLater(
      SummarySubmitStore(
        cache: cache,
      ).getOrCreate(userId: 'owner', fileKey: 'a'),
      throwsStateError,
    );
  }, timeout: timeout);
  test(
    'source keys are stable across signing and metadata changes without saving signatures',
    () {
      expect(
        summarySourceKey('storage://bucket/path?fileId=f&name=one'),
        'file:f',
      );
      expect(
        summarySourceKey('storage://bucket/path?fileId=f&name=two'),
        'file:f',
      );
      expect(
        summarySourceKey('https://audio.example.test/a?token=synthetic'),
        'remote:https://audio.example.test/a',
      );
    },
    timeout: timeout,
  );
}
