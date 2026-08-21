import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/i18n/app_strings.dart';
import '../../../shared/widgets/widgets.dart';
import '../../auth/providers/auth_provider.dart';
import '../../notes/data/notes_repository.dart';
import '../data/settings_repository.dart';
import '../providers/settings_provider.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(appTextProvider);
    final auth = ref.watch(authControllerProvider);
    final user = auth.user;
    final language = ref.watch(appLanguageProvider);
    final themeMode = ref.watch(themeModeProvider);
    final counts = ref.watch(settingsCountsProvider);
    final palette = FigmaDesign.of(context);

    return Scaffold(
      backgroundColor: palette.pageBackground,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(22, 28, 22, 34),
          children: [
            Text(
              t('settings.title'),
              style: TextStyle(
                color: palette.text,
                fontSize: 26,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 26),
            _UserCard(
              name: user?.displayName ?? t('settings.defaultUserName'),
              email: user?.email ?? t('settings.signedInWith'),
            ),
            const SizedBox(height: 24),
            _SectionLabel(t('settings.general')),
            const SizedBox(height: 8),
            _SettingsGroup(
              children: [
                _SettingsRow(
                  title: t('settings.appLanguage'),
                  value: language.label,
                  onTap: () => _showLanguageSheet(context, ref, language),
                ),
                _SettingsRow(
                  title: t('settings.theme'),
                  value: _themeLabel(themeMode, t),
                  onTap: () => _showThemeSheet(context, ref, themeMode),
                ),
              ],
            ),
            const SizedBox(height: 22),
            _SettingsNavCard(
              title: t('settings.summaryPrompts'),
              subtitle: t('settings.summaryPromptsSub'),
              trailing: counts.maybeWhen(
                data: (data) => '${data.summaryPrompts}',
                orElse: () => '',
              ),
              onTap: () => context.push('/settings/summary-prompts'),
            ),
            const SizedBox(height: 12),
            _SettingsNavCard(
              title: t('settings.speakerProfiles'),
              subtitle: t('settings.speakerProfilesSub'),
              trailing: counts.maybeWhen(
                data: (data) => '${data.speakerProfiles}',
                orElse: () => '',
              ),
              onTap: () => context.push('/settings/speaker-profiles'),
            ),
            const SizedBox(height: 12),
            _SettingsNavCard(
              title: t('settings.myMemory'),
              subtitle: t('settings.myMemorySub'),
              trailing: counts.maybeWhen(
                data: (data) => '${data.personalMemoryItems}',
                orElse: () => '',
              ),
              onTap: () => context.push('/settings/my-memory'),
            ),
            const SizedBox(height: 12),
            _SettingsNavCard(
              title: t('settings.mcpSetup'),
              subtitle: t('settings.mcpSetupSub'),
              trailing: counts.maybeWhen(
                data: (data) => data.activeMcpKeys > 0
                    ? t('settings.mcpConnected')
                    : t('settings.mcpSetupBadge'),
                orElse: () => '',
              ),
              onTap: () => context.push('/settings/mcp-setup'),
            ),
            const SizedBox(height: 12),
            _SettingsNavCard(
              title: t('settings.issues'),
              subtitle: t('settings.issuesSub'),
              onTap: () => context.push('/settings/issues'),
            ),
            const SizedBox(height: 28),
            Center(
              child: TextButton(
                onPressed: auth.loading
                    ? null
                    : () => ref.read(authControllerProvider.notifier).signOut(),
                child: Text(
                  t('settings.signOut'),
                  style: const TextStyle(
                    color: Color(0xFFFF3B3B),
                    fontSize: 14,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _showLanguageSheet(
    BuildContext context,
    WidgetRef ref,
    AppLanguage selected,
  ) {
    final t = ref.read(appTextProvider);
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (context) => _ChoiceSheet<AppLanguage>(
        title: t('settings.appLanguage'),
        selected: selected,
        options: AppLanguage.values,
        labelFor: (value) => value.label,
        onSelected: (value) {
          ref.read(appLanguageProvider.notifier).set(value);
          Navigator.of(context).pop();
        },
      ),
    );
  }

  void _showThemeSheet(
    BuildContext context,
    WidgetRef ref,
    ThemeMode selected,
  ) {
    final t = ref.read(appTextProvider);
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (context) => _ChoiceSheet<ThemeMode>(
        title: t('settings.theme'),
        selected: selected,
        options: const [ThemeMode.light, ThemeMode.dark],
        labelFor: (value) => _themeLabel(value, t),
        onSelected: (value) {
          ref.read(themeModeProvider.notifier).set(value);
          Navigator.of(context).pop();
        },
      ),
    );
  }
}

class SummaryPromptsScreen extends ConsumerStatefulWidget {
  const SummaryPromptsScreen({super.key});

  @override
  ConsumerState<SummaryPromptsScreen> createState() =>
      _SummaryPromptsScreenState();
}

class _SummaryPromptsScreenState extends ConsumerState<SummaryPromptsScreen> {
  late Future<List<SettingsSummaryPrompt>> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<List<SettingsSummaryPrompt>> _load({bool preferCache = true}) async {
    final repository = ref.read(settingsRepositoryProvider);
    if (preferCache) {
      final cached = await repository.cachedSummaryPrompts();
      if (cached != null) {
        _refreshFromNetwork();
        return cached;
      }
    }
    return repository.refreshSummaryPrompts();
  }

  void _refresh() {
    setState(() => _future = _load(preferCache: false));
    ref.invalidate(settingsCountsProvider);
    ref.invalidate(promptsProvider);
  }

  Future<void> _refreshFromNetwork() async {
    try {
      final prompts = await ref
          .read(settingsRepositoryProvider)
          .refreshSummaryPrompts();
      if (!mounted) return;
      setState(() => _future = Future.value(prompts));
      ref.invalidate(settingsCountsProvider);
      ref.invalidate(promptsProvider);
    } catch (_) {
      // Keep showing cached prompts.
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = ref.watch(appTextProvider);
    return _SettingsSubScaffold(
      title: t('settings.summaryPrompts'),
      backLabel: t('common.back'),
      action: FigmaPillButton(
        label: '+',
        compact: true,
        onTap: () => _editPrompt(),
      ),
      child: FutureBuilder<List<SettingsSummaryPrompt>>(
        future: _future,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return _ErrorState(
              title: t('prompts.loadError'),
              error: snapshot.error,
              onRetry: _refresh,
              retryLabel: t('common.tryAgain'),
            );
          }
          final prompts = snapshot.data ?? const [];
          if (prompts.isEmpty) {
            return _EmptyState(t('prompts.empty'));
          }
          return ListView.separated(
            padding: const EdgeInsets.fromLTRB(22, 18, 22, 34),
            itemCount: prompts.length,
            separatorBuilder: (_, __) => const SizedBox(height: 12),
            itemBuilder: (context, index) {
              final prompt = prompts[index];
              return _SettingsNavCard(
                title: prompt.name,
                subtitle: _preview(prompt.prompt),
                onTap: () => _editPrompt(prompt),
                onDelete: () => _deletePrompt(prompt),
                deleteTooltip: t('prompts.delete'),
              );
            },
          );
        },
      ),
    );
  }

  Future<void> _editPrompt([SettingsSummaryPrompt? prompt]) async {
    final changed = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => _PromptEditorSheet(prompt: prompt),
    );
    if (changed == true) _refresh();
  }

  Future<void> _deletePrompt(SettingsSummaryPrompt prompt) async {
    final t = ref.read(appTextProvider);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(t('prompts.deleteTitle')),
        content: Text(
          t('prompts.deleteConfirm').replaceAll('{name}', prompt.name),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(t('common.cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(t('prompts.delete')),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await ref.read(settingsRepositoryProvider).deleteSummaryPrompt(prompt);
      _refresh();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${t('prompts.deleteError')}: $error')),
      );
    }
  }
}

class SpeakerProfilesScreen extends ConsumerStatefulWidget {
  const SpeakerProfilesScreen({super.key});

  @override
  ConsumerState<SpeakerProfilesScreen> createState() =>
      _SpeakerProfilesScreenState();
}

class _SpeakerProfilesScreenState extends ConsumerState<SpeakerProfilesScreen> {
  late Future<List<SettingsSpeakerProfile>> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<List<SettingsSpeakerProfile>> _load({bool preferCache = true}) async {
    final repository = ref.read(settingsRepositoryProvider);
    if (preferCache) {
      final cached = await repository.cachedSpeakerProfiles();
      if (cached != null) {
        _refreshFromNetwork();
        return cached;
      }
    }
    return repository.refreshSpeakerProfiles();
  }

  void _refresh() {
    setState(() => _future = _load(preferCache: false));
    ref.invalidate(settingsCountsProvider);
  }

  Future<void> _refreshFromNetwork() async {
    try {
      final speakers = await ref
          .read(settingsRepositoryProvider)
          .refreshSpeakerProfiles();
      if (!mounted) return;
      setState(() => _future = Future.value(speakers));
      ref.invalidate(settingsCountsProvider);
    } catch (_) {
      // Keep showing cached speakers.
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = ref.watch(appTextProvider);
    final user = ref.watch(authControllerProvider).user;
    return _SettingsSubScaffold(
      title: t('settings.speakerProfiles'),
      backLabel: t('common.back'),
      child: FutureBuilder<List<SettingsSpeakerProfile>>(
        future: _future,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return _ErrorState(
              title: t('speakers.loadError'),
              error: snapshot.error,
              onRetry: _refresh,
              retryLabel: t('common.tryAgain'),
            );
          }
          final speakers = snapshot.data ?? const [];
          final repo = ref.read(settingsRepositoryProvider);
          final self = repo.findSelfSpeaker(speakers, user?.displayName ?? '');
          final others = self == null
              ? speakers
              : speakers.where((speaker) => speaker.id != self.id).toList();

          return ListView(
            padding: const EdgeInsets.fromLTRB(22, 18, 22, 34),
            children: [
              _SectionLabel(t('speakers.yourProfile')),
              const SizedBox(height: 8),
              if (self == null)
                _InfoCard(
                  title: t('speakers.noSelfTitle'),
                  subtitle: t('speakers.noSelfSub'),
                )
              else
                _SpeakerCard(
                  speaker: self,
                  onTap: () => _editSpeaker(self),
                  profileSavedLabel: t('speakers.profileSaved'),
                  noProfileLabel: t('speakers.noProfile'),
                ),
              const SizedBox(height: 24),
              _SectionLabel(t('speakers.otherSpeakers')),
              const SizedBox(height: 8),
              if (others.isEmpty)
                _InfoCard(
                  title: t('speakers.noOthersTitle'),
                  subtitle: t('speakers.noOthersSub'),
                )
              else
                for (final speaker in others) ...[
                  _SpeakerCard(
                    speaker: speaker,
                    onTap: () => _editSpeaker(speaker),
                    profileSavedLabel: t('speakers.profileSaved'),
                    noProfileLabel: t('speakers.noProfile'),
                  ),
                  const SizedBox(height: 12),
                ],
            ],
          );
        },
      ),
    );
  }

  Future<void> _editSpeaker(SettingsSpeakerProfile speaker) async {
    final changed = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => _SpeakerEditorSheet(speaker: speaker),
    );
    if (changed == true) _refresh();
  }
}

class MyMemoryScreen extends ConsumerStatefulWidget {
  const MyMemoryScreen({super.key});

  @override
  ConsumerState<MyMemoryScreen> createState() => _MyMemoryScreenState();
}

class _MyMemoryScreenState extends ConsumerState<MyMemoryScreen> {
  late Future<List<SettingsMemoryItem>> _future;
  bool _confirmingDelete = false;
  bool _deleting = false;

  @override
  void initState() {
    super.initState();
    _future = ref.read(settingsRepositoryProvider).userMemory();
  }

  void _refresh() {
    setState(() {
      _confirmingDelete = false;
      _future = ref.read(settingsRepositoryProvider).userMemory();
    });
    ref.invalidate(settingsCountsProvider);
  }

  Future<void> _delete() async {
    setState(() => _deleting = true);
    try {
      await ref.read(settingsRepositoryProvider).clearUserMemory();
      if (!mounted) return;
      setState(() {
        _deleting = false;
        _confirmingDelete = false;
        _future = Future.value(const <SettingsMemoryItem>[]);
      });
      ref.invalidate(settingsCountsProvider);
    } catch (_) {
      if (!mounted) return;
      setState(() => _deleting = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(ref.read(appTextProvider)('memory.deleteError'))),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = ref.watch(appTextProvider);
    final palette = FigmaDesign.of(context);
    return _SettingsSubScaffold(
      title: t('settings.myMemory'),
      backLabel: t('common.back'),
      child: FutureBuilder<List<SettingsMemoryItem>>(
        future: _future,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return _ErrorState(
              title: t('memory.loadError'),
              error: snapshot.error,
              onRetry: _refresh,
              retryLabel: t('common.tryAgain'),
            );
          }
          final items = snapshot.data ?? const [];
          return ListView(
            padding: const EdgeInsets.fromLTRB(22, 18, 22, 34),
            children: [
              Text(
                t('memory.desc'),
                style: TextStyle(color: palette.textMuted, fontSize: 13, height: 1.45),
              ),
              const SizedBox(height: 20),
              if (items.isEmpty)
                _InfoCard(
                  title: t('memory.emptyTitle'),
                  subtitle: t('memory.emptySub'),
                )
              else ...[
                for (final item in items) ...[
                  _MemoryItemCard(text: item.text),
                  const SizedBox(height: 10),
                ],
                const SizedBox(height: 14),
                _DeleteMemoryControl(
                  confirming: _confirmingDelete,
                  deleting: _deleting,
                  onStart: () => setState(() => _confirmingDelete = true),
                  onCancel: () => setState(() => _confirmingDelete = false),
                  onConfirm: _delete,
                  deleteLabel: t('memory.delete'),
                  confirmText: t('memory.deleteConfirm'),
                  deletingLabel: t('memory.deleting'),
                  deleteYesLabel: t('memory.deleteYes'),
                  cancelLabel: t('common.cancel'),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _MemoryItemCard extends StatelessWidget {
  const _MemoryItemCard({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return FigmaGlassCard(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            margin: const EdgeInsets.only(top: 6, right: 12),
            width: 6,
            height: 6,
            decoration: const BoxDecoration(
              color: Color(0xFF2F80FF),
              shape: BoxShape.circle,
            ),
          ),
          Expanded(
            child: Text(
              text,
              style: TextStyle(color: palette.text, fontSize: 14, height: 1.45),
            ),
          ),
        ],
      ),
    );
  }
}

class _DeleteMemoryControl extends StatelessWidget {
  const _DeleteMemoryControl({
    required this.confirming,
    required this.deleting,
    required this.onStart,
    required this.onCancel,
    required this.onConfirm,
    required this.deleteLabel,
    required this.confirmText,
    required this.deletingLabel,
    required this.deleteYesLabel,
    required this.cancelLabel,
  });

  final bool confirming;
  final bool deleting;
  final VoidCallback onStart;
  final VoidCallback onCancel;
  final Future<void> Function() onConfirm;
  final String deleteLabel;
  final String confirmText;
  final String deletingLabel;
  final String deleteYesLabel;
  final String cancelLabel;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    if (!confirming) {
      return Align(
        alignment: Alignment.centerLeft,
        child: TextButton.icon(
          onPressed: onStart,
          icon: const Icon(Icons.delete_outline_rounded,
              size: 18, color: Color(0xFFFF3B3B)),
          label: Text(
            deleteLabel,
            style: const TextStyle(
              color: Color(0xFFFF3B3B),
              fontSize: 14,
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          confirmText,
          style: TextStyle(color: palette.textSecondary, fontSize: 13),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            FilledButton(
              onPressed: deleting ? null : () => onConfirm(),
              style: FilledButton.styleFrom(
                backgroundColor: const Color(0xFFFF3B3B),
              ),
              child: Text(deleting ? deletingLabel : deleteYesLabel),
            ),
            const SizedBox(width: 10),
            TextButton(
              onPressed: deleting ? null : onCancel,
              child: Text(cancelLabel,
                  style: TextStyle(color: palette.textSecondary)),
            ),
          ],
        ),
      ],
    );
  }
}

class McpSetupScreen extends ConsumerStatefulWidget {
  const McpSetupScreen({super.key});

  @override
  ConsumerState<McpSetupScreen> createState() => _McpSetupScreenState();
}

class _McpSetupScreenState extends ConsumerState<McpSetupScreen> {
  var _showClaude = false;
  late Future<List<McpTokenRow>> _future;
  String? _newToken;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<List<McpTokenRow>> _load() =>
      ref.read(settingsRepositoryProvider).mcpTokens();

  void _refresh() {
    setState(() => _future = _load());
    ref.invalidate(settingsCountsProvider);
  }

  @override
  Widget build(BuildContext context) {
    final t = ref.watch(appTextProvider);
    return _SettingsSubScaffold(
      title: t('settings.mcpSetup'),
      backLabel: t('common.back'),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(22, 18, 22, 34),
        children: [
          _SegmentedToggle(
            left: 'ChatGPT',
            right: 'Claude',
            rightSelected: _showClaude,
            onChanged: (value) => setState(() => _showClaude = value),
          ),
          const SizedBox(height: 18),
          if (_showClaude) _claudeSetup() else _chatGptSetup(),
        ],
      ),
    );
  }

  Widget _chatGptSetup() {
    final t = ref.watch(appTextProvider);
    const url = 'https://meeting-note-mcp.onrender.com/mcp-chatgpt';
    return Column(
      children: [
        _InfoCard(
          title: t('mcp.chatgptUrlTitle'),
          subtitle: url,
          action: _SmallAction(
            label: t('mcp.copy'),
            onTap: () => _copy(url),
          ),
        ),
        const SizedBox(height: 12),
        _InstructionCard(
          title: t('mcp.chatgptStepsTitle'),
          steps: [
            t('mcp.chatgptStep1'),
            t('mcp.chatgptStep2'),
            t('mcp.chatgptStep3'),
            t('mcp.chatgptStep4'),
            t('mcp.chatgptStep5'),
          ],
        ),
      ],
    );
  }

  Widget _claudeSetup() {
    final t = ref.watch(appTextProvider);
    final config = _claudeConfig(_newToken);
    return Column(
      children: [
        _InfoCard(
          title: t('mcp.keyTitle'),
          subtitle: t('mcp.keySub'),
          action: _SmallAction(
            label: _busy ? t('mcp.working') : t('mcp.generate'),
            onTap: _busy ? null : _generateToken,
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 10),
          Text(
            _error!,
            style: const TextStyle(color: Color(0xFFE5484D), fontSize: 12),
          ),
        ],
        if (_newToken != null) ...[
          const SizedBox(height: 12),
          _CodeCard(
            title: t('mcp.newKeyTitle'),
            code: _newToken!,
            onCopy: () => _copy(_newToken!),
            copyLabel: t('mcp.copy'),
          ),
        ],
        const SizedBox(height: 12),
        _CodeCard(
          title: t('mcp.configTitle'),
          code: config,
          onCopy: () => _copy(config),
          copyLabel: t('mcp.copy'),
        ),
        const SizedBox(height: 12),
        FutureBuilder<List<McpTokenRow>>(
          future: _future,
          builder: (context, snapshot) {
            if (snapshot.connectionState == ConnectionState.waiting) {
              return _InfoCard(
                title: t('mcp.existingKeysTitle'),
                subtitle: t('mcp.loadingKeys'),
              );
            }
            final tokens = snapshot.data ?? const [];
            if (tokens.isEmpty) {
              return _InfoCard(
                title: t('mcp.existingKeysTitle'),
                subtitle: t('mcp.noKeys'),
              );
            }
            return _SettingsGroup(
              children: [
                for (final token in tokens)
                  _SettingsRow(
                    title: token.name,
                    value: token.isActive ? t('mcp.revoke') : t('mcp.inactive'),
                    subtitle: '${token.tokenPrefix} - ${_dateLabel(token.createdAt)}',
                    onTap: token.isActive ? () => _revokeToken(token.id) : null,
                  ),
              ],
            );
          },
        ),
        const SizedBox(height: 12),
        _InstructionCard(
          title: t('mcp.claudeStepsTitle'),
          steps: [
            t('mcp.claudeStep1'),
            t('mcp.claudeStep2'),
            t('mcp.claudeStep3'),
            t('mcp.claudeStep4'),
            t('mcp.claudeStep5'),
          ],
        ),
      ],
    );
  }

  Future<void> _generateToken() async {
    setState(() {
      _busy = true;
      _error = null;
      _newToken = null;
    });
    try {
      final result = await ref.read(settingsRepositoryProvider).createMcpToken();
      setState(() => _newToken = result.token);
      _refresh();
    } catch (error) {
      setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _revokeToken(String tokenId) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(settingsRepositoryProvider).revokeMcpToken(tokenId);
      _refresh();
    } catch (error) {
      setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _copy(String text) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(ref.read(appTextProvider)('mcp.copied'))),
    );
  }
}

class _PromptEditorSheet extends ConsumerStatefulWidget {
  const _PromptEditorSheet({this.prompt});

  final SettingsSummaryPrompt? prompt;

  @override
  ConsumerState<_PromptEditorSheet> createState() => _PromptEditorSheetState();
}

class _PromptEditorSheetState extends ConsumerState<_PromptEditorSheet> {
  late final TextEditingController _name;
  late final TextEditingController _prompt;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _name = TextEditingController(text: widget.prompt?.name ?? '');
    _prompt = TextEditingController(text: widget.prompt?.prompt ?? '');
  }

  @override
  void dispose() {
    _name.dispose();
    _prompt.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = ref.watch(appTextProvider);
    final existing = widget.prompt;
    return _EditorSheet(
      title: existing == null ? t('prompts.newTitle') : existing.name,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _TextInput(controller: _name, label: t('prompts.name')),
          const SizedBox(height: 12),
          _TextInput(
            controller: _prompt,
            label: t('prompts.prompt'),
            minLines: 12,
            maxLines: 18,
            monospace: true,
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: const TextStyle(color: Color(0xFFE5484D))),
          ],
          const SizedBox(height: 16),
          Row(
            children: [
              if (existing != null)
                Expanded(
                  child: _SecondaryButton(
                    label: t('prompts.delete'),
                    onTap: _saving ? null : _delete,
                    danger: true,
                  ),
                ),
              if (existing != null)
                const SizedBox(width: 10),
              Expanded(
                child: _PrimaryButton(
                  label: _saving ? t('prompts.saving') : t('prompts.save'),
                  onTap: _saving ? null : _save,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final prompt = _prompt.text.trim();
    if (name.isEmpty || prompt.isEmpty) {
      setState(() => _error = ref.read(appTextProvider)('prompts.required'));
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final repo = ref.read(settingsRepositoryProvider);
      final existing = widget.prompt;
      if (existing == null) {
        await repo.createSummaryPrompt(name: name, prompt: prompt);
      } else {
        await repo.updateSummaryPrompt(
          existing.copyWith(name: name, prompt: prompt),
        );
      }
      if (mounted) Navigator.of(context).pop(true);
    } catch (error) {
      setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _delete() async {
    final prompt = widget.prompt;
    if (prompt == null) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ref.read(settingsRepositoryProvider).deleteSummaryPrompt(prompt);
      if (mounted) Navigator.of(context).pop(true);
    } catch (error) {
      setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }
}

class _SpeakerEditorSheet extends ConsumerStatefulWidget {
  const _SpeakerEditorSheet({required this.speaker});

  final SettingsSpeakerProfile speaker;

  @override
  ConsumerState<_SpeakerEditorSheet> createState() => _SpeakerEditorSheetState();
}

class _SpeakerEditorSheetState extends ConsumerState<_SpeakerEditorSheet> {
  late final TextEditingController _profile;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _profile = TextEditingController(text: _prettyProfile(widget.speaker.profile));
  }

  @override
  void dispose() {
    _profile.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = ref.watch(appTextProvider);
    final palette = FigmaDesign.of(context);
    return _EditorSheet(
      title: widget.speaker.name,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (widget.speaker.email != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(
                widget.speaker.email!,
                style: TextStyle(color: palette.textMuted, fontSize: 13),
              ),
            ),
          _TextInput(
            controller: _profile,
            label: t('speakers.profileLabel'),
            minLines: 14,
            maxLines: 20,
            monospace: true,
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: const TextStyle(color: Color(0xFFE5484D))),
          ],
          const SizedBox(height: 16),
          _PrimaryButton(
            label: _saving ? t('speakers.saving') : t('speakers.saveProfile'),
            onTap: _saving ? null : _save,
          ),
        ],
      ),
    );
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ref.read(settingsRepositoryProvider).updateSpeakerProfile(
            id: widget.speaker.id,
            profile: _profile.text,
          );
      if (mounted) Navigator.of(context).pop(true);
    } catch (error) {
      setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }
}

class _SettingsSubScaffold extends StatelessWidget {
  const _SettingsSubScaffold({
    required this.title,
    required this.child,
    required this.backLabel,
    this.action,
  });

  final String title;
  final Widget child;
  final String backLabel;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Scaffold(
      backgroundColor: palette.pageBackground,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 24, 22, 0),
              child: Row(
                children: [
                  GestureDetector(
                    onTap: () => context.pop(),
                    child: Text(
                      backLabel,
                      style: TextStyle(
                        color: palette.textSecondary,
                        fontSize: 14,
                        fontWeight: FontWeight.w400,
                      ),
                    ),
                  ),
                  Expanded(
                    child: Text(
                      title,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: palette.text,
                        fontSize: 18,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  SizedBox(width: 56, child: Align(alignment: Alignment.centerRight, child: action)),
                ],
              ),
            ),
            Expanded(child: child),
          ],
        ),
      ),
    );
  }
}

class _UserCard extends StatelessWidget {
  const _UserCard({required this.name, required this.email});

  final String name;
  final String email;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return FigmaGlassCard(
      child: Row(
        children: [
          FigmaAvatarInitial(name: name),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: palette.text,
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  email,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: palette.textMuted,
                    fontSize: 12,
                    fontWeight: FontWeight.w400,
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

class _SettingsGroup extends StatelessWidget {
  const _SettingsGroup({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return FigmaGlassCard(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          for (var i = 0; i < children.length; i++) ...[
            children[i],
            if (i < children.length - 1)
              Divider(
                height: 1,
                indent: 15,
                endIndent: 15,
                color: palette.divider,
              ),
          ],
        ],
      ),
    );
  }
}

class _SettingsRow extends StatelessWidget {
  const _SettingsRow({
    required this.title,
    required this.value,
    this.subtitle,
    this.onTap,
  });

  final String title;
  final String value;
  final String? subtitle;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(20),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 16),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: TextStyle(
                      color: palette.text,
                      fontSize: 15,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  if (subtitle != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      subtitle!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: palette.textMuted,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 12),
            Text(
              value,
              style: TextStyle(
                color: onTap == null ? palette.textMuted : palette.textSecondary,
                fontSize: 13,
                fontWeight: FontWeight.w400,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SettingsNavCard extends StatelessWidget {
  const _SettingsNavCard({
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.trailing = '',
    this.onDelete,
    this.deleteTooltip,
  });

  final String title;
  final String subtitle;
  final String trailing;
  final VoidCallback onTap;
  final VoidCallback? onDelete;
  final String? deleteTooltip;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return FigmaGlassCard(
      onTap: onTap,
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: palette.text,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  subtitle,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: palette.textMuted,
                    fontSize: 12,
                    height: 1.25,
                    fontWeight: FontWeight.w400,
                  ),
                ),
              ],
            ),
          ),
          if (trailing.isNotEmpty) ...[
            const SizedBox(width: 10),
            Text(
              trailing,
              style: TextStyle(
                color: palette.textSecondary,
                fontSize: 12,
                fontWeight: FontWeight.w400,
              ),
            ),
          ],
          if (onDelete != null) ...[
            const SizedBox(width: 10),
            IconButton(
              tooltip: deleteTooltip,
              onPressed: onDelete,
              icon: const Icon(
                Icons.delete_outline_rounded,
                color: Color(0xFFE5484D),
                size: 20,
              ),
            ),
          ] else ...[
            const SizedBox(width: 8),
            const Icon(
              Icons.chevron_right_rounded,
              color: Color(0xFF9AA4B5),
              size: 22,
            ),
          ],
        ],
      ),
    );
  }
}

