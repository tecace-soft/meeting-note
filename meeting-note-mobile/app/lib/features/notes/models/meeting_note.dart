enum NoteStatus {
  pendingUpload,
  uploading,
  queued,
  transcribing,
  summarizing,
  done,
  failed
}

class TranscriptSegment {
  const TranscriptSegment({
    required this.startMs,
    required this.text,
    this.speaker,
    this.endMs,
  });

  final int startMs;
  final String text;
  final String? speaker;
  final int? endMs;

  TranscriptSegment copyWith({
    int? startMs,
    String? text,
    String? speaker,
    int? endMs,
  }) =>
      TranscriptSegment(
        startMs: startMs ?? this.startMs,
        text: text ?? this.text,
        speaker: speaker ?? this.speaker,
        endMs: endMs ?? this.endMs,
      );

  factory TranscriptSegment.fromJson(Map<String, dynamic> json) =>
      TranscriptSegment(
        startMs: _timestampMs(json) ?? 0,
        text: json['text'] as String,
        speaker: json['speaker'] as String?,
        endMs: _timestampMs(json, end: true),
      );

  String get timestamp {
    return _formatTimestamp(startMs);
  }

  String get timestampRange {
    if (endMs == null || endMs! <= startMs) return timestamp;
    return '$timestamp-${_formatTimestamp(endMs!)}';
  }

  String _formatTimestamp(int milliseconds) {
    final d = Duration(milliseconds: milliseconds);
    final h = d.inHours;
    final m = (d.inMinutes % 60).toString().padLeft(2, '0');
    final s = (d.inSeconds % 60).toString().padLeft(2, '0');
    return h > 0 ? '$h:$m:$s' : '$m:$s';
  }

  Map<String, dynamic> toJson() => {
        'speaker': speaker ?? '',
        'text': text,
        'start': startMs / 1000,
        if (endMs != null) 'end': endMs! / 1000,
      };
}

class MeetingNote {
  const MeetingNote({
    required this.id,
    required this.title,
    required this.createdAt,
    required this.durationSec,
    required this.status,
    this.ownerId,
    this.ownerName,
    this.meetingAt,
    this.summaryMarkdown,
    this.summaryEdit,
    this.transcription,
    this.tags = const [],
    this.projectIds = const [],
    this.sharedUserIds = const [],
    this.transcript = const [],
  });

  final String id;
  final String title;
  final DateTime createdAt;
  final int durationSec;
  final NoteStatus status;
  final String? ownerId;
  final String? ownerName;
  final DateTime? meetingAt;
  final String? summaryMarkdown;
  final String? summaryEdit;
  final String? transcription;
  final List<String> tags;
  final List<String> projectIds;
  final List<String> sharedUserIds;
  final List<TranscriptSegment> transcript;

  factory MeetingNote.fromJson(Map<String, dynamic> json) {
    final createdAt = _parseDate(json['createdAt'] ?? json['created_at']);
    final rawDuration =
        _int(json['durationSec'] ?? json['duration_seconds']) ?? 0;
    final meetingAt = _parseNullableDate(
          json['meetingAt'] ?? json['meeting_at'],
        ) ??
        (rawDuration > 0
            ? createdAt.subtract(Duration(seconds: rawDuration))
            : null);
    final title = _string(json['title']) ?? _string(json['name']) ?? 'Untitled note';
    final summaryTranslations = _stringMap(
      json['summaryTranslations'] ?? json['summary_translations'],
    );
    final summary = _string(json['summaryMarkdown']) ??
        _string(json['summary']) ??
        summaryTranslations['en'] ??
        summaryTranslations['ko'];
    final summaryEdit = _string(json['summary_edit']);
    final transcript = _parseTranscript(json['transcript'] ?? json['diarization']);

    return MeetingNote(
      id: _string(json['id']) ?? '',
      title: title,
      createdAt: createdAt,
      meetingAt: meetingAt,
      durationSec: rawDuration,
      status: NoteStatus.values.firstWhere(
        (s) => s.name == json['status'],
        orElse: () => summary?.trim().isNotEmpty == true || summaryEdit != null
            ? NoteStatus.done
            : NoteStatus.failed,
      ),
      ownerId: _string(json['user_id']),
      ownerName: _string(json['user_name']),
      summaryMarkdown: summary,
      summaryEdit: summaryEdit,
      transcription: _string(json['transcription']),
      tags: _stringList(json['tags'] ?? json['tag']),
      projectIds: _stringList(json['projects']),
      sharedUserIds: _stringList(json['shared_users']),
      transcript: transcript,
    );
  }

