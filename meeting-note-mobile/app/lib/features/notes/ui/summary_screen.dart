import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/i18n/app_strings.dart';
import '../../../shared/widgets/widgets.dart';
import '../../auth/providers/auth_provider.dart';
import '../data/notes_repository.dart';
import '../models/meeting_note.dart';

class SummaryScreen extends ConsumerWidget {
  const SummaryScreen({super.key, required this.noteId});

  final String noteId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(appTextProvider);
    final noteAsync = ref.watch(noteProvider(noteId));

    return noteAsync.when(
      loading: () => Scaffold(
        backgroundColor: FigmaDesign.of(context).pageBackground,
        body: const Center(child: CircularProgressIndicator()),
      ),
      error: (e, _) => Scaffold(
        backgroundColor: FigmaDesign.of(context).pageBackground,
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: EmptyState(
              icon: Icons.error_outline_rounded,
              title: t('note.loadFailed'),
              subtitle: '$e',
            ),
          ),
        ),
      ),
      data: (note) => _DetailScaffold(note: note),
    );
  }
}

class _DetailScaffold extends ConsumerStatefulWidget {
  const _DetailScaffold({required this.note});

  final MeetingNote note;

  @override
  ConsumerState<_DetailScaffold> createState() => _DetailScaffoldState();
}

class _DetailScaffoldState extends ConsumerState<_DetailScaffold> {
  int _tab = 0;
  String? _selectedSpeaker;
  late MeetingNote _note;

  @override
  void initState() {
    super.initState();
    _note = widget.note;
  }

  @override
  void didUpdateWidget(covariant _DetailScaffold oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.note.id != widget.note.id) {
      _note = widget.note;
      _selectedSpeaker = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final note = _note;
    final t = ref.watch(appTextProvider);
    return Scaffold(
      backgroundColor: FigmaDesign.of(context).pageBackground,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 33, 24, 0),
          child: Column(
            children: [
              _DetailHeader(
                note: note,
                backLabel: t('note.back'),
                moreLabel: t('note.more'),
              ),
              const SizedBox(height: 19),
              _SegmentedTabs(
                selected: _tab,
                onChanged: (value) => setState(() => _tab = value),
                summaryLabel: t('note.summaryTab'),
                transcriptLabel: t('note.transcriptTab'),
              ),
              const SizedBox(height: 19),
              Expanded(
                child: IndexedStack(
                  index: _tab,
                  children: [
                    _SummaryTab(
                      note: note,
                      emptyTitle: t('note.noSummaryTitle'),
                      emptySubtitle: t('note.noSummarySub'),
                    ),
                    _TranscriptTab(
                      note: note,
                      selectedSpeaker: _selectedSpeaker,
                      onSelectedSpeakerChanged: (speaker) {
                        setState(() => _selectedSpeaker = speaker);
                      },
                      onTranscriptChanged: (segments) {
                        setState(() {
                          _note = _note.copyWith(transcript: segments);
                          final speakers = _orderedSpeakers(segments);
                          if (_selectedSpeaker != null &&
                              !speakers.contains(_selectedSpeaker)) {
                            _selectedSpeaker = null;
                          }
                        });
                      },
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
      bottomNavigationBar: _ActionBar(
        note: note,
        tab: _tab,
        onNoteChanged: (next) => setState(() => _note = next),
      ),
    );
  }
}

class _DetailHeader extends StatelessWidget {
  const _DetailHeader({
    required this.note,
    required this.backLabel,
    required this.moreLabel,
  });

  final MeetingNote note;
  final String backLabel;
  final String moreLabel;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => context.canPop() ? context.pop() : context.go('/history'),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text(
              backLabel,
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w400,
                color: palette.textSecondary,
              ),
            ),
          ),
        ),
        const SizedBox(width: 18),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Text(
                note.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 18,
                  height: 1.1,
                  fontWeight: FontWeight.w600,
                  color: palette.text,
                ),
              ),
              const SizedBox(height: 5),
              Text(
                '${_formatDetailDate(note.displayDate)} - ${note.durationLabel}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w300,
                  color: palette.textMuted,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 18),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Text(
            moreLabel,
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w400,
              color: palette.textSecondary,
            ),
          ),
        ),
      ],
    );
  }
}

class _SegmentedTabs extends StatelessWidget {
  const _SegmentedTabs({
    required this.selected,
    required this.onChanged,
    required this.summaryLabel,
    required this.transcriptLabel,
  });

  final int selected;
  final ValueChanged<int> onChanged;
  final String summaryLabel;
  final String transcriptLabel;

  @override
  Widget build(BuildContext context) {
    return FigmaSlidingSegmentedToggle(
      options: [
        FigmaSegmentOption(label: summaryLabel),
        FigmaSegmentOption(label: transcriptLabel),
      ],
      selectedIndex: selected,
      onChanged: onChanged,
      height: 44,
    );
  }
}

class _SummaryTab extends StatelessWidget {
  const _SummaryTab({
    required this.note,
    required this.emptyTitle,
    required this.emptySubtitle,
  });

  final MeetingNote note;
  final String emptyTitle;
  final String emptySubtitle;

  @override
  Widget build(BuildContext context) {
    final summary = note.displaySummary;
    if (summary.isEmpty) {
      return EmptyState(
        icon: Icons.hourglass_empty_rounded,
        title: emptyTitle,
        subtitle: emptySubtitle,
      );
    }

    final palette = FigmaDesign.of(context);
    return ListView(
      padding: EdgeInsets.zero,
      children: [
        Container(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 20),
          decoration: BoxDecoration(
            color: palette.card,
            borderRadius: BorderRadius.circular(24),
          ),
          child: MarkdownBody(
            data: summary,
            styleSheet: MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
              h1: TextStyle(
                fontSize: 18,
                height: 1.2,
                fontWeight: FontWeight.w600,
                color: palette.text,
              ),
              h2: TextStyle(
                fontSize: 14,
                height: 1.25,
                fontWeight: FontWeight.w600,
                color: palette.text,
              ),
              h3: const TextStyle(
                fontSize: 13,
                height: 1.25,
                fontWeight: FontWeight.w500,
                color: FigmaDesign.activeBlue,
              ),
              p: TextStyle(
                fontSize: 13,
                height: 1.42,
                fontWeight: FontWeight.w300,
                color: palette.textSecondary,
              ),
              strong: TextStyle(
                fontWeight: FontWeight.w600,
                color: palette.text,
              ),
              listBullet: TextStyle(
                fontSize: 13,
                height: 1.42,
                color: palette.textSecondary,
              ),
              blockquote: TextStyle(
                fontSize: 13,
                height: 1.42,
                fontWeight: FontWeight.w300,
                color: palette.textSecondary,
              ),
            ),
          ),
        ),
        _NoteAttachments(noteId: note.id),
        const SizedBox(height: 28),
      ],
    );
  }
}

/// Note attachment gallery (web parity): mobile could attach files at creation but not VIEW
/// them on a saved note. Loads the note's attachments (signed URLs) and shows images as
/// tappable thumbnails (full-screen viewer) and other files as chips (open externally).
class _NoteAttachments extends ConsumerStatefulWidget {
  const _NoteAttachments({required this.noteId});

