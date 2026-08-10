import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

enum RecordState { idle, recording, paused }

class RecordingState {
  const RecordingState({
    this.state = RecordState.idle,
    this.elapsed = Duration.zero,
    this.amplitude = 0,
    this.filePath,
    this.recoverableSession,
    this.loadingRecovery = true,
    this.limitWarning = false,
    this.autoStoppedFilePath,
  });

  final RecordState state;
  final Duration elapsed;
  final double amplitude; // 0..1 for waveform UI
  final String? filePath;
  final RecoverableRecordingSession? recoverableSession;
  final bool loadingRecovery;

  /// True during the final minutes before the 2-hour cap (non-blocking warning).
  final bool limitWarning;

  /// Set to the saved file path when a recording was auto-stopped at the 2-hour
  /// cap, so the UI can navigate to the new-note flow. Cleared after handling.
  final String? autoStoppedFilePath;

  RecordingState copyWith({
    RecordState? state,
    Duration? elapsed,
    double? amplitude,
    String? filePath,
    RecoverableRecordingSession? recoverableSession,
    bool clearRecoverableSession = false,
    bool? loadingRecovery,
    bool? limitWarning,
    String? autoStoppedFilePath,
    bool clearAutoStopped = false,
  }) =>
      RecordingState(
        state: state ?? this.state,
        elapsed: elapsed ?? this.elapsed,
        amplitude: amplitude ?? this.amplitude,
        filePath: filePath ?? this.filePath,
        recoverableSession: clearRecoverableSession
            ? null
            : recoverableSession ?? this.recoverableSession,
        loadingRecovery: loadingRecovery ?? this.loadingRecovery,
        limitWarning: limitWarning ?? this.limitWarning,
        autoStoppedFilePath: clearAutoStopped
            ? null
            : autoStoppedFilePath ?? this.autoStoppedFilePath,
      );
}

class RecoverableRecordingSession {
  const RecoverableRecordingSession({
    required this.id,
    required this.filePath,
    required this.fileName,
    required this.mimeType,
    required this.startedAt,
    required this.lastHeartbeatAt,
    required this.elapsedSeconds,
    required this.sizeBytes,
  });

  final String id;
  final String filePath;
  final String fileName;
  final String mimeType;
  final DateTime startedAt;
  final DateTime lastHeartbeatAt;
  final int elapsedSeconds;
  final int sizeBytes;

  Duration get elapsed => Duration(seconds: elapsedSeconds);

  RecoverableRecordingSession copyWith({
    DateTime? lastHeartbeatAt,
    int? elapsedSeconds,
    int? sizeBytes,
  }) =>
      RecoverableRecordingSession(
        id: id,
        filePath: filePath,
        fileName: fileName,
        mimeType: mimeType,
        startedAt: startedAt,
        lastHeartbeatAt: lastHeartbeatAt ?? this.lastHeartbeatAt,
        elapsedSeconds: elapsedSeconds ?? this.elapsedSeconds,
        sizeBytes: sizeBytes ?? this.sizeBytes,
      );

  Map<String, Object?> toJson() => {
        'id': id,
        'filePath': filePath,
        'fileName': fileName,
        'mimeType': mimeType,
        'startedAt': startedAt.toIso8601String(),
        'lastHeartbeatAt': lastHeartbeatAt.toIso8601String(),
        'elapsedSeconds': elapsedSeconds,
        'sizeBytes': sizeBytes,
      };

  static RecoverableRecordingSession fromJson(Map<String, Object?> json) =>
      RecoverableRecordingSession(
        id: json['id'] as String,
        filePath: json['filePath'] as String,
        fileName: json['fileName'] as String,
        mimeType: json['mimeType'] as String? ?? 'audio/mp4',
        startedAt: DateTime.parse(json['startedAt'] as String),
        lastHeartbeatAt: DateTime.parse(json['lastHeartbeatAt'] as String),
        elapsedSeconds: json['elapsedSeconds'] as int? ?? 0,
        sizeBytes: json['sizeBytes'] as int? ?? 0,
      );
}

final recordingProvider =
    NotifierProvider<RecordingNotifier, RecordingState>(RecordingNotifier.new);

