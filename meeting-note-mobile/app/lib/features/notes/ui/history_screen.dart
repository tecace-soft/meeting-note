import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../shared/widgets/widgets.dart';
import '../../projects/data/projects_repository.dart';
import '../data/notes_repository.dart';
import '../models/meeting_note.dart';

class HistoryScreen extends ConsumerStatefulWidget {
  const HistoryScreen({super.key});

  @override
  ConsumerState<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends ConsumerState<HistoryScreen> {
  String _query = '';
  NoteOwnershipFilter _ownership = NoteOwnershipFilter.all;
  NoteSortKey _sort = NoteSortKey.meetingDesc;
  bool _calendarMode = false;
  late Future<List<MeetingNote>> _notesFuture;

  @override
  void initState() {
    super.initState();
    _notesFuture = _load();
  }

  Future<List<MeetingNote>> _load() {
    return ref.read(notesRepositoryProvider).list(
          query: _query,
          ownership: _ownership,
          sort: _sort,
        );
  }

  void _refresh() {
    setState(() => _notesFuture = _load());
  }

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Scaffold(
      backgroundColor: palette.pageBackground,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 34, 24, 0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      'History',
                      style: TextStyle(
                        fontSize: 25,
                        height: 1,
                        fontWeight: FontWeight.w700,
                        color: palette.text,
                      ),
                    ),
                  ),
                  _HistoryModeToggle(
                    calendarMode: _calendarMode,
                    onChanged: (value) => setState(() => _calendarMode = value),
                  ),
                ],
              ),
              const SizedBox(height: 28),
              _HistorySearchField(
                onChanged: (value) {
                  _query = value;
                  _refresh();
                },
              ),
              const SizedBox(height: 18),
              _HistoryOwnershipFilters(
                selected: _ownership,
                onChanged: (value) {
                  setState(() => _ownership = value);
                  _refresh();
                },
              ),
              const SizedBox(height: 16),
              Expanded(
                child: FutureBuilder<List<MeetingNote>>(
                  future: _notesFuture,
                  builder: (context, snapshot) {
                    if (snapshot.connectionState == ConnectionState.waiting) {
                      return const Center(child: CircularProgressIndicator());
                    }
                    if (snapshot.hasError) {
                      return _ErrorState(error: snapshot.error, onRetry: _refresh);
                    }
                    final notes = snapshot.data ?? const [];
                    if (notes.isEmpty) {
                      return EmptyState(
                        icon: Icons.mic_none_rounded,
                        title: _query.isEmpty ? 'No notes yet' : 'No results',
                        subtitle: _query.isEmpty
                            ? 'Record or upload your first meeting to get started.'
                            : null,
                        action: _query.isEmpty
                            ? FilledButton(
                                onPressed: () => context.go('/record'),
                                child: const Text('Record a meeting'),
                              )
                            : null,
                      );
                    }
                    return RefreshIndicator(
                      onRefresh: () async => _refresh(),
                      child: _calendarMode
                          ? _CalendarHistory(
                              notes: notes,
                              onOpen: _openNote,
                              onActions: _showNoteActions,
                            )
                          : _ListHistory(
                              notes: notes,
                              onOpen: _openNote,
                              onActions: _showNoteActions,
                            ),
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

  void _openNote(MeetingNote note) {
    context.push('/note/${note.id}');
  }

  Future<void> _showNoteActions(MeetingNote note) async {
    final action = await showModalBottomSheet<_NoteAction>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                leading: const Icon(Icons.ios_share_rounded),
                title: const Text('Share'),
                onTap: () => Navigator.pop(context, _NoteAction.share),
              ),
              ListTile(
                leading: const Icon(Icons.create_new_folder_rounded),
                title: const Text('Add to project'),
                onTap: () => Navigator.pop(context, _NoteAction.project),
              ),
              ListTile(
                leading: const Icon(Icons.badge_rounded),
                title: const Text('Sync profile'),
                onTap: () => Navigator.pop(context, _NoteAction.profile),
              ),
              ListTile(
                leading: const Icon(Icons.auto_awesome_rounded),
                title: const Text('Regenerate summary'),
                enabled: note.transcript.isNotEmpty,
                onTap: note.transcript.isEmpty
                    ? null
                    : () => Navigator.pop(context, _NoteAction.regenerate),
              ),
              ListTile(
                leading: const Icon(Icons.edit_rounded),
                title: const Text('Rename note'),
                onTap: () => Navigator.pop(context, _NoteAction.rename),
              ),
              ListTile(
                leading: Icon(
                  Icons.delete_rounded,
                  color: Theme.of(context).colorScheme.error,
                ),
                title: Text(
                  'Delete note',
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
                onTap: () => Navigator.pop(context, _NoteAction.delete),
              ),
            ],
          ),
        ),
      ),
    );

    if (!mounted || action == null) return;
    try {
      switch (action) {
        case _NoteAction.share:
          await _shareNote(note);
          break;
        case _NoteAction.project:
          await _addNoteToProject(note);
          break;
        case _NoteAction.profile:
          await _syncProfiles(note);
          break;
        case _NoteAction.regenerate:
          await _regenerateSummary(note);
          break;
        case _NoteAction.rename:
          await _renameNote(note);
          break;
        case _NoteAction.delete:
          await _deleteNote(note);
          break;
      }
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Action failed: $error')),
      );
    }
  }

  Future<void> _shareNote(MeetingNote note) async {
    final selected = await showModalBottomSheet<List<String>>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (context) => _ShareNoteSheet(
        note: note,
        repository: ref.read(notesRepositoryProvider),
      ),
    );
    if (selected == null) return;
    await ref.read(notesRepositoryProvider).shareNote(note.id, selected);
    _refresh();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Sharing updated.')),
    );
  }

  Future<void> _addNoteToProject(MeetingNote note) async {
    final project = await showModalBottomSheet<MeetingProject>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (context) => _AddToProjectSheet(
        note: note,
        projectsRepository: ref.read(projectsRepositoryProvider),
      ),
    );
    if (project == null) return;
    await ref.read(notesRepositoryProvider).addNoteToProject(
          noteId: note.id,
          projectId: project.id,
        );
    _refresh();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Added to ${project.name}.')),
    );
  }

  Future<void> _syncProfiles(MeetingNote note) async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (context) => _SyncProfilesSheet(
        note: note,
        repository: ref.read(notesRepositoryProvider),
      ),
    );
  }

  Future<void> _regenerateSummary(MeetingNote note) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Regenerate summary?'),
        content: const Text('This will replace the edited summary for this note.'),
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
    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(
      const SnackBar(content: Text('Regenerating summary...')),
    );
    try {
      await ref.read(notesRepositoryProvider).regenerateSummary(note);
      _refresh();
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('Summary regenerated.')),
      );
    } catch (error) {
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text('Regenerate failed: $error')),
      );
    }
  }

  Future<void> _renameNote(MeetingNote note) async {
    final controller = TextEditingController(text: note.title);
    final name = await showDialog<String>(
      context: context,
      builder: (context) {
        final palette = FigmaDesign.of(context);
        return Dialog(
          insetPadding: const EdgeInsets.symmetric(horizontal: 24),
          backgroundColor: Colors.transparent,
          child: Container(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
            decoration: BoxDecoration(
              color: palette.card,
              borderRadius: BorderRadius.circular(24),
              boxShadow: [
                BoxShadow(
                  color: palette.cardShadow,
                  blurRadius: 28,
                  offset: const Offset(0, 14),
                ),
              ],
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        'Rename note',
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w600,
                          color: palette.text,
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Close',
                      onPressed: () => Navigator.pop(context),
                      icon: Icon(Icons.close_rounded, color: palette.textMuted),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: controller,
                  autofocus: true,
                  style: TextStyle(color: palette.text),
                  decoration: InputDecoration(
                    hintText: 'Note title',
                    hintStyle: TextStyle(color: palette.textMuted),
                    filled: true,
                    fillColor: palette.field,
                    contentPadding:
                        const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(18),
                      borderSide: BorderSide.none,
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(18),
                      borderSide: BorderSide(color: palette.fieldBorder),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(18),
                      borderSide: const BorderSide(color: Color(0xFF2F80FF)),
                    ),
                  ),
                  textInputAction: TextInputAction.done,
                  onSubmitted: (_) {
                    final value = controller.text.trim();
                    Navigator.pop(context, value.isEmpty ? null : value);
                  },
                ),
                const SizedBox(height: 18),
                GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () {
                    final value = controller.text.trim();
                    Navigator.pop(context, value.isEmpty ? null : value);
                  },
                  child: Container(
                    height: 50,
                    width: double.infinity,
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        colors: FigmaDesign.primaryGradient,
                      ),
                      borderRadius: BorderRadius.circular(18),
                      boxShadow: const [
                        BoxShadow(
                          color: Color(0x263B82F6),
                          blurRadius: 16,
                          offset: Offset(0, 8),
                        ),
                      ],
                    ),
                    child: const Center(
                      child: Text(
                        'Save',
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
    WidgetsBinding.instance.addPostFrameCallback((_) => controller.dispose());
    if (name == null) return;
    await ref.read(notesRepositoryProvider).rename(note.id, name);
    _refresh();
  }

  Future<void> _deleteNote(MeetingNote note) async {
    final currentUserId = await ref.read(notesRepositoryProvider).currentUserId();
    final sharedWithMe = currentUserId != null &&
        note.ownerId != currentUserId &&
        note.sharedUserIds.contains(currentUserId);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(sharedWithMe ? 'Remove shared note?' : 'Delete note?'),
        content: Text(
          sharedWithMe
              ? '"${note.title}" will be removed from your shared notes. The owner will keep access.'
              : '"${note.title}" will be permanently deleted.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(sharedWithMe ? 'Remove' : 'Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    if (sharedWithMe) {
      await ref.read(notesRepositoryProvider).removeCurrentUserFromSharedNote(note.id);
    } else {
      await ref.read(notesRepositoryProvider).delete(note.id);
    }
    _refresh();
  }
}

class _HistoryModeToggle extends StatelessWidget {
  const _HistoryModeToggle({
    required this.calendarMode,
    required this.onChanged,
  });

  final bool calendarMode;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 40,
      width: 104,
      child: FigmaSlidingSegmentedToggle(
        height: 40,
        options: const [
          FigmaSegmentOption(label: 'List', icon: Icons.view_list_rounded),
          FigmaSegmentOption(
            label: 'Calendar',
            icon: Icons.calendar_month_rounded,
          ),
        ],
        selectedIndex: calendarMode ? 1 : 0,
        onChanged: (index) => onChanged(index == 1),
      ),
    );
  }
}

class _HistorySearchField extends StatelessWidget {
  const _HistorySearchField({required this.onChanged});

  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Container(
      height: 46,
      decoration: BoxDecoration(
        color: palette.card,
        borderRadius: BorderRadius.circular(24),
        boxShadow: [
          BoxShadow(
            color: palette.cardShadow,
            blurRadius: 18,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: TextField(
        onChanged: onChanged,
        style: TextStyle(
          fontSize: 14,
          fontWeight: FontWeight.w400,
          color: palette.text,
        ),
        decoration: InputDecoration(
          hintText: 'Search title, summary, speaker, tag',
          hintStyle: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w300,
            color: palette.textMuted,
          ),
          border: InputBorder.none,
          isCollapsed: true,
          contentPadding: const EdgeInsets.fromLTRB(20, 14, 20, 13),
        ),
      ),
    );
  }
}

class _HistoryOwnershipFilters extends StatelessWidget {
  const _HistoryOwnershipFilters({
    required this.selected,
    required this.onChanged,
  });

  final NoteOwnershipFilter selected;
  final ValueChanged<NoteOwnershipFilter> onChanged;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 10,
      children: [
        _HistoryFilterChip(
          label: 'All',
          selected: selected == NoteOwnershipFilter.all,
          onTap: () => onChanged(NoteOwnershipFilter.all),
        ),
        _HistoryFilterChip(
          label: 'Mine',
          selected: selected == NoteOwnershipFilter.mine,
          onTap: () => onChanged(NoteOwnershipFilter.mine),
        ),
        _HistoryFilterChip(
          label: 'Shared',
          selected: selected == NoteOwnershipFilter.shared,
          onTap: () => onChanged(NoteOwnershipFilter.shared),
        ),
      ],
    );
  }
}

class _HistoryFilterChip extends StatelessWidget {
  const _HistoryFilterChip({
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
    final dark = Theme.of(context).brightness == Brightness.dark;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        height: 32,
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
              fontSize: 13,
              fontWeight: FontWeight.w400,
              color:
                  selected ? const Color(0xFF2F80FF) : palette.textSecondary,
            ),
          ),
        ),
      ),
    );
  }
}