  final String noteId;

  @override
  ConsumerState<_NoteAttachments> createState() => _NoteAttachmentsState();
}

class _NoteAttachmentsState extends ConsumerState<_NoteAttachments> {
  late final Future<List<NoteAttachment>> _future;

  @override
  void initState() {
    super.initState();
    _future = ref
        .read(notesRepositoryProvider)
        .listNoteAttachments(widget.noteId)
        .catchError((_) => <NoteAttachment>[]); // best-effort: no attachments UI on failure
  }

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final t = ref.watch(appTextProvider);
    return FutureBuilder<List<NoteAttachment>>(
      future: _future,
      builder: (context, snapshot) {
        final items = snapshot.data ?? const <NoteAttachment>[];
        if (items.isEmpty) return const SizedBox.shrink();
        return Padding(
          padding: const EdgeInsets.only(top: 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${t('note.attachments')} (${items.length})',
                style: TextStyle(color: palette.text, fontSize: 14, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                children: [for (final a in items) _AttachmentTile(attachment: a)],
              ),
            ],
          ),
        );
      },
    );
  }
}

class _AttachmentTile extends StatelessWidget {
  const _AttachmentTile({required this.attachment});

  final NoteAttachment attachment;

  void _openImage(BuildContext context) {
    showDialog<void>(
      context: context,
      builder: (dialogContext) => Dialog(
        backgroundColor: Colors.black,
        insetPadding: const EdgeInsets.all(12),
        child: Stack(
          children: [
            InteractiveViewer(
              minScale: 0.5,
              maxScale: 4,
              child: Center(
                child: Image.network(attachment.url, fit: BoxFit.contain),
              ),
            ),
            Positioned(
              top: 4,
              right: 4,
              child: IconButton(
                icon: const Icon(Icons.close_rounded, color: Colors.white),
                onPressed: () => Navigator.of(dialogContext).pop(),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _openExternal() async {
    final uri = Uri.tryParse(attachment.url);
    if (uri == null) return;
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    if (attachment.isImage) {
      return GestureDetector(
        onTap: () => _openImage(context),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: Image.network(
            attachment.url,
            width: 84,
            height: 84,
            fit: BoxFit.cover,
            errorBuilder: (_, __, ___) => _fileChip(palette),
          ),
        ),
      );
    }
    return GestureDetector(
      onTap: _openExternal,
      child: _fileChip(palette),
    );
  }

  Widget _fileChip(FigmaPalette palette) {
    return Container(
      width: 84,
      height: 84,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: palette.card,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.insert_drive_file_outlined, color: palette.textMuted, size: 26),
          const SizedBox(height: 6),
          Text(
            attachment.name,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 10, height: 1.2, color: palette.textSecondary),
          ),
        ],
      ),
    );
  }
}

class _TranscriptTab extends ConsumerWidget {
  const _TranscriptTab({
    required this.note,
    required this.selectedSpeaker,
    required this.onSelectedSpeakerChanged,
    required this.onTranscriptChanged,
  });

  final MeetingNote note;
  final String? selectedSpeaker;
  final ValueChanged<String?> onSelectedSpeakerChanged;
  final ValueChanged<List<TranscriptSegment>> onTranscriptChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(appTextProvider);
    final segments = note.transcript;
    if (segments.isEmpty) {
      return EmptyState(
        icon: Icons.subject_rounded,
        title: t('note.noTranscript'),
      );
    }

    final speakers = _orderedSpeakers(segments);
    final anonLabels = anonymousLabelsInTranscript(segments);
    final visibleSegments = selectedSpeaker == null
        ? segments
        : segments
            .where((segment) => _speakerName(segment) == selectedSpeaker)
            .toList();

    return ListView(
      padding: EdgeInsets.zero,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            _SpeakerChip(
              label: t('note.allSpeakers'),
              selected: selectedSpeaker == null,
              onTap: () => onSelectedSpeakerChanged(null),
            ),
            for (final speaker in speakers)
              _SpeakerChip(
                label: speaker,
                selected: selectedSpeaker == speaker,
                onTap: () => onSelectedSpeakerChanged(
                  selectedSpeaker == speaker ? null : speaker,
                ),
              ),
          ],
        ),
        // AI speaker suggestion (identify-speakers). Only offered when the transcript still
        // has anonymous "Speaker A/B" labels to resolve.
        if (anonLabels.isNotEmpty) ...[
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerLeft,
            child: FigmaPillButton(
              label: t('note.suggestSpeakers'),
              compact: true,
              onTap: () async {
                final next = await showModalBottomSheet<List<TranscriptSegment>>(
                  context: context,
                  isScrollControlled: true,
                  showDragHandle: true,
                  builder: (_) => _SuggestSpeakersSheet(
                    repository: ref.read(notesRepositoryProvider),
                    noteId: note.id,
                    segments: segments,
                    selfName: ref.read(authControllerProvider).user?.displayName,
                  ),
                );
                if (next != null) onTranscriptChanged(next);
              },
            ),
          ),
        ],
        const SizedBox(height: 20),
        for (final entry in visibleSegments.indexed)
          _TranscriptRow(
            segment: entry.$2,
            onSpeakerTap: () async {
              final originalIndex = segments.indexOf(entry.$2);
              final next = await showModalBottomSheet<List<TranscriptSegment>>(
                context: context,
                isScrollControlled: true,
                showDragHandle: true,
                builder: (context) => _SpeakerPickerSheet(
                  noteId: note.id,
                  segments: segments,
                  currentSharedUserIds: note.sharedUserIds,
                  segmentIndex: originalIndex,
                  originalSpeaker: _speakerKeyOf(entry.$2),
                  transcription: note.transcription,
                  repository: ref.read(notesRepositoryProvider),
                ),
              );
              if (next != null) onTranscriptChanged(next);
            },
            onTextTap: () async {
              final originalIndex = segments.indexOf(entry.$2);
              final next = await showModalBottomSheet<List<TranscriptSegment>>(
                context: context,
                isScrollControlled: true,
                showDragHandle: true,
                builder: (context) => _EditSegmentTextSheet(
                  noteId: note.id,
                  segments: segments,
                  segmentIndex: originalIndex,
                  repository: ref.read(notesRepositoryProvider),
                ),
              );
              if (next != null) onTranscriptChanged(next);
            },
          ),
        const SizedBox(height: 28),
      ],
    );
  }
}

class _SpeakerChip extends StatelessWidget {
  const _SpeakerChip({
    required this.label,
    this.selected = false,
    this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        height: 34,
        padding: const EdgeInsets.symmetric(horizontal: 15),
        decoration: BoxDecoration(
          color: selected
              ? (dark ? const Color(0xFF17345D) : const Color(0xFFE8F2FF))
              : palette.card,
          borderRadius: BorderRadius.circular(18),
        ),
        child: Center(
          widthFactor: 1,
          child: Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w400,
              color: selected ? FigmaDesign.activeBlue : palette.textSecondary,
            ),
          ),
        ),
      ),
    );
  }
}

class _TranscriptRow extends StatelessWidget {
  const _TranscriptRow({
    required this.segment,
    required this.onSpeakerTap,
    required this.onTextTap,
  });

