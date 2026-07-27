import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';

final askRepositoryProvider =
    Provider<AskRepository>((ref) => AskRepository(ref.watch(apiClientProvider)));

class AskSource {
  const AskSource({required this.noteId, required this.title, this.date});

  final String noteId;
  final String title;
  final String? date;

  factory AskSource.fromJson(Map<String, dynamic> json) => AskSource(
        noteId: json['noteId'] as String,
        title: json['title'] as String,
        date: json['date'] as String?,
      );
}

class AskAnswer {
  const AskAnswer({required this.answer, this.sources = const []});

  final String answer;
  final List<AskSource> sources;

  factory AskAnswer.fromJson(Map<String, dynamic> json) => AskAnswer(
        answer: json['answer'] as String,
        sources: (json['sources'] as List<dynamic>? ?? [])
            .map((e) => AskSource.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

/// Cross-meeting Q&A ("Ask"): natural-language questions answered from the
/// user's entire meeting history (RAG over transcripts + summaries).
///
/// INTEGRATION POINT — replace the mock with:
///   POST /ask  {question, projectId?}  →  {answer, sources:[{noteId,title,date}]}
/// See docs/04-api-integration.md §Ask and docs/06-integration-checklist.md.
class AskRepository {
  AskRepository(this._dio);

  final Dio _dio; // ignore: unused_field

  Future<AskAnswer> ask(String question, {String? projectId}) async {
    // TODO(backend): POST /ask — remove mock below.
    // final res = await _dio.post('/ask',
    //     data: {'question': question, if (projectId != null) 'projectId': projectId});
    // return AskAnswer.fromJson(res.data as Map<String, dynamic>);
    await Future.delayed(const Duration(milliseconds: 900));
    return const AskAnswer(
      answer:
          'Internal beta was confirmed for the end of this month. Background-recording '
          'stability was discussed as the top priority.',
      sources: [
        AskSource(noteId: 'n1', title: 'Weekly Product Sync', date: 'Jul 9'),
      ],
    );
  }
}