class _SpeakerCard extends StatelessWidget {
  const _SpeakerCard({
    required this.speaker,
    required this.onTap,
    required this.profileSavedLabel,
    required this.noProfileLabel,
  });

  final SettingsSpeakerProfile speaker;
  final VoidCallback onTap;
  final String profileSavedLabel;
  final String noProfileLabel;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final hasProfile = speaker.profile != null && speaker.profile!.trim().isNotEmpty;
    return FigmaGlassCard(
      onTap: onTap,
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: const Color(0xFFEAF3FF),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Center(
              child: Text(
                figmaInitial(speaker.name),
                style: const TextStyle(
                  color: Color(0xFF2F80FF),
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  speaker.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: palette.text,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  speaker.email ?? (hasProfile ? profileSavedLabel : noProfileLabel),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: palette.textMuted,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          const Icon(Icons.chevron_right_rounded, color: Color(0xFF9AA4B5)),
        ],
      ),
    );
  }
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({required this.title, required this.subtitle, this.action});

  final String title;
  final String subtitle;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return FigmaGlassCard(
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    color: palette.text,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 5),
                Text(
                  subtitle,
                  style: TextStyle(
                    color: palette.textSecondary,
                    fontSize: 12,
                    height: 1.35,
                  ),
                ),
              ],
            ),
          ),
          if (action != null) ...[const SizedBox(width: 10), action!],
        ],
      ),
    );
  }
}