  final TranscriptSegment segment;
  final VoidCallback onSpeakerTap;
  final VoidCallback onTextTap;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final speaker = _speakerName(segment);
    final color = _speakerColor(speaker);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 32,
            height: 32,
            decoration: BoxDecoration(
              color: color.background,
              shape: BoxShape.circle,
            ),
            child: Center(
              child: Text(
                speaker.substring(0, 1).toUpperCase(),
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: color.foreground,
                ),
              ),
            ),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: onSpeakerTap,
                      child: Text(
                        speaker,
                        style: TextStyle(
                          fontSize: 12,
                          height: 1.1,
                          fontWeight: FontWeight.w600,
                          color: color.foreground,
                        ),
                      ),
                    ),
                    const SizedBox(width: 7),
                    Text(
                      segment.timestamp,
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w300,
                        color: palette.textMuted,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: onTextTap,
                  child: Text(
                    segment.text,
                    style: TextStyle(
                      fontSize: 13,
                      height: 1.35,
                      fontWeight: FontWeight.w300,
                      color: palette.textSecondary,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Edits the TEXT of one transcript segment (web parity: the segment text is read-only on
/// mobile today — only the speaker label is editable). Saves via the same `saveDiarization`
/// path as speaker relabeling. No new permissions.
class _EditSegmentTextSheet extends ConsumerStatefulWidget {
  const _EditSegmentTextSheet({
    required this.noteId,
    required this.segments,
    required this.segmentIndex,
    required this.repository,
  });

  final String noteId;
  final List<TranscriptSegment> segments;
  final int segmentIndex;
  final NotesRepository repository;

  @override
  ConsumerState<_EditSegmentTextSheet> createState() => _EditSegmentTextSheetState();
}

class _EditSegmentTextSheetState extends ConsumerState<_EditSegmentTextSheet> {
  late final TextEditingController _controller;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.segments[widget.segmentIndex].text);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final next = _controller.text.trim();
    final current = widget.segments[widget.segmentIndex].text.trim();
    if (next.isEmpty) {
      setState(() => _error = ref.read(appTextProvider)('note.editSegmentEmpty'));
      return;
    }
    if (next == current) {
      Navigator.of(context).pop(); // no change
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final updated = List<TranscriptSegment>.from(widget.segments);
      updated[widget.segmentIndex] =
          widget.segments[widget.segmentIndex].copyWith(text: next);
      await widget.repository.saveDiarization(widget.noteId, updated);
      if (!mounted) return;
      Navigator.of(context).pop(updated);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = '${ref.read(appTextProvider)('note.failedSaveSegmentEdit')}: $error';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final t = ref.watch(appTextProvider);
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          bottom: MediaQuery.viewInsetsOf(context).bottom + 20,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              t('note.editSegment'),
              style: TextStyle(color: palette.text, fontSize: 17, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _controller,
              autofocus: true,
              minLines: 3,
              maxLines: 8,
              textCapitalization: TextCapitalization.sentences,
              enabled: !_saving,
              style: TextStyle(color: palette.text, fontSize: 14, height: 1.4),
              decoration: InputDecoration(
                hintText: t('note.editSegmentHint'),
                filled: true,
                fillColor: palette.card,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: BorderSide.none,
                ),
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: const TextStyle(color: Color(0xFFFF3B3B), fontSize: 12)),
            ],
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _saving ? null : () => Navigator.of(context).pop(),
                    child: Text(t('common.cancel')),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    onPressed: _saving ? null : _save,
                    child: Text(_saving ? t('note.saving') : t('note.save')),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ActionBar extends ConsumerStatefulWidget {
  const _ActionBar({
    required this.note,
    required this.tab,
    required this.onNoteChanged,
  });

  final MeetingNote note;
  final int tab;
  final ValueChanged<MeetingNote> onNoteChanged;

  @override
  ConsumerState<_ActionBar> createState() => _ActionBarState();
}

class _ActionBarState extends ConsumerState<_ActionBar> {
  String? _activeAction;

  Future<void> _runAction(
    String id,
    String label,
    Future<void> Function() action,
  ) async {
    setState(() => _activeAction = id);
    try {
      await action();
    } catch (error) {
      if (!mounted) return;
      final t = ref.read(appTextProvider);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('$label ${t('note.failed')}: $error')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final note = widget.note;
    final t = ref.watch(appTextProvider);
    return SafeArea(
      top: false,
      child: Container(
        height: 80,
        padding: const EdgeInsets.fromLTRB(24, 12, 24, 12),
        color: FigmaDesign.of(context).card,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            _ActionText(
              label: t('note.copy'),
              active: _activeAction == 'Copy',
              onTap: () => _runAction('Copy', t('note.copy'), () async {
                final text = widget.tab == 0
                    ? note.displaySummary
                    : _transcriptCopyText(note);
                await Clipboard.setData(ClipboardData(text: text));
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(widget.tab == 0
                        ? t('note.summaryCopied')
                        : t('note.transcriptCopied')),
                  ),
                );
              }),
            ),
            _ActionText(
              label: t('note.share'),
              active: _activeAction == 'Share',
              onTap: () => _runAction('Share', t('note.share'), () async {
                final selected = await showModalBottomSheet<List<String>>(
                  context: context,
                  showDragHandle: true,
                  isScrollControlled: true,
                  builder: (context) => _DetailShareNoteSheet(
                    note: note,
                    repository: ref.read(notesRepositoryProvider),
                  ),
                );
                if (selected == null) return;
                await ref.read(notesRepositoryProvider).shareNote(
                      note.id,
                      selected,
                    );
                widget.onNoteChanged(note.copyWith(sharedUserIds: selected));
                if (!mounted) return;
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text(t('note.sharingUpdated'))),
                );
              }),
            ),
            _ActionText(
              label: t('note.syncProfile'),
              active: _activeAction == 'Sync Profile',
              onTap: () =>
                  _runAction('Sync Profile', t('note.syncProfile'), () async {
                await showModalBottomSheet<void>(
                  context: context,
                  showDragHandle: true,
                  isScrollControlled: true,
                  builder: (context) => _DetailSyncProfilesSheet(
                    note: note,
                    repository: ref.read(notesRepositoryProvider),
                  ),
                );
              }),
            ),
            _ActionText(
              label: t('note.regenerate'),
              active: _activeAction == 'Regenerate',
              onTap: note.transcript.isEmpty
                  ? null
                  : () =>
                      _runAction('Regenerate', t('note.regenerate'), () async {
                      final confirmed = await showDialog<bool>(
                        context: context,
                        builder: (context) => AlertDialog(
                          title: Text(t('note.regenConfirmTitle')),
                          content: Text(
                            t('note.regenConfirmBody'),
                          ),
                          actions: [
                            TextButton(
                              onPressed: () => Navigator.pop(context, false),
                              child: Text(t('common.cancel')),
                            ),
                            FilledButton(
                              onPressed: () => Navigator.pop(context, true),
                              child: Text(t('note.regenerate')),
                            ),
                          ],
                        ),
                      );
                      if (confirmed != true) return;
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(content: Text(t('note.regenerating'))),
                      );
                      final summary = await ref
                          .read(notesRepositoryProvider)
                          .regenerateSummary(note);
                      widget.onNoteChanged(note.copyWith(summaryEdit: summary));
                      if (!mounted) return;
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(content: Text(t('note.summaryRegenerated'))),
                      );
                    }),
            ),
          ],
        ),
      ),
    );
  }
}

