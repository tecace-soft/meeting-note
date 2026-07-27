import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../shared/widgets/widgets.dart';
import '../../auth/providers/auth_provider.dart';
import '../../notes/data/notes_repository.dart';
import '../../notes/models/meeting_note.dart';
import '../data/projects_repository.dart';

class ProjectsScreen extends ConsumerStatefulWidget {
  const ProjectsScreen({super.key});

  @override
  ConsumerState<ProjectsScreen> createState() => _ProjectsScreenState();
}

class _ProjectsScreenState extends ConsumerState<ProjectsScreen> {
  late Future<_ProjectsScreenData> _future;
  String? _loadedForUserId;
  int _loadRetries = 0;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<_ProjectsScreenData> _load({bool preferCache = true}) async {
    final projectsRepository = ref.read(projectsRepositoryProvider);
    if (preferCache) {
      final cachedProjects = await projectsRepository.cachedList();
      if (cachedProjects != null) {
        _refreshFromNetwork();
        return _ProjectsScreenData(projects: cachedProjects);
      }
    }
    final projects = await projectsRepository.refreshList();
    return _ProjectsScreenData(projects: projects);
  }

  void _refresh() {
    setState(() {
      _loadRetries = 0;
      _future = _load(preferCache: false);
    });
  }

  Future<void> _refreshFromNetwork() async {
    try {
      final data = await _load(preferCache: false);
      if (!mounted) return;
      setState(() => _future = Future.value(data));
    } catch (_) {
      // Keep showing cached projects.
    }
  }

  void _retryQuietly() {
    _loadRetries += 1;
    Future<void>.delayed(Duration(milliseconds: 500 * _loadRetries), () {
      if (!mounted) return;
      setState(() => _future = _load());
    });
  }

