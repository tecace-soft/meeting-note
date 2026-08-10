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
    this.amplitudeHistory = const <double>[],
    this.filePath,
    this.recoverableSession,
    this.loadingRecovery = true,
    this.limitWarning = false,
    this.autoStoppedFilePath,
    this.captureFailed = false,
  });

  final RecordState state;
  final Duration elapsed;
  /// Most recent normalised levels (0..1), oldest first, capped at
  /// [RecordingNotifier.waveformBarCount]. The waveform draws one bar per
  /// entry, so it scrolls right-to-left instead of scaling a fixed shape.
  final List<double> amplitudeHistory;
  final String? filePath;
  final RecoverableRecordingSession? recoverableSession;
  final bool loadingRecovery;

  /// True during the final minutes before the 2-hour cap (non-blocking warning).
  final bool limitWarning;

  /// Set to the saved file path when a recording was auto-stopped at the 2-hour
  /// cap, so the UI can navigate to the new-note flow. Cleared after handling.
  final String? autoStoppedFilePath;

  /// True when the capture watchdog stopped a recording that was producing no
  /// audio. The recording is already discarded; the UI only has to tell the
  /// user. Cleared after handling.
  final bool captureFailed;

  RecordingState copyWith({
    RecordState? state,
    Duration? elapsed,
    List<double>? amplitudeHistory,
    String? filePath,
    RecoverableRecordingSession? recoverableSession,
    bool clearRecoverableSession = false,
    bool? loadingRecovery,
    bool? limitWarning,
    String? autoStoppedFilePath,
    bool clearAutoStopped = false,
    bool? captureFailed,
  }) =>
      RecordingState(
        state: state ?? this.state,
        elapsed: elapsed ?? this.elapsed,
        amplitudeHistory: amplitudeHistory ?? this.amplitudeHistory,
        filePath: filePath ?? this.filePath,
        recoverableSession: clearRecoverableSession
            ? null
            : recoverableSession ?? this.recoverableSession,
        loadingRecovery: loadingRecovery ?? this.loadingRecovery,
        limitWarning: limitWarning ?? this.limitWarning,
        autoStoppedFilePath: clearAutoStopped
            ? null
            : autoStoppedFilePath ?? this.autoStoppedFilePath,
        captureFailed: captureFailed ?? this.captureFailed,
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

/// Why [RecordingNotifier.start] did or did not begin recording.
///
/// The two failures need different fixes from the user, so they are reported
/// separately instead of collapsing into a single `false`.
enum RecordStartResult {
  started,

  /// The OS denied microphone access.
  permissionDenied,

  /// Permission was granted but the audio engine never engaged — typically the
  /// audio session could not be activated (another app holds the microphone,
  /// or an interruption is in progress).
  engineFailed,
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
  // An m4a that only holds its `ftyp` box is 28 bytes. Anything at or below
  // this means the encoder never wrote audio.
  static const _headerOnlyBytes = 64;
  /// Number of bars the waveform draws, and so how many levels to keep.
  static const waveformBarCount = 18;
  /// dBFS window the bars are drawn across. `record` reports averagePower on
  /// iOS, which for meeting speech sits roughly between -45 (room tone) and
  /// -15 (someone talking near the phone). Mapping the full -60..0 range
  /// instead left every bar bunched in the middle with barely visible motion,
  /// so the window is clamped to the part speech actually uses. The floor also
  /// sets how flat the bars go in a quiet room: anything at or below it maps
  /// to zero, so room tone rests at the minimum bar height instead of
  /// hovering.
  static const _amplitudeFloorDb = -45.0;
  static const _amplitudeCeilDb = -15.0;
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

  Future<RecordStartResult> start() async {
    if (!await _recorder.hasPermission()) {
      return RecordStartResult.permissionDenied;
    }
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
      return RecordStartResult.started;
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
        // 16 kHz mono is speech-optimal and keeps a 2-hour meeting well under
        // the 200 MB cap (the 2-hour auto-stop bounds it too).
        //
        // Bitrate is platform-specific on purpose. 64 kbps matches the web
        // recorder and gives AssemblyAI more headroom, but iOS's AAC-LC
        // encoder does not accept 64 kbps at 16 kHz mono: AVAudioRecorder
        // reports isRecording == true, the microphone never engages (no orange
        // indicator, flat waveform) and the file stays at its 28-byte ftyp
        // header until the upload rejects it as empty. 32 kbps at 16 kHz is
        // the configuration that verifiably produces audio on device.
        // Android is unaffected — it records through the native
        // MediaRecorder in ForegroundRecordingService, not this path.
        bitRate: Platform.isIOS ? 48000 : 64000,
        sampleRate: 16000,
        numChannels: 1,
      ),
      path: path,
    );

    // record_ios throws away AVAudioRecorder.record()'s Bool result, so a
    // failed start is still reported as success. What is left behind is a
    // header-only ~28 byte .m4a (prepareToRecord writes the ftyp box; no audio
    // ever follows). Without this check the UI runs its timer for the whole
    // meeting and the loss only surfaces at upload time as "Audio file is
    // empty." Confirm the recorder actually engaged before claiming success.
    // Re-checked once before giving up: a real failure is permanent, so the
    // retry only costs 150ms in the failing case, while making it very unlikely
    // that a slow-to-report engine is mistaken for a broken one and healthy
    // recordings get refused.
    if (!await _recorder.isRecording()) {
      await Future<void>.delayed(const Duration(milliseconds: 150));
      if (!await _recorder.isRecording()) {
        await _recorder.stop();
        await clearRecoverableSession(deleteFile: true);
        state = const RecordingState(loadingRecovery: false);
        return RecordStartResult.engineFailed;
      }
    }

    state = RecordingState(
      state: RecordState.recording,
      filePath: path,
      recoverableSession: session,
      loadingRecovery: false,
    );
    _startTicker();
    // 100ms keeps the bars moving with speech; 200ms read as a slideshow.
    _ampSub = _recorder
        .onAmplitudeChanged(const Duration(milliseconds: 100))
        .listen((a) {
      state = state.copyWith(
        amplitudeHistory: _pushAmplitude(state.amplitudeHistory, a.current),
      );
    });
    unawaited(_watchForCapture(path, sessionId));
    return RecordStartResult.started;
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

  /// Appends one amplitude reading, keeping only the newest
  /// [waveformBarCount] entries.
  ///
  /// `current` is dBFS (0 = full scale, -160 = silence), mapped across
  /// [_amplitudeFloorDb]..[_amplitudeCeilDb] and then shaped by a smootherstep
  /// curve.
  ///
  /// The curve is there for the middle of the range. Straight linear mapping
  /// left the quiet floor and the loud peaks reading well, but everything
  /// between roughly 30% and 80% — which is where normal conversation sits —
  /// rose to a similar height regardless of how loud the speaker actually was.
  /// Smootherstep keeps both endpoints exactly where they are (so the flat
  /// quiet baseline and the full-height peaks are unchanged) while nearly
  /// doubling the slope through the middle, so a louder voice visibly
  /// out-climbs a softer one.
  static List<double> _pushAmplitude(List<double> history, double dbfs) {
    const span = _amplitudeCeilDb - _amplitudeFloorDb;
    final t = ((dbfs - _amplitudeFloorDb) / span).clamp(0.0, 1.0);
    final shaped = t * t * t * (t * (t * 6 - 15) + 10);
    final next = <double>[...history, shaped];
    if (next.length > waveformBarCount) {
      next.removeRange(0, next.length - waveformBarCount);
    }
    return next;
  }

  void clearCaptureFailedFlag() {
    state = state.copyWith(captureFailed: false);
  }

  /// Watches a just-started recording and aborts it if the encoder is producing
  /// nothing.
  ///
  /// A misconfigured encoder (see the bitrate note in [start]) leaves
  /// AVAudioRecorder reporting isRecording == true while the file never grows
  /// past its ~28 byte `ftyp` header — no microphone indicator, flat waveform,
  /// and the loss only surfaces at upload time. Left unchecked that can throw
  /// away a two-hour meeting. Checked off the start path so the UI is not
  /// blocked, and re-checked once before aborting so a slow first flush is not
  /// mistaken for a dead encoder.
  Future<void> _watchForCapture(String path, String sessionId) async {
    Future<bool> hasAudio() async {
      try {
        return await File(path).length() > _headerOnlyBytes;
      } catch (_) {
        return false;
      }
    }

    await Future<void>.delayed(const Duration(seconds: 3));
    if (state.state == RecordState.idle ||
        state.recoverableSession?.id != sessionId) {
      return; // already stopped by the user
    }
    if (await hasAudio()) return;

    await Future<void>.delayed(const Duration(seconds: 3));
    if (state.state == RecordState.idle ||
        state.recoverableSession?.id != sessionId) {
      return;
    }
    if (await hasAudio()) return;

    _ticker?.cancel();
    await _ampSub?.cancel();
    await _recorder.stop();
    await clearRecoverableSession(deleteFile: true);
    state = const RecordingState(loadingRecovery: false, captureFailed: true);
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
