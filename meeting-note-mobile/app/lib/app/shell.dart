import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/i18n/app_strings.dart';
import '../shared/widgets/widgets.dart';

class AppShell extends ConsumerWidget {
  const AppShell({
    super.key,
    required this.shell,
    this.showBottomNav = true,
  });

  final StatefulNavigationShell shell;
  final bool showBottomNav;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final palette = FigmaDesign.of(context);
    final t = ref.watch(appTextProvider);
    final tabs = [
      _TabSpec(label: t('shell.home')),
      _TabSpec(label: t('shell.history')),
      _TabSpec(label: t('shell.projects')),
      _TabSpec(label: t('shell.settings')),
    ];

    return Scaffold(
      resizeToAvoidBottomInset: false,
      body: shell,
      bottomNavigationBar: showBottomNav
          ? SafeArea(
              top: false,
              child: Container(
                height: 70,
                padding: const EdgeInsets.fromLTRB(24, 9, 24, 0),
                color: palette.card,
                child: Row(
                  children: [
                    for (var i = 0; i < tabs.length; i++)
                      Expanded(
                        child: _TabButton(
                          spec: tabs[i],
                          selected: shell.currentIndex == i,
                          onTap: () => shell.goBranch(
                            i,
                            initialLocation: i == shell.currentIndex,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            )
          : null,
    );
  }
}

class _TabSpec {
  const _TabSpec({required this.label});

  final String label;
}

class _TabButton extends StatelessWidget {
  const _TabButton({
    required this.spec,
    required this.selected,
    required this.onTap,
  });

  final _TabSpec spec;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    return InkWell(
      borderRadius: BorderRadius.circular(18),
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        padding: const EdgeInsets.symmetric(vertical: 7),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              spec.label,
              maxLines: 1,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 12,
                fontWeight: selected ? FontWeight.w500 : FontWeight.w400,
                color: selected ? FigmaDesign.activeBlue : palette.textMuted,
                letterSpacing: 0,
              ),
            ),
            const SizedBox(height: 7),
            AnimatedContainer(
              duration: const Duration(milliseconds: 180),
              width: selected ? 28 : 0,
              height: 3,
              decoration: BoxDecoration(
                color: FigmaDesign.activeBlue,
                borderRadius: BorderRadius.circular(99),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