  Future<void> _openCreateProject() async {
    final repository = ref.read(notesRepositoryProvider);
    final notes = await repository.cachedList(limit: 200) ??
        await repository.refreshList(limit: 200);
    if (!mounted) return;
    final created = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => _NewProjectSheet(notes: notes),
    );
    if (created == true) _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final auth = ref.watch(authControllerProvider);
    final userId = auth.user?.id;
    if (!auth.loading && userId != _loadedForUserId) {
      _loadedForUserId = userId;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _refreshFromNetwork();
      });
    }

    return Scaffold(
      backgroundColor: palette.pageBackground,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 34, 24, 0),
          child: FutureBuilder<_ProjectsScreenData>(
            future: _future,
            builder: (context, snapshot) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          'Projects',
                          style: TextStyle(
                            fontSize: 25,
                            height: 1,
                            fontWeight: FontWeight.w700,
                            color: palette.text,
                          ),
                        ),
                      ),
                      _NewProjectButton(
                        onTap: snapshot.connectionState ==
                                ConnectionState.waiting
                            ? null
                            : _openCreateProject,
                      ),
                    ],
                  ),
                  const SizedBox(height: 28),
                  Expanded(
                    child: Builder(
                      builder: (context) {
                        if (snapshot.hasError && _loadRetries < 2) {
                          _retryQuietly();
                          return const Center(child: CircularProgressIndicator());
                        }
                        if (!snapshot.hasError &&
                            snapshot.connectionState != ConnectionState.waiting) {
                          _loadRetries = 0;
                        }
                        return _ProjectBody(
                          snapshot: snapshot,
                          onRetry: _refresh,
                          onOpenProject: (project) => context.push(
                            '/projects/${project.id}',
                            extra: project.name,
                          ),
                        );
                      },
                      ),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

class ProjectDetailScreen extends ConsumerStatefulWidget {
  const ProjectDetailScreen({
    super.key,
    required this.projectId,
    this.projectName,
  });

  final String projectId;
  final String? projectName;

  @override
  ConsumerState<ProjectDetailScreen> createState() => _ProjectDetailScreenState();
}

class _ProjectDetailScreenState extends ConsumerState<ProjectDetailScreen> {
  final _chatController = TextEditingController();
  final _chatScrollController = ScrollController();
  late Future<_ProjectDetailData> _future;
  _ProjectDetailData? _data;
  String? _activeSessionId;
  String? _chatError;
  bool _sending = false;
  bool _showChats = true;
  bool _isLowerSectionExpanded = true;
  List<_ProjectChatMessage> _messages = const [];

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  @override
  void dispose() {
    _chatController.dispose();
    _chatScrollController.dispose();
    super.dispose();
  }

  Future<_ProjectDetailData> _load({bool preferCache = true}) async {
    final repository = ref.read(projectsRepositoryProvider);
    if (preferCache) {
      final cachedProject = await repository.cachedGet(widget.projectId);
      if (cachedProject != null) {
        final cachedNotes =
            await repository.cachedNotesForProject(widget.projectId);
        final cachedSessions =
            await repository.cachedSessionsForProject(widget.projectId);
        final cachedChats = await repository.cachedChatsForSessions(
          (cachedSessions ?? const <ProjectChatSession>[])
              .map((session) => session.id)
              .toList(),
        );
        final data = _buildProjectDetailData(
          project: cachedProject,
          notes: cachedNotes ?? const [],
          sessions: cachedSessions ?? const [],
          chats: cachedChats ?? const [],
        );
        _refreshFromNetwork();
        return data;
      }
    }
    final project = await repository.get(widget.projectId);
    var notes = const <ProjectNoteSummary>[];
    var sessions = const <ProjectChatSession>[];
    var chats = const <ProjectChatRow>[];
    try {
      notes = await repository.notesForProject(widget.projectId);
    } catch (_) {
      notes = const <ProjectNoteSummary>[];
    }
    try {
      sessions = await repository.sessionsForProject(widget.projectId);
      chats = await repository.chatsForSessions(
        sessions.map((session) => session.id).toList(),
      );
    } catch (_) {
      sessions = const <ProjectChatSession>[];
      chats = const <ProjectChatRow>[];
    }
    return _buildProjectDetailData(
      project: project,
      notes: notes,
      sessions: sessions,
      chats: chats,
    );
  }

  _ProjectDetailData _buildProjectDetailData({
    required MeetingProject project,
    required List<ProjectNoteSummary> notes,
    required List<ProjectChatSession> sessions,
    required List<ProjectChatRow> chats,
  }) {
    final chatsBySession = <String, List<ProjectChatRow>>{};
    for (final chat in chats) {
      chatsBySession.putIfAbsent(chat.sessionId, () => []).add(chat);
    }
    final data = _ProjectDetailData(
      project: project,
      notes: notes,
      sessions: sessions,
      chatsBySession: chatsBySession,
    );
    _data = data;
    if (_activeSessionId != null &&
        !sessions.any((session) => session.id == _activeSessionId)) {
      _activeSessionId = null;
      _messages = const [];
    }
    return data;
  }

  void _refresh() {
    setState(() => _future = _load(preferCache: false));
  }

  Future<void> _refreshFromNetwork() async {
    try {
      final data = await _load(preferCache: false);
      if (!mounted) return;
      setState(() => _future = Future.value(data));
    } catch (_) {
      // Keep showing cached project data.
    }
  }

  void _selectSession(String sessionId) {
    final data = _data;
    if (data == null) return;
    setState(() {
      _activeSessionId = sessionId;
      _messages = _messagesForRows(
        data.chatsBySession[sessionId] ?? const <ProjectChatRow>[],
      );
      _chatError = null;
      _showChats = true;
      _isLowerSectionExpanded = false;
    });
    _scrollChatSoon();
  }

  Future<void> _sendChat() async {
    final text = _chatController.text.trim();
    final auth = ref.read(authControllerProvider);
    final userId = auth.user?.id;
    final data = _data;
    if (text.isEmpty || _sending || data == null) return;
    if (userId == null || userId.isEmpty) {
      setState(() => _chatError = 'Missing authenticated user.');
      return;
    }

    final optimistic = _ProjectChatMessage(
      id: 'u-${DateTime.now().microsecondsSinceEpoch}',
      role: _ProjectChatRole.user,
      content: text,
    );
    setState(() {
      _sending = true;
      _chatError = null;
      _messages = [..._messages, optimistic];
      _showChats = true;
      _isLowerSectionExpanded = false;
    });
    _chatController.clear();
    _scrollChatSoon();

    try {
      final result = await ref.read(projectsRepositoryProvider).sendChat(
            projectId: data.project.id,
            message: text,
            userId: userId,
            sessionId: _activeSessionId,
          );
      final assistant = _ProjectChatMessage(
        id: 'a-${DateTime.now().microsecondsSinceEpoch}',
        role: _ProjectChatRole.assistant,
        content: result.assistantResponse,
      );
      final row = ProjectChatRow(
        id: 'local-${DateTime.now().microsecondsSinceEpoch}',
        sessionId: result.sessionId,
        createdAt: result.createdAt,
        message: text,
        response: result.assistantResponse,
      );
      final nextSessions = result.isNewSession
          ? [
              ProjectChatSession(
                id: result.sessionId,
                createdAt: result.createdAt,
                projectId: data.project.id,
              ),
              ...data.sessions,
            ]
          : data.sessions;
      final nextChats = <String, List<ProjectChatRow>>{
        ...data.chatsBySession,
        result.sessionId: [
          ...(data.chatsBySession[result.sessionId] ??
              const <ProjectChatRow>[]),
          row,
        ],
      };
      final nextData = data.copyWith(
        sessions: nextSessions,
        chatsBySession: nextChats,
      );
      setState(() {
        _activeSessionId = result.sessionId;
        _messages = [..._messages, assistant];
        _data = nextData;
        _future = Future.value(nextData);
      });
      _scrollChatSoon();
    } catch (error) {
      setState(() => _chatError = '$error');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  void _scrollChatSoon() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_chatScrollController.hasClients) return;
      _chatScrollController.animateTo(
        _chatScrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: FigmaDesign.of(context).pageBackground,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 34, 24, 0),
          child: FutureBuilder<_ProjectDetailData>(
            future: _future,
            builder: (context, snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting &&
                  snapshot.data == null &&
                  _data == null) {
                return const Center(child: CircularProgressIndicator());
              }
              if (snapshot.hasError && _data == null) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _ProjectBackHeader(
                      title: widget.projectName ?? 'Project',
                      subtitle: 'Could not load project',
                    ),
                    const SizedBox(height: 32),
                    EmptyState(
                      icon: Icons.error_outline_rounded,
                      title: 'Failed to load project',
                      subtitle: '${snapshot.error}',
                      action: FilledButton(
                        onPressed: _refresh,
                        child: const Text('Try again'),
                      ),
                    ),
                  ],
                );
              }
              final data = snapshot.data ?? _data!;
              _data = data;
              final title = data.project.name;
              final subtitle =
                  '${data.notes.length} ${data.notes.length == 1 ? 'note' : 'notes'} - ${_lastActivity(data)}';
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _ProjectBackHeader(title: title, subtitle: subtitle),
                  const SizedBox(height: 26),
                  _ProjectChatCard(
                    expanded: !_isLowerSectionExpanded,
                    controller: _chatController,
                    scrollController: _chatScrollController,
                    messages: _messages,
                    sending: _sending,
                    error: _chatError,
                    onSend: _sendChat,
                  ),
                  const SizedBox(height: 16),
                  _ProjectDetailToggle(
                    showChats: _showChats,
                    onChanged: (value) => setState(() {
                      _showChats = value;
                      _isLowerSectionExpanded = true;
                    }),
                  ),
                  const SizedBox(height: 12),
                  Expanded(
                    child: AnimatedSwitcher(
                      duration: const Duration(milliseconds: 180),
                      child: _isLowerSectionExpanded
                          ? (_showChats
                              ? _ProjectChatSessionList(
                                  key: const ValueKey('project-chats'),
                                  sessions: data.sessions,
                                  chatsBySession: data.chatsBySession,
                                  selectedSessionId: _activeSessionId,
                                  onSelect: _selectSession,
                                )
                              : _ProjectNotesList(
                                  key: const ValueKey('project-notes'),
                                  notes: data.notes,
                                  onOpen: (note) =>
                                      context.push('/note/${note.id}'),
                                ))
                          : const SizedBox.shrink(
                              key: ValueKey('project-lower-collapsed'),
                            ),
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

class _ProjectBackHeader extends StatelessWidget {
  const _ProjectBackHeader({
    required this.title,
    required this.subtitle,
  });

  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Row(
      children: [
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => context.pop(),
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
                title,
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
              const SizedBox(height: 4),
              Text(
                subtitle,
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
        const SizedBox(width: 48),
      ],
    );
  }
}

class _ProjectChatCard extends StatelessWidget {
  const _ProjectChatCard({
    required this.expanded,
    required this.controller,
    required this.scrollController,
    required this.messages,
    required this.sending,
    required this.error,
    required this.onSend,
  });

  final bool expanded;
  final TextEditingController controller;
  final ScrollController scrollController;
  final List<_ProjectChatMessage> messages;
  final bool sending;
  final String? error;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    final hasMessages = messages.isNotEmpty || sending;
    final expandedHeight =
        (MediaQuery.sizeOf(context).height * 0.58).clamp(390.0, 540.0);
    return AnimatedContainer(
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
      height: expanded ? expandedHeight : 284,
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: dark
              ? const [
                  Color(0xFF1A2740),
                  Color(0xFF182D46),
                  Color(0xFF2A213F),
                ]
              : const [
            Color(0xFFFFFFFF),
            Color(0xFFE7F3FF),
            Color(0xFFF7EAF8),
          ],
          stops: [0.08, 0.56, 1],
        ),
        boxShadow: [
          BoxShadow(
            color: palette.cardShadow,
            blurRadius: dark ? 18 : 24,
            offset: Offset(0, 12),
          ),
        ],
      ),
      child: Column(
        children: [
          Expanded(
            child: hasMessages
                ? ListView.separated(
                    controller: scrollController,
                    padding: const EdgeInsets.only(top: 38, bottom: 8),
                    itemCount: messages.length + (sending ? 1 : 0),
                    separatorBuilder: (_, __) => const SizedBox(height: 10),
                    itemBuilder: (context, index) {
                      if (index >= messages.length) {
                        return const _ProjectAssistantTyping();
                      }
                      return _ProjectMessageBubble(message: messages[index]);
                    },
                  )
                : Center(
                    child: Text(
                      'Ask about this project',
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w300,
                        color: palette.textMuted,
                      ),
                    ),
                  ),
          ),
          if (error != null) ...[
            Text(
              error!,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 11,
                color: Color(0xFFE5484D),
              ),
            ),
            const SizedBox(height: 8),
          ],
          Container(
            constraints: const BoxConstraints(minHeight: 42),
            padding: const EdgeInsets.fromLTRB(16, 3, 3, 3),
            decoration: BoxDecoration(
              color: dark ? palette.field : Colors.white.withValues(alpha: 0.88),
              borderRadius: BorderRadius.circular(999),
            ),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: controller,
                    minLines: 1,
                    maxLines: 3,
                    enabled: !sending,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => onSend(),
                    decoration: InputDecoration(
                      hintText: 'Ask about this project...',
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      focusedBorder: InputBorder.none,
                      disabledBorder: InputBorder.none,
                      errorBorder: InputBorder.none,
                      focusedErrorBorder: InputBorder.none,
                      isDense: true,
                      filled: true,
                      fillColor: Colors.transparent,
                      hintStyle: TextStyle(
                        color: palette.textMuted,
                        fontSize: 13,
                        fontWeight: FontWeight.w300,
                      ),
                    ),
                    style: TextStyle(
                      color: palette.text,
                      fontSize: 13,
                      fontWeight: FontWeight.w400,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: sending ? null : onSend,
                  child: Container(
                    height: 36,
                    width: 36,
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        colors: [Color(0xFF4D9FFF), Color(0xFF2F80ED)],
                      ),
                      shape: BoxShape.circle,
                    ),
                    child: Center(
                      child: sending
                          ? const SizedBox(
                              width: 14,
                              height: 14,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Icon(
                              Icons.send_rounded,
                              color: Colors.white,
                              size: 17,
                            ),
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

class _ProjectMessageBubble extends StatelessWidget {
  const _ProjectMessageBubble({required this.message});

  final _ProjectChatMessage message;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    final isUser = message.role == _ProjectChatRole.user;
    return Align(
      alignment: isUser ? Alignment.centerLeft : Alignment.centerRight,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 248),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        decoration: BoxDecoration(
          color: isUser
              ? (dark
                  ? const Color(0xFF223049).withValues(alpha: 0.86)
                  : Colors.white.withValues(alpha: 0.76))
              : (dark
                  ? const Color(0xFF17345D).withValues(alpha: 0.9)
                  : const Color(0xFFEAF3FF).withValues(alpha: 0.86)),
          borderRadius: BorderRadius.circular(16),
        ),
        child: isUser
            ? Text(
                message.content,
                style: TextStyle(
                  color: palette.textSecondary,
                  fontSize: 13,
                  height: 1.35,
                  fontWeight: FontWeight.w400,
                ),
              )
            : MarkdownBody(
                data: message.content,
                styleSheet: MarkdownStyleSheet(
                  p: TextStyle(
                    color: palette.text,
                    fontSize: 13,
                    height: 1.35,
                    fontWeight: FontWeight.w400,
                  ),
                ),
              ),
      ),
    );
  }
}

class _ProjectAssistantTyping extends StatelessWidget {
  const _ProjectAssistantTyping();

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Align(
      alignment: Alignment.centerRight,
      child: Text(
        'Thinking...',
        style: TextStyle(
          color: palette.textMuted,
          fontSize: 12,
          fontWeight: FontWeight.w300,
        ),
      ),
    );
  }
}

class _ProjectDetailToggle extends StatelessWidget {
  const _ProjectDetailToggle({
    required this.showChats,
    required this.onChanged,
  });

  final bool showChats;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 36,
      width: 120,
      child: FigmaSlidingSegmentedToggle(
        height: 36,
        thumbRadius: 999,
        options: const [
          FigmaSegmentOption(label: 'Chats'),
          FigmaSegmentOption(label: 'Notes'),
        ],
        selectedIndex: showChats ? 0 : 1,
        onChanged: (index) => onChanged(index == 0),
        optionTextStyle: const TextStyle(fontSize: 12),
      ),
    );
  }
}

