import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_note_mobile/features/record/data/recent_recordings_repository.dart';

void main() {
  test('recent recordings are ordered by upload time only', () {
    expect(recentRecordingsOrder, 'created_at.desc');
  });

  test('display date is upload time; meeting date stays as secondary info', () {
    final r = RecentRecording(
      id: '1',
      name: 'a.m4a',
      audioPath: '',
      createdAt: DateTime(2026, 10, 15, 9, 0),
      recordedAt: DateTime(2026, 1, 2, 15, 30),
      sizeBytes: 2048,
    );
    expect(r.displayDate, r.createdAt);
    expect(r.detailLabel('Meeting date'), '2.0 KB - Meeting date: 1/2/2026 3:30 PM');
  });
}