class _InstructionCard extends StatelessWidget {
  const _InstructionCard({required this.title, required this.steps});

  final String title;
  final List<String> steps;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return FigmaGlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(
              color: palette.text,
              fontSize: 15,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 10),
          for (var i = 0; i < steps.length; i++)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                '${i + 1}. ${steps[i]}',
                style: TextStyle(
                  color: palette.textSecondary,
                  fontSize: 13,
                  height: 1.35,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _CodeCard extends StatelessWidget {
  const _CodeCard({
    required this.title,
    required this.code,
    required this.onCopy,
    required this.copyLabel,
  });

  final String title;
  final String code;
  final VoidCallback onCopy;
  final String copyLabel;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return FigmaGlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  title,
                  style: TextStyle(
                    color: palette.text,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              _SmallAction(label: copyLabel, onTap: onCopy),
            ],
          ),
          const SizedBox(height: 10),
          Container(
            width: double.infinity,
            constraints: const BoxConstraints(maxHeight: 220),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: palette.codeBackground,
              borderRadius: BorderRadius.circular(14),
            ),
            child: SingleChildScrollView(
              child: SelectableText(
                code,
                style: TextStyle(
                  color: palette.textSecondary,
                  fontFamily: 'monospace',
                  fontSize: 11,
                  height: 1.35,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Padding(
      padding: const EdgeInsets.only(left: 4),
      child: Text(
        label,
        style: TextStyle(
          color: palette.textMuted,
          fontSize: 11,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }
}

class _ChoiceSheet<T> extends StatelessWidget {
  const _ChoiceSheet({
    required this.title,
    required this.options,
    required this.selected,
    required this.labelFor,
    required this.onSelected,
  });

  final String title;
  final List<T> options;
  final T selected;
  final String Function(T value) labelFor;
  final ValueChanged<T> onSelected;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              title,
              style: TextStyle(
                color: palette.text,
                fontSize: 18,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 12),
            for (final option in options)
              ListTile(
                title: Text(labelFor(option)),
                trailing: option == selected
                    ? const Icon(Icons.check_rounded, color: Color(0xFF2F80FF))
                    : null,
                onTap: () => onSelected(option),
              ),
          ],
        ),
      ),
    );
  }
}

class _EditorSheet extends StatelessWidget {
  const _EditorSheet({required this.title, required this.child});