class _ProjectChatSessionList extends StatelessWidget {
  const _ProjectChatSessionList({
    super.key,
    required this.sessions,
    required this.chatsBySession,
    required this.selectedSessionId,
    required this.onSelect,
  });

  final List<ProjectChatSession> sessions;
  final Map<String, List<ProjectChatRow>> chatsBySession;
  final String? selectedSessionId;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    if (sessions.isEmpty) {
      return const _ProjectEmptyLowerState('No chat sessions yet.');
    }
    return ListView.separated(
      padding: const EdgeInsets.only(bottom: 24),
      itemCount: sessions.length,
      separatorBuilder: (_, __) => const SizedBox(height: 12),
      itemBuilder: (context, index) {
        final session = sessions[index];
        final rows = chatsBySession[session.id] ?? const <ProjectChatRow>[];
        final firstResponse = _firstNonEmpty(
              rows.map((row) => row.response?.trim() ?? ''),
            ) ??
            'No response yet';
        final firstMessage = _firstNonEmpty(
              rows.map((row) => row.message?.trim() ?? ''),
            ) ??
            '';
        return _ProjectListCard(
          title: firstResponse,
          subtitle: firstMessage.isEmpty
              ? DateFormat('MMM d').format(session.createdAt)
              : firstMessage,
          trailing: DateFormat('MMM d').format(session.createdAt),
          selected: selectedSessionId == session.id,
          onTap: () => onSelect(session.id),
        );
      },
    );
  }
}

