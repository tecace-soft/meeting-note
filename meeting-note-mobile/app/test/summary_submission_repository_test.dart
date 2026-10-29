import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_note_mobile/core/cache/json_cache_store.dart';
import 'package:meeting_note_mobile/features/auth/data/auth_token_store.dart';
import 'package:meeting_note_mobile/features/auth/data/mobile_supabase_session.dart';
import 'package:meeting_note_mobile/features/notes/data/active_job_store.dart';
import 'package:meeting_note_mobile/features/notes/data/notes_repository.dart';
import 'package:meeting_note_mobile/features/notes/data/summary_submit_store.dart';
import 'support/offline_notes.dart';

class Cache extends JsonCacheStore {
  Cache() : super('fixture');
  Map<String, dynamic> value = {};
  bool fail = false;
  @override
  Future<Map<String, dynamic>?> readMap(String key) async => Map.of(value);
  @override
  Future<void> writeMap(String key, Map<String, dynamic> data) async {
    if (fail) throw StateError('Synthetic disk failure');
    value = Map.of(data);
  }
}

class Jobs extends ActiveJobStore {
  final entries = <String, ActiveJob>{};
  @override
  Future<void> put(ActiveJob job) async {
    entries[job.jobId] = job;
  }

  @override
  Future<ActiveJob?> get(String jobId) async => entries[jobId];
  @override
  Future<void> remove(String jobId) async {
    entries.remove(jobId);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(
    () => FlutterSecureStorage.setMockInitialValues({
      AuthTokenStore.accessTokenKey: 'synthetic-ms',
    }),
  );
  const timeout = Timeout(Duration(seconds: 5));
  test(
    'the first POST has a durable noteId, and response loss plus relaunch reuse it',
    () async {
      final cache = Cache();
      final store = SummarySubmitStore(cache: cache);
      final jobs = Jobs();
      final submitted = <Map<String, dynamic>>[];
      final root = Adapter(
        (_) => jsonResponse({
          'signedURL': '/storage/v1/object/sign/bucket/a?token=synthetic',
        }),
      );
      final workflow = Adapter((request) {
        final body = Map<String, dynamic>.from(request.data as Map);
        submitted.add(body);
        final persisted = cache.value.values.single as Map;
        expect(persisted['noteId'], body['noteId']);
        return submitted.length == 1
            ? jsonResponse({'message': 'Synthetic response loss'}, status: 500)
            : jsonResponse({'jobId': 'job-1'});
      });
      NotesRepository build() => NotesRepository(
        Dio(),
        supabaseRoot: fakeDio(root),
        workflow: fakeDio(workflow),
        summarySubmits: store,
        activeJobs: jobs,
        auth: () async =>
            const MobileSupabaseAuth(token: 'synthetic-app', userId: 'owner'),
      );
      Future<String> submit(NotesRepository repo, String noteId) =>
          repo.createNote(
            audioPath: 'storage://bucket/a?fileId=file-1',
            title: 'Fixture',
            promptId: 'prompt-1',
            noteId: noteId,
          );
      await expectLater(submit(build(), 'first-note'), throwsStateError);
      expect(cache.value, hasLength(1));
      expect(await submit(build(), 'new-note-after-relaunch'), 'job-1');
      expect(submitted.map((r) => r['noteId']), ['first-note', 'first-note']);
      expect(jobs.entries['job-1']?.noteId, 'first-note');
      expect(cache.value, hasLength(1));
      await build().clearActiveJob('job-1', completed: true);
      expect(cache.value, isEmpty);
    },
    timeout: timeout,
  );
  test('failed durable storage prevents upload and POST', () async {
    final cache = Cache()..fail = true;
    final io = Adapter((_) {
      fail('No network operation is allowed after persistence failure.');
    });
    final repo = NotesRepository(
      Dio(),
      supabaseRoot: fakeDio(io),
      workflow: fakeDio(io),
      summarySubmits: SummarySubmitStore(cache: cache),
      activeJobs: Jobs(),
      auth: () async =>
          const MobileSupabaseAuth(token: 'synthetic-app', userId: 'owner'),
    );
    await expectLater(
      repo.createNote(
        audioPath: 'storage://bucket/a?fileId=f',
        title: 'Fixture',
        promptId: 'p',
      ),
      throwsStateError,
    );
    expect(io.calls, isEmpty);
  }, timeout: timeout);
}