/// Records AAC to a local file first — upload is a separate step,
/// so audio is never lost on crash or network failure.
class RecordingNotifier extends Notifier<RecordingState> {
  static const _recoveryKey = 'meeting_note_active_recording_session';
  static const _mimeType = 'audio/mp4';
  // Hard cap on a single recording: 2 hours. At the cap the recording auto-stops
  // and is saved; the user starts a new recording to continue. A non-blocking
  // warning is surfaced recordingLimitWarningSeconds before the cap.
  static const maxRecordingSeconds = 2 * 60 * 60;
  static const recordingLimitWarningSeconds = 5 * 60;
  static const _nativeRecorder =
      MethodChannel('meeting_note_mobile/foreground_recorder');

  final _recorder = AudioRecorder();
  final _storage = const FlutterSecureStorage();
  Timer? _ticker;
  // Guards the 2-hour auto-stop so it runs once even if ticks overlap.
  bool _stoppingAtLimit = false;
  StreamSubscription<Amplitude>? _ampSub;

  @override
  RecordingState build() {
    unawaited(_restoreNativeOrRecoverableSession());
    ref.onDispose(() {
      _ticker?.cancel();
      _ampSub?.cancel();
      _recorder.dispose();
    });
    return const RecordingState();
  }

  /// Android API level, used to pick Opus/OGG (29+) vs AAC/m4a for recording.
  /// Fails safe to 0 (→ AAC/m4a) if the platform channel is unavailable.
  Future<int> _androidSdkInt() async {
    try {
      return await _nativeRecorder.invokeMethod<int>('sdkInt') ?? 0;
    } catch (_) {
      return 0;
    }
  }

  Future<bool> start() async {
    if (!await _recorder.hasPermission()) return false;
    _stoppingAtLimit = false;

    final dir = await getApplicationDocumentsDirectory();
    final startedAt = DateTime.now();
    final sessionId = startedAt.millisecondsSinceEpoch.toString();
    if (Platform.isAndroid) {
      // Opus/OGG via MediaRecorder needs API 29+ (Android 10); older devices
      // fall back to AAC/m4a. The native recorder gates on the same SDK level,
      // so this file extension always matches the bytes it writes. The upload
      // content-type is derived from the extension downstream.
      final useOpus = await _androidSdkInt() >= 29;
      final extension = useOpus ? 'ogg' : 'm4a';
      final path = '${dir.path}/rec_$sessionId.$extension';
      final session = RecoverableRecordingSession(
        id: sessionId,
        filePath: path,
        fileName: 'rec_$sessionId.$extension',
        mimeType: useOpus ? 'audio/ogg' : _mimeType,
        startedAt: startedAt,
        lastHeartbeatAt: startedAt,
        elapsedSeconds: 0,
        sizeBytes: 0,
      );
      await _persistRecoverySession(session);
      await _nativeRecorder.invokeMethod<bool>('start', {'path': path});
      state = RecordingState(
        state: RecordState.recording,
        filePath: path,
        recoverableSession: session,
        loadingRecovery: false,
      );
      _startTicker();
      return true;
    }

    // record_ios answers `true` for opus, but it maps opus to kAudioFormatOpus
    // on AVAudioRecorder, which picks the container from the file extension —
    // and CoreAudio has no OGG container. The recorder then writes nothing and
    // leaves a 0-byte .ogg behind, which only surfaces later as "Audio file is
    // empty." at upload time. iOS therefore always takes the AAC/m4a path.
    final useOpus = Platform.isIOS
        ? false
        : await _recorder.isEncoderSupported(AudioEncoder.opus);
    final encoder = useOpus ? AudioEncoder.opus : AudioEncoder.aacLc;
    final extension = useOpus ? 'ogg' : 'm4a';
    final mimeType = useOpus ? 'audio/ogg' : _mimeType;
    final path = '${dir.path}/rec_$sessionId.$extension';
    final session = RecoverableRecordingSession(
      id: sessionId,
      filePath: path,
      fileName: 'rec_$sessionId.$extension',
      mimeType: mimeType,
      startedAt: startedAt,
      lastHeartbeatAt: startedAt,
      elapsedSeconds: 0,
      sizeBytes: 0,
    );

    await _persistRecoverySession(session);

    await _recorder.start(
      RecordConfig(
        encoder: encoder,
        // 64 kbps mono / 16 kHz: speech-optimal, matches the web recorder for
        // consistent fidelity and gives AssemblyAI more headroom (AAC/Safari,
        // noisy rooms). A 2-hour meeting is ~58 MB, well under the 200 MB cap,
        // and the 2-hour auto-stop bounds it. Applies to the AAC path too,
        // which is the only path on iOS (see the encoder note above).
        bitRate: 64000,
        sampleRate: 16000,
        numChannels: 1,
      ),
      path: path,
    );

    state = RecordingState(
      state: RecordState.recording,
      filePath: path,
      recoverableSession: session,
      loadingRecovery: false,
    );
    _startTicker();
    _ampSub = _recorder
        .onAmplitudeChanged(const Duration(milliseconds: 200))
        .listen((a) {
      // dBFS (-45..0) → 0..1
      final level = ((a.current + 45) / 45).clamp(0.0, 1.0);
      state = state.copyWith(amplitude: level);
    });
    return true;
  }