class _ListHistory extends StatelessWidget {
  const _ListHistory({
    required this.notes,
    required this.onOpen,
    required this.onActions,
  });

  final List<MeetingNote> notes;
  final ValueChanged<MeetingNote> onOpen;
  final ValueChanged<MeetingNote> onActions;

  @override
  Widget build(BuildContext context) {
    return ListView.separated(
      padding: const EdgeInsets.only(bottom: 24),
      itemCount: notes.length,
      separatorBuilder: (_, __) => const SizedBox(height: 12),
      itemBuilder: (context, index) => _HistoryNoteCard(
        note: notes[index],
        onOpen: () => onOpen(notes[index]),
        onActions: () => onActions(notes[index]),
      ),
    );
  }
}

class _CalendarHistory extends StatelessWidget {
  const _CalendarHistory({
    required this.notes,
    required this.onOpen,
    required this.onActions,
  });

  final List<MeetingNote> notes;
  final ValueChanged<MeetingNote> onOpen;
  final ValueChanged<MeetingNote> onActions;

  @override
  Widget build(BuildContext context) {
    final grouped = <String, List<MeetingNote>>{};
    for (final note in notes) {
      final key = DateFormat('EEEE, MMM d').format(note.displayDate);
      grouped.putIfAbsent(key, () => []).add(note);
    }

    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        for (final entry in grouped.entries) ...[
          Padding(
            padding: const EdgeInsets.only(bottom: 8, top: 8),
            child: Text(
              entry.key,
              style: Theme.of(context).textTheme.titleSmall,
            ),
          ),
          for (final note in entry.value) ...[
            _HistoryNoteCard(
              note: note,
              onOpen: () => onOpen(note),
              onActions: () => onActions(note),
            ),
            const SizedBox(height: 10),
          ],
        ],
      ],
    );
  }
}

