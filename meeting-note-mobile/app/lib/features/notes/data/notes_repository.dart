import 'dart:convert';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';

import '../../../core/cache/json_cache_store.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/supabase_config.dart';
import '../../../core/network/workflow_config.dart';
import '../../auth/data/auth_token_store.dart';
import '../../auth/data/mobile_supabase_session.dart';
import '../models/meeting_note.dart';

final notesRepositoryProvider = Provider<NotesRepository>(
  (ref) => NotesRepository(ref.watch(apiClientProvider)),
);

final notesListProvider = FutureProvider<List<MeetingNote>>(
  (ref) => ref.watch(notesRepositoryProvider).list(),
);

final noteProvider = FutureProvider.family<MeetingNote, String>(
    (ref, id) => ref.watch(notesRepositoryProvider).get(id));

final promptsProvider = FutureProvider<List<SummaryPrompt>>(
    (ref) => ref.watch(notesRepositoryProvider).prompts());

const _defaultSummaryPromptName = 'Default';

/// Repository over the existing Meeting Note backend.
/// History and note detail intentionally fail loudly instead of showing mock
/// notes when Supabase cannot be reached.
class NotesRepository {
  NotesRepository(this._dio)
      : _supabase = Dio(
          BaseOptions(
            baseUrl: '${supabaseUrl.replaceAll(RegExp(r'/$'), '')}/rest/v1',
            connectTimeout: const Duration(seconds: 15),
            receiveTimeout: const Duration(seconds: 30),
          ),
        ),
        _supabaseRoot = Dio(
          BaseOptions(
            baseUrl: supabaseUrl.replaceAll(RegExp(r'/$'), ''),
            connectTimeout: const Duration(seconds: 15),
            receiveTimeout: const Duration(seconds: 30),
            sendTimeout: const Duration(minutes: 5),
          ),
        ),
        _workflow = Dio(
          BaseOptions(
            baseUrl: workflowApiUrl.replaceAll(RegExp(r'/$'), ''),
            connectTimeout: const Duration(seconds: 30),
            receiveTimeout: const Duration(minutes: 2),
            sendTimeout: const Duration(minutes: 5),
          ),
        ) {
    final retry = MobileSupabaseSession().retryOnUnauthorizedInterceptor();
    _supabase.interceptors.add(retry);
    _supabaseRoot.interceptors.add(retry);
  }

  final Dio _dio; // ignore: unused_field
  final Dio _supabase;
  final Dio _supabaseRoot;
  final Dio _workflow;
  static const _storage = FlutterSecureStorage();
  static const _cache = JsonCacheStore('notes');
  static const _audioBucket = 'meeting-recordings';
  static const _noteImageBucket = 'meeting-note-images';
  static const _signedUrlSeconds = 60 * 60 * 6;
  static final _pendingJobAttachments = <String, List<String>>{};

  Future<List<MeetingNote>?> cachedList({
    String? query,
    NoteOwnershipFilter ownership = NoteOwnershipFilter.all,
    NoteSortKey sort = NoteSortKey.meetingDesc,
    int limit = 50,
  }) async {
    final userId = await MobileSupabaseSession.cachedUserId();
    if (userId == null) return null;
    final rows = await _cache.readList(_notesCacheKey(userId));
    if (rows == null) return null;
    return _notesFromRows(
      rows,
      userId: userId,
      query: query,
      ownership: ownership,
      sort: sort,
      limit: limit,
    );
  }

  Future<List<MeetingNote>> refreshList({
    String? query,
    NoteOwnershipFilter ownership = NoteOwnershipFilter.all,
    NoteSortKey sort = NoteSortKey.meetingDesc,
    int limit = 50,
  }) =>
      list(query: query, ownership: ownership, sort: sort, limit: limit);

  Future<List<MeetingNote>> list({
    String? query,
    NoteOwnershipFilter ownership = NoteOwnershipFilter.all,
    NoteSortKey sort = NoteSortKey.meetingDesc,
    int limit = 50,
  }) async {
    final auth = await MobileSupabaseSession().auth();

    final response = await _supabase.get<List<dynamic>>(
      '/note',
      queryParameters: {
        'select': '*',
        'order': _orderParam(sort),
        'limit': max(limit, 200),
        if (ownership == NoteOwnershipFilter.mine)
          'user_id': 'eq.${auth.userId}',
        if (ownership == NoteOwnershipFilter.shared) ...{
          'user_id': 'neq.${auth.userId}',
          'shared_users': 'cs.{${auth.userId}}',
        },
      },
      options: Options(headers: _supabaseHeaders(auth.token)),
    );

    final rows = response.data ?? const [];
    if (ownership == NoteOwnershipFilter.all && query == null) {
      await _cache.writeList(_notesCacheKey(auth.userId), rows);
    }
    return _notesFromRows(
      rows,
      userId: auth.userId,
      query: query,
      ownership: ownership,
      sort: sort,
      limit: limit,
    );
  }

  List<MeetingNote> _notesFromRows(
    List<dynamic> rows, {
    required String userId,
    String? query,
    required NoteOwnershipFilter ownership,
    required NoteSortKey sort,
    required int limit,
  }) {
    var notes = rows
        .whereType<Map>()
        .map((json) => MeetingNote.fromJson(json.cast<String, dynamic>()))
        .where((note) => note.id.isNotEmpty)
        .toList();
    if (ownership == NoteOwnershipFilter.all) {
      notes = notes
          .where((note) =>
              note.ownerId == userId || note.sharedUserIds.contains(userId))
          .toList();
    } else if (ownership == NoteOwnershipFilter.mine) {
      notes = notes.where((note) => note.ownerId == userId).toList();
    } else {
      notes = notes
          .where((note) =>
              note.ownerId != userId && note.sharedUserIds.contains(userId))
          .toList();
    }
    notes = _filter(notes, query);
    notes.sort((a, b) => _compareNotes(a, b, sort));
    return notes.take(limit).toList();
  }