class _ActionText extends StatelessWidget {
  const _ActionText({
    required this.label,
    required this.onTap,
    this.active = false,
  });

  final String label;
  final VoidCallback? onTap;
  final bool active;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 10),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w400,
            color: onTap == null
                ? FigmaDesign.of(context).textMuted
                : active
                    ? FigmaDesign.activeBlue
                    : FigmaDesign.of(context).textSecondary,
          ),
        ),
      ),
    );
  }
}

class _DetailShareNoteSheet extends ConsumerStatefulWidget {
  const _DetailShareNoteSheet({
    required this.note,
    required this.repository,
  });

  final MeetingNote note;
  final NotesRepository repository;

  @override
  ConsumerState<_DetailShareNoteSheet> createState() =>
      _DetailShareNoteSheetState();
}

class _DetailShareNoteSheetState extends ConsumerState<_DetailShareNoteSheet> {
  late final Future<List<TecAceContact>> _future;
  late final Set<String> _selectedIds;
  String _query = '';

  @override
  void initState() {
    super.initState();
    _future = widget.repository.tecAceContacts();
    _selectedIds = {...widget.note.sharedUserIds};
  }

  @override
  Widget build(BuildContext context) {
    final t = ref.watch(appTextProvider);
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          bottom: MediaQuery.viewInsetsOf(context).bottom + 20,
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * 0.82,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _DetailSheetHeader(
                  title: t('note.shareNote'), subtitle: widget.note.title),
              const SizedBox(height: 12),
              _DetailSheetSearchField(
                hintText: t('note.searchTecAce'),
                onChanged: (value) => setState(() => _query = value),
              ),
              const SizedBox(height: 12),
              Flexible(
                child: FutureBuilder<List<TecAceContact>>(
                  future: _future,
                  builder: (context, snapshot) {
                    if (snapshot.connectionState == ConnectionState.waiting) {
                      return const Center(child: CircularProgressIndicator());
                    }
                    if (snapshot.hasError) {
                      return _DetailSheetMessage(
                        '${t('note.tecAceLoadError')}: ${snapshot.error}',
                      );
                    }
                    final contacts = (snapshot.data ?? const <TecAceContact>[])
                        .where((contact) => _contactMatches(contact, _query))
                        .toList();
                    if (contacts.isEmpty) {
                      return _DetailSheetMessage(t('note.noTecAceFound'));
                    }
                    return ListView.separated(
                      shrinkWrap: true,
                      itemCount: contacts.length,
                      separatorBuilder: (_, __) => const SizedBox(height: 8),
                      itemBuilder: (context, index) {
                        final contact = contacts[index];
                        final selected = _selectedIds.contains(contact.id);
                        return _DetailSelectableRow(
                          title: contact.displayName,
                          subtitle: contact.email,
                          selected: selected,
                          onTap: () {
                            setState(() {
                              if (selected) {
                                _selectedIds.remove(contact.id);
                              } else {
                                _selectedIds.add(contact.id);
                              }
                            });
                          },
                        );
                      },
                    );
                  },
                ),
              ),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () => Navigator.pop(context, _selectedIds.toList()),
                  child: Text('${t('note.shareWith')} ${_selectedIds.length}'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  bool _contactMatches(TecAceContact contact, String query) {
    final needle = query.trim().toLowerCase();
    if (needle.isEmpty) return true;
    return contact.displayName.toLowerCase().contains(needle) ||
        contact.email.toLowerCase().contains(needle) ||
        contact.userPrincipalName.toLowerCase().contains(needle);
  }
}

class _DetailSyncProfilesSheet extends ConsumerStatefulWidget {
  const _DetailSyncProfilesSheet({
    required this.note,
    required this.repository,
  });

  final MeetingNote note;
  final NotesRepository repository;

  @override
  ConsumerState<_DetailSyncProfilesSheet> createState() =>
      _DetailSyncProfilesSheetState();
}

class _DetailSyncProfilesSheetState
    extends ConsumerState<_DetailSyncProfilesSheet> {
  late final Future<List<GeneratedSpeakerProfile>> _future;
  final _savedSpeakerNames = <String>{};
  String? _error;
  bool _savingAll = false;

  @override
  void initState() {
    super.initState();
    _future = widget.repository.generateProfilesForNote(widget.note);
  }

  @override
  Widget build(BuildContext context) {
    final t = ref.watch(appTextProvider);
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          bottom: MediaQuery.viewInsetsOf(context).bottom + 20,
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * 0.86,
          ),
          child: FutureBuilder<List<GeneratedSpeakerProfile>>(
            future: _future,
            builder: (context, snapshot) {
              final profiles = snapshot.data ?? const <GeneratedSpeakerProfile>[];
              return Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _DetailSheetHeader(
                    title: t('note.syncProfile'),
                    subtitle: t('note.syncProfileSub'),
                  ),
                  const SizedBox(height: 12),
                  if (snapshot.connectionState == ConnectionState.waiting)
                    const Flexible(child: Center(child: CircularProgressIndicator()))
                  else if (snapshot.hasError)
                    Flexible(
                      child: _DetailSheetMessage(
                        '${t('note.profileSyncFailed')}: ${snapshot.error}',
                      ),
                    )
                  else
                    Flexible(
                      child: ListView.separated(
                        shrinkWrap: true,
                        itemCount: profiles.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 10),
                        itemBuilder: (context, index) {
                          final profile = profiles[index];
                          final saved =
                              _savedSpeakerNames.contains(profile.speakerName);
                          return _GeneratedProfileTile(
                            profile: profile,
                            saved: saved,
                            saveLabel: t('note.save'),
                            savedLabel: t('note.saved'),
                            onSave: saved ? null : () => _saveProfile(profile),
                          );
                        },
                      ),
                    ),
                  if (_error != null) ...[
                    const SizedBox(height: 10),
                    Text(
                      _error!,
                      style: const TextStyle(
                        color: Color(0xFFE5484D),
                        fontSize: 12,
                      ),
                    ),
                  ],
                  if (profiles.isNotEmpty) ...[
                    const SizedBox(height: 14),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton(
                        onPressed: _savingAll ? null : () => _saveAll(profiles),
                        child: Text(_savingAll
                            ? t('note.saving')
                            : t('note.saveAllProfiles')),
                      ),
                    ),
                  ],
                ],
              );
            },
          ),
        ),
      ),
    );
  }

  Future<void> _saveProfile(GeneratedSpeakerProfile profile) async {
    try {
      setState(() => _error = null);
      await widget.repository.saveGeneratedSpeakerProfile(profile);
      if (!mounted) return;
      setState(() => _savedSpeakerNames.add(profile.speakerName));
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = '$error');
    }
  }

  Future<void> _saveAll(List<GeneratedSpeakerProfile> profiles) async {
    setState(() {
      _savingAll = true;
      _error = null;
    });
    try {
      for (final profile in profiles) {
        if (_savedSpeakerNames.contains(profile.speakerName)) continue;
        await widget.repository.saveGeneratedSpeakerProfile(profile);
        _savedSpeakerNames.add(profile.speakerName);
      }
      if (!mounted) return;
      Navigator.pop(context);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(ref.read(appTextProvider)('note.profilesSaved'))),
      );
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _savingAll = false;
        _error = '$error';
      });
    }
  }
}