class _HistoryNoteCard extends StatelessWidget {
  const _HistoryNoteCard({
    required this.note,
    required this.onOpen,
    required this.onActions,
  });

  final MeetingNote note;
  final VoidCallback onOpen;
  final VoidCallback onActions;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(20),
        onTap: onOpen,
        child: Container(
          constraints: const BoxConstraints(minHeight: 92),
          padding: const EdgeInsets.fromLTRB(18, 16, 16, 14),
          decoration: BoxDecoration(
            color: palette.card,
            borderRadius: BorderRadius.circular(20),
            boxShadow: [
              BoxShadow(
                color: palette.cardShadow,
                blurRadius: 18,
                offset: const Offset(0, 8),
              ),
            ],
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      note.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 16,
                        height: 1.15,
                        fontWeight: FontWeight.w600,
                        color: palette.text,
                      ),
                    ),
                    const SizedBox(height: 7),
                    Text(
                      '${_historyDateLabel(note.displayDate)} - ${note.durationLabel}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        height: 1.2,
                        fontWeight: FontWeight.w300,
                        color: palette.textSecondary,
                      ),
                    ),
                    const SizedBox(height: 7),
                    Text(
                      _historyMetaLabel(note),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        height: 1.2,
                        fontWeight: FontWeight.w300,
                        color: palette.textMuted,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 14),
              _HistoryMenuButton(onTap: onActions),
            ],
          ),
        ),
      ),
    );
  }
}

