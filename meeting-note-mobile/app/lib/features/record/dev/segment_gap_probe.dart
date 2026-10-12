import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

/// §3 go/no-go GATE for the C1 segment-splitting design
/// (see repo `C1_M4A_RECOVERY_DESIGN.md`).
///
/// The segment-splitting strategy records audio as a sequence of short m4a
/// files, rotating the recorder (stop current, start next) at each boundary.
/// Each `stop()`/`start()` pair leaves a window where the microphone is not
/// capturing. If that boundary gap is large, 60s rotations would clip speech
/// and ruin transcription quality, so the WHOLE strategy must be abandoned.
///
/// This probe quantifies the average boundary gap on a real device BEFORE any
/// production code is written. It mirrors the production iOS recording config
/// exactly, rotates N short segments, then compares the real captured audio
/// (summed from each finalized segment's mvhd duration) against the wall-clock
/// time spent capturing. The difference is the audio lost to boundaries.
///
/// DEBUG-ONLY. Not referenced by production code. Run it from a debug build,
/// e.g. a temporary button, or `unawaited(SegmentGapProbe.run())` in a debug
/// gate, then read the result in the console. iOS only (Android records OGG and
/// is out of scope); it still runs on Android but the number is not meaningful
/// there.
///
/// PASS criterion: average boundary gap <= 120 ms (see design §3). On a pass,
/// proceed with the segment-splitting implementation; on a fail, hold the
/// design and reconsider the alternatives (fMP4 / PCM stream).
class SegmentGapProbe {
  const SegmentGapProbe._();

  /// Production iOS recording config, mirrored verbatim from
  /// `RecordingNotifier.start()` so the measured gap reflects the real encoder.
  /// Keep in sync if the production config changes.
  static const RecordConfig _iosConfig = RecordConfig(
    encoder: AudioEncoder.aacLc,
    bitRate: 48000,
    sampleRate: 16000,
    numChannels: 1,
  );

  static const Duration _passThreshold = Duration(milliseconds: 120);

  /// Records [segments] segments of [each] duration, rotating the recorder
  /// between them, and reports the average per-boundary audio gap.
  static Future<SegmentGapReport> run({
    int segments = 6,
    Duration each = const Duration(seconds: 2),
  }) async {
    assert(segments >= 2, 'Need at least 2 segments to have a boundary.');
    final recorder = AudioRecorder();
    final report = SegmentGapReport(segments: segments, each: each);
    try {
      if (!await recorder.hasPermission()) {
        report.error = 'Microphone permission was denied.';
        return report;
      }
      final dir = await getTemporaryDirectory();
      final stamp = DateTime.now().millisecondsSinceEpoch;
      final paths = <String>[];

      // Start the first segment and only begin the clock once the engine has
      // actually engaged, so one-time start latency is excluded from the gap.
      final firstPath = '${dir.path}/gapprobe_${stamp}_000.m4a';
      await recorder.start(_iosConfig, path: firstPath);
      await _waitUntilRecording(recorder);
      final sw = Stopwatch()..start();
      paths.add(firstPath);

      for (var i = 0; i < segments; i++) {
        await Future<void>.delayed(each);
        if (i == segments - 1) break; // last segment: no rotation, closed below
        // Rotation boundary: this is exactly the window being measured.
        await recorder.stop();
        final next = '${dir.path}/gapprobe_${stamp}_${(i + 1).toString().padLeft(3, '0')}.m4a';
        await recorder.start(_iosConfig, path: next);
        await _waitUntilRecording(recorder);
        paths.add(next);
      }

      // Stop the clock before the final finalize (final stop is not a boundary).
      final wallClockMs = sw.elapsedMilliseconds;
      await recorder.stop();

      double audioSumSeconds = 0;
      for (final p in paths) {
        final d = await _m4aDurationSeconds(File(p));
        report.segmentDurationsSeconds.add(d);
        if (d != null) audioSumSeconds += d;
      }
      report.wallClockMs = wallClockMs;
      report.audioSumMs = (audioSumSeconds * 1000).round();
      // Boundaries = segments - 1. Total lost audio / boundaries = avg gap.
      final boundaries = segments - 1;
      report.gapTotalMs = (report.wallClockMs - report.audioSumMs);
      report.avgGapMs = boundaries > 0 ? report.gapTotalMs / boundaries : 0;
      report.pass = report.avgGapMs <= _passThreshold.inMilliseconds &&
          !report.segmentDurationsSeconds.contains(null);

      // Clean up the probe files.
      for (final p in paths) {
        final f = File(p);
        if (await f.exists()) {
          await f.delete();
        }
      }
    } catch (e) {
      report.error = '$e';
    } finally {
      await recorder.dispose();
    }

    debugPrint(report.toString());
    return report;
  }

