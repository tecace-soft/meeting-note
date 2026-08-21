import 'dart:math';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../../core/network/supabase_config.dart';
import '../../../core/network/workflow_config.dart';
import '../../auth/data/auth_token_store.dart';
import '../../auth/data/mobile_supabase_session.dart';

/// F2: in-app feedback / issue tracker — mobile data + pure-logic layer.
///
/// Ports the web `src/lib/feedbackIssues.ts` domain: the [FeedbackIssue] shape, the
/// deterministic rule-based [IssuesRepository.suggestTriage] auto-classifier, the
/// `FB-YYYYMMDD-<random8>` issue key, list + create over the team-wide `feedback_issues`
/// table, and a best-effort `/issue-notify` email call.
///
/// Mobile scope is LIST + CREATE + READ-ONLY DETAIL: triage / assignment / resolution
/// EDITING stays web-only (admin). The `feedback_issues` RLS is team-wide (any authenticated
/// user may SELECT/INSERT), so there is no owner-scoping on read or insert.

// ---- enums -----------------------------------------------------------------

enum IssuePurpose { bug, feature, question, other }

enum IssueStatus { open, triage, inProgress, done, closed }

enum IssuePriority { p1, p2, p3, p4 }

enum IssueSeverity { low, medium, high, critical }

// ---- option tables (value ↔ DB string, i18n label key, color) --------------

class IssueOption<T> {
  const IssueOption(this.value, this.wire, this.labelKey, this.color);

  final T value;
  final String wire; // the exact string stored in the DB column
  final String labelKey; // i18n key resolved by the UI; empty = show [wire]
  final int color; // 0xAARRGGBB
}

const purposeOptions = <IssueOption<IssuePurpose>>[
  IssueOption(IssuePurpose.bug, 'bug', 'issues.purposeBug', 0xFFDC2626),
  IssueOption(IssuePurpose.feature, 'feature', 'issues.purposeFeature', 0xFF2563EB),
  IssueOption(IssuePurpose.question, 'question', 'issues.purposeQuestion', 0xFF7C3AED),
  IssueOption(IssuePurpose.other, 'other', 'issues.purposeOther', 0xFF6B7280),
];

const statusOptions = <IssueOption<IssueStatus>>[
  IssueOption(IssueStatus.open, 'OPEN', 'issues.statusOpen', 0xFF0EA5E9),
  IssueOption(IssueStatus.triage, 'TRIAGE', 'issues.statusTriage', 0xFFF59E0B),
  IssueOption(IssueStatus.inProgress, 'IN_PROGRESS', 'issues.statusInProgress', 0xFF8B5CF6),
  IssueOption(IssueStatus.done, 'DONE', 'issues.statusDone', 0xFF16A34A),
  IssueOption(IssueStatus.closed, 'CLOSED', 'issues.statusClosed', 0xFF6B7280),
];

const priorityOptions = <IssueOption<IssuePriority>>[
  IssueOption(IssuePriority.p1, 'P1', '', 0xFFDC2626),
  IssueOption(IssuePriority.p2, 'P2', '', 0xFFEA580C),
  IssueOption(IssuePriority.p3, 'P3', '', 0xFFCA8A04),
  IssueOption(IssuePriority.p4, 'P4', '', 0xFF6B7280),
];

const severityOptions = <IssueOption<IssueSeverity>>[
  IssueOption(IssueSeverity.critical, 'Critical', '', 0xFFDC2626),
  IssueOption(IssueSeverity.high, 'High', '', 0xFFEA580C),
  IssueOption(IssueSeverity.medium, 'Medium', '', 0xFFCA8A04),
  IssueOption(IssueSeverity.low, 'Low', '', 0xFF6B7280),
];

/// App screens → issue "area" options (mirrors the web AREA_OPTIONS incl. synonyms).
class AreaOption {
  const AreaOption(this.value, this.labelKey, this.synonyms);

  final String value;
  final String labelKey; // i18n key
  final List<String> synonyms;
}

