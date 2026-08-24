// RadioListTile is still appropriate for this compact picker; Flutter's newer
// RadioGroup migration can happen alongside a broader SDK pass.
// ignore_for_file: deprecated_member_use

import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';

import '../../../core/i18n/app_strings.dart';
import '../../../shared/util/uuid.dart';
import '../../../shared/widgets/widgets.dart';
import '../../auth/providers/auth_provider.dart';
import '../../settings/data/settings_repository.dart';
import '../data/notes_repository.dart';
import '../models/meeting_note.dart';
import 'processing_screen.dart';

class NewNoteDraft {
  const NewNoteDraft({
    required this.audioPath,
    this.attachmentPaths = const [],
  });

  final String audioPath;
  final List<String> attachmentPaths;
}

class NewNoteScreen extends ConsumerStatefulWidget {
  const NewNoteScreen({
    super.key,
    this.audioPath,
    this.initialAttachmentPaths = const [],
  });

  final String? audioPath;
  final List<String> initialAttachmentPaths;

  @override
  ConsumerState<NewNoteScreen> createState() => _NewNoteScreenState();
}

class _NewNoteScreenState extends ConsumerState<NewNoteScreen> {
  late final TextEditingController _title;
  final _instructions = TextEditingController();
  final _peopleCount = TextEditingController();
  SummaryPrompt? _prompt;
  late String? _audioPath;
  late final List<String> _attachmentPaths;
  bool _loadingPrompts = true;

  @override
  void initState() {
    super.initState();
    _title = TextEditingController(
      text: 'Meeting ${DateFormat('yyyy-MM-dd HH:mm').format(DateTime.now())}',
    );
    _audioPath = widget.audioPath;
    _attachmentPaths = [...widget.initialAttachmentPaths];
    Future.microtask(_loadDefaultPrompt);
  }

