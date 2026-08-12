import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/widgets/widgets.dart';
import '../data/notes_repository.dart';
import '../models/meeting_note.dart';

class SummaryScreen extends ConsumerWidget {
  const SummaryScreen({super.key, required this.noteId});

  final String noteId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
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
              title: 'Failed to load note',
              subtitle: '$e',
            ),
          ),
        ),
      ),
      data: (note) => _DetailScaffold(note: note),
    );
  }
}

class _DetailScaffold extends StatefulWidget {
  const _DetailScaffold({required this.note});

  final MeetingNote note;

  @override
  State<_DetailScaffold> createState() => _DetailScaffoldState();
}

class _DetailScaffoldState extends State<_DetailScaffold> {
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
    return Scaffold(
      backgroundColor: FigmaDesign.of(context).pageBackground,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 33, 24, 0),
          child: Column(
            children: [
              _DetailHeader(note: note),
              const SizedBox(height: 19),
              _SegmentedTabs(
                selected: _tab,
                onChanged: (value) => setState(() => _tab = value),
              ),
              const SizedBox(height: 19),
              Expanded(
                child: IndexedStack(
                  index: _tab,
                  children: [
                    _SummaryTab(note: note),
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
  const _DetailHeader({required this.note});

  final MeetingNote note;

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
              'Back',
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
            'More',
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
  });

  final int selected;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    return FigmaSlidingSegmentedToggle(
      options: const [
        FigmaSegmentOption(label: 'Summary'),
        FigmaSegmentOption(label: 'Transcript'),
      ],
      selectedIndex: selected,
      onChanged: onChanged,
      height: 44,
    );
  }
}

class _SummaryTab extends StatelessWidget {
  const _SummaryTab({required this.note});

  final MeetingNote note;

  @override
  Widget build(BuildContext context) {
    final summary = note.displaySummary;
    if (summary.isEmpty) {
      return const EmptyState(
        icon: Icons.hourglass_empty_rounded,
        title: 'No summary yet',
        subtitle: 'This note has no summary. Try retrying the job.',
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
        const SizedBox(height: 28),
      ],
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
    final segments = note.transcript;
    if (segments.isEmpty) {
      return const EmptyState(
        icon: Icons.subject_rounded,
        title: 'No transcript',
      );
    }

    final speakers = _orderedSpeakers(segments);
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
              label: 'All',
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
  });

  final TranscriptSegment segment;
  final VoidCallback onSpeakerTap;

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
                Text(
                  segment.text,
                  style: TextStyle(
                    fontSize: 13,
                    height: 1.35,
                    fontWeight: FontWeight.w300,
                    color: palette.textSecondary,
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

  Future<void> _runAction(String label, Future<void> Function() action) async {
    setState(() => _activeAction = label);
    try {
      await action();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('$label failed: $error')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final note = widget.note;
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
              label: 'Copy',
              active: _activeAction == 'Copy',
              onTap: () => _runAction('Copy', () async {
                final text = widget.tab == 0
                    ? note.displaySummary
                    : _transcriptCopyText(note);
                await Clipboard.setData(ClipboardData(text: text));
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(widget.tab == 0
                        ? 'Summary copied'
                        : 'Transcript copied'),
                  ),
                );
              }),
            ),
            _ActionText(
              label: 'Share',
              active: _activeAction == 'Share',
              onTap: () => _runAction('Share', () async {
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
                  const SnackBar(content: Text('Sharing updated.')),
                );
              }),
            ),
            _ActionText(
              label: 'Sync Profile',
              active: _activeAction == 'Sync Profile',
              onTap: () => _runAction('Sync Profile', () async {
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
              label: 'Regenerate',
              active: _activeAction == 'Regenerate',
              onTap: note.transcript.isEmpty
                  ? null
                  : () => _runAction('Regenerate', () async {
                      final confirmed = await showDialog<bool>(
                        context: context,
                        builder: (context) => AlertDialog(
                          title: const Text('Regenerate summary?'),
                          content: const Text(
                            'This will replace the edited summary for this note.',
                          ),
                          actions: [
                            TextButton(
                              onPressed: () => Navigator.pop(context, false),
                              child: const Text('Cancel'),
                            ),
                            FilledButton(
                              onPressed: () => Navigator.pop(context, true),
                              child: const Text('Regenerate'),
                            ),
                          ],
                        ),
                      );
                      if (confirmed != true) return;
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Regenerating summary...')),
                      );
                      final summary = await ref
                          .read(notesRepositoryProvider)
                          .regenerateSummary(note);
                      widget.onNoteChanged(note.copyWith(summaryEdit: summary));
                      if (!mounted) return;
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Summary regenerated.')),
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

class _DetailShareNoteSheet extends StatefulWidget {
  const _DetailShareNoteSheet({
    required this.note,
    required this.repository,
  });

  final MeetingNote note;
  final NotesRepository repository;

  @override
  State<_DetailShareNoteSheet> createState() => _DetailShareNoteSheetState();
}

class _DetailShareNoteSheetState extends State<_DetailShareNoteSheet> {
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
              _DetailSheetHeader(title: 'Share note', subtitle: widget.note.title),
              const SizedBox(height: 12),
              _DetailSheetSearchField(
                hintText: 'Search TecAce members',
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
                        'Could not load TecAce members: ${snapshot.error}',
                      );
                    }
                    final contacts = (snapshot.data ?? const <TecAceContact>[])
                        .where((contact) => _contactMatches(contact, _query))
                        .toList();
                    if (contacts.isEmpty) {
                      return const _DetailSheetMessage('No TecAce members found.');
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
                  child: Text('Share with ${_selectedIds.length}'),
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

class _DetailSyncProfilesSheet extends StatefulWidget {
  const _DetailSyncProfilesSheet({
    required this.note,
    required this.repository,
  });

  final MeetingNote note;
  final NotesRepository repository;

  @override
  State<_DetailSyncProfilesSheet> createState() => _DetailSyncProfilesSheetState();
}

class _DetailSyncProfilesSheetState extends State<_DetailSyncProfilesSheet> {
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
                  const _DetailSheetHeader(
                    title: 'Sync Profile',
                    subtitle: 'AI-generated speaker profiles from this transcript',
                  ),
                  const SizedBox(height: 12),
                  if (snapshot.connectionState == ConnectionState.waiting)
                    const Flexible(child: Center(child: CircularProgressIndicator()))
                  else if (snapshot.hasError)
                    Flexible(
                      child: _DetailSheetMessage(
                        'Profile sync failed: ${snapshot.error}',
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
                        child: Text(_savingAll ? 'Saving...' : 'Save all profiles'),
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
        const SnackBar(content: Text('Speaker profiles saved.')),
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
    required this.onSave,
  });

  final GeneratedSpeakerProfile profile;
  final bool saved;
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
                child: Text(saved ? 'Saved' : 'Save'),
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

class _SpeakerPickerSheet extends StatefulWidget {
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
  State<_SpeakerPickerSheet> createState() => _SpeakerPickerSheetState();
}

class _SpeakerPickerSheetState extends State<_SpeakerPickerSheet> {
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
        contactError =
            'TecAce directory unavailable. Sign out and back in if Microsoft asks for new permissions.';
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
      setState(() => _error = 'Enter a speaker name.');
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
                      'Change speaker',
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
                      child: const Text('Reset A/B'),
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
                  hintText: 'Search or type speaker',
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
                            _SpeakerSectionTitle('Saved speakers'),
                          if (_savedSpeakers.isEmpty)
                            const _SpeakerEmptyRow('No saved speakers yet.')
                          else if (filteredSavedSpeakers.isEmpty)
                            const _SpeakerEmptyRow(
                              'No saved speaker matches. Type a new name to add one.',
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
                            _SpeakerSectionTitle('TecAce Members'),
                          if (_contactError != null)
                            _SpeakerEmptyRow(_contactError!)
                          else if (_contacts.isEmpty)
                            const _SpeakerEmptyRow('No TecAce contacts found.')
                          else if (filteredContacts.isEmpty)
                            const _SpeakerEmptyRow('No TecAce members match.')
                          else
                            for (final contact in filteredContacts)
                              _SpeakerChoiceRow(
                                title: contact.displayName,
                                subtitle: _savedSpeakerForContact(contact) == null
                                    ? contact.email
                                    : 'Saved speaker',
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
                  child: Text(_saving ? 'Saving...' : 'Change'),
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
  });

  final _ReplacementScope value;
  final ValueChanged<_ReplacementScope> onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        _ScopeRow(
          label: 'Only this instance',
          selected: value == _ReplacementScope.single,
          onTap: () => onChanged(_ReplacementScope.single),
        ),
        _ScopeRow(
          label: 'This and all following instances',
          selected: value == _ReplacementScope.fromHere,
          onTap: () => onChanged(_ReplacementScope.fromHere),
        ),
        _ScopeRow(
          label: 'All instances',
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