  Future<void> pause() async {
    if (Platform.isAndroid) {
      final ok = await _nativeRecorder.invokeMethod<bool>('pause') ?? false;
      if (!ok) return;
      _ticker?.cancel();
      state = state.copyWith(state: RecordState.paused);
      return;
    }
    await _recorder.pause();
    _ticker?.cancel();
    state = state.copyWith(state: RecordState.paused);
  }

  Future<void> resume() async {
    if (Platform.isAndroid) {
      final ok = await _nativeRecorder.invokeMethod<bool>('resume') ?? false;
      if (!ok) return;
      _startTicker();
      state = state.copyWith(state: RecordState.recording);
      return;
    }
    await _recorder.resume();
    _startTicker();
    state = state.copyWith(state: RecordState.recording);
  }

  /// Stops and returns the recorded file path.
  Future<String?> stop() async {
    _ticker?.cancel();
    await _ampSub?.cancel();
    final path = Platform.isAndroid
        ? await _nativeRecorder.invokeMethod<String>('stop')
        : await _recorder.stop();
    final result = path ?? state.filePath;
    await clearRecoverableSession(deleteFile: false);
    state = const RecordingState(loadingRecovery: false);
    return result;
  }

  Future<String?> recoverRecording() async {
    final session = state.recoverableSession ?? await _readRecoverableSession();
    if (session == null) return null;

    final file = File(session.filePath);
    if (!await file.exists() || await file.length() == 0) {
      await clearRecoverableSession(deleteFile: false);
      return null;
    }
    if (_isMpeg4Recording(session.filePath, session.mimeType) &&
        !await _hasFinalizedMp4Metadata(file)) {
      await clearRecoverableSession(deleteFile: true);
      return null;
    }

    await clearRecoverableSession(deleteFile: false);
    return session.filePath;
  }

  Future<void> discardRecoverableRecording() async {
    await clearRecoverableSession(deleteFile: true);
  }

  Future<void> loadRecoverableSession() async {
    final session = await _readRecoverableSession();
    if (session == null) {
      state = state.copyWith(
        loadingRecovery: false,
        clearRecoverableSession: true,
      );
      return;
    }

    final file = File(session.filePath);
    if (!await file.exists() || await file.length() == 0) {
      await clearRecoverableSession(deleteFile: false);
      return;
    }

    final size = await file.length();
    state = state.copyWith(
      recoverableSession: session.copyWith(sizeBytes: size),
      loadingRecovery: false,
    );
  }

  Future<void> clearRecoverableSession({required bool deleteFile}) async {
    final session = state.recoverableSession ?? await _readRecoverableSession();
    await _storage.delete(key: _recoveryKey);

    if (deleteFile && session != null) {
      final file = File(session.filePath);
      if (await file.exists()) {
        await file.delete();
      }
    }

    state = state.copyWith(
      clearRecoverableSession: true,
      loadingRecovery: false,
    );
  }