class _ProjectNotesList extends StatelessWidget {
  const _ProjectNotesList({
    super.key,
    required this.notes,
    required this.onOpen,
  });

  final List<ProjectNoteSummary> notes;
  final ValueChanged<ProjectNoteSummary> onOpen;

  @override
  Widget build(BuildContext context) {
    if (notes.isEmpty) {
      return const _ProjectEmptyLowerState('No project notes yet.');
    }
    return ListView.separated(
      padding: const EdgeInsets.only(bottom: 24),
      itemCount: notes.length,
      separatorBuilder: (_, __) => const SizedBox(height: 12),
      itemBuilder: (context, index) {
        final note = notes[index];
        final meta = [
          DateFormat('MMM d, yyyy').format(note.createdAt),
          if (note.durationLabel.isNotEmpty) note.durationLabel,
          if (note.tags.isNotEmpty) '#${note.tags.take(2).join(' #')}',
        ].join(' - ');
        return _ProjectListCard(
          title: note.title,
          subtitle: meta,
          trailing: '',
          selected: false,
          onTap: () => onOpen(note),
        );
      },
    );
  }
}

class _ProjectListCard extends StatelessWidget {
  const _ProjectListCard({
    required this.title,
    required this.subtitle,
    required this.trailing,
    required this.selected,
    required this.onTap,
  });