class _GeneratedProfileTile extends StatelessWidget {
  const _GeneratedProfileTile({
    required this.profile,
    required this.saved,
    required this.saveLabel,
    required this.savedLabel,
    required this.onSave,
  });

  final GeneratedSpeakerProfile profile;
  final bool saved;
  final String saveLabel;
  final String savedLabel;
  final VoidCallback? onSave;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Container(
      padding: const EdgeInsets.all(14),
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
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              FigmaAvatarInitial(name: profile.speakerName, size: 34, fontSize: 12),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  profile.speakerName,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: palette.text,
                  ),
                ),
              ),
              TextButton(
                onPressed: onSave,
                child: Text(saved ? savedLabel : saveLabel),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            profile.profile,
            maxLines: 6,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 12,
              height: 1.35,
              color: palette.textSecondary,
            ),
          ),
        ],
      ),
    );
  }
}

class _DetailSheetHeader extends StatelessWidget {
  const _DetailSheetHeader({required this.title, this.subtitle});

  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w600,
                  color: palette.text,
                ),
              ),
              if (subtitle != null && subtitle!.trim().isNotEmpty)
                Text(
                  subtitle!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, color: palette.textMuted),
                ),
            ],
          ),
        ),
        IconButton(
          onPressed: () => Navigator.pop(context),
          icon: Icon(Icons.close_rounded, color: palette.textMuted),
        ),
      ],
    );
  }
}

class _DetailSheetSearchField extends StatelessWidget {
  const _DetailSheetSearchField({
    required this.hintText,
    required this.onChanged,
  });

  final String hintText;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return TextField(
      onChanged: onChanged,
      style: TextStyle(color: palette.text),
      decoration: InputDecoration(
        hintText: hintText,
        hintStyle: TextStyle(color: palette.textMuted),
        filled: true,
        fillColor: palette.field,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(18),
          borderSide: BorderSide.none,
        ),
      ),
    );
  }
}

class _DetailSelectableRow extends StatelessWidget {
  const _DetailSelectableRow({
    required this.title,
    required this.subtitle,
    required this.selected,
    required this.onTap,
  });

  final String title;
  final String subtitle;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    return InkWell(
      borderRadius: BorderRadius.circular(18),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: selected
              ? (dark ? const Color(0xFF17345D) : const Color(0xFFE8F2FF))
              : palette.field,
          borderRadius: BorderRadius.circular(18),
        ),
        child: Row(
          children: [
            Icon(
              selected ? Icons.check_circle_rounded : Icons.circle_outlined,
              color: selected ? const Color(0xFF2F80FF) : palette.textMuted,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: palette.text,
                    ),
                  ),
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11, color: palette.textMuted),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DetailSheetMessage extends StatelessWidget {
  const _DetailSheetMessage(this.message);

  final String message;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Text(
          message,
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 13, color: palette.textSecondary),
        ),
      ),
    );
  }
}

class _SpeakerColors {
  const _SpeakerColors(this.background, this.foreground);

  final Color background;
  final Color foreground;
}

_SpeakerColors _speakerColor(String speaker) {
  const palette = [
    _SpeakerColors(Color(0xFFE8F2FF), Color(0xFF2F80FF)),
    _SpeakerColors(Color(0xFFF1E8FF), Color(0xFF9B51E0)),
    _SpeakerColors(Color(0xFFE5F8EC), Color(0xFF27AE60)),
    _SpeakerColors(Color(0xFFFFF0E5), Color(0xFFF2994A)),
    _SpeakerColors(Color(0xFFE7F8F6), Color(0xFF00A896)),
    _SpeakerColors(Color(0xFFFFEBF0), Color(0xFFE84873)),
    _SpeakerColors(Color(0xFFEAF0FF), Color(0xFF4667D8)),
    _SpeakerColors(Color(0xFFFFF7D8), Color(0xFFC99000)),
    _SpeakerColors(Color(0xFFEFF7E8), Color(0xFF5C9E2F)),
    _SpeakerColors(Color(0xFFF4EAFF), Color(0xFF7B3FF2)),
    _SpeakerColors(Color(0xFFE5F4FF), Color(0xFF1687C7)),
    _SpeakerColors(Color(0xFFFFEDE4), Color(0xFFE66A2C)),
  ];

  var hash = 0;
  for (final unit in speaker.trim().toLowerCase().codeUnits) {
    hash = (hash * 31 + unit) & 0x7fffffff;
  }
  return palette[hash % palette.length];
}

String _formatDetailDate(DateTime value) {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  final hour = value.hour % 12 == 0 ? 12 : value.hour % 12;
  final minute = value.minute.toString().padLeft(2, '0');
  final suffix = value.hour >= 12 ? 'PM' : 'AM';
  return '${months[value.month - 1]} ${value.day}, ${value.year} - $hour:$minute $suffix';
}

String _transcriptCopyText(MeetingNote note) {
  if (note.transcript.isNotEmpty) {
    return note.transcript
        .map((segment) =>
            '[${segment.timestampRange}] ${_speakerName(segment)}: ${segment.text}')
        .join('\n');
  }
  return note.transcription?.trim() ?? '';
}

List<String> _orderedSpeakers(List<TranscriptSegment> segments) {
  final seen = <String>{};
  final ordered = <String>[];
  for (final segment in segments) {
    final speaker = _speakerName(segment);
    if (seen.add(speaker)) ordered.add(speaker);
  }
  return ordered;
}

String _speakerName(TranscriptSegment segment) {
  final speaker = segment.speaker?.trim();
  return speaker == null || speaker.isEmpty ? 'Speaker' : speaker;
}

/// Stable identity for matching a rename. Falls back to the display name on legacy notes.
String _speakerKeyOf(TranscriptSegment segment) {
  final key = segment.speakerKey?.trim();
  if (key != null && key.isNotEmpty) return key;
  return _speakerName(segment);
}

/// Parse the frozen transcription ("Speaker A: ...\nSpeaker B: ...") into one original label
/// per line. Returns null unless the line count matches the segment count.
List<String>? _deriveOriginalLabels(String? transcription, int segmentCount) {
  if (transcription == null || transcription.trim().isEmpty) return null;
  final lines =
      transcription.split('\n').where((l) => l.trim().isNotEmpty).toList();
  if (lines.length != segmentCount) return null;
  final labels = <String>[];
  for (final line in lines) {
    final idx = line.indexOf(':');
    final label = idx > 0 ? line.substring(0, idx).trim() : '';
    if (label.isEmpty) return null;
    labels.add(label);
  }
  return labels;
}

/// Reset speakers back to their original diarization labels. Prefers stored speakerKeys;
/// derives from the frozen transcription for legacy notes. `onlyKey` limits the reset.
List<TranscriptSegment> _resetSpeakers(
  List<TranscriptSegment> segments,
  String? transcription, {
  String? onlyKey,
}) {
  final fromTranscript = _deriveOriginalLabels(transcription, segments.length);
  return [
    for (var i = 0; i < segments.length; i++)
      _resetOne(segments[i], segments[i].speakerKey ?? fromTranscript?[i], onlyKey),
  ];
}

