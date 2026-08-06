package com.tecace.meeting_note_mobile

import android.os.Build
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.android.FlutterActivity
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "meeting_note_mobile/foreground_recorder"
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    val path = call.argument<String>("path")
                    if (path.isNullOrBlank()) {
                        result.error("missing_path", "Recording path is required.", null)
                    } else {
                        ForegroundRecordingService.start(this, path)
                        result.success(true)
                    }
                }
                "stop" -> result.success(ForegroundRecordingService.stop(this))
                "pause" -> result.success(ForegroundRecordingService.pause())
                "resume" -> result.success(ForegroundRecordingService.resume())
                "status" -> result.success(ForegroundRecordingService.status(this))
                "sdkInt" -> result.success(Build.VERSION.SDK_INT)
                else -> result.notImplemented()
            }
        }
    }
}
