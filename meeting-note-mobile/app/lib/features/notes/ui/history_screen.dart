import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/i18n/app_strings.dart';
import '../../../shared/widgets/widgets.dart';
import '../../auth/data/mobile_supabase_session.dart';
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
  int _loadRetries = 0;
  int _loadVersion = 0;
  String? _currentUserId;
  late Future<List<MeetingNote>> _notesFuture;

  @override
  void initState() {
    super.initState();
    _notesFuture = _load();
    MobileSupabaseSession.cachedUserId().then((userId) {
      if (!mounted) return;
      setState(() => _currentUserId = userId);
    });
  }

  Future<List<MeetingNote>> _load({bool preferCache = true}) async {
    final repository = ref.read(notesRepositoryProvider);
    final query = _query;
    final ownership = _ownership;
    final sort = _sort;
    final version = ++_loadVersion;
    if (preferCache) {
      final cached = await repository.cachedList(
        query: query,
        ownership: ownership,
        sort: sort,
      );
      if (cached != null) {
        _refreshFromNetwork(
          query: query,
          ownership: ownership,
          sort: sort,
          version: version,
        );
        return cached;
      }
    }
    return repository.refreshList(
      query: query,
      ownership: ownership,
      sort: sort,
    );
  }

  Future<void> _refresh({bool preferCache = false}) async {
    final future = _load(preferCache: preferCache);
    setState(() {
      _loadRetries = 0;
      _notesFuture = future;
    });
    await future;
  }

  Future<void> _refreshFromNetwork({
    required String query,
    required NoteOwnershipFilter ownership,
    required NoteSortKey sort,
    required int version,
  }) async {
    try {
      final notes = await ref.read(notesRepositoryProvider).refreshList(
            query: query,
            ownership: ownership,
            sort: sort,
          );
      if (!mounted ||
          version != _loadVersion ||
          query != _query ||
          ownership != _ownership ||
          sort != _sort) {
        return;
      }
      setState(() => _notesFuture = Future.value(notes));
    } catch (_) {
      // Keep showing cached notes.
    }
  }

  void _retryQuietly() {
    _loadRetries += 1;
    Future<void>.delayed(Duration(milliseconds: 500 * _loadRetries), () {
      if (!mounted) return;
      setState(() => _notesFuture = _load());
    });
  }

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final t = ref.watch(appTextProvider);
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
                      t('history.title'),
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
                    listLabel: t('history.list'),
                    calendarLabel: t('history.calendar'),
                    onChanged: (value) => setState(() => _calendarMode = value),
                  ),
                ],
              ),
              const SizedBox(height: 28),
              _HistorySearchField(
                hintText: t('history.searchHint'),
                onChanged: (value) {
                  _query = value;
                  _refresh(preferCache: true);
                },
              ),
              const SizedBox(height: 18),
              _HistoryOwnershipFilters(
                allLabel: t('history.filterAll'),
                mineLabel: t('history.filterMine'),
                sharedLabel: t('history.filterShared'),
                selected: _ownership,
                onChanged: (value) {
                  setState(() => _ownership = value);
                  _refresh(preferCache: true);
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
                      if (_loadRetries < 2) {
                        _retryQuietly();
                        return const Center(child: CircularProgressIndicator());
                      }
                      return _ErrorState(
                        error: snapshot.error,
                        title: t('history.loadFailedTitle'),
                        retryLabel: t('history.tryAgain'),
                        onRetry: _refresh,
                      );
                    }
                    _loadRetries = 0;
                    final notes = snapshot.data ?? const [];
                    if (notes.isEmpty) {
                      return EmptyState(
                        icon: Icons.mic_none_rounded,
                        title: _query.isEmpty
                            ? t('history.emptyTitle')
                            : t('history.emptyResults'),
                        subtitle: _query.isEmpty
                            ? t('history.emptySubtitle')
                            : null,
                        action: _query.isEmpty
                            ? FilledButton(
                                onPressed: () => context.go('/record'),
                                child: Text(t('history.recordMeeting')),
                              )
                            : null,
                      );
                    }
                    return RefreshIndicator(
                      onRefresh: _refresh,
                      child: _calendarMode
                          ? _CalendarHistory(
                              notes: notes,
                              currentUserId: _currentUserId,
                              onOpen: _openNote,
                              onActions: _showNoteActions,
                            )
                          : _ListHistory(
                              notes: notes,
                              currentUserId: _currentUserId,
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
    final t = ref.read(appTextProvider);
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
                title: Text(t('history.share')),
                onTap: () => Navigator.pop(context, _NoteAction.share),
              ),
              ListTile(
                leading: const Icon(Icons.create_new_folder_rounded),
                title: Text(t('history.addToProject')),
                onTap: () => Navigator.pop(context, _NoteAction.project),
              ),
              ListTile(
                leading: const Icon(Icons.badge_rounded),
                title: Text(t('history.syncProfile')),
                onTap: () => Navigator.pop(context, _NoteAction.profile),
              ),
              ListTile(
                leading: const Icon(Icons.auto_awesome_rounded),
                title: Text(t('history.regenerateSummaryAction')),
                enabled: note.transcript.isNotEmpty,
                onTap: note.transcript.isEmpty
                    ? null
                    : () => Navigator.pop(context, _NoteAction.regenerate),
              ),
              ListTile(
                leading: const Icon(Icons.edit_rounded),
                title: Text(t('history.renameNote')),
                onTap: () => Navigator.pop(context, _NoteAction.rename),
              ),
              ListTile(
                leading: Icon(
                  Icons.delete_rounded,
                  color: Theme.of(context).colorScheme.error,
                ),
                title: Text(
                  t('history.deleteNote'),
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
        SnackBar(content: Text('${t('history.actionFailed')}: $error')),
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
      SnackBar(content: Text(ref.read(appTextProvider)('history.sharingUpdated'))),
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
      SnackBar(
        content: Text(
          '${ref.read(appTextProvider)('history.addedToProject')}: ${project.name}',
        ),
      ),
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
    final t = ref.read(appTextProvider);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(t('history.regenerateConfirmTitle')),
        content: Text(t('history.regenerateConfirmBody')),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(t('common.cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(t('history.regenerate')),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(
      SnackBar(content: Text(t('history.regenerating'))),
    );
    try {
      await ref.read(notesRepositoryProvider).regenerateSummary(note);
      _refresh();
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text(t('history.summaryRegenerated'))),
      );
    } catch (error) {
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text('${t('history.regenerateFailed')}: $error')),
      );
    }
  }

  Future<void> _renameNote(MeetingNote note) async {
    final t = ref.read(appTextProvider);
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
                        t('history.renameNote'),
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w600,
                          color: palette.text,
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: t('history.close'),
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
                    hintText: t('history.noteTitleHint'),
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
                    child: Center(
                      child: Text(
                        t('history.save'),
                        style: const TextStyle(
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
    final t = ref.read(appTextProvider);
    final currentUserId = await ref.read(notesRepositoryProvider).currentUserId();
    final sharedWithMe = currentUserId != null &&
        note.ownerId != currentUserId &&
        note.sharedUserIds.contains(currentUserId);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(
          sharedWithMe
              ? t('history.removeSharedTitle')
              : t('history.deleteConfirmTitle'),
        ),
        content: Text(
          sharedWithMe
              ? '"${note.title}" ${t('history.removeSharedBody')}'
              : '"${note.title}" ${t('history.deleteBody')}',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(t('common.cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(sharedWithMe ? t('history.remove') : t('history.delete')),
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
    required this.listLabel,
    required this.calendarLabel,
    required this.onChanged,
  });

  final bool calendarMode;
  final String listLabel;
  final String calendarLabel;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 40,
      width: 104,
      child: FigmaSlidingSegmentedToggle(
        height: 40,
        options: [
          FigmaSegmentOption(label: listLabel, icon: Icons.view_list_rounded),
          FigmaSegmentOption(
            label: calendarLabel,
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
  const _HistorySearchField({required this.hintText, required this.onChanged});

  final String hintText;
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
          hintText: hintText,
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
    required this.allLabel,
    required this.mineLabel,
    required this.sharedLabel,
    required this.selected,
    required this.onChanged,
  });

  final String allLabel;
  final String mineLabel;
  final String sharedLabel;
  final NoteOwnershipFilter selected;
  final ValueChanged<NoteOwnershipFilter> onChanged;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 10,
      children: [
        _HistoryFilterChip(
          label: allLabel,
          selected: selected == NoteOwnershipFilter.all,
          activeColor: _allNotesColor,
          onTap: () => onChanged(NoteOwnershipFilter.all),
        ),
        _HistoryFilterChip(
          label: mineLabel,
          selected: selected == NoteOwnershipFilter.mine,
          activeColor: _mineNoteColor,
          dotColor: _mineNoteColor,
          onTap: () => onChanged(NoteOwnershipFilter.mine),
        ),
        _HistoryFilterChip(
          label: sharedLabel,
          selected: selected == NoteOwnershipFilter.shared,
          activeColor: _sharedNoteColor,
          dotColor: _sharedNoteColor,
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
    required this.activeColor,
    required this.onTap,
    this.dotColor,
  });

  final String label;
  final bool selected;
  final Color activeColor;
  final VoidCallback onTap;
  final Color? dotColor;

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
              ? (dark
                  ? activeColor.withOpacity(0.18)
                  : activeColor.withOpacity(0.10))
              : palette.card,
          borderRadius: BorderRadius.circular(18),
        ),
        child: Center(
          widthFactor: 1,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (dotColor != null) ...[
                _NoteAccentDot(color: dotColor!, size: 6),
                const SizedBox(width: 6),
              ],
              Text(
                label,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w400,
                  color: selected ? activeColor : palette.textSecondary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ListHistory extends StatelessWidget {
  const _ListHistory({
    required this.notes,
    required this.currentUserId,
    required this.onOpen,
    required this.onActions,
  });

  final List<MeetingNote> notes;
  final String? currentUserId;
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
        shared: _isSharedNote(notes[index], currentUserId),
        onOpen: () => onOpen(notes[index]),
        onActions: () => onActions(notes[index]),
      ),
    );
  }
}

enum _CalendarScope { month, week, day }

const _mineNoteColor = Color(0xFF4F46E5);
const _sharedNoteColor = Color(0xFF2EC4A6);
const _allNotesColor = Color(0xFF2F80FF);

class _CalendarHistory extends StatefulWidget {
  const _CalendarHistory({
    required this.notes,
    required this.currentUserId,
    required this.onOpen,
    required this.onActions,
  });

  final List<MeetingNote> notes;
  final String? currentUserId;
  final ValueChanged<MeetingNote> onOpen;
  final ValueChanged<MeetingNote> onActions;

  @override
  State<_CalendarHistory> createState() => _CalendarHistoryState();
}

class _CalendarHistoryState extends State<_CalendarHistory> {
  _CalendarScope _scope = _CalendarScope.month;
  late DateTime _focusedDay;

  @override
  void initState() {
    super.initState();
    _focusedDay = _startOfDay(
      widget.notes.isEmpty ? DateTime.now() : widget.notes.first.displayDate,
    );
  }

  @override
  Widget build(BuildContext context) {
    final notes = [...widget.notes]
      ..sort((a, b) => a.displayDate.compareTo(b.displayDate));

    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        _CalendarToolbar(
          focusedDay: _focusedDay,
          scope: _scope,
          onScopeChanged: (scope) => setState(() => _scope = scope),
          onPrevious: () => setState(() => _focusedDay = _shiftFocused(-1)),
          onNext: () => setState(() => _focusedDay = _shiftFocused(1)),
        ),
        const SizedBox(height: 14),
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 180),
          child: switch (_scope) {
            _CalendarScope.month => _MonthCalendarView(
                key: const ValueKey('month'),
                focusedDay: _focusedDay,
                notes: notes,
                currentUserId: widget.currentUserId,
                onDaySelected: (day) => setState(() {
                  _focusedDay = day;
                  _scope = _CalendarScope.day;
                }),
              ),
            _CalendarScope.week => _WeekCalendarView(
                key: const ValueKey('week'),
                focusedDay: _focusedDay,
                notes: notes,
                currentUserId: widget.currentUserId,
                onDaySelected: (day) => setState(() {
                  _focusedDay = day;
                  _scope = _CalendarScope.day;
                }),
              ),
            _CalendarScope.day => _DayCalendarView(
                key: const ValueKey('day'),
                day: _focusedDay,
                notes: notes,
                currentUserId: widget.currentUserId,
                onOpen: widget.onOpen,
                onActions: widget.onActions,
              ),
          },
        ),
      ],
    );
  }

  DateTime _shiftFocused(int direction) {
    return switch (_scope) {
      _CalendarScope.month =>
        DateTime(_focusedDay.year, _focusedDay.month + direction, 1),
      _CalendarScope.week => _focusedDay.add(Duration(days: 7 * direction)),
      _CalendarScope.day => _focusedDay.add(Duration(days: direction)),
    };
  }
}

