import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_note_mobile/core/cache/json_cache_store.dart';
import 'package:meeting_note_mobile/features/notes/data/summary_submit_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'an interrupted later disk write retains the first durable submission on restart',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'meeting-note-summary-submit-',
      );
      addTearDown(() => directory.delete(recursive: true));
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
            const MethodChannel('plugins.flutter.io/path_provider'),
            (_) async => directory.path,
          );
      const cache = JsonCacheStore('summary_submits', atomicWrites: true);
      final first = await const SummarySubmitStore(
        cache: cache,
      ).getOrCreate(userId: 'owner', fileKey: 'file:one');
      final partial = File(
        '${directory.path}/cache/summary_submits/pending.json.pending',
      );
      await partial.writeAsString('{incomplete', flush: true);
      final resumed = await const SummarySubmitStore(
        cache: cache,
      ).getOrCreate(userId: 'owner', fileKey: 'file:one');
      expect(resumed.noteId, first.noteId);
      await const SummarySubmitStore(
        cache: cache,
      ).getOrCreate(userId: 'owner', fileKey: 'file:two');
      expect(await partial.exists(), isFalse);
      final stored = await cache.readMap('pending');
      expect(stored, hasLength(2));
    },
    timeout: const Timeout(Duration(seconds: 5)),
  );
}