  @override
  void dispose() {
    _title.dispose();
    _instructions.dispose();
    _peopleCount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final t = ref.watch(appTextProvider);
    final audioName = _fileName(_audioPath) ?? t('newNote.noAudioSelected');
    final attachmentNames = _attachmentPaths.map(_fileName).whereType<String>().toList();

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
                    onTap: _goBackToRecord,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Text(
                        t('newNote.back'),
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
                    t('newNote.title'),
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
              const SizedBox(height: 30),
              Expanded(
                child: ListView(
                  padding: EdgeInsets.zero,
                  children: [
                    _AudioSourceCard(
                      name: audioName,
                      meta: _audioMetaLine(_audioPath),
                      removeLabel: t('newNote.remove'),
                      onRemove: () => setState(() => _audioPath = null),
                    ),
                    const SizedBox(height: 24),
                    _FieldLabel(t('newNote.titleLabel')),
                    const SizedBox(height: 8),
                    _FigmaTextField(
                      controller: _title,
                      minHeight: 51,
                    ),
                    const SizedBox(height: 23),
                    _FieldLabel(t('newNote.instructionsLabel')),
                    const SizedBox(height: 8),
                    _FigmaTextField(
                      controller: _instructions,
                      minHeight: 84,
                      maxLines: 3,
                      hintText: t('newNote.instructionsHint'),
                    ),
                    const SizedBox(height: 23),
                    _FieldLabel(t('newNote.peopleCountLabel')),
                    const SizedBox(height: 8),
                    _FigmaTextField(
                      controller: _peopleCount,
                      minHeight: 51,
                      keyboardType: TextInputType.number,
                      hintText: t('newNote.peopleCountHint'),
                    ),
                    const SizedBox(height: 23),
                    _FieldLabel(t('newNote.summaryPromptLabel')),
                    const SizedBox(height: 8),
                    _SummaryPromptButton(
                      label: _prompt?.name ??
                          (_loadingPrompts
                              ? t('newNote.loadingPrompts')
                              : t('newNote.chooseSummaryPrompt')),
                      changeLabel: t('newNote.change'),
                      onTap: _pickPrompt,
                    ),
                    const SizedBox(height: 26),
                    _FieldLabel(t('newNote.attachments')),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: _AttachmentButton(
                            label: t('newNote.attachFile'),
                            onTap: _pickAttachment,
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: _AttachmentButton(
                            label: t('newNote.camera'),
                            icon: Icons.camera_alt_outlined,
                            onTap: _pickCameraImage,
                          ),
                        ),
                      ],
                    ),
                    if (attachmentNames.isNotEmpty) ...[
                      const SizedBox(height: 10),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          for (var i = 0; i < attachmentNames.length; i++)
                            _AttachmentButton(
                              label: attachmentNames[i],
                              muted: true,
                              onTap: () => setState(() => _attachmentPaths.removeAt(i)),
                            ),
                        ],
                      ),
                    ],
                    const SizedBox(height: 55),
                    PrimaryButton(
                      label: t('newNote.generateSummary'),
                      loading: false,
                      onPressed: _audioPath == null ? null : _submit,
                    ),
                    const SizedBox(height: 19),
                    Text(
                      t('newNote.notifyReady'),
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w300,
                        color: palette.textMuted,
                      ),
                    ),
                    const SizedBox(height: 34),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _pickPrompt() async {
    final t = ref.read(appTextProvider);
    late final List<SummaryPrompt> prompts;
    try {
      prompts = await _loadPromptsFresh();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${t('newNote.couldNotLoadPrompts')}: $error')),
      );
      return;
    }
    if (!mounted) return;
    if (prompts.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(t('newNote.noSummaryPrompts')),
        ),
      );
      return;
    }
    final currentPrompt = _prompt ?? _preferredPrompt(prompts);
    final selected = await showModalBottomSheet<SummaryPrompt>(
      context: context,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.symmetric(vertical: 16),
          children: [
            for (final p in prompts)
              RadioListTile<String>(
                value: p.id,
                groupValue: currentPrompt.id,
                onChanged: (_) => Navigator.pop(context, p),
                title: Text(p.name),
                subtitle: p.description != null ? Text(p.description!) : null,
              ),
          ],
        ),
      ),
    );
    if (selected != null) setState(() => _prompt = selected);
  }

  Future<void> _loadDefaultPrompt() async {
    try {
      final prompts = await _loadPrompts();
      if (!mounted || prompts.isEmpty || _prompt != null) return;
      setState(() => _prompt = _preferredPrompt(prompts));
      _loadPromptsFresh().catchError((_) => <SummaryPrompt>[]);
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            '${ref.read(appTextProvider)('newNote.couldNotLoadPrompts')}: $error',
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _loadingPrompts = false);
    }
  }

  Future<List<SummaryPrompt>> _loadPromptsFresh() async {
    ref.invalidate(promptsProvider);
    final rows = await ref.read(settingsRepositoryProvider).refreshSummaryPrompts();
    return _summaryPromptsFromSettings(rows);
  }

  Future<List<SummaryPrompt>> _loadPrompts() async {
    final repository = ref.read(settingsRepositoryProvider);
    final rows = await repository.cachedSummaryPrompts() ??
        await repository.refreshSummaryPrompts();
    return _summaryPromptsFromSettings(rows);
  }

  List<SummaryPrompt> _summaryPromptsFromSettings(
    List<SettingsSummaryPrompt> rows,
  ) {
    return rows
        .map(
          (row) => SummaryPrompt(
            id: row.id,
            name: row.name,
            description: _previewPrompt(row.prompt),
          ),
        )
        .toList();
  }

  SummaryPrompt _preferredPrompt(List<SummaryPrompt> prompts) {
    for (final prompt in prompts) {
      if (prompt.name.trim().toLowerCase() == 'default') return prompt;
    }
    return prompts.first;
  }

  Future<SummaryPrompt?> _selectedPromptForSubmit() async {
    if (_prompt != null) return _prompt;
    final prompts = await _loadPrompts();
    if (prompts.isEmpty) return null;
    final prompt = _preferredPrompt(prompts);
    if (mounted) setState(() => _prompt = prompt);
    return prompt;
  }

  Future<void> _showAudioOptions() async {
    final t = ref.read(appTextProvider);
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
                title: Text(t('newNote.chooseAudioFile')),
                subtitle: Text(t('newNote.chooseAudioFileSub')),
                onTap: () => Navigator.pop(context, 'pick'),
              ),
              ListTile(
                leading: const Icon(Icons.edit_rounded),
                title: Text(t('newNote.enterLocalPath')),
                subtitle: Text(t('newNote.enterLocalPathSub')),
                onTap: () => Navigator.pop(context, 'manual'),
              ),
            ],
          ),
        ),
      ),
    );

    if (!mounted || selected == null) return;
    if (selected == 'pick') {
      final path = await _pickAudioFile();
      if (path != null) setState(() => _audioPath = path);
      return;
    }
    if (selected == 'manual') {
      final path = await _showManualPathDialog();
      if (path != null) setState(() => _audioPath = path);
      return;
    }
    setState(() => _audioPath = selected);
  }

  Future<String?> _pickAudioFile() async {
    try {
      final result = await FilePicker.pickFiles(
        type: FileType.custom,
        allowedExtensions: [
          'm4a',
          'mp3',
          'wav',
          'aac',
          'ogg',
          'flac',
          'mp4',
          'webm',
        ],
      );
      return result?.files.single.path;
    } catch (error) {
      if (!mounted) return null;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            '${ref.read(appTextProvider)('newNote.couldNotChooseAudio')}: $error',
          ),
        ),
      );
      return null;
    }
  }

  Future<String?> _showManualPathDialog() {
    final t = ref.read(appTextProvider);
    final controller = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(t('newNote.audioFilePath')),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(
            hintText: '/sdcard/Download/meeting.m4a',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(t('common.cancel')),
          ),
          FilledButton(
            onPressed: () {
              final path = controller.text.trim();
              Navigator.pop(context, path.isEmpty ? null : path);
            },
            child: Text(t('newNote.continue')),
          ),
        ],
      ),
    ).whenComplete(controller.dispose);
  }

  Future<void> _pickAttachment() async {
    try {
      final result = await FilePicker.pickFiles();
      final path = result?.files.single.path;
      if (path != null) setState(() => _attachmentPaths.add(path));
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            '${ref.read(appTextProvider)('newNote.couldNotAttachFile')}: $error',
          ),
        ),
      );
    }
  }

  Future<void> _pickCameraImage() async {
    try {
      final image = await ImagePicker().pickImage(source: ImageSource.camera);
      if (image != null) setState(() => _attachmentPaths.add(image.path));
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            '${ref.read(appTextProvider)('newNote.couldNotOpenCamera')}: $error',
          ),
        ),
      );
    }
  }

  Future<void> _submit() async {
    final audioPath = _audioPath;
    if (audioPath == null) return;

    final t = ref.read(appTextProvider);
    try {
      final selectedPrompt = await _selectedPromptForSubmit();
      if (selectedPrompt == null) {
        throw StateError(t('newNote.noPromptsError'));
      }
      final user = ref.read(authControllerProvider).user;
      if (!mounted) return;
      context.pushReplacement(
        '/processing/starting',
        extra: PendingProcessingJob(
          // Generated once here so a createNote retry reuses the same keys and
          // the server deduplicates instead of creating a duplicate note.
          noteId: uuidV4(),
          fileId: uuidV4(),
          audioPath: audioPath,
          title: _title.text.trim(),
          instructions: _instructions.text.trim().isEmpty
              ? null
              : _instructions.text.trim(),
          promptId: selectedPrompt.id,
          userName: user?.displayName,
          maxSpeakers: () {
            final n = int.tryParse(_peopleCount.text.trim());
            return (n != null && n >= 1) ? n : null;
          }(),
          attachmentPaths: [..._attachmentPaths],
        ),
      );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('${t('newNote.failedToSubmit')}: $e')),
        );
      }
    }
  }

  void _goBackToRecord() {
    if (context.canPop()) {
      context.pop();
    } else {
      context.go('/record');
    }
  }

  String? _fileName(String? path) {
    if (path == null || path.isEmpty) return null;
    return path.split(RegExp(r'[\\/]')).last;
  }

  String _audioMetaLine(String? path) {
    final t = ref.read(appTextProvider);
    if (path == null || path.isEmpty) return t('newNote.selectAudioFile');
    final size = _fileSizeLabel(path);
    final audioSource = t('newNote.audioSource');
    return size == null ? audioSource : '$audioSource - $size';
  }

  String? _fileSizeLabel(String path) {
    try {
      final bytes = File(path).lengthSync();
      if (bytes <= 0) return null;
      final mb = bytes / (1024 * 1024);
      if (mb >= 0.1) return '${mb.toStringAsFixed(1)} MB';
      return '${(bytes / 1024).toStringAsFixed(0)} KB';
    } catch (_) {
      return null;
    }
  }

  String _previewPrompt(String value) {
    final compact = value.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (compact.length <= 96) return compact;
    return '${compact.substring(0, 96)}...';
  }
}

