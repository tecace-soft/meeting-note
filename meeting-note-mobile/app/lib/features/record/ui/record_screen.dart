import 'dart:ui';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';

import '../../../shared/widgets/widgets.dart';
import '../../notes/ui/new_note_screen.dart';
import '../data/recent_recordings_repository.dart';
import '../data/recording_service.dart';

class RecordScreen extends ConsumerStatefulWidget {
  const RecordScreen({super.key});

  @override
  ConsumerState<RecordScreen> createState() => _RecordScreenState();
}

class _RecordScreenState extends ConsumerState<RecordScreen> {
  final List<String> _capturedAttachmentPaths = [];

  @override
  Widget build(BuildContext context) {
    final rec = ref.watch(recordingProvider);
    final notifier = ref.read(recordingProvider.notifier);

    // When a recording auto-stops at the 2-hour cap, move the user into the
    // new-note flow with the saved audio and tell them what happened.
    ref.listen<RecordingState>(recordingProvider, (prev, next) {
      final path = next.autoStoppedFilePath;
      if (path == null || prev?.autoStoppedFilePath == path) return;
      notifier.clearAutoStoppedFlag();
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Reached the 2-hour limit. Recording stopped and saved. Start a new recording to continue.',
          ),
        ),
      );
      context.push(
        '/record/new-note',
        extra: NewNoteDraft(
          audioPath: path,
          attachmentPaths: List.of(_capturedAttachmentPaths),
        ),
      );
      _capturedAttachmentPaths.clear();
    });

    final recoverableSession = rec.state == RecordState.idle
        ? rec.recoverableSession
        : null;

    if (rec.state != RecordState.idle) {
      return _ActiveRecordingScreen(
        state: rec.state,
        elapsed: rec.elapsed,
        amplitude: rec.amplitude,
        limitWarning: rec.limitWarning,
        onPauseResume: () => _handleRecordTap(context, notifier, rec.state),
        attachmentCount: _capturedAttachmentPaths.length,
        onCamera: () => _capturePhoto(context),
        onDone: () async {
          final path = await notifier.stop();
          if (path != null && context.mounted) {
            context.push(
              '/record/new-note',
              extra: NewNoteDraft(
                audioPath: path,
                attachmentPaths: List.of(_capturedAttachmentPaths),
              ),
            );
            _capturedAttachmentPaths.clear();
          }
        },
      );
    }

    return Scaffold(
      backgroundColor: FigmaDesign.of(context).pageBackground,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(30, 18, 30, 0),
          child: Column(
            children: [
              const _HomeTopBar(),
              const SizedBox(height: 38),
              _RecordContainer(
                onRecordTap: () => _handleRecordTap(context, notifier, rec.state),
                onUpload: () => _showUploadOptions(context),
                onRecent: () => _showRecentRecordings(context),
              ),
              const SizedBox(height: 22),
              Text(
                'Keeps recording in the background - Auto-recovery',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w400,
                  color: FigmaDesign.of(context).textMuted,
                  letterSpacing: 0,
                ),
              ),
              const SizedBox(height: 16),
              if (recoverableSession != null)
                _RecoverableRecordingCard(
                  session: recoverableSession,
                  onRecover: () async {
                    final path = await notifier.recoverRecording();
                    if (!context.mounted) return;
                    if (path == null) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(
                          content: Text(
                            'This interrupted recording could not be finalized. Please record again.',
                          ),
                        ),
                      );
                      return;
                    }
                    context.push('/record/new-note', extra: path);
                  },
                  onDiscard: () async {
                    await notifier.discardRecoverableRecording();
                    if (!context.mounted) return;
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Recovered recording discarded.')),
                    );
                  },
                ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _handleRecordTap(
    BuildContext context,
    RecordingNotifier notifier,
    RecordState state,
  ) async {
    if (state == RecordState.idle) {
      _capturedAttachmentPaths.clear();
      final ok = await notifier.start();
      if (!ok && context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Microphone permission is required. Enable it in Settings.'),
          ),
        );
      }
      return;
    }

    if (state == RecordState.recording) {
      await notifier.pause();
      return;
    }

    await notifier.resume();
  }

  Future<void> _capturePhoto(BuildContext context) async {
    try {
      final image = await ImagePicker().pickImage(source: ImageSource.camera);
      if (image == null) return;
      if (!mounted) return;
      setState(() => _capturedAttachmentPaths.add(image.path));
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Photo attached to this recording.')),
      );
    } catch (error) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not open camera: $error')),
      );
    }
  }

  Future<void> _showUploadOptions(BuildContext context) async {
    final selected = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                leading: const Icon(Icons.upload_file_rounded),
                title: const Text('Choose audio file'),
                subtitle: const Text('Pick an audio file from this device'),
                onTap: () => Navigator.pop(context, 'pick'),
              ),
              ListTile(
                leading: const Icon(Icons.edit_rounded),
                title: const Text('Enter local file path'),
                subtitle: const Text('Useful for emulator testing'),
                onTap: () => Navigator.pop(context, 'manual'),
              ),
            ],
          ),
        ),
      ),
    );

    if (!context.mounted || selected == null) return;
    if (selected == 'pick') {
      final path = await _pickAudioFile(context);
      if (path != null && context.mounted) {
        context.push('/record/new-note', extra: path);
      }
      return;
    }
    if (selected == 'manual') {
      final path = await _showManualPathDialog(context);
      if (path != null && context.mounted) {
        context.push('/record/new-note', extra: path);
      }
    }
  }

  Future<String?> _pickAudioFile(BuildContext context) async {
    try {
      final result = await FilePicker.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['m4a', 'mp3', 'wav', 'aac', 'ogg', 'flac', 'mp4', 'webm'],
      );
      return result?.files.single.path;
    } catch (error) {
      if (!context.mounted) return null;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not choose audio: $error')),
      );
      return null;
    }
  }

  Future<String?> _showManualPathDialog(BuildContext context) {
    final controller = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Audio file path'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: '/sdcard/Download/meeting.m4a'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              final path = controller.text.trim();
              Navigator.pop(context, path.isEmpty ? null : path);
            },
            child: const Text('Continue'),
          ),
        ],
      ),
    ).whenComplete(controller.dispose);
  }

  Future<void> _showRecentRecordings(BuildContext context) async {
    final repository = RecentRecordingsRepository();
    final selected = await showModalBottomSheet<RecentRecording>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (context) => _RecentRecordingsSheet(repository: repository),
    );
    if (!context.mounted || selected == null) return;

    try {
      final audioPath = await repository.resolveAudioPath(selected);
      if (context.mounted) {
        context.push('/record/new-note', extra: audioPath);
      }
    } catch (error) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Failed to load recent recording: $error')),
      );
    }
  }
}