  final String title;
  final Widget child;

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
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                title,
                style: TextStyle(
                  color: palette.text,
                  fontSize: 18,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 16),
              Flexible(
                child: SingleChildScrollView(
                  child: child,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TextInput extends StatelessWidget {
  const _TextInput({
    required this.controller,
    required this.label,
    this.minLines = 1,
    this.maxLines = 1,
    this.monospace = false,
  });

  final TextEditingController controller;
  final String label;
  final int minLines;
  final int maxLines;
  final bool monospace;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return TextField(
      controller: controller,
      minLines: minLines,
      maxLines: maxLines,
      style: TextStyle(
        color: palette.text,
        fontFamily: monospace ? 'monospace' : null,
        fontSize: monospace ? 12 : 14,
        height: 1.35,
      ),
      decoration: InputDecoration(
        labelText: label,
        filled: true,
        fillColor: palette.field,
        labelStyle: TextStyle(color: palette.textMuted),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          borderSide: BorderSide(color: palette.fieldBorder),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          borderSide: BorderSide(color: palette.fieldBorder),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          borderSide: const BorderSide(color: Color(0xFF2F80FF)),
        ),
      ),
    );
  }
}

class _PrimaryButton extends StatelessWidget {
  const _PrimaryButton({required this.label, required this.onTap});

  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Opacity(
        opacity: onTap == null ? 0.55 : 1,
        child: Container(
          height: 54,
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              colors: [Color(0xFF4D9FFF), Color(0xFF2F80ED)],
            ),
            borderRadius: BorderRadius.circular(26),
            boxShadow: [
              BoxShadow(
                color: const Color(0xFF2F80ED).withValues(alpha: 0.24),
                blurRadius: 18,
                offset: const Offset(0, 9),
              ),
            ],
          ),
          child: Center(
            child: Text(
              label,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 15,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SecondaryButton extends StatelessWidget {
  const _SecondaryButton({
    required this.label,
    required this.onTap,
    this.danger = false,
  });

  final String label;
  final VoidCallback? onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 54,
        decoration: BoxDecoration(
          color: palette.card,
          borderRadius: BorderRadius.circular(26),
        ),
        child: Center(
          child: Text(
            label,
            style: TextStyle(
              color: danger ? const Color(0xFFFF3B3B) : const Color(0xFF2F80FF),
              fontSize: 15,
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
      ),
    );
  }
}

class _SmallAction extends StatelessWidget {
  const _SmallAction({required this.label, required this.onTap});

  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Opacity(
        opacity: onTap == null ? 0.5 : 1,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: Theme.of(context).brightness == Brightness.dark
                ? const Color(0xFF17345D)
                : const Color(0xFFEAF3FF),
            borderRadius: BorderRadius.circular(16),
          ),
          child: Text(
            label,
            style: const TextStyle(
              color: Color(0xFF2F80FF),
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ),
    );
  }
}

class _SegmentedToggle extends StatelessWidget {
  const _SegmentedToggle({
    required this.left,
    required this.right,
    required this.rightSelected,
    required this.onChanged,
  });

  final String left;
  final String right;
  final bool rightSelected;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return FigmaSlidingSegmentedToggle(
      options: [
        FigmaSegmentOption(label: left),
        FigmaSegmentOption(label: right),
      ],
      selectedIndex: rightSelected ? 1 : 0,
      onChanged: (index) => onChanged(index == 1),
      height: 44,
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({
    required this.title,
    required this.error,
    required this.onRetry,
    required this.retryLabel,
  });

  final String title;
  final Object? error;
  final VoidCallback onRetry;
  final String retryLabel;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.error_outline_rounded,
              color: palette.textSecondary,
              size: 42,
            ),
            const SizedBox(height: 12),
            Text(
              title,
              style: TextStyle(
                color: palette.text,
                fontSize: 18,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              error.toString(),
              textAlign: TextAlign.center,
              style: TextStyle(color: palette.textSecondary, fontSize: 13),
            ),
            const SizedBox(height: 18),
            FigmaPillButton(label: retryLabel, onTap: onRetry, compact: true),
          ],
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState(this.message);

  final String message;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Center(
      child: Text(
        message,
        style: TextStyle(color: palette.textSecondary, fontSize: 14),
      ),
    );
  }
}

String _themeLabel(ThemeMode mode, AppText t) => switch (mode) {
      ThemeMode.light => t('theme.light'),
      ThemeMode.dark => t('theme.dark'),
      ThemeMode.system => t('theme.light'),
    };

String _preview(String value) {
  final compact = value.trim().replaceAll(RegExp(r'\s+'), ' ');
  if (compact.length <= 82) return compact;
  return '${compact.substring(0, 82)}...';
}

String _prettyProfile(String? value) {
  final trimmed = value?.trim();
  if (trimmed == null || trimmed.isEmpty) return '';
  try {
    return const JsonEncoder.withIndent('  ').convert(jsonDecode(trimmed));
  } catch (_) {
    return trimmed;
  }
}

String _dateLabel(DateTime date) => '${date.month}/${date.day}/${date.year}';

String _claudeConfig(String? token) {
  final header = token == null || token.isEmpty
      ? 'Generate a key above to fill this value'
      : 'Bearer $token';
  return const JsonEncoder.withIndent('  ').convert({
    'mcpServers': {
      'meeting-note': {
        'command': 'npx.cmd',
        'args': [
          '-y',
          'mcp-remote',
          'https://meeting-note-mcp.onrender.com/mcp',
          '--header',
          r'Authorization:${AUTH_HEADER}',
        ],
        'env': {'AUTH_HEADER': header},
      },
    },
  });
}