class _AudioSourceCard extends StatelessWidget {
  const _AudioSourceCard({
    required this.name,
    required this.meta,
    required this.removeLabel,
    required this.onRemove,
  });

  final String name;
  final String meta;
  final String removeLabel;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Container(
      height: 75,
      padding: const EdgeInsets.fromLTRB(14, 0, 14, 0),
      decoration: BoxDecoration(
        color: palette.card,
        borderRadius: BorderRadius.circular(21),
      ),
      child: Row(
        children: [
          Container(
            width: 35,
            height: 35,
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              gradient: LinearGradient(
                colors: [Color(0xFF4D9FFF), Color(0xFF2F80ED)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
            ),
            child: const Center(
              child: Text(
                '31m',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 10,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
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
                  meta,
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
          const SizedBox(width: 10),
          GestureDetector(
            onTap: onRemove,
            child: Text(
              removeLabel,
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w300,
                color: palette.textMuted,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _FieldLabel extends StatelessWidget {
  const _FieldLabel(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    return Text(
      label,
      style: TextStyle(
        fontSize: 13,
        fontWeight: FontWeight.w400,
        color: FigmaDesign.of(context).textSecondary,
      ),
    );
  }
}

class _FigmaTextField extends StatelessWidget {
  const _FigmaTextField({
    required this.controller,
    required this.minHeight,
    this.maxLines = 1,
    this.hintText,
    this.keyboardType,
  });

  final TextEditingController controller;
  final double minHeight;
  final int maxLines;
  final String? hintText;
  final TextInputType? keyboardType;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return Container(
      constraints: BoxConstraints(minHeight: minHeight),
      decoration: BoxDecoration(
        color: palette.field,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: palette.fieldBorder),
      ),
      child: TextField(
        controller: controller,
        maxLines: maxLines,
        keyboardType: keyboardType,
        style: TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w400,
          color: palette.text,
        ),
        decoration: InputDecoration(
          hintText: hintText,
          hintStyle: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w300,
            color: palette.textMuted,
          ),
          border: InputBorder.none,
          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
        ),
      ),
    );
  }
}

class _SummaryPromptButton extends StatelessWidget {
  const _SummaryPromptButton({
    required this.label,
    required this.changeLabel,
    required this.onTap,
  });

  final String label;
  final String changeLabel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        height: 56,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        decoration: BoxDecoration(
          color: FigmaDesign.of(context).field,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: FigmaDesign.of(context).fieldBorder),
        ),
        child: Row(
          children: [
            Expanded(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w400,
                  color: FigmaDesign.of(context).text,
                ),
              ),
            ),
            const SizedBox(width: 10),
            Text(
              changeLabel,
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w500,
                color: FigmaDesign.activeBlue,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AttachmentButton extends StatelessWidget {
  const _AttachmentButton({
    required this.label,
    required this.onTap,
    this.muted = false,
    this.icon,
  });

  final String label;
  final VoidCallback onTap;
  final bool muted;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        height: 39,
        constraints: const BoxConstraints(minWidth: 96),
        padding: const EdgeInsets.symmetric(horizontal: 18),
        decoration: BoxDecoration(
          color: muted ? palette.field : palette.card,
          borderRadius: BorderRadius.circular(22),
        ),
        child: Center(
          child: Row(
            mainAxisSize: MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (icon != null) ...[
                Icon(
                  icon,
                  size: 16,
                  color: muted ? palette.textSecondary : palette.text,
                ),
                const SizedBox(width: 6),
              ],
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w400,
                    color: muted ? palette.textSecondary : palette.text,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