const areaOptions = <AreaOption>[
  AreaOption('meeting-note', 'issues.areaMeetingNote',
      ['회의', '노트', '녹음', 'meeting', 'note', 'record', '전사', '요약', 'summary']),
  AreaOption('history', 'issues.areaHistory', ['히스토리', '기록', '목록', 'history', '검색', 'search']),
  AreaOption('projects', 'issues.areaProjects', ['프로젝트', 'project']),
  AreaOption('onedrive', 'issues.areaOnedrive',
      ['onedrive', '원드라이브', '저장', 'save', '내보내기', 'export']),
  AreaOption('settings', 'issues.areaSettings', ['설정', '계정', 'settings', 'account', '프로필', 'profile']),
  AreaOption('speaker', 'issues.areaSpeaker', ['화자', 'speaker', '다이어리제이션', 'diariz']),
  AreaOption('general', 'issues.areaGeneral', <String>[]),
];

int purposeColor(IssuePurpose p) =>
    purposeOptions.firstWhere((o) => o.value == p).color;
int statusColor(IssueStatus s) =>
    statusOptions.firstWhere((o) => o.value == s).color;
int priorityColor(IssuePriority p) =>
    priorityOptions.firstWhere((o) => o.value == p).color;
int severityColor(IssueSeverity s) =>
    severityOptions.firstWhere((o) => o.value == s).color;

IssuePurpose purposeFromWire(String? v) => purposeOptions
    .firstWhere((o) => o.wire == v, orElse: () => purposeOptions.last)
    .value;
IssueStatus statusFromWire(String? v) => statusOptions
    .firstWhere((o) => o.wire == v, orElse: () => statusOptions.first)
    .value;
IssuePriority priorityFromWire(String? v) => priorityOptions
    .firstWhere((o) => o.wire == v, orElse: () => priorityOptions[2])
    .value;
IssueSeverity severityFromWire(String? v) => severityOptions
    .firstWhere((o) => o.wire == v, orElse: () => severityOptions[2])
    .value;

String purposeWire(IssuePurpose p) =>
    purposeOptions.firstWhere((o) => o.value == p).wire;
String statusWire(IssueStatus s) =>
    statusOptions.firstWhere((o) => o.value == s).wire;
String priorityWire(IssuePriority p) =>
    priorityOptions.firstWhere((o) => o.value == p).wire;
String severityWire(IssueSeverity s) =>
    severityOptions.firstWhere((o) => o.value == s).wire;

// ---- models ----------------------------------------------------------------

class IssueResolution {
  const IssueResolution({
    required this.summary,
    required this.rootCauses,
    required this.checks,
    required this.fixPlan,
    required this.verification,
    required this.confidence,
  });

  final String summary;
  final List<String> rootCauses;
  final List<String> checks;
  final List<String> fixPlan;
  final List<String> verification;
  final String confidence; // low | medium | high

  static IssueResolution? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final map = raw.cast<String, dynamic>();
    final summary = _str(map['summary']);
    if (summary.isEmpty) return null;
    return IssueResolution(
      summary: summary,
      rootCauses: _strList(map['rootCauses']),
      checks: _strList(map['checks']),
      fixPlan: _strList(map['fixPlan']),
      verification: _strList(map['verification']),
      confidence: _str(map['confidence']),
    );
  }
}

class IssueAttachment {
  const IssueAttachment({required this.name, required this.path, required this.type});

  final String name;
  final String path;
  final String type;

  static IssueAttachment? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final map = raw.cast<String, dynamic>();
    final name = _str(map['name']);
    if (name.isEmpty) return null;
    return IssueAttachment(name: name, path: _str(map['path']), type: _str(map['type']));
  }
}

/// The deterministic auto-triage output. Ports the web `suggestTriage`, but keeps the
/// human-readable reason as STRUCTURED signals so the UI can localize it (the web baked a
/// single Korean string). purpose / area / priority / severity match the web exactly.
class TriageSuggestion {
  const TriageSuggestion({
    required this.purpose,
    required this.area,
    required this.priority,
    required this.severity,
    required this.keywordMatched,
    required this.detectedAreaValue,
    required this.escalated,
  });