  String get durationLabel {
    final m = durationSec ~/ 60;
    final s = durationSec % 60;
    return '${m}m ${s.toString().padLeft(2, '0')}s';
  }

  DateTime get displayDate => (meetingAt ?? createdAt).toLocal();

  String get displaySummary =>
      summaryEdit?.trim().isNotEmpty == true
          ? summaryEdit!.trim()
          : summaryMarkdown?.trim() ?? '';

  bool get hasTranscript =>
      transcript.isNotEmpty || transcription?.trim().isNotEmpty == true;

  MeetingNote copyWith({
    List<TranscriptSegment>? transcript,
    String? summaryEdit,
    List<String>? sharedUserIds,
  }) =>
      MeetingNote(
        id: id,
        title: title,
        createdAt: createdAt,
        durationSec: durationSec,
        status: status,
        ownerId: ownerId,
        ownerName: ownerName,
        meetingAt: meetingAt,
        summaryMarkdown: summaryMarkdown,
        summaryEdit: summaryEdit ?? this.summaryEdit,
        transcription: transcription,
        tags: tags,
        projectIds: projectIds,
        sharedUserIds: sharedUserIds ?? this.sharedUserIds,
        transcript: transcript ?? this.transcript,
      );
}

class SummaryPrompt {
  const SummaryPrompt({required this.id, required this.name, this.description});

  final String id;
  final String name;
  final String? description;
}

DateTime _parseDate(Object? value) =>
    _parseNullableDate(value) ?? DateTime.fromMillisecondsSinceEpoch(0);

DateTime? _parseNullableDate(Object? value) {
  if (value is! String || value.isEmpty) return null;
  return DateTime.tryParse(value)?.toLocal();
}

String? _string(Object? value) {
  if (value is String && value.trim().isNotEmpty) return value.trim();
  return null;
}

int? _int(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value);
  return null;
}

List<String> _stringList(Object? value) {
  if (value is List) {
    return value
        .map((item) => item?.toString().trim() ?? '')
        .where((item) => item.isNotEmpty)
        .toList();
  }
  if (value is String && value.trim().isNotEmpty) {
    return value
        .split(',')
        .map((item) => item.trim())
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
    final text = _string(entry.value);
    if (key != null && key.isNotEmpty && text != null) {
      result[key] = text;
    }
  }
  return result;
}

List<TranscriptSegment> _parseTranscript(Object? value) {
  if (value is! List) return const [];
  return value
      .whereType<Map>()
      .map((item) => item.cast<String, dynamic>())
      .map((json) {
        final text = _string(json['text']) ?? '';
        return TranscriptSegment(
          startMs: _timestampMs(json) ?? 0,
          text: text,
          speaker: _string(json['speaker']),
          endMs: _timestampMs(json, end: true),
        );
      })
      .where((segment) => segment.text.isNotEmpty)
      .toList();
}

int? _timestampMs(Map<String, dynamic> json, {bool end = false}) {
  final camelMs = _numValue(json[end ? 'endMs' : 'startMs']);
  if (camelMs != null) return camelMs.round();

  final snakeMs = _numValue(json[end ? 'end_ms' : 'start_ms']);
  if (snakeMs != null) return snakeMs.round();

  final seconds = _numValue(json[end ? 'end' : 'start']);
  if (seconds == null) return null;

  // Workflow-server stores AssemblyAI utterance timestamps as seconds.
  // Keep a guard for older rows that may already have millisecond-scale values.
  return seconds > 10000 ? seconds.round() : (seconds * 1000).round();
}

num? _numValue(Object? value) {
  if (value is num) return value;
  if (value is String) return num.tryParse(value);
  return null;
}