  Future<MeetingNote> get(String id) async {
    final auth = await MobileSupabaseSession().auth();
    final response = await _supabase.get<List<dynamic>>(
      '/note',
      queryParameters: {
        'select': '*',
        'id': 'eq.$id',
        'limit': 1,
      },
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
    final rows = response.data?.whereType<Map>().toList() ?? const [];
    final row = rows.isEmpty ? null : rows.first;
    if (row == null) throw StateError('Note not found.');
    return MeetingNote.fromJson(row.cast<String, dynamic>());
  }

  Future<List<SummaryPrompt>> prompts() async {
    final auth = await MobileSupabaseSession().auth();

    final response = await _supabase.get<List<dynamic>>(
      '/summary_prompt',
      queryParameters: {
        'select': 'id,name,prompt',
        'user_id': 'eq.${auth.userId}',
        'order': 'name.asc',
      },
      options: Options(headers: _supabaseHeaders(auth.token)),
    );

    var prompts = (response.data ?? const [])
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .map((row) {
          final id = row['id'];
          final name = row['name'];
          if (id is! String || name is! String) return null;
          final prompt = row['prompt'];
          return SummaryPrompt(
            id: id,
            name: name,
            description: prompt is String ? _preview(prompt) : null,
          );
        })
        .whereType<SummaryPrompt>()
        .toList();
    return prompts;
  }

  /// Uploads audio + attachments and creates the job. Returns jobId.
  Future<String> createNote({
    required String audioPath,
    required String title,
    String? instructions,
    String? promptId,
    String? userName,
    List<String> attachmentPaths = const [],
  }) async {
    final microsoftToken =
        await _storage.read(key: AuthTokenStore.accessTokenKey);
    final auth = await MobileSupabaseSession().auth();
    final appLanguage =
        await _storage.read(key: 'settings_app_language') == 'ko' ? 'ko' : 'en';
    if (microsoftToken == null || microsoftToken.isEmpty) {
      throw StateError('Sign in with Microsoft before generating a summary.');
    }
    try {
      final audio = await _prepareAudioForWorkflow(
        audioPath: audioPath,
        title: title,
        userId: auth.userId,
        supabaseToken: auth.token,
      );
      final prompt = await _resolvePromptId(promptId);
      final noteId = _uuidV4();
      final attachments = await _workflowAttachments(attachmentPaths);

      final response = await _workflow.post<Map<String, dynamic>>(
        '/summarize-audio/jobs',
        data: {
          'downloadUrl': audio.downloadUrl,
          'fileName': audio.fileName,
          'fileId': audio.fileId,
          'meetingAt': audio.recordedAt,
          'userTimeZone': DateTime.now().timeZoneName,
          'instructions': instructions ?? '',
          'promptId': prompt.promptId,
          if (prompt.summaryRulesOverride != null)
            'summaryRulesOverride': prompt.summaryRulesOverride,
          'userId': auth.userId,
          'userName': userName?.trim() ?? '',
          'noteId': noteId,
          'language': appLanguage,
          'attachments': attachments,
        },
        options: Options(
          headers: {
            'content-type': 'application/json',
            'authorization': 'Bearer $microsoftToken',
          },
        ),
      );
      final jobId = response.data?['jobId'];
      if (jobId is String && jobId.trim().isNotEmpty) {
        _pendingJobAttachments[jobId.trim()] = attachmentPaths
            .map((path) => path.trim())
            .where((path) => path.isNotEmpty)
            .toList();
        return jobId.trim();
      }
      throw StateError('Workflow server did not return a job id.');
    } on DioException catch (error) {
      throw StateError(
        _dioMessage(
          error,
          'Could not reach $workflowApiUrl/summarize-audio/jobs.',
        ),
      );
    }
  }

  Future<void> savePendingAttachmentsForJob({
    required String jobId,
    required String noteId,
  }) async {
    final key = jobId.trim();
    final paths = _pendingJobAttachments[key] ?? const [];
    if (paths.isEmpty) return;
    final auth = await MobileSupabaseSession().auth();
    for (final path in paths.take(10)) {
      await _saveNoteAttachment(
        path: path,
        noteId: noteId,
        userId: auth.userId,
        token: auth.token,
      );
    }
    _pendingJobAttachments.remove(key);
  }

  Future<WorkflowJobSnapshot> jobStatus(String jobId) async {
    final token = await _storage.read(key: AuthTokenStore.accessTokenKey);
    if (token == null || token.isEmpty) {
      throw StateError('Sign in with Microsoft before checking job status.');
    }

    try {
      final response = await _workflow.get<Map<String, dynamic>>(
        '/summarize-audio/jobs/$jobId',
        options: Options(headers: {'authorization': 'Bearer $token'}),
      );
      return WorkflowJobSnapshot.fromJson(response.data ?? const {});
    } on DioException catch (error) {
      throw StateError(
        _dioMessage(
          error,
          'Could not reach $workflowApiUrl/summarize-audio/jobs/$jobId.',
        ),
      );
    }
  }

  Future<_ResolvedPrompt> _resolvePromptId(String? selectedPromptId) async {
    final trimmed = selectedPromptId?.trim();
    if (trimmed != null && trimmed.isNotEmpty) {
      return _ResolvedPrompt(promptId: trimmed);
    }
    final list = await prompts();
    SummaryPrompt? defaultPrompt;
    for (final prompt in list) {
      if (prompt.name.trim().toLowerCase() ==
          _defaultSummaryPromptName.toLowerCase()) {
        defaultPrompt = prompt;
        break;
      }
    }
    if (list.isNotEmpty) {
      return _ResolvedPrompt(promptId: (defaultPrompt ?? list.first).id);
    }
    throw StateError(
      'Select a summarization prompt before generating a summary.',
    );
  }

  Future<_PreparedAudio> _prepareAudioForWorkflow({
    required String audioPath,
    required String title,
    required String userId,
    required String supabaseToken,
  }) async {
    final storageRef = _StorageAudioRef.tryParse(audioPath);
    if (storageRef != null) {
      final signedUrl = await _createAudioSignedUrl(
        storageRef.storagePath,
        bucket: storageRef.bucket,
        token: supabaseToken,
      );
      return _PreparedAudio(
        downloadUrl: signedUrl,
        fileName:
            storageRef.name ?? _fileName(storageRef.storagePath, fallback: '$title.m4a'),
        fileId: storageRef.fileId,
        recordedAt: storageRef.recordedAt,
      );
    }

    final localAudioPath = await _localAudioPath(audioPath, title);
    final file = File(localAudioPath);
    if (!await file.exists()) {
      throw StateError(
        'Audio file was not found on this device: $localAudioPath',
      );
    }
    final stat = await file.stat();
    if (stat.size <= 0) {
      throw StateError('Audio file is empty.');
    }
    const maxBytes = 100 * 1024 * 1024;
    if (stat.size > maxBytes) {
      throw StateError('File too large. Maximum size is 100 MB.');
    }

    final fileId = _uuidV4();
    final fileName = _fileName(localAudioPath, fallback: '$title.m4a');
    if (_isMpeg4Audio(fileName) && !await _hasFinalizedMp4Metadata(file)) {
      throw StateError(
        'This recovered recording was interrupted before Android finalized the audio file. Please discard it and record again.',
      );
    }
    final storagePath = '$fileId-${_sanitizeStorageFileName(fileName)}';
    final mimeType = _audioMimeType(fileName);
    await _uploadAudioToStorage(
      storagePath: storagePath,
      file: file,
      mimeType: mimeType,
      token: supabaseToken,
    );
    final signedUrl = await _createAudioSignedUrl(
      storagePath,
      bucket: _audioBucket,
      token: supabaseToken,
    );
    final rowId = await _saveAudioFileRecord(
      userId: userId,
      name: fileName,
      storagePath: storagePath,
      mimeType: mimeType,
      sizeBytes: stat.size,
      token: supabaseToken,
      recordedAt: stat.modified.toUtc().toIso8601String(),
      source: fileName.startsWith('rec_') ? 'recording' : 'upload',
    );

    return _PreparedAudio(
      downloadUrl: signedUrl,
      fileName: fileName,
      fileId: rowId,
      recordedAt: stat.modified.toUtc().toIso8601String(),
    );
  }

  Future<void> _uploadAudioToStorage({
    required String storagePath,
    required File file,
    required String mimeType,
    required String token,
  }) async {
    await _supabaseRoot.post<void>(
      '/storage/v1/object/$_audioBucket/$storagePath',
      data: await file.readAsBytes(),
      options: Options(
        contentType: mimeType,
        headers: {
          'apikey': supabaseAnonKey,
          'authorization': 'Bearer $token',
          'cache-control': '3600',
          'x-upsert': 'false',
        },
      ),
    );
  }

  Future<List<Map<String, String>>> _workflowAttachments(
    List<String> paths,
  ) async {
    final attachments = <Map<String, String>>[];
    var totalBytes = 0;
    for (final path in paths.take(10)) {
      final file = File(path);
      if (!await file.exists()) continue;
      final stat = await file.stat();
      if (stat.size <= 0) continue;
      if (stat.size > 25 * 1024 * 1024) {
        throw StateError(
          "Attachment ${_fileName(path, fallback: 'attachment')} is larger than 25 MB.",
        );
      }
      totalBytes += stat.size;
      if (totalBytes > 50 * 1024 * 1024) {
        throw StateError('Attachments are larger than the 50 MB total limit.');
      }
      final name = _fileName(path, fallback: 'attachment');
      final mimeType = _attachmentMimeType(name);
      if (!_isSupportedAttachmentMimeType(mimeType)) {
        throw StateError(
          'Unsupported attachment type for $name. Use PDF, text, image, audio, or video.',
        );
      }
      attachments.add({
        'name': name,
        'mimeType': mimeType,
        'dataBase64': base64Encode(await file.readAsBytes()),
      });
    }
    return attachments;
  }

  Future<void> _saveNoteAttachment({
    required String path,
    required String noteId,
    required String userId,
    required String token,
  }) async {
    final file = File(path);
    if (!await file.exists()) return;
    final stat = await file.stat();
    if (stat.size <= 0) return;
    if (stat.size > 50 * 1024 * 1024) {
      throw StateError(
        "Attachment ${_fileName(path, fallback: 'attachment')} is larger than 50 MB.",
      );
    }
    final imageId = _uuidV4();
    final name = _fileName(path, fallback: 'attachment');
    final mimeType = _attachmentMimeType(name);
    if (!_isSupportedAttachmentMimeType(mimeType)) {
      throw StateError(
        'Unsupported attachment type for $name. Use PDF, text, image, audio, or video.',
      );
    }
    final storagePath =
        '$userId/$noteId/$imageId.${_attachmentExtension(name, fallback: 'bin')}';
    await _supabaseRoot.post<void>(
      '/storage/v1/object/$_noteImageBucket/$storagePath',
      data: await file.readAsBytes(),
      options: Options(
        contentType: mimeType,
        headers: {
          'apikey': supabaseAnonKey,
          'authorization': 'Bearer $token',
          'cache-control': '3600',
          'x-upsert': 'false',
        },
      ),
    );
    try {
      await _supabase.post<void>(
        '/note_image',
        data: {
          'id': imageId,
          'note_id': noteId,
          'user_id': userId,
          'bucket': _noteImageBucket,
          'storage_path': storagePath,
          'name': name,
          'mime_type': mimeType,
          'size_bytes': stat.size,
        },
        options: Options(headers: _supabaseJsonHeaders(token)),
      );
    } catch (_) {
      await _supabaseRoot.delete<void>(
        '/storage/v1/object/$_noteImageBucket/$storagePath',
        options: Options(headers: _supabaseJsonHeaders(token)),
      ).catchError((_) {});
      rethrow;
    }
  }

  Future<String> _createAudioSignedUrl(
    String storagePath, {
    required String bucket,
    required String token,
  }) async {
    DioException? lastError;
    for (var attempt = 0; attempt < 12; attempt++) {
      if (attempt > 0) {
        await Future<void>.delayed(
          Duration(milliseconds: min(2500, 80 * (attempt + 1))),
        );
      }
      try {
        final encodedPath = _encodeStoragePath(storagePath);
        final response = await _supabaseRoot.post<Map<String, dynamic>>(
          '/storage/v1/object/sign/$bucket/$encodedPath',
          data: {'expiresIn': _signedUrlSeconds},
          options: Options(headers: _supabaseJsonHeaders(token)),
        );
        final signedUrl =
            response.data?['signedURL'] ?? response.data?['signedUrl'];
        if (signedUrl is String && signedUrl.isNotEmpty) {
          return _absoluteSupabaseStorageUrl(signedUrl);
        }
      } on DioException catch (error) {
        lastError = error;
      }
    }
    if (lastError != null) {
      throw StateError(
        _dioMessage(lastError, 'Could not create a signed audio URL.'),
      );
    }
    throw StateError('Could not create a signed audio URL.');
  }

  Future<String?> _saveAudioFileRecord({
    required String userId,
    required String name,
    required String storagePath,
    required String mimeType,
    required int sizeBytes,
    required String token,
    required String recordedAt,
    required String source,
  }) async {
    final response = await _supabase.post<List<dynamic>>(
      '/file',
      data: {
        'user_id': userId,
        'name': name,
        'bucket': _audioBucket,
        'storage_path': storagePath,
        'public_url': '',
        'mime_type': mimeType,
        'size_bytes': sizeBytes,
        'source': source,
        'recorded_at': recordedAt,
      },
      queryParameters: {'select': 'id'},
      options: Options(headers: _supabaseInsertHeaders(token)),
    );
    Map? row;
    for (final item in response.data ?? const []) {
      if (item is Map) {
        row = item;
        break;
      }
    }
    final id = row?['id'];
    return id is String && id.isNotEmpty ? id : null;
  }

  Future<void> delete(String id) async {
    final auth = await MobileSupabaseSession().auth();
    await _supabase.delete<void>(
      '/note',
      queryParameters: {'id': 'eq.$id', 'user_id': 'eq.${auth.userId}'},
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
    await _cache.delete(_notesCacheKey(auth.userId));
  }

  Future<void> removeCurrentUserFromSharedNote(String id) async {
    final auth = await MobileSupabaseSession().auth();
    await _supabase.post<void>(
      '/rpc/remove_current_user_from_note_shared_users',
      data: {'p_note_id': id},
      options: Options(headers: _supabaseJsonHeaders(auth.token)),
    );
    await _cache.delete(_notesCacheKey(auth.userId));
  }

  Future<void> rename(String id, String name) async {
    final auth = await MobileSupabaseSession().auth();
    await _supabase.patch<void>(
      '/note',
      data: {'name': name},
      queryParameters: {'id': 'eq.$id', 'user_id': 'eq.${auth.userId}'},
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
    await _cache.delete(_notesCacheKey(auth.userId));
  }

  Future<String?> currentUserId() async => (await MobileSupabaseSession().auth()).userId;

  Future<void> shareNote(String id, List<String> sharedUserIds) async {
    final auth = await MobileSupabaseSession().auth();
    await _supabase.patch<void>(
      '/note',
      data: {'shared_users': sharedUserIds},
      queryParameters: {'id': 'eq.$id', 'user_id': 'eq.${auth.userId}'},
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
    await _cache.delete(_notesCacheKey(auth.userId));
  }

  Future<void> addNoteToProject({
    required String noteId,
    required String projectId,
  }) async {
    final auth = await MobileSupabaseSession().auth();
    await _supabase.post<void>(
      '/rpc/add_accessible_note_to_project',
      data: {
        'p_note_id': noteId,
        'p_project_id': projectId,
      },
      options: Options(headers: _supabaseJsonHeaders(auth.token)),
    );
    await _cache.delete(_notesCacheKey(auth.userId));
  }

  Future<String> regenerateSummary(MeetingNote note) async {
    final microsoftToken = await _storage.read(key: AuthTokenStore.accessTokenKey);
    final auth = await MobileSupabaseSession().auth();
    if (microsoftToken == null || microsoftToken.isEmpty) {
      throw StateError('Sign in with Microsoft before regenerating a summary.');
    }
    if (note.transcript.isEmpty) {
      throw StateError('No diarized transcription found for this note.');
    }
    if (workflowApiUrl.trim().isEmpty) {
      throw StateError('Workflow API URL is not configured.');
    }

    final uniqueSpeakers = note.transcript
        .map((segment) => segment.speaker?.trim() ?? '')
        .where((speaker) => speaker.isNotEmpty)
        .toSet()
        .toList();
    final speakerProfiles = <Map<String, dynamic>>[];
    if (uniqueSpeakers.isNotEmpty) {
      final response = await _supabase.get<List<dynamic>>(
        '/speaker',
        queryParameters: {
          'select': 'name,profile',
          'user_id': 'eq.${auth.userId}',
          'name': 'in.(${uniqueSpeakers.map(_quotedInValue).join(',')})',
        },
        options: Options(headers: _supabaseHeaders(auth.token)),
      );
      for (final row in response.data ?? const []) {
        if (row is! Map) continue;
        final name = _stringValue(row['name']);
        final profile = _stringValue(row['profile']);
        if (name == null || profile == null) continue;
        speakerProfiles.add({
          'speakerName': name,
          'profile': _tryJsonDecode(profile) ?? profile,
        });
      }
    }

    final response = await _workflow.post<Map<String, dynamic>>(
      '/regenerate-summary',
      data: {
        'noteId': note.id,
        'diarization': note.transcript.map((segment) => segment.toJson()).toList(),
        'previousSummary': note.displaySummary,
        'speakerProfiles': speakerProfiles,
        'instructions': '',
      },
      options: Options(headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer $microsoftToken',
      }),
    );
    final summary = _stringValue(response.data?['summary']);
    if (summary == null) throw StateError('No summary returned from webhook.');
    await saveSummaryEdit(note.id, summary);
    return summary;
  }

  Future<List<GeneratedSpeakerProfile>> generateProfilesForNote(
    MeetingNote note,
  ) async {
    final auth = await MobileSupabaseSession().auth();
    if (note.transcript.isEmpty) {
      throw StateError('No diarized transcription found for this note.');
    }
    final uniqueSpeakers = note.transcript
        .map((segment) => segment.speaker?.trim() ?? '')
        .where((speaker) => speaker.isNotEmpty)
        .toSet()
        .toList();
    if (uniqueSpeakers.isEmpty) {
      throw StateError('No speakers found in this note.');
    }

    final existingResponse = await _supabase.get<List<dynamic>>(
      '/speaker',
      queryParameters: {
        'select': 'id,name,profile',
        'user_id': 'eq.${auth.userId}',
        'name': 'in.(${uniqueSpeakers.map(_quotedInValue).join(',')})',
      },
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
    final existing = <String, SavedSpeaker>{};
    for (final row in existingResponse.data ?? const []) {
      if (row is! Map) continue;
      final speaker = SavedSpeaker.fromJson(row.cast<String, dynamic>());
      if (speaker != null) existing[speaker.name.toLowerCase()] = speaker;
    }

    final transcriptText = note.transcript
        .map((segment) => '${segment.speaker ?? 'Speaker'}: ${segment.text}')
        .join('\n\n');
    final profiles = <GeneratedSpeakerProfile>[];
    for (final speakerName in uniqueSpeakers) {
      final record = existing[speakerName.toLowerCase()];
      final profile = await _generateSpeakerProfile(
        speakerName: speakerName,
        speakerId: record?.id ?? '',
        transcriptText: transcriptText,
        existingProfile: record?.profile,
      );
      profiles.add(GeneratedSpeakerProfile(
        speakerId: record?.id,
        speakerName: speakerName,
        profile: profile,
        isNew: record?.profile?.trim().isNotEmpty != true,
      ));
    }
    return profiles;
  }

  Future<void> saveGeneratedSpeakerProfile(
    GeneratedSpeakerProfile profile,
  ) async {
    final auth = await MobileSupabaseSession().auth();
    if (profile.speakerId != null && profile.speakerId!.isNotEmpty) {
      await _supabase.patch<void>(
        '/speaker',
        data: {'profile': profile.profile},
        queryParameters: {
          'id': 'eq.${profile.speakerId}',
          'user_id': 'eq.${auth.userId}',
        },
        options: Options(headers: _supabaseHeaders(auth.token)),
      );
      return;
    }
    await _supabase.post<void>(
      '/speaker',
      data: {
        'user_id': auth.userId,
        'name': profile.speakerName,
        'profile': profile.profile,
      },
      options: Options(headers: _supabaseJsonHeaders(auth.token)),
    );
  }

  Future<String> _generateSpeakerProfile({
    required String speakerName,
    required String speakerId,
    required String transcriptText,
    required String? existingProfile,
  }) async {
    final response = await _supabaseRoot.post<Map<String, dynamic>>(
      '/functions/v1/generate-profile',
      data: {
        'speakerName': speakerName,
        'speakerId': speakerId,
        'transcriptText': transcriptText,
        'existingProfile': existingProfile,
      },
      options: Options(headers: {
        'content-type': 'application/json',
        'apikey': supabaseAnonKey,
        'authorization': 'Bearer $supabaseAnonKey',
      }),
    );
    final error = _stringValue(response.data?['error']);
    if (error != null) throw StateError(error);
    final rawProfile = response.data?['profile'];
    if (rawProfile is String && rawProfile.trim().isNotEmpty) {
      return rawProfile.trim();
    }
    if (rawProfile != null) return jsonEncode(rawProfile);
    throw StateError('No profile returned for $speakerName.');
  }

  Future<void> saveSummaryEdit(String id, String summaryEdit) async {
    final auth = await MobileSupabaseSession().auth();
    await _supabase.patch<void>(
      '/note',
      data: {'summary_edit': summaryEdit},
      queryParameters: {'id': 'eq.$id'},
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
    await _cache.delete(_notesCacheKey(auth.userId));
  }

  Future<List<SavedSpeaker>> savedSpeakers() async {
    final auth = await MobileSupabaseSession().auth();
    final response = await _supabase.get<List<dynamic>>(
      '/speaker',
      queryParameters: {
        'select': 'id,name,profile,email,microsoft_id',
        'order': 'name.asc',
      },
      options: Options(headers: _supabaseHeaders(auth.token)),
    );

    return (response.data ?? const [])
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .map(SavedSpeaker.fromJson)
        .whereType<SavedSpeaker>()
        .toList();
  }

  Future<List<TecAceContact>> tecAceContacts() async {
    final token = await _storage.read(key: AuthTokenStore.accessTokenKey);
    if (token == null || token.isEmpty) {
      throw StateError('Microsoft access token is not available. Sign in again.');
    }

    final graph = Dio(BaseOptions(
      connectTimeout: const Duration(seconds: 20),
      receiveTimeout: const Duration(seconds: 30),
    ));
    var requestUrl =
        'https://graph.microsoft.com/v1.0/users?\$select=id,displayName,mail,userPrincipalName&\$top=999';
    final contacts = <TecAceContact>[];
    while (requestUrl.isNotEmpty) {
      final response = await graph.get<Map<String, dynamic>>(
        requestUrl,
        options: Options(headers: {
          'authorization': 'Bearer $token',
          'accept': 'application/json',
        }),
      );
      for (final item in response.data?['value'] is List
          ? response.data!['value'] as List
          : const []) {
        if (item is! Map) continue;
        final contact = TecAceContact.fromJson(item.cast<String, dynamic>());
        if (contact != null && contact.belongsToTecAce) contacts.add(contact);
      }
      final next = response.data?['@odata.nextLink'];
      requestUrl = next is String ? next : '';
    }
    contacts.sort((a, b) => a.displayName.compareTo(b.displayName));
    return contacts;
  }

  Future<SavedSpeaker> ensureSavedSpeaker({
    required String name,
    String? email,
    String? microsoftId,
  }) async {
    final auth = await MobileSupabaseSession().auth();

    Future<SavedSpeaker?> lookup() async {
      final params = <String, dynamic>{
        'select': 'id,name,profile,email,microsoft_id',
        'user_id': 'eq.${auth.userId}',
        'limit': 1,
      };
      if (microsoftId != null && microsoftId.isNotEmpty) {
        params['microsoft_id'] = 'eq.$microsoftId';
      } else if (email != null && email.isNotEmpty) {
        params['email'] = 'eq.$email';
      } else {
        params['name'] = 'ilike.$name';
      }
      final response = await _supabase.get<List<dynamic>>(
        '/speaker',
        queryParameters: params,
        options: Options(headers: _supabaseHeaders(auth.token)),
      );
      for (final item in response.data ?? const []) {
        if (item is Map) {
          return SavedSpeaker.fromJson(item.cast<String, dynamic>());
        }
      }
      return null;
    }

    final existing = await lookup();
    if (existing != null) return existing;

    try {
      final response = await _supabase.post<List<dynamic>>(
        '/speaker',
        data: {
          'user_id': auth.userId,
          'name': name,
          if (email != null && email.isNotEmpty) 'email': email,
          if (microsoftId != null && microsoftId.isNotEmpty)
            'microsoft_id': microsoftId,
        },
        queryParameters: {'select': 'id,name,profile,email,microsoft_id'},
        options: Options(headers: _supabaseInsertHeaders(auth.token)),
      );
      for (final item in response.data ?? const []) {
        if (item is Map) {
          final speaker = SavedSpeaker.fromJson(item.cast<String, dynamic>());
          if (speaker != null) return speaker;
        }
      }
    } on DioException catch (error) {
      final message = error.response?.data?.toString().toLowerCase() ?? '';
      if (!message.contains('duplicate') && !message.contains('unique')) {
        rethrow;
      }
    }

    final afterInsertRace = await lookup();
    if (afterInsertRace != null) return afterInsertRace;
    throw StateError('Could not create or find speaker "$name".');
  }

  Future<void> saveDiarization(
    String noteId,
    List<TranscriptSegment> segments,
  ) async {
    final auth = await MobileSupabaseSession().auth();

    final response = await _supabase.patch<List<dynamic>>(
      '/note',
      data: {'diarization': segments.map((segment) => segment.toJson()).toList()},
      queryParameters: {
        'id': 'eq.$noteId',
        'select': 'id',
      },
      options: Options(headers: _supabaseInsertHeaders(auth.token)),
    );
    if ((response.data ?? const []).isEmpty) {
      throw StateError(
        'Diarization save did not update the note. You may not have permission to edit this note.',
      );
    }
    await _cache.delete(_notesCacheKey(auth.userId));
  }

  Future<void> shareNoteWithMicrosoftUser(
    String noteId,
    String microsoftId,
    List<String> currentSharedUserIds,
  ) async {
    final auth = await MobileSupabaseSession().auth();
    if (!isSupabaseConfigured ||
        microsoftId.trim().isEmpty ||
        currentSharedUserIds.contains(microsoftId)) {
      return;
    }

    final nextSharedUsers = {...currentSharedUserIds, microsoftId}.toList();
    await _supabase.patch<void>(
      '/note',
      data: {'shared_users': nextSharedUsers},
      queryParameters: {'id': 'eq.$noteId'},
      options: Options(headers: _supabaseHeaders(auth.token)),
    );
    await _cache.delete(_notesCacheKey(auth.userId));
  }

  Future<String> exportToOneDrive(String noteId,
      {String format = 'docx', String content = 'summary'}) async {
    // TODO: POST /notes/{id}/export → webUrl
    await Future.delayed(const Duration(seconds: 1));
    return 'https://onedrive.live.com/...';
  }
}

class WorkflowJobSnapshot {
  const WorkflowJobSnapshot({
    required this.jobId,
    required this.noteId,
    required this.status,
    required this.stage,
    required this.progress,
    this.error,
  });

  final String jobId;
  final String noteId;
  final String status;
  final String stage;
  final int progress;
  final String? error;

  bool get isComplete => status == 'completed';
  bool get isFailed => status == 'failed' || status == 'error';

  factory WorkflowJobSnapshot.fromJson(Map<String, dynamic> json) {
    final status = _stringValue(json['status']) ?? 'queued';
    final stage = _stringValue(json['stage']) ?? status;
    return WorkflowJobSnapshot(
      jobId: _stringValue(json['jobId']) ?? '',
      noteId: _stringValue(json['noteId']) ?? '',
      status: status,
      stage: stage,
      progress: _intValue(json['progress']) ?? 0,
      error: _errorText(json['error']),
    );
  }
}

class SavedSpeaker {
  const SavedSpeaker({
    required this.id,
    required this.name,
    this.profile,
    this.email,
    this.microsoftId,
  });

  final String id;
  final String name;
  final String? profile;
  final String? email;
  final String? microsoftId;

  static SavedSpeaker? fromJson(Map<String, dynamic> json) {
    final id = _stringValue(json['id']);
    final name = _stringValue(json['name']);
    if (id == null || name == null) return null;
    return SavedSpeaker(
      id: id,
      name: name,
      profile: _stringValue(json['profile']),
      email: _stringValue(json['email']),
      microsoftId: _stringValue(json['microsoft_id']),
    );
  }
}

class TecAceContact {
  const TecAceContact({
    required this.id,
    required this.displayName,
    required this.email,
    required this.userPrincipalName,
  });

  final String id;
  final String displayName;
  final String email;
  final String userPrincipalName;

  bool get belongsToTecAce =>
      email.toLowerCase().endsWith('@tecace.com') ||
      userPrincipalName.toLowerCase().endsWith('@tecace.com');

  static TecAceContact? fromJson(Map<String, dynamic> json) {
    final id = _stringValue(json['id']);
    final displayName = _stringValue(json['displayName']);
    final email =
        _stringValue(json['mail']) ?? _stringValue(json['userPrincipalName']);
    final userPrincipalName = _stringValue(json['userPrincipalName']) ?? email;
    if (id == null || displayName == null || email == null) return null;
    return TecAceContact(
      id: id,
      displayName: displayName,
      email: email,
      userPrincipalName: userPrincipalName ?? email,
    );
  }
}

class GeneratedSpeakerProfile {
  const GeneratedSpeakerProfile({
    required this.speakerName,
    required this.profile,
    required this.isNew,
    this.speakerId,
  });

  final String? speakerId;
  final String speakerName;
  final String profile;
  final bool isNew;

  GeneratedSpeakerProfile copyWith({String? profile}) => GeneratedSpeakerProfile(
        speakerId: speakerId,
        speakerName: speakerName,
        profile: profile ?? this.profile,
        isNew: isNew,
      );
}

class _PreparedAudio {
  const _PreparedAudio({
    required this.downloadUrl,
    required this.fileName,
    required this.fileId,
    required this.recordedAt,
  });

  final String downloadUrl;
  final String fileName;
  final String? fileId;
  final String? recordedAt;
}

class _ResolvedPrompt {
  const _ResolvedPrompt({
    required this.promptId,
    this.summaryRulesOverride,
  });

  final String promptId;
  final String? summaryRulesOverride;
}

class _StorageAudioRef {
  const _StorageAudioRef({
    required this.bucket,
    required this.storagePath,
    this.fileId,
    this.name,
    this.recordedAt,
  });

  final String bucket;
  final String storagePath;
  final String? fileId;
  final String? name;
  final String? recordedAt;

  static _StorageAudioRef? tryParse(String value) {
    const prefix = 'storage://';
    if (!value.startsWith(prefix)) return null;
    final uri = Uri.tryParse(value);
    if (uri == null || uri.host.isEmpty || uri.pathSegments.isEmpty) {
      return null;
    }
    return _StorageAudioRef(
      bucket: uri.host,
      storagePath: Uri.decodeComponent(uri.pathSegments.join('/')),
      fileId: uri.queryParameters['fileId'],
      name: uri.queryParameters['name'],
      recordedAt: uri.queryParameters['recordedAt'],
    );
  }
}

enum NoteOwnershipFilter { all, mine, shared }

enum NoteSortKey {
  meetingDesc,
  meetingAsc,
  createdDesc,
  createdAsc,
  titleAsc,
  titleDesc,
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

String _notesCacheKey(String userId) => 'notes_$userId';

Future<String> _localAudioPath(String audioPath, String title) async {
  if (audioPath.startsWith('demo://')) {
    throw StateError(
      'Demo audio cannot be sent to the real workflow. Record audio or choose a local audio file.',
    );
  }
  if (audioPath.startsWith('storage://')) {
    throw StateError(
      'This cloud recording needs a signed URL before it can be reused.',
    );
  }
  if (!audioPath.startsWith('http://') && !audioPath.startsWith('https://')) {
    return audioPath;
  }

  final dir = await getTemporaryDirectory();
  final targetName =
      _fileName(Uri.parse(audioPath).path, fallback: '$title.m4a');
  final target = File('${dir.path}${Platform.pathSeparator}$targetName');
  await Dio().download(audioPath, target.path);
  return target.path;
}

String _fileName(String path, {required String fallback}) {
  final name = path.split(RegExp(r'[\\/]')).last.trim();
  if (name.isEmpty) return _safeFileName(fallback);
  return _safeFileName(name);
}

String _safeFileName(String name) {
  final cleaned = name.replaceAll(RegExp(r'[^A-Za-z0-9._ -]+'), '_').trim();
  return cleaned.isEmpty ? 'meeting-recording.m4a' : cleaned;
}

String _sanitizeStorageFileName(String name) {
  final ascii = name.codeUnits
      .where((codeUnit) => codeUnit <= 0x7f)
      .map((codeUnit) => String.fromCharCode(codeUnit))
      .join();
  final cleaned = ascii
      .replaceAll(RegExp(r'\s+'), '_')
      .replaceAll(RegExp(r'[^a-zA-Z0-9._-]'), '');
  final fallback = 'audio_${DateTime.now().millisecondsSinceEpoch}.m4a';
  final result = cleaned.isEmpty ? fallback : cleaned;
  return result.contains('.') ? result : '$result.m4a';
}

String _encodeStoragePath(String storagePath) {
  return storagePath
      .split('/')
      .map(Uri.encodeComponent)
      .join('/');
}

String _absoluteSupabaseStorageUrl(String signedUrl) {
  if (signedUrl.startsWith('http://') || signedUrl.startsWith('https://')) {
    return signedUrl;
  }

  final base = supabaseUrl.replaceAll(RegExp(r'/$'), '');
  if (signedUrl.startsWith('/storage/v1/')) {
    return '$base$signedUrl';
  }
  if (signedUrl.startsWith('/object/')) {
    return '$base/storage/v1$signedUrl';
  }
  if (signedUrl.startsWith('object/')) {
    return '$base/storage/v1/$signedUrl';
  }
  return '$base$signedUrl';
}

String _audioMimeType(String fileName) {
  final ext = fileName.split('.').last.toLowerCase();
  return switch (ext) {
    'm4a' => 'audio/mp4',
    'mp4' => 'audio/mp4',
    'mp3' => 'audio/mpeg',
    'wav' => 'audio/wav',
    'aac' => 'audio/aac',
    'ogg' => 'audio/ogg',
    'oga' => 'audio/ogg',
    'flac' => 'audio/flac',
    'webm' => 'video/webm',
    _ => 'application/octet-stream',
  };
}

String _attachmentExtension(String fileName, {String fallback = ''}) {
  final ext = fileName.split('.').last.toLowerCase();
  if (ext == fileName.toLowerCase()) return fallback;
  final cleaned = ext.replaceAll(RegExp(r'[^a-z0-9]'), '');
  return cleaned.isEmpty ? fallback : cleaned;
}

String _attachmentMimeType(String fileName) {
  final ext = _attachmentExtension(fileName);
  return switch (ext) {
    'html' || 'htm' => 'text/html',
    'css' => 'text/css',
    'txt' => 'text/plain',
    'xml' => 'text/xml',
    'csv' => 'text/csv',
    'rtf' => 'text/rtf',
    'js' || 'mjs' => 'text/javascript',
    'json' => 'application/json',
    'pdf' => 'application/pdf',
    'jpg' || 'jpeg' => 'image/jpeg',
    'png' => 'image/png',
    'webp' => 'image/webp',
    'bmp' => 'image/bmp',
    'heic' => 'image/heic',
    'heif' => 'image/heif',
    'mp4' => 'video/mp4',
    'mpeg' => 'video/mpeg',
    'mov' => 'video/quicktime',
    'avi' => 'video/avi',
    'flv' => 'video/x-flv',
    'mpg' => 'video/mpg',
    'webm' => 'video/webm',
    'wmv' => 'video/wmv',
    '3gp' => 'video/3gpp',
    'wav' => 'audio/wav',
    'mp3' => 'audio/mp3',
    'aiff' || 'aif' => 'audio/aiff',
    'aac' => 'audio/aac',
    'ogg' => 'audio/ogg',
    'flac' => 'audio/flac',
    _ => 'application/octet-stream',
  };
}

bool _isSupportedAttachmentMimeType(String mimeType) {
  return const {
    'text/html',
    'text/css',
    'text/plain',
    'text/xml',
    'text/csv',
    'text/rtf',
    'text/javascript',
    'application/json',
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/bmp',
    'image/heic',
    'image/heif',
    'video/mp4',
    'video/mpeg',
    'video/quicktime',
    'video/avi',
    'video/x-flv',
    'video/mpg',
    'video/webm',
    'video/wmv',
    'video/3gpp',
    'audio/wav',
    'audio/mp3',
    'audio/mpeg',
    'audio/aiff',
    'audio/aac',
    'audio/ogg',
    'audio/flac',
  }.contains(mimeType);
}

bool _isMpeg4Audio(String fileName) {
  final ext = fileName.split('.').last.toLowerCase();
  return ext == 'm4a' || ext == 'mp4';
}

Future<bool> _hasFinalizedMp4Metadata(File file) async {
  try {
    return await _fileContainsAscii(file, 'moov') &&
        await _fileContainsAscii(file, 'mdat');
  } catch (_) {
    return false;
  }
}

Future<bool> _fileContainsAscii(File file, String value) async {
  final pattern = value.codeUnits;
  var carry = <int>[];
  await for (final chunk in file.openRead()) {
    final bytes = [...carry, ...chunk];
    for (var i = 0; i <= bytes.length - pattern.length; i++) {
      var found = true;
      for (var j = 0; j < pattern.length; j++) {
        if (bytes[i + j] != pattern[j]) {
          found = false;
          break;
        }
      }
      if (found) return true;
    }
    carry = bytes.length <= pattern.length
        ? bytes
        : bytes.sublist(bytes.length - pattern.length + 1);
  }
  return false;
}

String _uuidV4() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20),
  ].join('-');
}

String _preview(String value) {
  final compact = value.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (compact.length <= 96) return compact;
  return '${compact.substring(0, 96)}...';
}

String _dioMessage(DioException error, String fallback) {
  final data = error.response?.data;
  if (data is Map) {
    final message = data['error'] ?? data['message'];
    if (message is String && message.trim().isNotEmpty) return message.trim();
  }
  if (data is String && data.trim().isNotEmpty) return data.trim();
  final message = error.message?.trim();
  if (message != null && message.isNotEmpty) {
    return '$fallback $message';
  }
  return fallback;
}

int? _intValue(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value);
  return null;
}

String? _stringValue(Object? value) {
  final text = value?.toString().trim();
  if (text != null && text.isNotEmpty) return text;
  return null;
}

String? _errorText(Object? value) {
  if (value == null) return null;
  if (value is String) {
    final text = value.trim();
    if (text.isEmpty) return null;
    return text == '[object Object]' ? 'Backend returned an error object.' : text;
  }
  if (value is Map) {
    final parts = <String>[];
    for (final key in const ['message', 'error', 'detail', 'details', 'hint', 'code']) {
      final text = _stringValue(value[key]);
      if (text != null && text != '[object Object]') {
        parts.add('$key: $text');
      }
    }
    if (parts.isNotEmpty) return parts.join('\n');
    try {
      return const JsonEncoder.withIndent('  ').convert(value);
    } catch (_) {
      return value.toString();
    }
  }
  if (value is List) {
    try {
      return const JsonEncoder.withIndent('  ').convert(value);
    } catch (_) {
      return value.toString();
    }
  }
  return value.toString();
}

String _quotedInValue(String value) => '"${value.replaceAll('"', r'\"')}"';

Object? _tryJsonDecode(String value) {
  try {
    return jsonDecode(value);
  } catch (_) {
    return null;
  }
}

String _orderParam(NoteSortKey sort) => switch (sort) {
      NoteSortKey.titleAsc => 'name.asc.nullslast,created_at.desc',
      NoteSortKey.titleDesc => 'name.desc.nullslast,created_at.desc',
      NoteSortKey.createdAsc => 'created_at.asc',
      NoteSortKey.createdDesc => 'created_at.desc',
      NoteSortKey.meetingAsc => 'meeting_at.asc.nullslast,created_at.asc',
      NoteSortKey.meetingDesc => 'meeting_at.desc.nullslast,created_at.desc',
    };

List<MeetingNote> _filter(List<MeetingNote> notes, String? query) {
  final needle = query?.trim().toLowerCase();
  if (needle == null || needle.isEmpty) return [...notes];
  return notes.where((note) {
    final haystack = [
      note.title,
      note.ownerName,
      note.displaySummary,
      note.transcription,
      ...note.tags,
      ...note.transcript.map((segment) => segment.speaker),
    ].whereType<String>().join(' ').toLowerCase();
    return haystack.contains(needle);
  }).toList();
}

int _compareNotes(MeetingNote a, MeetingNote b, NoteSortKey sort) {
  final titleCompare = a.title.toLowerCase().compareTo(b.title.toLowerCase());
  return switch (sort) {
    NoteSortKey.titleAsc => titleCompare,
    NoteSortKey.titleDesc => -titleCompare,
    NoteSortKey.createdAsc => a.createdAt.compareTo(b.createdAt),
    NoteSortKey.createdDesc => b.createdAt.compareTo(a.createdAt),
    NoteSortKey.meetingAsc => a.displayDate.compareTo(b.displayDate),
    NoteSortKey.meetingDesc => b.displayDate.compareTo(a.displayDate),
  };
}