class _HistoryMenuButton extends StatelessWidget {
  const _HistoryMenuButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        width: 36,
        height: 28,
        decoration: BoxDecoration(
          color: dark ? const Color(0xFF17345D) : const Color(0xFFE8F2FF),
          borderRadius: BorderRadius.circular(16),
        ),
        child: const Icon(
          Icons.more_horiz_rounded,
          size: 20,
          color: Color(0xFF2F80FF),
        ),
      ),
    );
  }
}

class _ShareNoteSheet extends StatefulWidget {
  const _ShareNoteSheet({
    required this.note,
    required this.repository,
  });

  final MeetingNote note;
  final NotesRepository repository;

  @override
  State<_ShareNoteSheet> createState() => _ShareNoteSheetState();
}

class _ShareNoteSheetState extends State<_ShareNoteSheet> {
  late Future<List<TecAceContact>> _future;
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
    final palette = FigmaDesign.of(context);
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          bottom: MediaQuery.viewInsetsOf(context).bottom + 20,
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.82),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _SheetHeader(title: 'Share note', subtitle: widget.note.title),
              const SizedBox(height: 12),
              _SheetSearchField(
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
                      return _SheetMessage('Could not load TecAce members: ${snapshot.error}');
                    }
                    final contacts = (snapshot.data ?? const <TecAceContact>[])
                        .where((contact) => _contactMatches(contact, _query))
                        .toList();
                    if (contacts.isEmpty) return const _SheetMessage('No TecAce members found.');
                    return ListView.separated(
                      shrinkWrap: true,
                      itemCount: contacts.length,
                      separatorBuilder: (_, __) => const SizedBox(height: 8),
                      itemBuilder: (context, index) {
                        final contact = contacts[index];
                        final selected = _selectedIds.contains(contact.id);
                        return _SelectableSheetRow(
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
              const SizedBox(height: 6),
              Text(
                'Existing shared users are preselected.',
                style: TextStyle(fontSize: 11, color: palette.textMuted),
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

class _AddToProjectSheet extends StatelessWidget {
  const _AddToProjectSheet({
    required this.note,
    required this.projectsRepository,
  });

  final MeetingNote note;
  final ProjectsRepository projectsRepository;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.72),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _SheetHeader(title: 'Add to Project', subtitle: note.title),
              const SizedBox(height: 12),
              Flexible(
                child: FutureBuilder<List<MeetingProject>>(
                  future: projectsRepository.list(),
                  builder: (context, snapshot) {
                    if (snapshot.connectionState == ConnectionState.waiting) {
                      return const Center(child: CircularProgressIndicator());
                    }
                    if (snapshot.hasError) {
                      return _SheetMessage('Could not load projects: ${snapshot.error}');
                    }
                    final projects = snapshot.data ?? const <MeetingProject>[];
                    if (projects.isEmpty) return const _SheetMessage('No projects found.');
                    return ListView.separated(
                      shrinkWrap: true,
                      itemCount: projects.length,
                      separatorBuilder: (_, __) => const SizedBox(height: 8),
                      itemBuilder: (context, index) {
                        final project = projects[index];
                        final alreadyAdded = note.projectIds.any(
                          (id) => id.toString() == project.id.toString(),
                        );
                        return _SelectableSheetRow(
                          title: project.name,
                          subtitle: alreadyAdded ? 'Already in project' : 'Add to project',
                          selected: alreadyAdded,
                          enabled: !alreadyAdded,
                          onTap: alreadyAdded ? null : () => Navigator.pop(context, project),
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

class _SyncProfilesSheet extends StatefulWidget {
  const _SyncProfilesSheet({
    required this.note,
    required this.repository,
  });

  final MeetingNote note;
  final NotesRepository repository;

  @override
  State<_SyncProfilesSheet> createState() => _SyncProfilesSheetState();
}

class _SyncProfilesSheetState extends State<_SyncProfilesSheet> {
  late Future<List<GeneratedSpeakerProfile>> _future;
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
    final palette = FigmaDesign.of(context);
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          bottom: MediaQuery.viewInsetsOf(context).bottom + 20,
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.86),
          child: FutureBuilder<List<GeneratedSpeakerProfile>>(
            future: _future,
            builder: (context, snapshot) {
              final profiles = snapshot.data ?? const <GeneratedSpeakerProfile>[];
              return Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _SheetHeader(
                    title: 'Sync Profile',
                    subtitle: 'AI-generated speaker profiles from this transcript',
                  ),
                  const SizedBox(height: 12),
                  if (snapshot.connectionState == ConnectionState.waiting)
                    const Flexible(child: Center(child: CircularProgressIndicator()))
                  else if (snapshot.hasError)
                    Flexible(child: _SheetMessage('Profile sync failed: ${snapshot.error}'))
                  else
                    Flexible(
                      child: ListView.separated(
                        shrinkWrap: true,
                        itemCount: profiles.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 10),
                        itemBuilder: (context, index) {
                          final profile = profiles[index];
                          final saved = _savedSpeakerNames.contains(profile.speakerName);
                          return _GeneratedProfileCard(
                            profile: profile,
                            saved: saved,
                            onSave: saved ? null : () => _saveProfile(profile),
                          );
                        },
                      ),
                    ),
                  if (_error != null) ...[
                    const SizedBox(height: 10),
                    Text(_error!, style: const TextStyle(color: Color(0xFFE5484D), fontSize: 12)),
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
                    const SizedBox(height: 6),
                    Text(
                      'Profiles are saved to your speaker profiles.',
                      style: TextStyle(fontSize: 11, color: palette.textMuted),
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

class _GeneratedProfileCard extends StatelessWidget {
  const _GeneratedProfileCard({
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

class _SheetHeader extends StatelessWidget {
  const _SheetHeader({required this.title, this.subtitle});

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

class _SheetSearchField extends StatelessWidget {
  const _SheetSearchField({
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

class _SelectableSheetRow extends StatelessWidget {
  const _SelectableSheetRow({
    required this.title,
    required this.subtitle,
    required this.selected,
    required this.onTap,
    this.enabled = true,
  });

  final String title;
  final String subtitle;
  final bool selected;
  final VoidCallback? onTap;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Opacity(
      opacity: enabled ? 1 : 0.62,
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: enabled ? onTap : null,
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
      ),
    );
  }
}

class _SheetMessage extends StatelessWidget {
  const _SheetMessage(this.message);

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

String _historyDateLabel(DateTime value) {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final date = DateTime(value.year, value.month, value.day);
  final time = DateFormat('HH:mm').format(value);
  if (date == today) return 'Today $time';
  if (date == today.subtract(const Duration(days: 1))) return 'Yesterday $time';
  return '${DateFormat('EEE M/d').format(value)} - $time';
}

String _historyMetaLabel(MeetingNote note) {
  final speakers = note.transcript
      .map((segment) => segment.speaker?.trim() ?? '')
      .where((speaker) => speaker.isNotEmpty)
      .toSet()
      .length;
  final speakerText = speakers == 1 ? '1 speaker' : '$speakers speakers';
  final tags = note.tags.take(2).map((tag) => '#$tag').join(' ');
  return tags.isEmpty ? speakerText : '$speakerText - $tags';
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.error, required this.onRetry});

  final Object? error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return EmptyState(
      icon: Icons.error_outline_rounded,
      title: 'Failed to load history',
      subtitle: error.toString(),
      action: FilledButton(
        onPressed: onRetry,
        child: const Text('Try again'),
      ),
    );
  }
}

enum _NoteAction {
  share,
  project,
  profile,
  regenerate,
  rename,
  delete,
}