class _HomeTopBar extends ConsumerWidget {
  const _HomeTopBar();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final palette = FigmaDesign.of(context);
    return Row(
      children: [
        const SizedBox(width: 30),
        const Spacer(),
        RichText(
          text: TextSpan(
            style: TextStyle(
              fontSize: 16,
              height: 1,
              fontWeight: FontWeight.w600,
              color: palette.text,
              letterSpacing: -0.1,
            ),
            children: [
              const TextSpan(text: 'Meeting '),
              TextSpan(
                text: 'Note',
                style: TextStyle(color: FigmaDesign.activeBlue),
              ),
            ],
          ),
        ),
        const Spacer(),
        const SizedBox(width: 30),
      ],
    );
  }
}

class _ActiveRecordingScreen extends StatelessWidget {
  const _ActiveRecordingScreen({
    required this.state,
    required this.elapsed,
    required this.amplitude,
    required this.limitWarning,
    required this.onPauseResume,
    required this.onCamera,
    required this.onDone,
    required this.attachmentCount,
  });

  final RecordState state;
  final Duration elapsed;
  final double amplitude;
  final bool limitWarning;
  final VoidCallback onPauseResume;
  final VoidCallback onCamera;
  final VoidCallback onDone;
  final int attachmentCount;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Scaffold(
      backgroundColor: palette.pageBackground,
      body: SafeArea(
        bottom: false,
        child: Stack(
          children: [
            Positioned.fill(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  gradient: RadialGradient(
                    center: Alignment(0, -0.08),
                    radius: 0.72,
                    colors: dark
                        ? const [
                            Color(0xFF17345D),
                            Color(0xFF1A2B4D),
                            Color(0xFF263047),
                            Color(0xFF101827),
                          ]
                        : const [
                            Color(0xFFA9D2FF),
                            Color(0xFFD7D8FF),
                            Color(0xFFDDF7F6),
                            Color(0xFFF9FAFD),
                          ],
                    stops: [0, 0.48, 0.78, 1],
                  ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(28, 57, 28, 24),
              child: Column(
                children: [
                  Text(
                    'Recording',
                    style: TextStyle(
                      fontSize: 16,
                      height: 1,
                      fontWeight: FontWeight.w500,
                      color: palette.text,
                      letterSpacing: 0,
                    ),
                  ),
                  const SizedBox(height: 18),
                  Align(
                    alignment: Alignment.center,
                    child: Container(
                      height: 27,
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                      decoration: BoxDecoration(
                        color: dark ? const Color(0xFF17345D) : const Color(0xFFE8F2FF),
                        borderRadius: BorderRadius.circular(99),
                      ),
                      child: const Center(
                        widthFactor: 1,
                        child: Text(
                          'Background active',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w400,
                            color: Color(0xFF2F80FF),
                          ),
                        ),
                      ),
                    ),
                  ),
                  const Spacer(flex: 9),
                  _RecordingTimer(elapsed: elapsed),
                  const SizedBox(height: 10),
                  Text(
                    'Weekly Product Sync',
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                      color: palette.textSecondary,
                    ),
                  ),
                  if (limitWarning) ...[
                    const SizedBox(height: 14),
                    Container(
                      padding:
                          const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                      decoration: BoxDecoration(
                        color: const Color(0x1AE5484D),
                        borderRadius: BorderRadius.circular(99),
                      ),
                      child: const Text(
                        'Approaching the 2-hour limit. Recording will stop soon.',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w500,
                          color: Color(0xFFE5484D),
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: 52),
                  _WaveformBars(
                    level: amplitude,
                    active: state == RecordState.recording,
                  ),
                  const Spacer(flex: 7),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      _SecondaryActionButton(
                        label: state == RecordState.paused ? 'Resume' : 'Pause',
                        onTap: onPauseResume,
                      ),
                      const SizedBox(width: 16),
                      _IconActionButton(
                        icon: Icons.camera_alt_outlined,
                        badgeText: attachmentCount > 0 ? '$attachmentCount' : null,
                        onTap: onCamera,
                      ),
                      const SizedBox(width: 16),
                      _GradientActionButton(
                        label: 'Done',
                        onTap: onDone,
                      ),
                    ],
                  ),
                  const SizedBox(height: 38),
                  const Text(
                    'Saved locally even if interrupted',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w300,
                      color: Color(0xFFB7C0CD),
                    ),
                  ),
                  const Spacer(flex: 4),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _RecordContainer extends StatelessWidget {
  const _RecordContainer({
    required this.onRecordTap,
    required this.onUpload,
    required this.onRecent,
  });

  final VoidCallback onRecordTap;
  final VoidCallback onUpload;
  final VoidCallback onRecent;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return SizedBox(
      height: 480,
      width: double.infinity,
      child: Container(
        decoration: BoxDecoration(
          color: palette.card,
          borderRadius: BorderRadius.circular(27),
          boxShadow: [
            BoxShadow(
              color: palette.cardShadow,
              blurRadius: 3,
              offset: const Offset(0, 1),
            ),
            BoxShadow(
              color: palette.cardShadow,
              blurRadius: 38,
              offset: const Offset(0, 24),
            ),
          ],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(27),
          child: Stack(
            children: [
              Positioned.fill(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: RadialGradient(
                      center: Alignment(0, -0.08),
                      radius: 0.78,
                      colors: isDark
                          ? const [
                              Color(0xFF173A65),
                              Color(0xFF302E68),
                              Color(0xFF173342),
                              Color(0xFF121C2F),
                            ]
                          : const [
                              Color(0xFFCDE6FF),
                              Color(0xFFD9D5FF),
                              Color(0xFFE8F8FA),
                              Color(0xFFFFFFFF),
                            ],
                      stops: [0.0, 0.43, 0.68, 1.0],
                    ),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 32, 24, 32),
                child: Column(
                  children: [
                    const Spacer(flex: 12),
                    Column(
                      children: [
                        Text(
                          'Record your meeting',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 21,
                            height: 1.05,
                            fontWeight: FontWeight.w500,
                            color: palette.text,
                            letterSpacing: 0,
                          ),
                        ),
                        const SizedBox(height: 10),
                        Text(
                          'AI transcribes and summarizes for you',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w300,
                            color: palette.textMuted,
                            letterSpacing: 0,
                          ),
                        ),
                      ],
                    ),
                    const Spacer(flex: 13),
                    TextButton(
                      onPressed: onRecordTap,
                      style: TextButton.styleFrom(
                        foregroundColor: const Color(0xFF2F80FF),
                        textStyle: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      child: const Text('Tap to record'),
                    ),
                    const SizedBox(height: 13),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        _PillButton(label: 'Record', selected: true, onTap: onRecordTap),
                        const SizedBox(width: 10),
                        _PillButton(label: 'Upload', onTap: onUpload),
                        const SizedBox(width: 10),
                        _PillButton(label: 'Recent', onTap: onRecent),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PillButton extends StatelessWidget {
  const _PillButton({
    required this.label,
    required this.onTap,
    this.selected = false,
  });

  final String label;
  final VoidCallback onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Material(
      color: selected
          ? (dark ? const Color(0xFF17345D) : const Color(0xFFE8F2FF))
          : (dark ? palette.field : const Color(0xFFF3F5F9)),
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: SizedBox(
          height: 37,
          width: 75,
          child: Center(
            child: Text(
              label,
              style: TextStyle(
                fontSize: 13,
                fontWeight: selected ? FontWeight.w500 : FontWeight.w400,
                color: selected ? const Color(0xFF2F80FF) : palette.text,
                letterSpacing: 0,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _GradientActionButton extends StatelessWidget {
  const _GradientActionButton({
    required this.label,
    required this.onTap,
  });

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        width: 108,
        height: 50,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(24),
          gradient: const LinearGradient(
            colors: [Color(0xFF4D9FFF), Color(0xFF2F80ED)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
          ),
          boxShadow: const [
            BoxShadow(
              color: Color(0x332F80ED),
              blurRadius: 22,
              offset: Offset(0, 12),
            ),
          ],
        ),
        child: Center(
          child: Text(
            label,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 14,
              fontWeight: FontWeight.w500,
              letterSpacing: 0,
            ),
          ),
        ),
      ),
    );
  }
}

class _IconActionButton extends StatelessWidget {
  const _IconActionButton({
    required this.icon,
    required this.onTap,
    this.badgeText,
  });

  final IconData icon;
  final VoidCallback onTap;
  final String? badgeText;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Container(
            width: 50,
            height: 50,
            decoration: BoxDecoration(
              color: palette.card,
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(
                  color: palette.cardShadow,
                  blurRadius: 22,
                  offset: const Offset(0, 12),
                ),
              ],
            ),
            child: Icon(
              icon,
              color: Color(0xFF2F80FF),
              size: 22,
            ),
          ),
          if (badgeText != null)
            Positioned(
              top: -2,
              right: -2,
              child: Container(
                constraints: const BoxConstraints(minWidth: 17, minHeight: 17),
                padding: const EdgeInsets.symmetric(horizontal: 4),
                decoration: const BoxDecoration(
                  color: Color(0xFF2F80FF),
                  shape: BoxShape.circle,
                ),
                child: Center(
                  child: Text(
                    badgeText!,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 10,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _SecondaryActionButton extends StatelessWidget {
  const _SecondaryActionButton({
    required this.label,
    required this.onTap,
  });

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Material(
      color: palette.card,
      borderRadius: BorderRadius.circular(24),
      child: InkWell(
        borderRadius: BorderRadius.circular(24),
        onTap: onTap,
        child: Container(
          width: 108,
          height: 50,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(24),
            boxShadow: [
              BoxShadow(
                color: palette.cardShadow,
                blurRadius: 20,
                offset: const Offset(0, 10),
              ),
            ],
          ),
          child: Center(
            child: Text(
              label,
              style: const TextStyle(
                color: Color(0xFF2F80ED),
                fontSize: 14,
                fontWeight: FontWeight.w500,
                letterSpacing: 0,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RecoverableRecordingCard extends StatelessWidget {
  const _RecoverableRecordingCard({
    required this.session,
    required this.onRecover,
    required this.onDiscard,
  });

  final RecoverableRecordingSession session;
  final VoidCallback onRecover;
  final VoidCallback onDiscard;

  @override
  Widget build(BuildContext context) {
    final started = _formatStarted(session.startedAt);
    final duration = _formatDuration(session.elapsed);
    final palette = FigmaDesign.of(context);

    return Material(
      color: palette.card,
      borderRadius: BorderRadius.circular(15),
      child: Container(
        constraints: const BoxConstraints(minHeight: 70),
        padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(15),
          boxShadow: [
            BoxShadow(
              color: palette.cardShadow,
              blurRadius: 18,
              offset: const Offset(0, 8),
            ),
          ],
        ),
        child: Row(
          children: [
            _DurationBadge(label: _badgeLabel(session.elapsed)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Recover interrupted recording',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                      color: palette.text,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '$started - $duration saved',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w300,
                      color: palette.textMuted,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 6),
            TextButton(
              onPressed: onDiscard,
              style: TextButton.styleFrom(
                foregroundColor: palette.textMuted,
                textStyle: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w400,
                ),
              ),
              child: const Text('Discard'),
            ),
            TextButton(
              onPressed: onRecover,
              style: TextButton.styleFrom(
                foregroundColor: const Color(0xFF2F80FF),
                textStyle: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                ),
              ),
              child: const Text('Use'),
            ),
          ],
        ),
      ),
    );
  }

  String _formatStarted(DateTime startedAt) {
    final now = DateTime.now();
    final sameDay = now.year == startedAt.year &&
        now.month == startedAt.month &&
        now.day == startedAt.day;
    return sameDay
        ? DateFormat("'Today' h:mm").format(startedAt)
        : DateFormat('MMM d h:mm').format(startedAt);
  }

  String _badgeLabel(Duration duration) {
    final minutes = duration.inMinutes;
    if (minutes < 1) return '<1m';
    if (minutes < 100) return '${minutes}m';
    return '${duration.inHours}h';
  }

  String _formatDuration(Duration duration) {
    final minutes = duration.inMinutes;
    if (minutes < 1) return 'less than 1 min';
    if (minutes == 1) return '1 min';
    if (minutes < 60) return '$minutes min';
    final hours = duration.inHours;
    final remainder = minutes % 60;
    return remainder == 0 ? '$hours hr' : '$hours hr $remainder min';
  }
}

class _DurationBadge extends StatelessWidget {
  const _DurationBadge({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      width: 33,
      height: 33,
      decoration: BoxDecoration(
        color: dark ? const Color(0xFF17345D) : const Color(0xFFE8F2FF),
        shape: BoxShape.circle,
      ),
      child: Center(
        child: Text(
          label,
          style: const TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.w500,
            color: Color(0xFF2F80FF),
          ),
        ),
      ),
    );
  }
}

class _Timer extends StatelessWidget {
  const _Timer({required this.elapsed});

  final Duration elapsed;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final h = elapsed.inHours;
    final m = (elapsed.inMinutes % 60).toString().padLeft(2, '0');
    final s = (elapsed.inSeconds % 60).toString().padLeft(2, '0');
    return Text(
      h > 0 ? '$h:$m:$s' : '$m:$s',
      style: TextStyle(
        fontSize: 44,
        fontWeight: FontWeight.w300,
        color: palette.text,
        fontFeatures: [FontFeature.tabularFigures()],
      ),
    );
  }
}

class _RecordingTimer extends StatelessWidget {
  const _RecordingTimer({required this.elapsed});

  final Duration elapsed;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final h = elapsed.inHours;
    final m = (elapsed.inMinutes % 60).toString().padLeft(2, '0');
    final s = (elapsed.inSeconds % 60).toString().padLeft(2, '0');
    return Text(
      h > 0 ? '$h:$m:$s' : '$m:$s',
      style: TextStyle(
        fontSize: 64,
        height: 0.95,
        fontWeight: FontWeight.w100,
        color: palette.text,
        letterSpacing: 0,
        fontFeatures: [FontFeature.tabularFigures()],
      ),
    );
  }
}

class _WaveformBars extends StatelessWidget {
  const _WaveformBars({required this.level, required this.active});

  final double level;
  final bool active;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 48,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: List.generate(18, (i) {
          final t = (i % 5 + 1) / 5;
          final h = active ? (10 + 34 * level * t) : 12.0;
          return AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            margin: const EdgeInsets.symmetric(horizontal: 2.5),
            width: 4,
            height: h,
            decoration: BoxDecoration(
              color: const Color(0xFF3A8BFF),
              borderRadius: BorderRadius.circular(2),
            ),
          );
        }),
      ),
    );
  }
}

class _RecentRecordingsSheet extends StatefulWidget {
  const _RecentRecordingsSheet({required this.repository});

  final RecentRecordingsRepository repository;

  @override
  State<_RecentRecordingsSheet> createState() => _RecentRecordingsSheetState();
}

class _RecentRecordingsSheetState extends State<_RecentRecordingsSheet> {
  late Future<List<RecentRecording>> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<List<RecentRecording>> _load({bool preferCache = true}) async {
    if (preferCache) {
      final cached = await widget.repository.cachedList();
      if (cached != null) {
        _refreshFromNetwork();
        return cached;
      }
    }
    return widget.repository.refreshList();
  }

  void _refresh() {
    setState(() => _future = _load(preferCache: false));
  }

  Future<void> _refreshFromNetwork() async {
    try {
      final recordings = await widget.repository.refreshList();
      if (!mounted) return;
      setState(() => _future = Future.value(recordings));
    } catch (_) {
      // Keep showing cached recordings.
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final palette = FigmaDesign.of(context);

    return SafeArea(
      child: DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.62,
        minChildSize: 0.32,
        maxChildSize: 0.88,
        builder: (context, scrollController) => Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      'Recent recordings',
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w500,
                        color: palette.text,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Refresh',
                    onPressed: _refresh,
                    icon: const Icon(Icons.refresh_rounded),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              Expanded(
                child: FutureBuilder<List<RecentRecording>>(
                  future: _future,
                  builder: (context, snapshot) {
                    if (snapshot.connectionState == ConnectionState.waiting) {
                      return const Center(child: CircularProgressIndicator());
                    }
                    if (snapshot.hasError) {
                      return Center(
                        child: Text(
                          'Failed to load recent recordings: ${snapshot.error}',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: scheme.error),
                        ),
                      );
                    }
                    final recordings = snapshot.data ?? const [];
                    if (recordings.isEmpty) {
                      return Center(
                        child: Text(
                          'No recent recordings yet.',
                          style: TextStyle(color: scheme.onSurfaceVariant),
                        ),
                      );
                    }
                    return ListView.separated(
                      controller: scrollController,
                      itemCount: recordings.length,
                      separatorBuilder: (_, __) => const SizedBox(height: 10),
                      itemBuilder: (context, index) {
                        final recording = recordings[index];
                        return _RecentRecordingTile(
                          recording: recording,
                          onTap: () => Navigator.pop(context, recording),
                          onDelete: () async {
                            try {
                              await widget.repository.delete(recording);
                              _refresh();
                            } catch (error) {
                              if (!context.mounted) return;
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(
                                  content: Text(
                                    'Failed to delete recent recording: $error',
                                  ),
                                ),
                              );
                            }
                          },
                        );
                      },
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _RecentRecordingTile extends StatelessWidget {
  const _RecentRecordingTile({
    required this.recording,
    required this.onTap,
    required this.onDelete,
  });

  final RecentRecording recording;
  final VoidCallback onTap;
  final Future<void> Function() onDelete;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final palette = FigmaDesign.of(context);
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: Container(
          decoration: BoxDecoration(
            color: palette.card,
            borderRadius: BorderRadius.circular(18),
            boxShadow: [
              BoxShadow(
                color: palette.cardShadow,
                blurRadius: 14,
                offset: const Offset(0, 7),
              ),
            ],
          ),
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: scheme.primary.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(Icons.graphic_eq_rounded, color: scheme.primary),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      recording.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontWeight: FontWeight.w500,
                        color: palette.text,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      '${DateFormat('MMM d, h:mm a').format(recording.displayDate)} - ${recording.detailLabel}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12, color: palette.textMuted),
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'Remove',
                onPressed: onDelete,
                icon: Icon(Icons.close_rounded, color: palette.textMuted),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
