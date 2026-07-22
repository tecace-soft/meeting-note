import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/network/workflow_config.dart';
import '../data/notes_repository.dart';

class ProcessingScreen extends ConsumerStatefulWidget {
  const ProcessingScreen({super.key, required this.jobId});

  final String jobId;

  @override
  ConsumerState<ProcessingScreen> createState() => _ProcessingScreenState();
}

class _ProcessingScreenState extends ConsumerState<ProcessingScreen> {
  static const _steps = [
    'Upload',
    'Transcribing',
    'Summarize',
    'Done',
  ];

  Timer? _timer;
  WorkflowJobSnapshot? _snapshot;
  String? _error;

  @override
  void initState() {
    super.initState();
    _poll();
    _timer = Timer.periodic(const Duration(seconds: 4), (_) => _poll());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = _snapshot;
    final activeStep = _activeStep(snapshot?.stage, snapshot?.progress ?? 0);

    return Scaffold(
      backgroundColor: const Color(0xFFF3F4F8),
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
                    child: const Padding(
                      padding: EdgeInsets.symmetric(vertical: 8),
                      child: Text(
                        'Back',
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w400,
                          color: Color(0xFF4B5565),
                        ),
                      ),
                    ),
                  ),
                  const Spacer(),
                  const Text(
                    'AI Summary',
                    style: TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF111827),
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
                statusText: _error == null ? 'Generating...' : 'Generation failed',
              ),
              if (_error != null) ...[
                const SizedBox(height: 16),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 116),
                  child: SingleChildScrollView(
                    child: Text(
                      'Job ${widget.jobId}\n$_error',
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
                _CancelButton(label: 'Try again', onTap: _poll),
              ],
              const SizedBox(height: 39),
              const Text(
                "You can leave this screen - we'll notify you",
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w300,
                  color: Color(0xFF9EA8B8),
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
                style: const TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w300,
                  color: Color(0xFF9EA8B8),
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
      final next = await ref.read(notesRepositoryProvider).jobStatus(widget.jobId);
      if (!mounted) return;
      if (next.isComplete && next.noteId.isNotEmpty) {
        _timer?.cancel();
        context.pushReplacement('/note/${next.noteId}');
        return;
      }
      setState(() {
        _snapshot = next;
        _error = next.isFailed
            ? next.error ?? 'The workflow failed while generating this note.'
            : null;
      });
      if (next.isFailed) _timer?.cancel();
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

class _GeneratingLines extends StatelessWidget {
  const _GeneratingLines();

  @override
  Widget build(BuildContext context) {
    const widths = [180.0, 238.0, 208.0, 139.0];
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
                gradient: const LinearGradient(
                  colors: [
                    Color(0xFF9CCBFF),
                    Color(0xFFE3C8FF),
                    Color(0xFFAEE6D8),
                  ],
                ),
              ),
            ),
            if (i != widths.length - 1) const SizedBox(height: 8),
          ],
        ],
      ),
    );
  }
}

class _StepProgress extends StatelessWidget {
  const _StepProgress({required this.activeStep});

  final int activeStep;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (var i = 0; i < _ProcessingScreenState._steps.length; i++) ...[
          Expanded(
            child: Column(
              children: [
                Row(
                  children: [
                    if (i > 0)
                      Expanded(
                        child: Container(
                          height: 2,
                          color: i <= activeStep
                              ? const Color(0xFF3A8BFF)
                              : const Color(0xFFE1E6EF),
                        ),
                      )
                    else
                      const Expanded(child: SizedBox(height: 2)),
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
                    if (i < _ProcessingScreenState._steps.length - 1)
                      Expanded(
                        child: Container(
                          height: 2,
                          color: i < activeStep
                              ? const Color(0xFF3A8BFF)
                              : const Color(0xFFE1E6EF),
                        ),
                      )
                    else
                      const Expanded(child: SizedBox(height: 2)),
                  ],
                ),
                const SizedBox(height: 9),
                Text(
                  _ProcessingScreenState._steps[i],
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w400,
                    color: i <= activeStep
                        ? const Color(0xFF172033)
                        : const Color(0xFFB5BECC),
                  ),
                ),
              ],
            ),
          ),
        ],
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
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        height: 40,
        constraints: const BoxConstraints(minWidth: 108),
        padding: const EdgeInsets.symmetric(horizontal: 24),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(22),
        ),
        child: Center(
          child: Text(
            label,
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w400,
              color: Color(0xFF667085),
            ),
          ),
        ),
      ),
    );
  }
}