  final String title;
  final String subtitle;
  final String trailing;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 72),
          padding: const EdgeInsets.fromLTRB(16, 13, 14, 13),
          decoration: BoxDecoration(
            color: selected
                ? (dark ? const Color(0xFF17345D) : const Color(0xFFEAF3FF))
                : palette.card,
            borderRadius: BorderRadius.circular(18),
            boxShadow: [
              BoxShadow(
                color: palette.cardShadow,
                blurRadius: 16,
                offset: Offset(0, 8),
              ),
            ],
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: palette.text,
                      ),
                    ),
                    const SizedBox(height: 5),
                    Text(
                      subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w300,
                        color: palette.textMuted,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              trailing.isEmpty
                  ? Icon(
                      Icons.chevron_right_rounded,
                      color: palette.textMuted,
                    )
                  : Text(
                      trailing,
                      style: TextStyle(
                        color: palette.textMuted,
                        fontSize: 12,
                        fontWeight: FontWeight.w300,
                      ),
                    ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ProjectEmptyLowerState extends StatelessWidget {
  const _ProjectEmptyLowerState(this.message);

  final String message;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Center(
      child: Text(
        message,
        style: TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w300,
          color: palette.textMuted,
        ),
      ),
    );
  }
}

class _ProjectDetailData {
  const _ProjectDetailData({
    required this.project,
    required this.notes,
    required this.sessions,
    required this.chatsBySession,
  });