  final IssuePurpose purpose;
  final String area;
  final IssuePriority priority;
  final IssueSeverity severity;
  final bool keywordMatched; // a purpose keyword rule matched
  final String? detectedAreaValue; // area value if a synonym matched, else null
  final bool escalated; // urgency expression raised priority/severity

  Map<String, dynamic> toJson() => {
        'purpose': purposeWire(purpose),
        'area': area,
        'priority': priorityWire(priority),
        'severity': severityWire(severity),
      };
}

class FeedbackIssue {
  const FeedbackIssue({
    required this.id,
    required this.issueKey,
    required this.title,
    required this.description,
    required this.purpose,
    required this.area,
    required this.status,
    required this.priority,
    required this.severity,
    required this.assigneeEmail,
    required this.assigneeName,
    required this.triageNote,
    required this.attachments,
    required this.resolution,
    required this.authorEmail,
    required this.authorName,
    required this.triagedAt,
    required this.createdAt,
  });

  final String id;
  final String issueKey;
  final String title;
  final String description;
  final IssuePurpose purpose;
  final String area;
  final IssueStatus status;
  final IssuePriority priority;
  final IssueSeverity severity;
  final String? assigneeEmail;
  final String? assigneeName;
  final String? triageNote;
  final List<IssueAttachment> attachments;
  final IssueResolution? resolution;
  final String authorEmail;
  final String? authorName;
  final String? triagedAt;
  final String createdAt;

  bool get isOpen => status != IssueStatus.done && status != IssueStatus.closed;
  bool get needsTriage => triagedAt == null || triagedAt!.trim().isEmpty;

  static FeedbackIssue? fromJson(Map<String, dynamic> row) {
    final id = _str(row['id']);
    if (id.isEmpty) return null;
    final attachmentsRaw = row['attachments'];
    return FeedbackIssue(
      id: id,
      issueKey: _str(row['issue_key']),
      title: _str(row['title']),
      description: _str(row['description']),
      purpose: purposeFromWire(_strOrNull(row['purpose'])),
      area: _strOrNull(row['area']) ?? 'general',
      status: statusFromWire(_strOrNull(row['status'])),
      priority: priorityFromWire(_strOrNull(row['priority'])),
      severity: severityFromWire(_strOrNull(row['severity'])),
      assigneeEmail: _strOrNull(row['assignee_email']),
      assigneeName: _strOrNull(row['assignee_name']),
      triageNote: _strOrNull(row['triage_note']),
      attachments: attachmentsRaw is List
          ? attachmentsRaw
              .map(IssueAttachment.fromJson)
              .whereType<IssueAttachment>()
              .toList()
          : const [],
      resolution: IssueResolution.fromJson(row['resolution']),
      authorEmail: _str(row['author_email']),
      authorName: _strOrNull(row['author_name']),
      triagedAt: _strOrNull(row['triaged_at']),
      createdAt: _str(row['created_at']),
    );
  }
}

class NewIssueInput {
  const NewIssueInput({
    required this.title,
    required this.description,
    required this.purpose,
    required this.area,
    required this.priority,
    required this.severity,
    required this.aiSuggestion,
    required this.authorEmail,
    required this.authorName,
  });

  final String title;
  final String description;
  final IssuePurpose purpose;
  final String area;
  final IssuePriority priority;
  final IssueSeverity severity;
  final TriageSuggestion aiSuggestion;
  final String authorEmail;
  final String? authorName;
}

// ---- repository ------------------------------------------------------------

final issuesRepositoryProvider =
    Provider<IssuesRepository>((ref) => IssuesRepository());

class IssuesRepository {
  IssuesRepository()
      : _supabase = Dio(
          BaseOptions(
            baseUrl: '${supabaseUrl.replaceAll(RegExp(r'/$'), '')}/rest/v1',
            connectTimeout: const Duration(seconds: 15),
            receiveTimeout: const Duration(seconds: 30),
          ),
        ),
        _workflow = Dio(
          BaseOptions(
            baseUrl: workflowApiUrl.replaceAll(RegExp(r'/$'), ''),
            // 60s connect: the free-tier backend cold-starts (~12-60s) after idle.
            connectTimeout: const Duration(seconds: 60),
            receiveTimeout: const Duration(minutes: 2),
          ),
        ) {
    final session = MobileSupabaseSession();
    _supabase.interceptors.add(session.retryOnUnauthorizedInterceptor());
    _workflow.interceptors
        .add(session.retryOnWorkflowUnauthorizedInterceptor());
  }