TranscriptSegment _resetOne(
    TranscriptSegment seg, String? original, String? onlyKey) {
  if (original == null) return seg;
  if (onlyKey != null && _speakerKeyOf(seg) != onlyKey) return seg;
  return seg.copyWith(speaker: original, speakerKey: original);
}

/// True when Reset can recover original labels (stored keys, or an aligned transcription).
bool _canResetSpeakers(List<TranscriptSegment> segments, String? transcription) {
  if (segments.any((s) => (s.speakerKey?.trim().isNotEmpty ?? false))) return true;
  return _deriveOriginalLabels(transcription, segments.length) != null;
}

enum _ReplacementScope { single, fromHere, all }

List<TranscriptSegment> _applySpeakerReplacement({
  required List<TranscriptSegment> segments,
  required int segmentIndex,
  required String originalSpeaker,
  required String newSpeaker,
  required _ReplacementScope scope,
}) {
  return [
    for (var index = 0; index < segments.length; index++)
      if (_shouldReplaceSpeaker(
        index: index,
        segment: segments[index],
        segmentIndex: segmentIndex,
        originalSpeaker: originalSpeaker,
        scope: scope,
      ))
        segments[index].copyWith(speaker: newSpeaker)
      else
        segments[index],
  ];
}

bool _shouldReplaceSpeaker({
  required int index,
  required TranscriptSegment segment,
  required int segmentIndex,
  required String originalSpeaker,
  required _ReplacementScope scope,
}) {
  // Match on the stable key, not the display name, so speakers merged to one name stay
  // distinct and can be re-assigned independently. `originalSpeaker` is the tapped
  // segment's key (see picker open).
  final sameSpeaker = _speakerKeyOf(segment) == originalSpeaker;
  return switch (scope) {
    _ReplacementScope.single => index == segmentIndex,
    _ReplacementScope.fromHere => index >= segmentIndex && sameSpeaker,
    _ReplacementScope.all => sameSpeaker,
  };
}

/// AI speaker suggestion sheet: asks identify-speakers to guess who each anonymous label
/// is, lets the user review + toggle, and applies the selected renames to the diarization.
class _SuggestSpeakersSheet extends ConsumerStatefulWidget {
  const _SuggestSpeakersSheet({
    required this.repository,
    required this.noteId,
    required this.segments,
    required this.selfName,
  });

  final NotesRepository repository;
  final String noteId;
  final List<TranscriptSegment> segments;
  final String? selfName;

  @override
  ConsumerState<_SuggestSpeakersSheet> createState() => _SuggestSpeakersSheetState();
}

class _SuggestSpeakersSheetState extends ConsumerState<_SuggestSpeakersSheet> {
  late Future<List<SpeakerSuggestion>> _future;
  final Set<String> _selected = {};
  bool _applying = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<List<SpeakerSuggestion>> _load() async {
    final list = await widget.repository.requestSpeakerSuggestions(
      segments: widget.segments,
      selfName: widget.selfName,
    );
    // Pre-select confident, resolvable suggestions (mirrors the ingest auto-apply bar of 0.8).
    _selected
      ..clear()
      ..addAll(list.where(_isApplicable).where((s) => s.confidence >= 0.8).map((s) => s.label));
    return list;
  }

  bool _isApplicable(SpeakerSuggestion s) =>
      (s.isSelf && (widget.selfName?.trim().isNotEmpty ?? false)) ||
      (s.name != null && s.name!.trim().isNotEmpty);

  String _appliedName(SpeakerSuggestion s) {
    if (s.isSelf && (widget.selfName?.trim().isNotEmpty ?? false)) return widget.selfName!.trim();
    return s.name?.trim() ?? '';
  }

  Future<void> _apply(List<SpeakerSuggestion> suggestions) async {
    final nameByLabel = <String, String>{};
    for (final s in suggestions) {
      if (!_selected.contains(s.label)) continue;
      final name = _appliedName(s);
      if (name.isNotEmpty) nameByLabel[s.label] = name;
    }
    if (nameByLabel.isEmpty) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _applying = true;
      _error = null;
    });
    try {
      final next = widget.segments
          .map((seg) => nameByLabel.containsKey(seg.speaker)
              ? seg.copyWith(speaker: nameByLabel[seg.speaker])
              : seg)
          .toList();
      await widget.repository.saveDiarization(widget.noteId, next);
      // Ground-truth log: the human kept these suggestions (feedback loop, Stage 0).
      for (final s in suggestions) {
        if (!_selected.contains(s.label)) continue;
        final name = _appliedName(s);
        if (name.isEmpty) continue;
        unawaited(widget.repository.logSpeakerFeedback(
          noteId: widget.noteId,
          label: s.label,
          chosenName: name,
          chosenSpeakerId: s.speakerId,
          source: 'suggest_sheet',
          suggestion: s,
        ));
      }
      if (!mounted) return;
      Navigator.of(context).pop(next);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _applying = false;
        _error = '$error';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final t = ref.watch(appTextProvider);
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          bottom: MediaQuery.viewInsetsOf(context).bottom + 20,
        ),
        child: FutureBuilder<List<SpeakerSuggestion>>(
          future: _future,
          builder: (context, snapshot) {
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  t('note.suggestTitle'),
                  style: TextStyle(color: palette.text, fontSize: 17, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 4),
                Text(
                  t('note.suggestSubtitle'),
                  style: TextStyle(color: palette.textMuted, fontSize: 12, height: 1.4),
                ),
                const SizedBox(height: 16),
                _buildBody(context, t, snapshot),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _buildBody(BuildContext context, AppText t, AsyncSnapshot<List<SpeakerSuggestion>> snapshot) {
    final palette = FigmaDesign.of(context);
    if (snapshot.connectionState == ConnectionState.waiting) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 32),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
            const SizedBox(width: 12),
            Text(t('note.suggesting'), style: TextStyle(color: palette.textSecondary)),
          ],
        ),
      );
    }
    if (snapshot.hasError) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 16),
        child: Text('${t('note.suggestFailed')}: ${snapshot.error}',
            style: const TextStyle(color: Color(0xFFFF3B3B), fontSize: 13)),
      );
    }
    final suggestions = snapshot.data ?? const <SpeakerSuggestion>[];
    final applicable = suggestions.where(_isApplicable).toList();
    if (applicable.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 16),
        child: Text(t('note.noSuggestions'), style: TextStyle(color: palette.textSecondary, fontSize: 13)),
      );
    }
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final s in applicable)
          _SuggestionRow(
            label: s.label,
            name: _appliedName(s),
            confidence: s.confidence,
            selected: _selected.contains(s.label),
            onChanged: (v) => setState(() {
              if (v) {
                _selected.add(s.label);
              } else {
                _selected.remove(s.label);
              }
            }),
          ),
        if (_error != null) ...[
          const SizedBox(height: 8),
          Text(_error!, style: const TextStyle(color: Color(0xFFFF3B3B), fontSize: 12)),
        ],
        const SizedBox(height: 16),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _applying ? null : () => _apply(suggestions),
            child: Text(_applying ? t('note.applying') : t('note.applySuggestions')),
          ),
        ),
      ],
    );
  }
}