  final MeetingProject project;
  final List<ProjectNoteSummary> notes;
  final List<ProjectChatSession> sessions;
  final Map<String, List<ProjectChatRow>> chatsBySession;

  _ProjectDetailData copyWith({
    List<ProjectChatSession>? sessions,
    Map<String, List<ProjectChatRow>>? chatsBySession,
  }) =>
      _ProjectDetailData(
        project: project,
        notes: notes,
        sessions: sessions ?? this.sessions,
        chatsBySession: chatsBySession ?? this.chatsBySession,
      );
}

enum _ProjectChatRole { user, assistant }

class _ProjectChatMessage {
  const _ProjectChatMessage({
    required this.id,
    required this.role,
    required this.content,
  });

  final String id;
  final _ProjectChatRole role;
  final String content;
}

List<_ProjectChatMessage> _messagesForRows(List<ProjectChatRow> rows) {
  final sorted = [...rows]..sort((a, b) => a.createdAt.compareTo(b.createdAt));
  return [
    for (final row in sorted) ...[
      if (row.message?.trim().isNotEmpty == true)
        _ProjectChatMessage(
          id: 'u-${row.id}',
          role: _ProjectChatRole.user,
          content: row.message!.trim(),
        ),
      if (row.response?.trim().isNotEmpty == true)
        _ProjectChatMessage(
          id: 'a-${row.id}',
          role: _ProjectChatRole.assistant,
          content: row.response!.trim(),
        ),
    ]
  ];
}