  static Future<void> _waitUntilRecording(AudioRecorder recorder) async {
    for (var i = 0; i < 20; i++) {
      if (await recorder.isRecording()) return;
      await Future<void>.delayed(const Duration(milliseconds: 25));
    }
  }

  /// Reads the movie duration (seconds) from a finalized m4a by parsing
  /// moov -> mvhd. Returns null if the file has no moov (e.g. an unfinalized
  /// recording) or cannot be parsed. Self-contained: no external dependency.
  static Future<double?> _m4aDurationSeconds(File file) async {
    try {
      if (!await file.exists()) return null;
      final bytes = await file.readAsBytes();
      final moov = _findBox(bytes, 0, bytes.length, 'moov');
      if (moov == null) return null;
      final mvhd = _findBox(bytes, moov.payloadStart, moov.end, 'mvhd');
      if (mvhd == null) return null;
      final p = mvhd.payloadStart;
      if (p + 1 > bytes.length) return null;
      final version = bytes[p];
      int timescale;
      int duration;
      if (version == 1) {
        // version(1)+flags(3) + creation(8)+modification(8) + timescale(4) + duration(8)
        final ts = p + 4 + 8 + 8;
        if (ts + 12 > bytes.length) return null;
        timescale = _u32(bytes, ts);
        duration = _u64(bytes, ts + 4);
      } else {
        // version(1)+flags(3) + creation(4)+modification(4) + timescale(4) + duration(4)
        final ts = p + 4 + 4 + 4;
        if (ts + 8 > bytes.length) return null;
        timescale = _u32(bytes, ts);
        duration = _u32(bytes, ts + 4);
      }
      if (timescale == 0) return null;
      return duration / timescale;
    } catch (_) {
      return null;
    }
  }

  /// Finds the first child box of [type] among the siblings in [start, end).
  static _Box? _findBox(Uint8List d, int start, int end, String type) {
    var o = start;
    while (o + 8 <= end) {
      final size = _u32(d, o);
      final t = String.fromCharCodes(d, o + 4, o + 8);
      var headerSize = 8;
      int boxEnd;
      if (size == 1) {
        if (o + 16 > end) break;
        boxEnd = o + _u64(d, o + 8);
        headerSize = 16;
      } else if (size == 0) {
        boxEnd = end;
      } else {
        boxEnd = o + size;
      }
      if (boxEnd <= o || boxEnd > end) break;
      if (t == type) return _Box(o + headerSize, boxEnd);
      o = boxEnd;
    }
    return null;
  }

  static int _u32(Uint8List d, int o) =>
      (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3];

  static int _u64(Uint8List d, int o) {
    var v = 0;
    for (var i = 0; i < 8; i++) {
      v = (v << 8) | d[o + i];
    }
    return v;
  }
}

class _Box {
  const _Box(this.payloadStart, this.end);
  final int payloadStart;
  final int end;
}

/// Result of a [SegmentGapProbe.run]. Read [pass] for the go/no-go verdict and
/// [avgGapMs] for the measured per-boundary gap.
class SegmentGapReport {
  SegmentGapReport({required this.segments, required this.each});

  final int segments;
  final Duration each;
  final List<double?> segmentDurationsSeconds = <double?>[];
  int wallClockMs = 0;
  int audioSumMs = 0;
  int gapTotalMs = 0;
  double avgGapMs = 0;
  bool pass = false;
  String? error;

  @override
  String toString() {
    if (error != null) {
      return '[SegmentGapProbe] ERROR: $error';
    }
    final durs = segmentDurationsSeconds
        .map((d) => d == null ? 'null(no moov)' : '${(d * 1000).round()}ms')
        .join(', ');
    return '[SegmentGapProbe] '
        'segments=$segments each=${each.inMilliseconds}ms '
        'boundaries=${segments - 1}\n'
        '  segmentDurations=[$durs]\n'
        '  wallClock=${wallClockMs}ms audioSum=${audioSumMs}ms '
        'gapTotal=${gapTotalMs}ms\n'
        '  avgGapPerBoundary=${avgGapMs.toStringAsFixed(1)}ms '
        '(threshold ${SegmentGapProbe._passThreshold.inMilliseconds}ms)\n'
        '  VERDICT: ${pass ? 'PASS -> proceed with segment-splitting' : 'FAIL -> hold design, reconsider fMP4/PCM'}';
  }
}
