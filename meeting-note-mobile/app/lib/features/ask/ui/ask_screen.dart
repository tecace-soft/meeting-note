import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_theme.dart';
import '../../../shared/widgets/widgets.dart';
import '../data/ask_repository.dart';

class _Msg {
  const _Msg({required this.isUser, required this.text, this.sources = const []});

  final bool isUser;
  final String text;
  final List<AskSource> sources;
}

class AskScreen extends ConsumerStatefulWidget {
  const AskScreen({super.key});

  @override
  ConsumerState<AskScreen> createState() => _AskScreenState();
}

class _AskScreenState extends ConsumerState<AskScreen> {
  final _controller = TextEditingController();
  final _scroll = ScrollController();
  final List<_Msg> _messages = [];
  bool _loading = false;

  static const _suggestions = [
    'What was decided last week?',
    'Find mentions of Acme',
    'What are my action items?',
  ];

  @override
  void dispose() {
    _controller.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Ask')),
      body: SoftScreenBackground(
        child: SafeArea(
          child: Column(
            children: [
              Expanded(
                child: _messages.isEmpty ? _emptyState(scheme) : _chatList(scheme),
              ),
              _inputBar(scheme),
            ],
          ),
        ),
      ),
    );
  }

  Widget _emptyState(ColorScheme scheme) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: SoftCard(
          padding: const EdgeInsets.fromLTRB(22, 24, 22, 22),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 72,
                height: 72,
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [AppColors.blueSoft, AppColors.lavenderSoft],
                  ),
                ),
                child: Icon(Icons.chat_bubble_rounded, color: scheme.primary),
              ),
              const SizedBox(height: 16),
              const Text(
                'Ask anything',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 8),
              Text(
                'Answers come from all your meeting notes',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant),
              ),
              const SizedBox(height: 22),
              for (final s in _suggestions)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: SizedBox(
                    width: double.infinity,
                    child: ActionChip(
                      backgroundColor: AppColors.blueSoft.withValues(alpha: 0.7),
                      side: BorderSide(color: scheme.outline),
                      label: Text(s),
                      onPressed: () => _send(s),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _chatList(ColorScheme scheme) {
    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.all(16),
      itemCount: _messages.length + (_loading ? 1 : 0),
      itemBuilder: (context, i) {
        if (i == _messages.length) {
          return const Padding(
            padding: EdgeInsets.all(16),
            child: Center(
              child: SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(strokeWidth: 2.5),
              ),
            ),
          );
        }
        final m = _messages[i];
        return Align(
          alignment: m.isUser ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            margin: const EdgeInsets.only(bottom: 12),
            padding: const EdgeInsets.all(15),
            constraints: const BoxConstraints(maxWidth: 300),
            decoration: BoxDecoration(
              color: m.isUser ? scheme.primary : scheme.surface.withValues(alpha: 0.96),
              borderRadius: BorderRadius.circular(20),
              border: m.isUser ? null : Border.all(color: scheme.outline),
              boxShadow: const [
                BoxShadow(
                  color: AppColors.shadowLight,
                  blurRadius: 18,
                  offset: Offset(0, 8),
                ),
              ],
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  m.text,
                  style: TextStyle(color: m.isUser ? Colors.white : scheme.onSurface),
                ),
                for (final s in m.sources) ...[
                  const SizedBox(height: 10),
                  InkWell(
                    onTap: () => context.push('/note/${s.noteId}'),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                      decoration: BoxDecoration(
                        color: AppColors.blueSoft,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Text(
                        'Source: ${s.title}${s.date != null ? ' - ${s.date}' : ''}',
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          color: scheme.primary,
                        ),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _inputBar(ColorScheme scheme) {
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
        child: SoftCard(
          padding: const EdgeInsets.fromLTRB(12, 10, 10, 10),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _controller,
                  decoration: const InputDecoration(
                    hintText: 'Ask about your meetings...',
                    prefixIcon: Icon(Icons.search_rounded),
                  ),
                  textInputAction: TextInputAction.send,
                  onSubmitted: _send,
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                style: FilledButton.styleFrom(
                  minimumSize: const Size(50, 50),
                  padding: EdgeInsets.zero,
                  shape: const CircleBorder(),
                ),
                onPressed: _loading ? null : () => _send(_controller.text),
                child: const Icon(Icons.arrow_upward_rounded),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _send(String text) async {
    final q = text.trim();
    if (q.isEmpty || _loading) return;
    setState(() {
      _messages.add(_Msg(isUser: true, text: q));
      _loading = true;
      _controller.clear();
    });
    try {
      final res = await ref.read(askRepositoryProvider).ask(q);
      setState(() {
        _messages.add(_Msg(isUser: false, text: res.answer, sources: res.sources));
      });
    } catch (_) {
      setState(() {
        _messages.add(const _Msg(isUser: false, text: 'Something went wrong. Try again.'));
      });
    } finally {
      setState(() => _loading = false);
      await Future.delayed(const Duration(milliseconds: 50));
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
        );
      }
    }
  }
}