String? _firstNonEmpty(Iterable<String> values) {
  for (final value in values) {
    final trimmed = value.trim();
    if (trimmed.isNotEmpty) return trimmed;
  }
  return null;
}

String _lastActivity(_ProjectDetailData data) {
  final dates = [
    ...data.notes.map((note) => note.createdAt),
    ...data.sessions.map((session) => session.createdAt),
  ]..sort((a, b) => b.compareTo(a));
  if (dates.isEmpty) return 'Last activity: none';
  final latest = dates.first;
  final now = DateTime.now();
  final sameDay =
      latest.year == now.year && latest.month == now.month && latest.day == now.day;
  if (sameDay) return 'Last activity: today';
  return 'Last activity: ${DateFormat('MMM d').format(latest)}';
}

class _ProjectBody extends StatelessWidget {
  const _ProjectBody({
    required this.snapshot,
    required this.onRetry,
    required this.onOpenProject,
  });

  final AsyncSnapshot<_ProjectsScreenData> snapshot;
  final VoidCallback onRetry;
  final ValueChanged<MeetingProject> onOpenProject;

  @override
  Widget build(BuildContext context) {
    if (snapshot.connectionState == ConnectionState.waiting) {
      return const Center(child: CircularProgressIndicator());
    }
    if (snapshot.hasError) {
      return EmptyState(
        icon: Icons.error_outline_rounded,
        title: 'Failed to load projects',
        subtitle: '${snapshot.error}',
        action: FilledButton(
          onPressed: onRetry,
          child: const Text('Try again'),
        ),
      );
    }
    final data = snapshot.data;
    final projects = data?.projects ?? const <MeetingProject>[];
    if (projects.isEmpty) {
      return const EmptyState(
        icon: Icons.folder_open_rounded,
        title: 'No projects yet',
        subtitle: 'Create a project to organize related meeting notes.',
      );
    }

    return RefreshIndicator(
      onRefresh: () async => onRetry(),
      child: ListView.separated(
        padding: const EdgeInsets.only(bottom: 24),
        itemCount: projects.length,
        separatorBuilder: (_, __) => const SizedBox(height: 14),
        itemBuilder: (context, index) {
          final project = projects[index];
          return _ProjectCard(
            project: project,
            noteCount: null,
            onTap: () => onOpenProject(project),
          );
        },
      ),
    );
  }
}