class _SuggestionRow extends StatelessWidget {
  const _SuggestionRow({
    required this.label,
    required this.name,
    required this.confidence,
    required this.selected,
    required this.onChanged,
  });

  final String label;
  final String name;
  final double confidence;
  final bool selected;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return InkWell(
      onTap: () => onChanged(!selected),
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            Checkbox(
              value: selected,
              onChanged: (v) => onChanged(v ?? false),
              visualDensity: VisualDensity.compact,
            ),
            Expanded(
              child: Row(
                children: [
                  Text(label, style: TextStyle(color: palette.textMuted, fontSize: 13)),
                  const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 6),
                    child: Icon(Icons.arrow_forward_rounded, size: 14, color: Color(0xFF9AA4B5)),
                  ),
                  Flexible(
                    child: Text(
                      name,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: palette.text, fontSize: 14, fontWeight: FontWeight.w600),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text('${(confidence * 100).round()}%',
                style: TextStyle(color: palette.textMuted, fontSize: 12)),
          ],
        ),
      ),
    );
  }
}

class _SpeakerPickerSheet extends ConsumerStatefulWidget {
  const _SpeakerPickerSheet({
    required this.noteId,
    required this.segments,
    required this.currentSharedUserIds,
    required this.segmentIndex,
    required this.originalSpeaker,
    required this.repository,
    this.transcription,
  });

  final String noteId;
  final List<TranscriptSegment> segments;
  final List<String> currentSharedUserIds;
  final int segmentIndex;
  // Stable key of the tapped speaker (used for matching), not the display name.
  final String originalSpeaker;
  // Frozen note.transcription — lets Reset recover original labels on legacy notes.
  final String? transcription;
  final NotesRepository repository;

  @override
  ConsumerState<_SpeakerPickerSheet> createState() =>
      _SpeakerPickerSheetState();
}

class _SpeakerPickerSheetState extends ConsumerState<_SpeakerPickerSheet> {
  late final TextEditingController _controller;
  _ReplacementScope _scope = _ReplacementScope.single;
  List<SavedSpeaker> _savedSpeakers = const [];
  List<TecAceContact> _contacts = const [];
  String? _pickedSpeakerId;
  bool _hasEditedSpeakerSearch = false;
  String? _contactError;
  String? _error;
  bool _loading = true;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(
      text: _speakerName(widget.segments[widget.segmentIndex]),
    );
    _controller.addListener(_clearPickedSpeaker);
    _load();
  }

  @override
  void dispose() {
    _controller.removeListener(_clearPickedSpeaker);
    _controller.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final saved = await widget.repository.savedSpeakers();
      List<TecAceContact> contacts = const [];
      String? contactError;
      try {
        contacts = await widget.repository.tecAceContacts();
      } catch (error) {
        contactError = ref.read(appTextProvider)('note.tecAceDirUnavailable');
      }
      if (!mounted) return;
      setState(() {
        _savedSpeakers = saved;
        _contacts = contacts;
        _contactError = contactError;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = '$error';
        _loading = false;
      });
    }
  }

  Future<void> _applyCustomSpeaker() async {
    final name = _controller.text.trim();
    if (name.isEmpty) {
      setState(() => _error = ref.read(appTextProvider)('note.enterSpeakerName'));
      return;
    }
    if (_pickedSpeakerId != null) {
      final picked = _savedSpeakers.where((row) => row.id == _pickedSpeakerId);
      if (picked.isNotEmpty) {
        await _applySavedSpeaker(picked.first);
        return;
      }
    }
    final speaker = await widget.repository.ensureSavedSpeaker(name: name);
    await _applySpeaker(
      name: speaker.name,
      microsoftId: speaker.microsoftId,
    );
  }

  void _selectSavedSpeaker(SavedSpeaker speaker) {
    _controller.removeListener(_clearPickedSpeaker);
    _controller.text = speaker.name;
    _controller.selection = TextSelection.collapsed(offset: speaker.name.length);
    _controller.addListener(_clearPickedSpeaker);
    setState(() {
      _pickedSpeakerId = speaker.id;
      _hasEditedSpeakerSearch = true;
      _error = null;
    });
  }

  void _clearPickedSpeaker() {
    if (_pickedSpeakerId == null && _hasEditedSpeakerSearch) return;
    setState(() {
      _pickedSpeakerId = null;
      _hasEditedSpeakerSearch = true;
    });
  }

  Future<void> _applySavedSpeaker(SavedSpeaker speaker) => _applySpeaker(
        name: speaker.name,
        microsoftId: speaker.microsoftId,
      );

  Future<void> _applyContact(TecAceContact contact) async {
    final speaker = await widget.repository.ensureSavedSpeaker(
      name: contact.displayName,
      email: contact.email,
      microsoftId: contact.id,
    );
    await _applySpeaker(
      name: speaker.name,
      microsoftId: speaker.microsoftId ?? contact.id,
    );
  }

  Future<void> _applySpeaker({
    required String name,
    String? microsoftId,
  }) async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final next = _applySpeakerReplacement(
        segments: widget.segments,
        segmentIndex: widget.segmentIndex,
        originalSpeaker: widget.originalSpeaker,
        newSpeaker: name,
        scope: _scope,
      );
      await widget.repository.saveDiarization(widget.noteId, next);
      // Ground-truth log: human set this anonymous label manually (feedback loop, Stage 0).
      unawaited(widget.repository.logSpeakerFeedback(
        noteId: widget.noteId,
        label: widget.originalSpeaker,
        chosenName: name,
        source: 'manual_rename',
      ));
      if (microsoftId != null && microsoftId.isNotEmpty) {
        await widget.repository.shareNoteWithMicrosoftUser(
          widget.noteId,
          microsoftId,
          widget.currentSharedUserIds,
        );
      }
      if (!mounted) return;
      Navigator.of(context).pop(next);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = '$error';
      });
    }
  }

  // Reset every speaker back to its original diarization label ("Speaker A/B"), undoing all
  // naming for this note (recovers identities even after two speakers were merged to one).
  Future<void> _resetSpeakersAction() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final next = _resetSpeakers(widget.segments, widget.transcription);
      await widget.repository.saveDiarization(widget.noteId, next);
      if (!mounted) return;
      Navigator.of(context).pop(next);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = '$error';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final query = _hasEditedSpeakerSearch
        ? _controller.text.trim().toLowerCase()
        : '';
    final filteredSavedSpeakers = _savedSpeakers
        .where((speaker) => _matchesSavedSpeaker(speaker, query))
        .toList();
    final filteredContacts = _contacts
        .where((contact) => _matchesTecAceContact(contact, query))
        .toList();
    final t = ref.watch(appTextProvider);

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          bottom: MediaQuery.viewInsetsOf(context).bottom + 20,
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * 0.82,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      t('note.changeSpeaker'),
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                        color: FigmaDesign.of(context).text,
                      ),
                    ),
                  ),
                  if (_canResetSpeakers(widget.segments, widget.transcription))
                    TextButton(
                      onPressed: _saving ? null : _resetSpeakersAction,
                      child: Text(t('note.resetAB')),
                    ),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _controller,
                style: TextStyle(color: FigmaDesign.of(context).text),
                decoration: InputDecoration(
                  hintText: t('note.searchOrTypeSpeaker'),
                  hintStyle: TextStyle(color: FigmaDesign.of(context).textMuted),
                  filled: true,
                  fillColor: FigmaDesign.of(context).field,
                  contentPadding:
                      const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(18),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
              const SizedBox(height: 18),
              Flexible(
                child: _loading
                    ? const Center(child: CircularProgressIndicator())
                    : ListView(
                        shrinkWrap: true,
                        children: [
                          if (filteredSavedSpeakers.isNotEmpty)
                            _SpeakerSectionTitle(t('note.savedSpeakers')),
                          if (_savedSpeakers.isEmpty)
                            _SpeakerEmptyRow(t('note.noSavedSpeakers'))
                          else if (filteredSavedSpeakers.isEmpty)
                            _SpeakerEmptyRow(
                              t('note.noSavedSpeakerMatch'),
                            )
                          else
                            for (final speaker in filteredSavedSpeakers)
                              _SpeakerChoiceRow(
                                title: speaker.name,
                                subtitle:
                                    speaker.microsoftId != null && speaker.email != null
                                        ? speaker.email
                                        : null,
                                selected: _pickedSpeakerId == speaker.id,
                                onTap:
                                    _saving ? null : () => _selectSavedSpeaker(speaker),
                              ),
                          const SizedBox(height: 16),
                          if (_contactError == null && filteredContacts.isNotEmpty)
                            _SpeakerSectionTitle(t('note.tecAceMembers')),
                          if (_contactError != null)
                            _SpeakerEmptyRow(_contactError!)
                          else if (_contacts.isEmpty)
                            _SpeakerEmptyRow(t('note.noTecAceContacts'))
                          else if (filteredContacts.isEmpty)
                            _SpeakerEmptyRow(t('note.noTecAceMatch'))
                          else
                            for (final contact in filteredContacts)
                              _SpeakerChoiceRow(
                                title: contact.displayName,
                                subtitle: _savedSpeakerForContact(contact) == null
                                    ? contact.email
                                    : t('note.savedSpeaker'),
                                onTap:
                                    _saving ? null : () => _applyContact(contact),
                              ),
                        ],
                      ),
              ),
              const SizedBox(height: 14),
              _ScopeChoice(
                value: _scope,
                onChanged: (value) => setState(() => _scope = value),
                singleLabel: t('note.scopeSingle'),
                fromHereLabel: t('note.scopeFromHere'),
                allLabel: t('note.scopeAll'),
              ),
              if (_error != null) ...[
                const SizedBox(height: 10),
                Text(
                  _error!,
                  style: const TextStyle(
                    fontSize: 12,
                    color: Color(0xFFE5484D),
                  ),
                ),
              ],
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _saving ? null : _applyCustomSpeaker,
                  style: ElevatedButton.styleFrom(
                    elevation: 0,
                    backgroundColor: const Color(0xFF2F80ED),
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(18),
                    ),
                  ),
                  child: Text(_saving ? t('note.saving') : t('note.change')),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  bool _matchesSavedSpeaker(SavedSpeaker speaker, String query) {
    if (query.isEmpty) return true;
    return speaker.name.toLowerCase().contains(query) ||
        (speaker.email ?? '').toLowerCase().contains(query) ||
        (speaker.profile ?? '').toLowerCase().contains(query);
  }

  bool _matchesTecAceContact(TecAceContact contact, String query) {
    if (query.isEmpty) return true;
    return contact.displayName.toLowerCase().contains(query) ||
        contact.email.toLowerCase().contains(query) ||
        contact.userPrincipalName.toLowerCase().contains(query);
  }

  SavedSpeaker? _savedSpeakerForContact(TecAceContact contact) {
    for (final speaker in _savedSpeakers) {
      if (speaker.microsoftId != null && speaker.microsoftId == contact.id) {
        return speaker;
      }
      if ((speaker.email ?? '').toLowerCase() == contact.email.toLowerCase()) {
        return speaker;
      }
    }
    return null;
  }
}

