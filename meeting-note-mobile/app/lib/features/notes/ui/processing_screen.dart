import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/network/workflow_config.dart';
import '../../../shared/widgets/widgets.dart';
import '../data/notes_repository.dart';

class ProcessingScreen extends ConsumerStatefulWidget {
  const ProcessingScreen({super.key, required this.jobId, this.pendingJob});

  final String jobId;
  final PendingProcessingJob? pendingJob;

  @override
  ConsumerState<ProcessingScreen> createState() => _ProcessingScreenState();
}

class _ProcessingScreenState extends ConsumerState<ProcessingScreen> {
  static const _steps = [
    'Upload',
    'Transcribe',
    'Summarize',
    'Done',
  ];

  Timer? _timer;
  WorkflowJobSnapshot? _snapshot;
  String? _error;
  late String _jobId;

  @override
  void initState() {
    super.initState();
    _jobId = widget.jobId;
    final pendingJob = widget.pendingJob;
    if (pendingJob == null) {
      _startPolling();
    } else {
      Future.microtask(() => _startPendingJob(pendingJob));
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final snapshot = _snapshot;
    final activeStep = _activeStep(snapshot?.stage, snapshot?.progress ?? 0);
    final starting = widget.pendingJob != null && snapshot == null && _error == null;

    return Scaffold(
      backgroundColor: palette.pageBackground,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 33, 24, 0),
          child: Column(
            children: [
              Row(
                children: [
                  GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: () => context.go('/record'),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Text(
                        'Back',
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w400,
                          color: palette.textSecondary,
                        ),
                      ),
                    ),
                  ),
                  const Spacer(),
                  Text(
                    'AI Summary',
                    style: TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w600,
                      color: palette.text,
                    ),
                  ),
                  const Spacer(),
                  const SizedBox(width: 38),
                ],
              ),
              const Spacer(flex: 24),
              _GeneratingCard(
                failed: _error != null,
                activeStep: activeStep,
                statusText: _error == null
                    ? (starting ? 'Uploading...' : 'Generating...')
                    : 'Generation failed',
              ),
              if (_error != null) ...[
                const SizedBox(height: 16),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 116),
                  child: SingleChildScrollView(
                    child: Text(
                      'Job $_jobId\n$_error',
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        color: Color(0xFFE5484D),
                        fontSize: 12,
                        fontWeight: FontWeight.w400,
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                _CancelButton(
                  label: 'Try again',
                  onTap: widget.pendingJob != null && _jobId == widget.jobId
                      ? () => _startPendingJob(widget.pendingJob!)
                      : _poll,
                ),
              ],
              const SizedBox(height: 39),
              Text(
                "You can leave this screen - we'll notify you",
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w300,
                  color: palette.textMuted,
                ),
              ),
              const SizedBox(height: 23),
              _CancelButton(
                label: 'Cancel',
                onTap: () => context.go('/record'),
              ),
              const SizedBox(height: 10),
              Text(
                workflowApiUrl,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w300,
                  color: palette.textMuted,
                ),
              ),
              const Spacer(flex: 18),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _poll() async {
    try {
      final next = await ref.read(notesRepositoryProvider).jobStatus(_jobId);
      if (!mounted) return;
      if (next.isComplete && next.noteId.isNotEmpty) {
        _timer?.cancel();
        setState(() {
          _snapshot = next;
          _error = null;
        });
        await Future<void>.delayed(const Duration(milliseconds: 450));
        try {
          await ref.read(notesRepositoryProvider).savePendingAttachmentsForJob(
                jobId: _jobId,
                noteId: next.noteId,
              );
        } catch (error) {
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('Note created, but attachments failed to save: $error')),
            );
          }
        }
        // Terminal: drop the persisted record so a relaunch does not resume a
        // finished job. Done after the single attachment-save attempt so it
        // cannot loop on a transient attachment failure.
        await ref.read(notesRepositoryProvider).clearActiveJob(_jobId);
        if (!mounted) return;
        context.pushReplacement('/note/${next.noteId}');
        return;
      }
      setState(() {
        _snapshot = next;
        _error = next.isFailed
            ? next.error ?? 'The workflow failed while generating this note.'
            : null;
      });
      if (next.isFailed) {
        _timer?.cancel();
        // Terminal failure: stop resuming this dead job on future launches.
        unawaited(ref.read(notesRepositoryProvider).clearActiveJob(_jobId));
      }
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = '$error');
    }
  }

  int _activeStep(String? stage, int progress) {
    final value = (stage ?? '').toLowerCase();
    if (value.contains('done') || value.contains('saving') || progress >= 90) {
      return 3;
    }
    if (value.contains('summar') || progress >= 70) return 2;
    if (value.contains('transcrib') || progress >= 20) return 1;
    return 0;
  }

  void _startPolling() {
    _poll();
    _timer = Timer.periodic(const Duration(seconds: 4), (_) => _poll());
  }

  Future<void> _startPendingJob(PendingProcessingJob job) async {
    try {
      if (_snapshot != null || _error != null) {
        setState(() {
          _snapshot = null;
          _error = null;
        });
      }
      final jobId = await ref.read(notesRepositoryProvider).createNote(
            noteId: job.noteId,
            fileId: job.fileId,
            audioPath: job.audioPath,
            title: job.title,
            instructions: job.instructions,
            promptId: job.promptId,
            userName: job.userName,
            attachmentPaths: job.attachmentPaths,
          );
      if (!mounted) return;
      _jobId = jobId;
      _startPolling();
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = '$error');
    }
  }
}