  final Dio _supabase;
  final Dio _workflow;
  static const _storage = FlutterSecureStorage();
  static const _table = '/feedback_issues';

  /// Team-wide list, newest first, excluding soft-deleted rows.
  Future<List<FeedbackIssue>> listIssues() async {
    final auth = await MobileSupabaseSession().auth();
    final response = await _supabase.get<List<dynamic>>(
      _table,
      queryParameters: {
        'select': '*',
        'deleted_at': 'is.null',
        'order': 'created_at.desc',
      },
      options: Options(headers: _headers(auth.token)),
    );
    return (response.data ?? const [])
        .whereType<Map>()
        .map((row) => FeedbackIssue.fromJson(row.cast<String, dynamic>()))
        .whereType<FeedbackIssue>()
        .toList();
  }

  /// Creates an OPEN issue with a generated key + attached ai_suggestion, then fires a
  /// best-effort notify. Attachments are not uploaded from mobile v1 (sent as `[]`).
  Future<FeedbackIssue> createIssue(NewIssueInput input) async {
    final auth = await MobileSupabaseSession().auth();
    final payload = <String, dynamic>{
      'issue_key': generateIssueKey(),
      'title': input.title.trim(),
      'description': input.description.trim(),
      'purpose': purposeWire(input.purpose),
      'area': input.area,
      'status': statusWire(IssueStatus.open),
      'priority': priorityWire(input.priority),
      'severity': severityWire(input.severity),
      'attachments': const <dynamic>[],
      'ai_suggestion': input.aiSuggestion.toJson(),
      'author_email': input.authorEmail,
      'author_name': input.authorName,
    };
    final response = await _supabase.post<List<dynamic>>(
      _table,
      data: payload,
      queryParameters: {'select': '*'},
      options: Options(headers: _insertHeaders(auth.token)),
    );
    final rows = (response.data ?? const []).whereType<Map>().toList();
    if (rows.isEmpty) {
      throw StateError('Issue was not created. Please try again.');
    }
    final created =
        FeedbackIssue.fromJson(rows.first.cast<String, dynamic>());
    if (created == null) {
      throw StateError('Issue was created but could not be read back.');
    }
    await _notifyCreated(created); // best-effort; never throws
    return created;
  }

  /// Rule-based auto-triage. Deterministic, no network. Ports the web keyword rules
  /// faithfully so the same title/description yields the same purpose/area/priority/severity.
  TriageSuggestion suggestTriage(String title, String description) {
    final text = '$title\n$description';

    IssuePurpose purpose = IssuePurpose.other;
    IssuePriority priority = IssuePriority.p4;
    IssueSeverity severity = IssueSeverity.low;
    var keywordMatched = false;
    for (final rule in _purposeRules) {
      if (rule.kw.hasMatch(text)) {
        purpose = rule.purpose;
        priority = rule.priority;
        severity = rule.severity;
        keywordMatched = true;
        break;
      }
    }

    final lower = text.toLowerCase();
    String? detectedAreaValue;
    for (final area in areaOptions) {
      if (area.synonyms.any((s) => lower.contains(s.toLowerCase()))) {
        detectedAreaValue = area.value;
        break;
      }
    }
    final area = detectedAreaValue ?? 'general';

    var escalated = false;
    if (_escalateRe.hasMatch(text)) {
      priority = _escalatePriority(priority);
      severity = _escalateSeverity(severity);
      escalated = true;
    }

    return TriageSuggestion(
      purpose: purpose,
      area: area,
      priority: priority,
      severity: severity,
      keywordMatched: keywordMatched,
      detectedAreaValue: detectedAreaValue,
      escalated: escalated,
    );
  }