class _ScopeChoice extends StatelessWidget {
  const _ScopeChoice({
    required this.value,
    required this.onChanged,
    required this.singleLabel,
    required this.fromHereLabel,
    required this.allLabel,
  });

  final _ReplacementScope value;
  final ValueChanged<_ReplacementScope> onChanged;
  final String singleLabel;
  final String fromHereLabel;
  final String allLabel;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        _ScopeRow(
          label: singleLabel,
          selected: value == _ReplacementScope.single,
          onTap: () => onChanged(_ReplacementScope.single),
        ),
        _ScopeRow(
          label: fromHereLabel,
          selected: value == _ReplacementScope.fromHere,
          onTap: () => onChanged(_ReplacementScope.fromHere),
        ),
        _ScopeRow(
          label: allLabel,
          selected: value == _ReplacementScope.all,
          onTap: () => onChanged(_ReplacementScope.all),
        ),
      ],
    );
  }
}

class _ScopeRow extends StatelessWidget {
  const _ScopeRow({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          children: [
            Icon(
              selected
                  ? Icons.radio_button_checked_rounded
                  : Icons.radio_button_off_rounded,
              size: 19,
              color: selected ? FigmaDesign.activeBlue : palette.textMuted,
            ),
            const SizedBox(width: 10),
            Text(
              label,
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w400,
                color: palette.textSecondary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SpeakerSectionTitle extends StatelessWidget {
  const _SpeakerSectionTitle(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w600,
          color: FigmaDesign.of(context).textMuted,
        ),
      ),
    );
  }
}

class _SpeakerChoiceRow extends StatelessWidget {
  const _SpeakerChoiceRow({
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.selected = false,
  });

  final String title;
  final String? subtitle;
  final VoidCallback? onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    final color = _speakerColor(title);
    return InkWell(
      borderRadius: BorderRadius.circular(18),
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: selected
              ? (dark ? const Color(0xFF17345D) : const Color(0xFFE8F2FF))
              : palette.field,
          borderRadius: BorderRadius.circular(18),
          border: selected
              ? Border.all(color: const Color(0xFFB8DAFF))
              : Border.all(color: Colors.transparent),
        ),
        child: Row(
          children: [
            Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(
                color: color.background,
                shape: BoxShape.circle,
              ),
              child: Center(
                child: Text(
                  title.substring(0, 1).toUpperCase(),
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: color.foreground,
                  ),
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                      color: palette.text,
                    ),
                  ),
                  if (subtitle != null && subtitle!.trim().isNotEmpty)
                    Text(
                      subtitle!,
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
            Icon(
              Icons.chevron_right_rounded,
              color: palette.textMuted,
            ),
          ],
        ),
      ),
    );
  }
}

class _SpeakerEmptyRow extends StatelessWidget {
  const _SpeakerEmptyRow(this.message);

  final String message;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: palette.field,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Text(
        message,
        style: TextStyle(
          fontSize: 12,
          height: 1.35,
          fontWeight: FontWeight.w300,
          color: palette.textMuted,
        ),
      ),
    );
  }
}
