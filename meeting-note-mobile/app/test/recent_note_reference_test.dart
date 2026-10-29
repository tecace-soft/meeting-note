import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_note_mobile/features/auth/data/mobile_supabase_session.dart';
import 'package:meeting_note_mobile/features/notes/data/notes_repository.dart';
import 'support/offline_notes.dart';

void main() {
  const timeout = Timeout(Duration(seconds: 5));
  NotesRepository repo(Adapter adapter) => NotesRepository(
    Dio(),
    supabase: fakeDio(adapter),
    auth: () async =>
        const MobileSupabaseAuth(token: 'synthetic-app', userId: 'owner'),
  );
  const source = 'storage://bucket/owner%2Fa.m4a?fileId=file-1';
  test('a foreign-key reference suppresses automatic submission', () async {
    final adapter = Adapter(
      (_) => jsonResponse(
        [
          {'id': 'note-1', 'audio_file_id': 'file-1'},
        ],
        extraHeaders: {
          'content-range': ['0-0/1'],
        },
      ),
    );
    expect(await repo(adapter).referencingNote(source), 'note-1');
    expect(adapter.calls.single.queryParameters['user_id'], 'eq.owner');
    expect(adapter.calls.single.headers['prefer'], 'count=exact');
  }, timeout: timeout);
  test(
    'legacy signed storage URLs are matched by bucket and decoded path only',
    () async {
      final adapter = Adapter(
        (_) => jsonResponse(
          [
            {
              'id': 'legacy-note',
              'audio_file_id': null,
              'audio_file':
                  'https://example.test/storage/v1/object/sign/bucket/owner%2Fa.m4a?token=synthetic',
            },
          ],
          extraHeaders: {
            'content-range': ['0-0/1'],
          },
        ),
      );
      expect(await repo(adapter).referencingNote(source), 'legacy-note');
    },
    timeout: timeout,
  );
  test(
    'a capped response continues until the complete count is checked',
    () async {
      final adapter = Adapter(
        (request) => request.queryParameters['offset'] == 0
            ? jsonResponse(
                [
                  {'id': 'unrelated', 'audio_file_id': 'other-file'},
                ],
                extraHeaders: {
                  'content-range': ['0-0/2'],
                },
              )
            : jsonResponse(
                [
                  {'id': 'note-1', 'audio_file_id': 'file-1'},
                ],
                extraHeaders: {
                  'content-range': ['1-1/2'],
                },
              ),
      );
      expect(await repo(adapter).referencingNote(source), 'note-1');
      expect(adapter.calls.last.queryParameters['offset'], 1);
    },
    timeout: timeout,
  );
  test('a complete empty snapshot permits the countdown', () async {
    final adapter = Adapter(
      (_) => jsonResponse(
        [],
        extraHeaders: {
          'content-range': ['*/0'],
        },
      ),
    );
    expect(await repo(adapter).referencingNote(source), isNull);
  }, timeout: timeout);
  for (final mode in [
    'missing-count',
    'changed-count',
    'truncated',
    'page-cap',
  ]) {
    test('$mode fails closed instead of claiming no existing notes', () async {
      final adapter = Adapter((request) {
        final offset = request.queryParameters['offset'] as int;
        if (mode == 'missing-count') {
          return jsonResponse([]);
        }
        if (mode == 'truncated') {
          return jsonResponse(
            [],
            extraHeaders: {
              'content-range': ['*/2'],
            },
          );
        }
        return jsonResponse(
          [
            {'id': 'other-$offset', 'audio_file_id': 'another-file'},
          ],
          extraHeaders: {
            'content-range': [
              '$offset-$offset/${mode == 'changed-count' && offset > 0 ? 3 : 25}',
            ],
          },
        );
      });
      await expectLater(
        repo(adapter).referencingNote(source),
        throwsStateError,
      );
      expect(adapter.calls.length, lessThanOrEqualTo(20));
    }, timeout: timeout);
  }
  test(
    'an unverifiable source never starts an auto reference check',
    () async {
      final adapter = Adapter((_) {
        fail('Unverified sources must not reach network.');
      });
      await expectLater(
        repo(adapter).referencingNote('/local/file.m4a'),
        throwsStateError,
      );
      expect(adapter.calls, isEmpty);
    },
    timeout: timeout,
  );
}