class _GeneratingCard extends StatelessWidget {
  const _GeneratingCard({
    required this.failed,
    required this.activeStep,
    required this.statusText,
  });

  final bool failed;
  final int activeStep;
  final String statusText;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 378,
      width: double.infinity,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(27),
        boxShadow: const [
          BoxShadow(
            color: Color(0x0809152D),
            blurRadius: 3,
            offset: Offset(0, 1),
          ),
          BoxShadow(
            color: Color(0x1109152D),
            blurRadius: 38,
            offset: Offset(0, 24),
          ),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(27),
        child: Stack(
          children: [
            const Positioned.fill(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  gradient: RadialGradient(
                    center: Alignment(0, -0.18),
                    radius: 0.82,
                    colors: [
                      Color(0xFFCDE6FF),
                      Color(0xFFD9D5FF),
                      Color(0xFFE8F8FA),
                      Color(0xFFFFFFFF),
                    ],
                    stops: [0, 0.42, 0.72, 1],
                  ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(28, 29, 28, 27),
              child: Column(
                children: [
                  Text(
                    failed ? 'Generation failed' : 'Generating summary',
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w400,
                      color: Color(0xFF172033),
                    ),
                  ),
                  const Spacer(flex: 11),
                  if (failed)
                    const Icon(
                      Icons.error_rounded,
                      size: 48,
                      color: Color(0xFFE5484D),
                    )
                  else
                    const _GeneratingLines(),
                  const SizedBox(height: 28),
                  Text(
                    statusText,
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w300,
                      color: Color(0xFF9EA8B8),
                    ),
                  ),
                  const Spacer(flex: 6),
                  _StepProgress(activeStep: failed ? 0 : activeStep),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _GeneratingLines extends StatefulWidget {
  const _GeneratingLines();

  @override
  State<_GeneratingLines> createState() => _GeneratingLinesState();
}

class _GeneratingLinesState extends State<_GeneratingLines>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    const widths = [180.0, 238.0, 208.0, 139.0];
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        return SizedBox(
          height: 63,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              for (var i = 0; i < widths.length; i++) ...[
                Container(
                  width: widths[i],
                  height: 7,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(99),
                    gradient: LinearGradient(
                      begin: Alignment(-1.4 + (_controller.value * 2.8), 0),
                      end: Alignment(-0.4 + (_controller.value * 2.8), 0),
                      colors: const [
                        Color(0xFF9CCBFF),
                        Color(0xFFE3C8FF),
                        Color(0xFFFFFFFF),
                        Color(0xFFAEE6D8),
                      ],
                      stops: const [0, 0.38, 0.52, 1],
                    ),
                  ),
                ),
                if (i != widths.length - 1) const SizedBox(height: 8),
              ],
            ],
          ),
        );
      },
    );
  }

}

class PendingProcessingJob {
  const PendingProcessingJob({
    required this.noteId,
    required this.fileId,
    required this.audioPath,
    required this.title,
    required this.promptId,
    this.instructions,
    this.userName,
    this.attachmentPaths = const [],
  });

  /// Stable idempotency keys generated once at submit time. Reused on every
  /// createNote retry so a resubmitted job is deduplicated server-side instead
  /// of creating a duplicate note.
  final String noteId;
  final String fileId;
  final String audioPath;
  final String title;
  final String promptId;
  final String? instructions;
  final String? userName;
  final List<String> attachmentPaths;
}

class _StepProgress extends StatelessWidget {
  const _StepProgress({required this.activeStep});

  final int activeStep;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Row(
          children: [
            for (var i = 0; i < _ProcessingScreenState._steps.length; i++)
              Expanded(
                child: Row(
                  children: [
                    Expanded(
                      child: Container(
                        height: 2,
                        color: i == 0
                            ? Colors.transparent
                            : i <= activeStep
                                ? const Color(0xFF3A8BFF)
                                : const Color(0xFFE1E6EF),
                      ),
                    ),
                    Container(
                      width: 12,
                      height: 12,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: i <= activeStep
                            ? const Color(0xFF3A8BFF)
                            : const Color(0xFFDDE3ED),
                        boxShadow: i == activeStep
                            ? const [
                                BoxShadow(
                                  color: Color(0x553A8BFF),
                                  blurRadius: 16,
                                  spreadRadius: 2,
                                ),
                              ]
                            : null,
                      ),
                    ),
                    Expanded(
                      child: Container(
                        height: 2,
                        color: i == _ProcessingScreenState._steps.length - 1
                            ? Colors.transparent
                            : i < activeStep
                                ? const Color(0xFF3A8BFF)
                                : const Color(0xFFE1E6EF),
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
        const SizedBox(height: 9),
        Row(
          children: [
            for (var i = 0; i < _ProcessingScreenState._steps.length; i++)
              Expanded(
                child: Center(
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Text(
                      _ProcessingScreenState._steps[i],
                      maxLines: 1,
                      softWrap: false,
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w400,
                        color: i <= activeStep
                            ? const Color(0xFF172033)
                            : const Color(0xFFB5BECC),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ],
    );
  }
}

class _CancelButton extends StatelessWidget {
  const _CancelButton({
    required this.label,
    required this.onTap,
  });

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        height: 40,
        constraints: const BoxConstraints(minWidth: 108),
        padding: const EdgeInsets.symmetric(horizontal: 24),
        decoration: BoxDecoration(
          color: palette.card,
          borderRadius: BorderRadius.circular(22),
        ),
        child: Center(
          child: Text(
            label,
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w400,
              color: palette.textSecondary,
            ),
          ),
        ),
      ),
    );
  }
}