  /// `FB-YYYYMMDD-<8 uppercase hex>` (4 secure-random bytes), matching the web key format.
  String generateIssueKey([DateTime? now]) {
    final at = now ?? DateTime.now();
    final y = at.year.toString().padLeft(4, '0');
    final m = at.month.toString().padLeft(2, '0');
    final d = at.day.toString().padLeft(2, '0');
    final random = Random.secure();
    final rand = List<int>.generate(4, (_) => random.nextInt(256))
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join()
        .toUpperCase();
    return 'FB-$y$m$d-$rand';
  }

  /// Fire-and-forget email notify (mirrors the web `notifyIssue('created', ...)`). Never
  /// throws: an email failure must never block or undo the issue the user just filed.
  Future<void> _notifyCreated(FeedbackIssue issue) async {
    try {
      if (workflowApiUrl.trim().isEmpty) return;
      final microsoftToken =
          await _storage.read(key: AuthTokenStore.accessTokenKey);
      if (microsoftToken == null || microsoftToken.isEmpty) return;
      await _workflow.post<void>(
        '/issue-notify',
        data: {
          'kind': 'created',
          'issueKey': issue.issueKey,
          'title': issue.title,
          'description': issue.description,
          'purpose': purposeWire(issue.purpose),
          'area': issue.area,
          'priority': priorityWire(issue.priority),
          'assigneeEmail': issue.assigneeEmail,
          'assigneeName': issue.assigneeName,
          'attachmentPaths': const <String>[],
        },
        options: Options(headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer $microsoftToken',
        }),
      );
    } catch (_) {
      // best-effort: email failure must never surface to the user.
    }
  }

  Map<String, String> _headers(String token) => {
        'apikey': supabaseAnonKey,
        'authorization': 'Bearer $token',
        'content-type': 'application/json',
      };

  Map<String, String> _insertHeaders(String token) => {
        'apikey': supabaseAnonKey,
        'authorization': 'Bearer $token',
        'content-type': 'application/json',
        'prefer': 'return=representation',
      };
}

// ---- keyword rules (ported verbatim from the web) --------------------------

class _PurposeRule {
  const _PurposeRule(this.purpose, this.priority, this.severity, this.kw);

  final IssuePurpose purpose;
  final IssuePriority priority;
  final IssueSeverity severity;
  final RegExp kw;
}

final _purposeRules = <_PurposeRule>[
  _PurposeRule(IssuePurpose.bug, IssuePriority.p2, IssueSeverity.high,
      RegExp(r'안\s*됨|안돼|안된|에러|오류|크래시|crash|실패|fail|버그|bug|깨짐|튕김|먹통|안 나와|작동', caseSensitive: false)),
  _PurposeRule(IssuePurpose.feature, IssuePriority.p3, IssueSeverity.medium,
      RegExp(r'추가|개선|요청|주세요|했으면|기능|feature|지원|넣어|만들어', caseSensitive: false)),
  _PurposeRule(IssuePurpose.question, IssuePriority.p4, IssueSeverity.low,
      RegExp(r'\?|인가요|문의|어떻게|가능한가|질문|how|왜', caseSensitive: false)),
];

final _escalateRe =
    RegExp(r'긴급|급함|전혀|아무도|안돼요|urgent|critical|심각|중요', caseSensitive: false);

IssuePriority _escalatePriority(IssuePriority p) {
  const order = [
    IssuePriority.p4,
    IssuePriority.p3,
    IssuePriority.p2,
    IssuePriority.p1,
  ];
  final i = order.indexOf(p);
  return order[min(i + 1, order.length - 1)];
}

IssueSeverity _escalateSeverity(IssueSeverity s) {
  const order = [
    IssueSeverity.low,
    IssueSeverity.medium,
    IssueSeverity.high,
    IssueSeverity.critical,
  ];
  final i = order.indexOf(s);
  return order[min(i + 1, order.length - 1)];
}

// ---- small helpers ---------------------------------------------------------

String _str(Object? v) => v is String ? v : '';

String? _strOrNull(Object? v) => v is String && v.trim().isNotEmpty ? v : null;

List<String> _strList(Object? v) => v is List
    ? v.whereType<String>().where((s) => s.trim().isNotEmpty).toList()
    : const [];
