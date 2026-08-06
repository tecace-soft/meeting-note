package com.example.meeting_note_mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import java.io.File

class ForegroundRecordingService : Service() {
    private var recorder: MediaRecorder? = null
    private var filePath: String? = null
    private var startedAt: Long = 0L
    private var paused = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startRecording(intent.getStringExtra(EXTRA_PATH) ?: return START_NOT_STICKY)
            ACTION_STOP -> stopRecording()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopRecording()
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        stopRecording()
        super.onTaskRemoved(rootIntent)
    }

    private fun startRecording(path: String) {
        if (recorder != null) return

        instance = this
        filePath = path
        startedAt = System.currentTimeMillis()
        paused = false
        File(path).parentFile?.mkdirs()

        createChannel()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification("Recording in progress"),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification("Recording in progress"))
        }

        // Opus/OGG is the best speech-per-byte codec but needs API 29+ (Android 10);
        // older devices fall back to AAC/m4a. The Dart side gates the file extension
        // on the same SDK level, so the container here always matches the file name.
        // 64 kbps mono / 16 kHz matches the web recorder (~58 MB for a 2-hour
        // meeting, well under the 200 MB cap; the 2-hour auto-stop bounds it).
        val useOpus = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        recorder = newRecorder().apply {
            setAudioSource(MediaRecorder.AudioSource.MIC)
            if (useOpus) {
                setOutputFormat(MediaRecorder.OutputFormat.OGG)
                setAudioEncoder(MediaRecorder.AudioEncoder.OPUS)
            } else {
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            }
            setAudioEncodingBitRate(64000)
            setAudioSamplingRate(16000)
            setAudioChannels(1)
            setOutputFile(path)
            // Hard 2-hour cap enforced natively, so a backgrounded recording
            // still stops even if the Dart-side timer is throttled. Stop off the
            // callback thread to avoid reentrancy on MediaRecorder.stop().
            setMaxDuration(MAX_RECORDING_DURATION_MS)
            setOnInfoListener { _, what, _ ->
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) {
                    android.os.Handler(android.os.Looper.getMainLooper()).post {
                        stopRecording()
                    }
                }
            }
            prepare()
            start()
        }
        saveStatus()
    }

    private fun stopRecording(): String? {
        val path = filePath ?: statusPath(this)
        val activeRecorder = recorder
        recorder = null
        filePath = null
        paused = false
        instance = null

        if (activeRecorder != null) {
            try {
                activeRecorder.stop()
            } catch (_: RuntimeException) {
                if (path != null) File(path).delete()
            } finally {
                activeRecorder.reset()
                activeRecorder.release()
            }
        }
        clearStatus(this)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        return path
    }

    private fun pauseRecording(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        val activeRecorder = recorder ?: return false
        if (!paused) {
            activeRecorder.pause()
            paused = true
            saveStatus()
        }
        return true
    }

    private fun resumeRecording(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        val activeRecorder = recorder ?: return false
        if (paused) {
            activeRecorder.resume()
            paused = false
            saveStatus()
        }
        return true
    }

    private fun notification(text: String): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle("Meeting Note")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(
                PendingIntent.getActivity(
                    this,
                    0,
                    packageManager.getLaunchIntentForPackage(packageName),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
            )
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Meeting recordings",
                NotificationManager.IMPORTANCE_LOW
            )
        )
    }

    private fun saveStatus() {
        prefs(this).edit()
            .putBoolean(KEY_ACTIVE, true)
            .putString(KEY_PATH, filePath)
            .putLong(KEY_STARTED_AT, startedAt)
            .putBoolean(KEY_PAUSED, paused)
            .apply()
    }

    @Suppress("DEPRECATION")
    private fun newRecorder(): MediaRecorder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(this)
        } else {
            MediaRecorder()
        }

    companion object {
        // 2-hour hard cap on a single recording (milliseconds).
        private const val MAX_RECORDING_DURATION_MS = 2 * 60 * 60 * 1000

        private const val ACTION_START = "meeting_note.START_RECORDING"
        private const val ACTION_STOP = "meeting_note.STOP_RECORDING"
        private const val EXTRA_PATH = "path"
        private const val CHANNEL_ID = "meeting_note_recording"
        private const val NOTIFICATION_ID = 9317
        private const val PREFS = "meeting_note_foreground_recording"
        private const val KEY_ACTIVE = "active"
        private const val KEY_PATH = "path"
        private const val KEY_STARTED_AT = "startedAt"
        private const val KEY_PAUSED = "paused"

        private var instance: ForegroundRecordingService? = null

        fun start(context: Context, path: String) {
            val intent = Intent(context, ForegroundRecordingService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_PATH, path)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context): String? =
            instance?.stopRecording() ?: statusPath(context).also { clearStatus(context) }

        fun pause(): Boolean = instance?.pauseRecording() ?: false

        fun resume(): Boolean = instance?.resumeRecording() ?: false

        fun status(context: Context): Map<String, Any?> {
            val prefs = prefs(context)
            val active = prefs.getBoolean(KEY_ACTIVE, false)
            val startedAt = prefs.getLong(KEY_STARTED_AT, 0L)
            return mapOf(
                "active" to active,
                "path" to prefs.getString(KEY_PATH, null),
                "startedAt" to startedAt,
                "elapsedSeconds" to if (active && startedAt > 0L) {
                    ((System.currentTimeMillis() - startedAt) / 1000L).toInt()
                } else 0,
                "paused" to prefs.getBoolean(KEY_PAUSED, false)
            )
        }

        private fun statusPath(context: Context): String? =
            prefs(context).getString(KEY_PATH, null)

        private fun clearStatus(context: Context) {
            prefs(context).edit().clear().apply()
        }

        private fun prefs(context: Context) =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    }
}