  void _startTicker() {
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) async {
      final elapsed = state.elapsed + const Duration(seconds: 1);
      final seconds = elapsed.inSeconds;
      final warn = seconds >= (maxRecordingSeconds - recordingLimitWarningSeconds);
      state = state.copyWith(elapsed: elapsed, limitWarning: warn);

      if (seconds >= maxRecordingSeconds && !_stoppingAtLimit) {
        _stoppingAtLimit = true;
        await _handleAutoStopAtLimit();
        return;
      }

      if (seconds % 2 == 0) {
        await _heartbeatRecoverySession(elapsed);
      }
    });
  }

  /// Auto-stop at the 2-hour cap: finalize/save the recording, then surface the
  /// saved path via [RecordingState.autoStoppedFilePath] so the UI can move the
  /// user into the new-note flow. The user starts a fresh recording to continue.
  Future<void> _handleAutoStopAtLimit() async {
    final path = await stop(); // resets state to idle and returns the saved path
    if (path != null) {
      state = state.copyWith(autoStoppedFilePath: path);
    }
  }

  /// Clears the auto-stop marker once the UI has navigated, so it is not
  /// handled twice.
  void clearAutoStoppedFlag() {
    state = state.copyWith(clearAutoStopped: true);
  }

  Future<void> _heartbeatRecoverySession(Duration elapsed) async {
    final session = state.recoverableSession;
    final path = state.filePath;
    if (session == null || path == null) return;

    final file = File(path);
    final size = await file.exists() ? await file.length() : 0;
    final updated = session.copyWith(
      lastHeartbeatAt: DateTime.now(),
      elapsedSeconds: elapsed.inSeconds,
      sizeBytes: size,
    );
    await _persistRecoverySession(updated);
    state = state.copyWith(recoverableSession: updated);
  }

  Future<void> _persistRecoverySession(
    RecoverableRecordingSession session,
  ) async {
    await _storage.write(
      key: _recoveryKey,
      value: jsonEncode(session.toJson()),
    );
  }

  Future<RecoverableRecordingSession?> _readRecoverableSession() async {
    final raw = await _storage.read(key: _recoveryKey);
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw) as Map<String, dynamic>;
      return RecoverableRecordingSession.fromJson(decoded);
    } catch (_) {
      await _storage.delete(key: _recoveryKey);
      return null;
    }
  }

  Future<void> _restoreNativeOrRecoverableSession() async {
    if (Platform.isAndroid) {
      final status = await _nativeRecorder.invokeMapMethod<String, Object?>(
        'status',
      );
      if (status != null && status['active'] == true) {
        final path = status['path'] as String?;
        final startedAtMs = status['startedAt'] as int? ?? 0;
        if (path != null && path.isNotEmpty) {
          final file = File(path);
          final startedAt = startedAtMs > 0
              ? DateTime.fromMillisecondsSinceEpoch(startedAtMs)
              : DateTime.now();
          final elapsedSeconds = status['elapsedSeconds'] as int? ?? 0;
          final session = RecoverableRecordingSession(
            id: startedAt.millisecondsSinceEpoch.toString(),
            filePath: path,
            fileName: path.split(Platform.pathSeparator).last,
            mimeType: _mimeType,
            startedAt: startedAt,
            lastHeartbeatAt: DateTime.now(),
            elapsedSeconds: elapsedSeconds,
            sizeBytes: await file.exists() ? await file.length() : 0,
          );
          await _persistRecoverySession(session);
          state = RecordingState(
            state: status['paused'] == true
                ? RecordState.paused
                : RecordState.recording,
            elapsed: Duration(seconds: elapsedSeconds),
            filePath: path,
            recoverableSession: session,
            loadingRecovery: false,
          );
          if (state.state == RecordState.recording) _startTicker();
          return;
        }
      }
    }
    await loadRecoverableSession();
  }
}

bool _isMpeg4Recording(String path, String mimeType) {
  final lowerPath = path.toLowerCase();
  final lowerMime = mimeType.toLowerCase();
  return lowerMime.contains('mp4') ||
      lowerPath.endsWith('.m4a') ||
      lowerPath.endsWith('.mp4');
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