class _CalendarToolbar extends ConsumerWidget {
  const _CalendarToolbar({
    required this.focusedDay,
    required this.scope,
    required this.onScopeChanged,
    required this.onPrevious,
    required this.onNext,
  });

  final DateTime focusedDay;
  final _CalendarScope scope;
  final ValueChanged<_CalendarScope> onScopeChanged;
  final VoidCallback onPrevious;
  final VoidCallback onNext;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final palette = FigmaDesign.of(context);
    final t = ref.watch(appTextProvider);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            IconButton(
              onPressed: onPrevious,
              icon: Icon(Icons.chevron_left_rounded, color: palette.text),
            ),
            Expanded(
              child: Text(
                _calendarTitle(focusedDay, scope),
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: palette.text,
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            IconButton(
              onPressed: onNext,
              icon: Icon(Icons.chevron_right_rounded, color: palette.text),
            ),
          ],
        ),
        const SizedBox(height: 10),
        FigmaSlidingSegmentedToggle(
          height: 38,
          options: [
            FigmaSegmentOption(label: t('history.month')),
            FigmaSegmentOption(label: t('history.week')),
            FigmaSegmentOption(label: t('history.day')),
          ],
          selectedIndex: scope.index,
          onChanged: (index) => onScopeChanged(_CalendarScope.values[index]),
        ),
      ],
    );
  }
}

