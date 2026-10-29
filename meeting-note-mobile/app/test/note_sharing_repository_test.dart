import 'dart:convert';
import 'support/offline_notes.dart';
import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_note_mobile/features/auth/data/mobile_supabase_session.dart';
import 'package:meeting_note_mobile/features/notes/data/notes_repository.dart';

NotesRepository repository(Adapter adapter) => NotesRepository(
  Dio(),
  supabase: fakeDio(adapter),
  auth: () async =>
      const MobileSupabaseAuth(token: 'synthetic-app', userId: 'owner'),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/path_provider'),
          (_) async => '/tmp/meeting-note-mobile-sharing-fixture',
        );
  });
  const timeout = Timeout(Duration(seconds: 5));
  for (final change in ['revoke', 'add']) {
    test(
      'conditional add preserves a concurrent $change after read',
      () async {
        var shared = <String>['legacy'];
        var writes = 0;
        final adapter = Adapter((request) {
          if (request.method == 'GET') {
            return jsonResponse([
              {'user_id': 'owner', 'shared_users': List.of(shared)},
            ]);
          }
          writes++;
          if (writes == 1) {
            shared = change == 'revoke' ? [] : ['legacy', 'another'];
          }
          final expected = 'eq.{${shared.map(jsonEncode).join(',')}}';
          if (request.queryParameters['shared_users'] != expected) {
            return jsonResponse([]);
          }
          shared = List<String>.from(
            (request.data as Map)['shared_users'] as List,
          );
          return jsonResponse([
            {'id': 'note-1'},
          ]);
        });
        final result = await repository(
          adapter,
        ).shareNoteWithMicrosoftUser('note-1', 'target');
        expect(
          result,
          change == 'revoke' ? ['target'] : ['legacy', 'another', 'target'],
        );
        expect(shared, result);
        expect(writes, 2);
        for (final request in adapter.calls.where((r) => r.method == 'PATCH')) {
          expect(request.queryParameters['user_id'], 'eq.owner');
          expect(request.queryParameters['select'], 'id');
          expect(request.headers['prefer'], 'return=representation');
        }
      },
      timeout: timeout,
    );
  }
  test(
    'zero-row full-list writes and wrong returned note ids are errors',
    () async {
      for (final rows in [
        [],
        [
          {'id': 'another-note'},
        ],
      ]) {
        final adapter = Adapter((_) => jsonResponse(rows));
        await expectLater(
          repository(adapter).shareNote('note-1', ['target']),
          throwsStateError,
        );
      }
    },
    timeout: timeout,
  );
  for (final snapshot in <List<String?>?>[
    null,
    [],
    ['comma,value', 'quote"', r'back\slash', null, 'NULL'],
  ]) {
    test(
      'exact snapshot guard preserves null, empty and escaped arrays ($snapshot)',
      () async {
        final adapter = Adapter(
          (_) => jsonResponse([
            {'id': 'note-1'},
          ]),
        );
        await repository(adapter).setNoteSharedUsersAsOwner(
          'note-1',
          ['target'],
          expected: NoteSharingSnapshot(
            ownerId: 'owner',
            sharedUsers: snapshot,
          ),
        );
        final filter = adapter.calls.single.queryParameters['shared_users'];
        if (snapshot == null) {
          expect(filter, 'is.null');
        } else if (snapshot.isEmpty) {
          expect(filter, 'eq.{}');
        } else {
          expect(
            filter,
            r'eq.{"comma,value","quote\"","back\\slash",NULL,"NULL"}',
          );
        }
      },
      timeout: timeout,
    );
  }
  test('rechecks ownership after a conflict and stops on denial', () async {
    var reads = 0;
    final adapter = Adapter(
      (r) => r.method == 'GET'
          ? jsonResponse([
              {
                'user_id': ++reads == 1 ? 'owner' : 'new-owner',
                'shared_users': [],
              },
            ])
          : jsonResponse([]),
    );
    await expectLater(
      repository(adapter).shareNoteWithMicrosoftUser('note-1', 'target'),
      throwsStateError,
    );
    expect(adapter.calls.where((r) => r.method == 'PATCH'), hasLength(1));
  }, timeout: timeout);
  test('stops after three conflicts with no false success', () async {
    final adapter = Adapter(
      (r) => jsonResponse(
        r.method == 'GET'
            ? [
                {'user_id': 'owner', 'shared_users': []},
              ]
            : [],
      ),
    );
    await expectLater(
      repository(adapter).shareNoteWithMicrosoftUser('note-1', 'target'),
      throwsA(isA<NoteSharingChangedError>()),
    );
    expect(adapter.calls.where((r) => r.method == 'GET'), hasLength(3));
    expect(adapter.calls.where((r) => r.method == 'PATCH'), hasLength(3));
  }, timeout: timeout);
  test('a database failure is not retried', () async {
    final adapter = Adapter(
      (r) => r.method == 'GET'
          ? jsonResponse([
              {'user_id': 'owner', 'shared_users': []},
            ])
          : jsonResponse({'message': 'synthetic failure'}, status: 500),
    );
    await expectLater(
      repository(adapter).shareNoteWithMicrosoftUser('note-1', 'target'),
      throwsA(isA<DioException>()),
    );
    expect(adapter.calls.where((r) => r.method == 'PATCH'), hasLength(1));
  }, timeout: timeout);
  test('a changed assignment or a nonowner never writes', () async {
    final adapter = Adapter(
      (_) => jsonResponse([
        {'user_id': 'owner', 'shared_users': []},
      ]),
    );
    await expectLater(
      repository(
        adapter,
      ).shareNoteWithMicrosoftUser('note-1', 'target', isCurrent: () => false),
      throwsStateError,
    );
    expect(adapter.calls.where((r) => r.method == 'PATCH'), isEmpty);
    await expectLater(
      repository(adapter).setNoteSharedUsersAsOwner(
        'note-1',
        ['target'],
        expected: const NoteSharingSnapshot(
          ownerId: 'another-owner',
          sharedUsers: [],
        ),
      ),
      throwsStateError,
    );
    expect(adapter.calls.where((r) => r.method == 'PATCH'), isEmpty);
  }, timeout: timeout);
  test('an already-shared target does not write again', () async {
    final adapter = Adapter(
      (_) => jsonResponse([
        {
          'user_id': 'owner',
          'shared_users': ['target'],
        },
      ]),
    );
    expect(
      await repository(adapter).shareNoteWithMicrosoftUser('note-1', 'target'),
      ['target'],
    );
    expect(adapter.calls.where((r) => r.method == 'PATCH'), isEmpty);
  }, timeout: timeout);
}