class _NewProjectButton extends StatelessWidget {
  const _NewProjectButton({required this.onTap});

  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Opacity(
        opacity: onTap == null ? 0.5 : 1,
        child: Container(
          height: 42,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              colors: [Color(0xFF4D9FFF), Color(0xFF2F80ED)],
            ),
            borderRadius: BorderRadius.circular(22),
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
              '+ New',
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: Colors.white,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ProjectCard extends StatelessWidget {
  const _ProjectCard({
    required this.project,
    required this.noteCount,
    required this.onTap,
  });

  final MeetingProject project;
  final int? noteCount;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    final initial = project.name.trim().isEmpty
        ? 'P'
        : project.name.trim().substring(0, 1).toUpperCase();
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(20),
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 76),
          padding: const EdgeInsets.fromLTRB(16, 14, 14, 14),
          decoration: BoxDecoration(
            color: palette.card,
            borderRadius: BorderRadius.circular(20),
            boxShadow: [
              BoxShadow(
                color: palette.cardShadow,
                blurRadius: 18,
                offset: Offset(0, 8),
              ),
            ],
          ),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: dark ? const Color(0xFF17345D) : const Color(0xFFE8F2FF),
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Center(
                  child: Text(
                    initial,
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                      color: FigmaDesign.activeBlue,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      project.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 15,
                        height: 1.15,
                        fontWeight: FontWeight.w600,
                        color: palette.text,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      noteCount == null
                          ? 'Open project'
                          : noteCount == 1
                              ? '1 note'
                              : '$noteCount notes',
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w300,
                        color: palette.textMuted,
                      ),
                    ),
                  ],
                ),
              ),
              Icon(
                Icons.chevron_right_rounded,
                size: 25,
                color: palette.textMuted,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _NewProjectSheet extends ConsumerStatefulWidget {
  const _NewProjectSheet({required this.notes});

  final List<MeetingNote> notes;

  @override
  ConsumerState<_NewProjectSheet> createState() => _NewProjectSheetState();
}

class _NewProjectSheetState extends ConsumerState<_NewProjectSheet> {
  final _controller = TextEditingController();
  final _selectedNoteIds = <String>{};
  String? _error;
  bool _saving = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    final name = _controller.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'Project name is required.');
      return;
    }

    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ref.read(projectsRepositoryProvider).create(
            name: name,
            noteIds: _selectedNoteIds.toList(),
          );
      if (!mounted) return;
      Navigator.of(context).pop(true);
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
    final palette = FigmaDesign.of(context);
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
                      'New Project',
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                        color: palette.text,
                      ),
                    ),
                  ),
                  IconButton(
                    onPressed: _saving ? null : () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _controller,
                autofocus: true,
                decoration: InputDecoration(
                  hintText: 'Project name',
                  filled: true,
                  fillColor: palette.field,
                  hintStyle: TextStyle(color: palette.textMuted),
                  contentPadding:
                      const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(18),
                    borderSide: BorderSide.none,
                  ),
                ),
                style: TextStyle(color: palette.text),
              ),
              const SizedBox(height: 18),
              Text(
                'Select notes',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: palette.textMuted,
                ),
              ),
              const SizedBox(height: 8),
              Flexible(
                child: widget.notes.isEmpty
                    ? const _ProjectSheetEmptyNoteList()
                    : ListView.separated(
                        shrinkWrap: true,
                        itemCount: widget.notes.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 8),
                        itemBuilder: (context, index) {
                          final note = widget.notes[index];
                          final selected = _selectedNoteIds.contains(note.id);
                          return _SelectableNoteRow(
                            note: note,
                            selected: selected,
                            onTap: () {
                              setState(() {
                                if (selected) {
                                  _selectedNoteIds.remove(note.id);
                                } else {
                                  _selectedNoteIds.add(note.id);
                                }
                              });
                            },
                          );
                        },
                      ),
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
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _saving ? null : _create,
                  style: ElevatedButton.styleFrom(
                    elevation: 0,
                    backgroundColor: const Color(0xFF2F80ED),
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(18),
                    ),
                  ),
                  child: Text(_saving ? 'Creating...' : 'Create Project'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SelectableNoteRow extends StatelessWidget {
  const _SelectableNoteRow({
    required this.note,
    required this.selected,
    required this.onTap,
  });

  final MeetingNote note;
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
          border: selected
              ? Border.all(color: dark ? const Color(0xFF2F80ED) : const Color(0xFFB8DAFF))
              : Border.all(color: Colors.transparent),
        ),
        child: Row(
          children: [
            Icon(
              selected
                  ? Icons.check_circle_rounded
                  : Icons.radio_button_unchecked_rounded,
              color:
                  selected ? FigmaDesign.activeBlue : palette.textMuted,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    note.title,
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
                    note.durationLabel,
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w300,
                      color: palette.textMuted,
                    ),
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

class _ProjectNoteRow extends StatelessWidget {
  const _ProjectNoteRow({
    required this.note,
    required this.onTap,
  });

  final MeetingNote note;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(20),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: palette.card,
            borderRadius: BorderRadius.circular(20),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  note.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: palette.text,
                  ),
                ),
              ),
              Icon(
                Icons.chevron_right_rounded,
                color: palette.textMuted,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ProjectSheetEmptyNoteList extends StatelessWidget {
  const _ProjectSheetEmptyNoteList();

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: palette.field,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Text(
        'No notes available yet.',
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w300,
          color: palette.textMuted,
        ),
      ),
    );
  }
}

class _ProjectsScreenData {
  const _ProjectsScreenData({
    required this.projects,
  });

  final List<MeetingProject> projects;
}