class _MonthCalendarView extends StatelessWidget {
  const _MonthCalendarView({
    super.key,
    required this.focusedDay,
    required this.notes,
    required this.currentUserId,
    required this.onDaySelected,
  });

  final DateTime focusedDay;
  final List<MeetingNote> notes;
  final String? currentUserId;
  final ValueChanged<DateTime> onDaySelected;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final firstOfMonth = DateTime(focusedDay.year, focusedDay.month);
    final firstVisible =
        firstOfMonth.subtract(Duration(days: firstOfMonth.weekday % 7));
    final today = _startOfDay(DateTime.now());

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: palette.card,
        borderRadius: BorderRadius.circular(22),
        boxShadow: [
          BoxShadow(
            color: palette.cardShadow,
            blurRadius: 18,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Column(
        children: [
          Row(
            children: [
              for (final label in const ['S', 'M', 'T', 'W', 'T', 'F', 'S'])
                Expanded(
                  child: Center(
                    child: Text(
                      label,
                      style: TextStyle(
                        color: palette.textMuted,
                        fontSize: 11,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 8),
          GridView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: 42,
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 7,
              mainAxisSpacing: 6,
              crossAxisSpacing: 6,
            ),
            itemBuilder: (context, index) {
              final day = _startOfDay(firstVisible.add(Duration(days: index)));
              final dayNotes = _notesForDay(notes, day);
              final inMonth = day.month == focusedDay.month;
              final isToday = _sameDay(day, today);
              return GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => onDaySelected(day),
                child: Container(
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(
                    color: isToday
                        ? const Color(0xFFE8F2FF)
                        : dayNotes.isNotEmpty
                            ? palette.field
                            : Colors.transparent,
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(
                        '${day.day}',
                        style: TextStyle(
                          color: inMonth ? palette.text : palette.textMuted,
                          fontSize: 12,
                          fontWeight: isToday ? FontWeight.w700 : FontWeight.w400,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          for (var i = 0; i < dayNotes.take(3).length; i++)
                            Container(
                              width: 4,
                              height: 4,
                              margin: const EdgeInsets.symmetric(horizontal: 1),
                              decoration: BoxDecoration(
                                color: _noteAccentColor(
                                  dayNotes[i],
                                  currentUserId,
                                ),
                                shape: BoxShape.circle,
                              ),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
        ],
      ),
    );
  }
}

class _WeekCalendarView extends StatelessWidget {
  const _WeekCalendarView({
    super.key,
    required this.focusedDay,
    required this.notes,
    required this.currentUserId,
    required this.onDaySelected,
  });

  final DateTime focusedDay;
  final List<MeetingNote> notes;
  final String? currentUserId;
  final ValueChanged<DateTime> onDaySelected;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final weekStart = _weekStart(focusedDay);
    final hours = _visibleHours(notes, weekStart, weekStart.add(const Duration(days: 6)));
    return _CalendarGridFrame(
      child: Column(
        children: [
          Row(
            children: [
              const SizedBox(width: 42),
              for (var i = 0; i < 7; i++)
                Expanded(
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: () => onDaySelected(weekStart.add(Duration(days: i))),
                    child: Center(
                      child: Text(
                        DateFormat('E\nd').format(weekStart.add(Duration(days: i))),
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: palette.textSecondary,
                          fontSize: 11,
                          height: 1.25,
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 10),
          for (final hour in hours)
            SizedBox(
              height: 54,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 42,
                    child: Text(
                      _hourLabel(hour),
                      style: TextStyle(color: palette.textMuted, fontSize: 10),
                    ),
                  ),
                  for (var day = 0; day < 7; day++)
                    Expanded(
                      child: _CalendarHourCell(
                        day: weekStart.add(Duration(days: day)),
                        notes: _notesForHour(
                          notes,
                          weekStart.add(Duration(days: day)),
                          hour,
                        ),
                        currentUserId: currentUserId,
                        onDaySelected: onDaySelected,
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

class _DayCalendarView extends ConsumerWidget {
  const _DayCalendarView({
    super.key,
    required this.day,
    required this.notes,
    required this.currentUserId,
    required this.onOpen,
    required this.onActions,
  });

  final DateTime day;
  final List<MeetingNote> notes;
  final String? currentUserId;
  final ValueChanged<MeetingNote> onOpen;
  final ValueChanged<MeetingNote> onActions;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final palette = FigmaDesign.of(context);
    final dayNotes = _notesForDay(notes, day);
    final hours = _visibleHours(dayNotes, day, day);
    return _CalendarGridFrame(
      child: Column(
        children: [
          for (final hour in hours)
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 48,
                  child: Text(
                    _hourLabel(hour),
                    style: TextStyle(color: palette.textMuted, fontSize: 10),
                  ),
                ),
                Expanded(
                  child: Column(
                    children: [
                      for (final note in _notesForHour(notes, day, hour))
                        Padding(
                          padding: const EdgeInsets.only(bottom: 10),
                          child: _HistoryNoteCard(
                            note: note,
                            shared: _isSharedNote(note, currentUserId),
                            onOpen: () => onOpen(note),
                            onActions: () => onActions(note),
                          ),
                        ),
                      if (_notesForHour(notes, day, hour).isEmpty)
                        const SizedBox(height: 42),
                    ],
                  ),
                ),
              ],
            ),
          if (dayNotes.isEmpty)
            _CalendarEmptyMessage(ref.read(appTextProvider)('history.noMeetingsDay')),
        ],
      ),
    );
  }
}

class _CalendarGridFrame extends StatelessWidget {
  const _CalendarGridFrame({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: palette.card,
        borderRadius: BorderRadius.circular(22),
        boxShadow: [
          BoxShadow(
            color: palette.cardShadow,
            blurRadius: 18,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: child,
    );
  }
}

class _CalendarHourCell extends ConsumerWidget {
  const _CalendarHourCell({
    required this.day,
    required this.notes,
    required this.currentUserId,
    required this.onDaySelected,
  });

  final DateTime day;
  final List<MeetingNote> notes;
  final String? currentUserId;
  final ValueChanged<DateTime> onDaySelected;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final palette = FigmaDesign.of(context);
    final color = notes.isEmpty
        ? _mineNoteColor
        : _noteAccentColor(notes.first, currentUserId);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => onDaySelected(day),
      child: Container(
        margin: const EdgeInsets.only(left: 3, bottom: 5),
        padding: const EdgeInsets.symmetric(horizontal: 4),
        decoration: BoxDecoration(
          color: palette.field,
          borderRadius: BorderRadius.circular(10),
        ),
        alignment: Alignment.center,
        child: notes.isEmpty
            ? const SizedBox.shrink()
            : Stack(
                clipBehavior: Clip.none,
                children: [
                  Center(
                    child: Text(
                      notes.length == 1
                          ? notes.first.title
                          : '${notes.length} ${ref.read(appTextProvider)('history.meetings')}',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        fontSize: 9,
                        fontWeight: FontWeight.w600,
                        height: 1.1,
                      ).copyWith(color: color),
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}

class _NoteAccentDot extends StatelessWidget {
  const _NoteAccentDot({required this.color, this.size = 8});

  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
      ),
    );
  }
}

class _CalendarEmptyMessage extends StatelessWidget {
  const _CalendarEmptyMessage(this.message);

  final String message;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 18),
      child: Center(
        child: Text(
          message,
          style: TextStyle(color: palette.textMuted, fontSize: 13),
        ),
      ),
    );
  }
}

class _HistoryNoteCard extends ConsumerWidget {
  const _HistoryNoteCard({
    required this.note,
    required this.shared,
    required this.onOpen,
    required this.onActions,
  });

  final MeetingNote note;
  final bool shared;
  final VoidCallback onOpen;
  final VoidCallback onActions;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final palette = FigmaDesign.of(context);
    final t = ref.watch(appTextProvider);
    final accent = shared ? _sharedNoteColor : _mineNoteColor;
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
                    Row(
                      children: [
                        _NoteAccentDot(color: accent),
                        const SizedBox(width: 9),
                        Expanded(
                          child: Text(
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
                        ),
                      ],
                    ),
                    const SizedBox(height: 7),
                    Text(
                      '${_historyDateLabel(note.displayDate, t)} - ${note.durationLabel}',
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
                      _historyMetaLabel(note, t),
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

class _ShareNoteSheet extends ConsumerStatefulWidget {
  const _ShareNoteSheet({
    required this.note,
    required this.repository,
  });

  final MeetingNote note;
  final NotesRepository repository;

  @override
  ConsumerState<_ShareNoteSheet> createState() => _ShareNoteSheetState();
}

class _ShareNoteSheetState extends ConsumerState<_ShareNoteSheet> {
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
    final t = ref.watch(appTextProvider);
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
              _SheetHeader(title: t('history.shareNoteTitle'), subtitle: widget.note.title),
              const SizedBox(height: 12),
              _SheetSearchField(
                hintText: t('history.searchTecAce'),
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
                      return _SheetMessage('${t('history.loadTecAceError')}: ${snapshot.error}');
                    }
                    final contacts = (snapshot.data ?? const <TecAceContact>[])
                        .where((contact) => _contactMatches(contact, _query))
                        .toList();
                    if (contacts.isEmpty) return _SheetMessage(t('history.noTecAceMembers'));
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
                  child: Text('${t('history.shareWith')} ${_selectedIds.length}'),
                ),
              ),
              const SizedBox(height: 6),
              Text(
                t('history.sharePreselectNote'),
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

class _AddToProjectSheet extends ConsumerWidget {
  const _AddToProjectSheet({
    required this.note,
    required this.projectsRepository,
  });

  final MeetingNote note;
  final ProjectsRepository projectsRepository;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(appTextProvider);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.72),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _SheetHeader(title: t('history.addToProjectTitle'), subtitle: note.title),
              const SizedBox(height: 12),
              Flexible(
                child: FutureBuilder<List<MeetingProject>>(
                  future: projectsRepository.list(),
                  builder: (context, snapshot) {
                    if (snapshot.connectionState == ConnectionState.waiting) {
                      return const Center(child: CircularProgressIndicator());
                    }
                    if (snapshot.hasError) {
                      return _SheetMessage('${t('history.loadProjectsError')}: ${snapshot.error}');
                    }
                    final projects = snapshot.data ?? const <MeetingProject>[];
                    if (projects.isEmpty) return _SheetMessage(t('history.noProjects'));
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
                          subtitle: alreadyAdded
                              ? t('history.alreadyInProject')
                              : t('history.addToProject'),
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

class _SyncProfilesSheet extends ConsumerStatefulWidget {
  const _SyncProfilesSheet({
    required this.note,
    required this.repository,
  });

  final MeetingNote note;
  final NotesRepository repository;

  @override
  ConsumerState<_SyncProfilesSheet> createState() => _SyncProfilesSheetState();
}

class _SyncProfilesSheetState extends ConsumerState<_SyncProfilesSheet> {
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
    final t = ref.watch(appTextProvider);
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
                    title: t('history.syncProfileTitle'),
                    subtitle: t('history.syncProfileSubtitle'),
                  ),
                  const SizedBox(height: 12),
                  if (snapshot.connectionState == ConnectionState.waiting)
                    const Flexible(child: Center(child: CircularProgressIndicator()))
                  else if (snapshot.hasError)
                    Flexible(child: _SheetMessage('${t('history.syncProfileFailed')}: ${snapshot.error}'))
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
                        child: Text(_savingAll
                            ? t('history.savingAll')
                            : t('history.saveAllProfiles')),
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      t('history.profilesSavedNote'),
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
        SnackBar(content: Text(ref.read(appTextProvider)('history.speakerProfilesSaved'))),
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

class _GeneratedProfileCard extends ConsumerWidget {
  const _GeneratedProfileCard({
    required this.profile,
    required this.saved,
    required this.onSave,
  });

  final GeneratedSpeakerProfile profile;
  final bool saved;
  final VoidCallback? onSave;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final palette = FigmaDesign.of(context);
    final t = ref.watch(appTextProvider);
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
                child: Text(saved ? t('history.saved') : t('history.save')),
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

String _historyDateLabel(DateTime value, AppText t) {
  value = value.toLocal();
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final date = DateTime(value.year, value.month, value.day);
  final time = DateFormat('HH:mm').format(value);
  if (date == today) return '${t('history.today')} $time';
  if (date == today.subtract(const Duration(days: 1))) {
    return '${t('history.yesterday')} $time';
  }
  return '${DateFormat('EEE M/d').format(value)} - $time';
}

DateTime _startOfDay(DateTime value) =>
    DateTime(value.year, value.month, value.day);

DateTime _weekStart(DateTime value) {
  final day = _startOfDay(value);
  return day.subtract(Duration(days: day.weekday % 7));
}

bool _sameDay(DateTime a, DateTime b) =>
    a.year == b.year && a.month == b.month && a.day == b.day;

List<MeetingNote> _notesForDay(List<MeetingNote> notes, DateTime day) {
  final target = _startOfDay(day);
  return notes
      .where((note) => _sameDay(note.displayDate, target))
      .toList()
    ..sort((a, b) => a.displayDate.compareTo(b.displayDate));
}

List<MeetingNote> _notesForHour(
  List<MeetingNote> notes,
  DateTime day,
  int hour,
) {
  return _notesForDay(notes, day)
      .where((note) => note.displayDate.hour == hour)
      .toList();
}

List<int> _visibleHours(List<MeetingNote> notes, DateTime start, DateTime end) {
  final hours = notes
      .where((note) {
        final day = _startOfDay(note.displayDate);
        return !day.isBefore(_startOfDay(start)) && !day.isAfter(_startOfDay(end));
      })
      .map((note) => note.displayDate.hour)
      .toSet()
      .toList()
    ..sort();
  if (hours.isEmpty) return List<int>.generate(10, (i) => i + 8);
  final first = (hours.first - 1).clamp(0, 23).toInt();
  final last = (hours.last + 1).clamp(0, 23).toInt();
  return List<int>.generate(last - first + 1, (i) => first + i);
}

String _hourLabel(int hour) {
  final suffix = hour >= 12 ? 'PM' : 'AM';
  final value = hour % 12 == 0 ? 12 : hour % 12;
  return '$value $suffix';
}

String _calendarTitle(DateTime day, _CalendarScope scope) {
  return switch (scope) {
    _CalendarScope.month => DateFormat('MMMM yyyy').format(day),
    _CalendarScope.week =>
      '${DateFormat('MMM d').format(_weekStart(day))} - ${DateFormat('MMM d').format(_weekStart(day).add(const Duration(days: 6)))}',
    _CalendarScope.day => DateFormat('EEEE, MMM d').format(day),
  };
}

String _historyMetaLabel(MeetingNote note, AppText t) {
  final speakers = note.transcript
      .map((segment) => segment.speaker?.trim() ?? '')
      .where((speaker) => speaker.isNotEmpty)
      .toSet()
      .length;
  final speakerText = speakers == 1
      ? '1 ${t('history.speakerSingular')}'
      : '$speakers ${t('history.speakerPlural')}';
  final tags = note.tags.take(2).map((tag) => '#$tag').join(' ');
  return tags.isEmpty ? speakerText : '$speakerText - $tags';
}

bool _isSharedNote(MeetingNote note, String? currentUserId) {
  final userId = currentUserId?.trim();
  return userId != null &&
      userId.isNotEmpty &&
      note.ownerId != null &&
      note.ownerId != userId &&
      note.sharedUserIds.contains(userId);
}

Color _noteAccentColor(MeetingNote note, String? currentUserId) {
  return _isSharedNote(note, currentUserId) ? _sharedNoteColor : _mineNoteColor;
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({
    required this.error,
    required this.title,
    required this.retryLabel,
    required this.onRetry,
  });

  final Object? error;
  final String title;
  final String retryLabel;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return EmptyState(
      icon: Icons.error_outline_rounded,
      title: title,
      subtitle: error.toString(),
      action: FilledButton(
        onPressed: onRetry,
        child: Text(retryLabel),
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
