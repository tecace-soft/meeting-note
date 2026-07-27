import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';
import '../../features/notes/models/meeting_note.dart';

class SoftScreenBackground extends StatelessWidget {
  const SoftScreenBackground({super.key, required this.child, this.padding});

  final Widget child;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Stack(
      children: [
        Positioned.fill(
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: isDark
                    ? const [AppColors.bgDark, Color(0xFF101A2D)]
                    : const [Color(0xFFEFF6FF), AppColors.bgLight],
              ),
            ),
          ),
        ),
        Positioned(
          top: -92,
          right: -78,
          child: _GlowOrb(
            size: 240,
            colors: isDark
                ? const [Color(0x553365FF), Color(0x00111A2C)]
                : const [AppColors.blueSoft, Color(0x00F8FAFF)],
          ),
        ),
        Positioned(
          top: 126,
          left: -72,
          child: _GlowOrb(
            size: 176,
            colors: isDark
                ? const [Color(0x44518BFF), Color(0x00111A2C)]
                : const [AppColors.cyanSoft, Color(0x00F8FAFF)],
          ),
        ),
        Padding(
          padding: padding ?? EdgeInsets.zero,
          child: child,
        ),
      ],
    );
  }
}

class _GlowOrb extends StatelessWidget {
  const _GlowOrb({required this.size, required this.colors});

  final double size;
  final List<Color> colors;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(colors: colors),
      ),
    );
  }
}

class SoftCard extends StatelessWidget {
  const SoftCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.onTap,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final content = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: scheme.surface.withValues(alpha: 0.96),
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: scheme.outline.withValues(alpha: 0.82)),
        boxShadow: Theme.of(context).brightness == Brightness.dark
            ? null
            : const [
                BoxShadow(
                  color: AppColors.shadowLight,
                  blurRadius: 24,
                  offset: Offset(0, 12),
                ),
              ],
      ),
      child: child,
    );
    if (onTap == null) return content;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.card),
        onTap: onTap,
        child: content,
      ),
    );
  }
}

class FigmaScreen extends StatelessWidget {
  const FigmaScreen({
    super.key,
    required this.title,
    required this.child,
    this.subtitle,
    this.leading,
    this.trailing,
    this.padding = const EdgeInsets.fromLTRB(16, 8, 16, 16),
  });

  final String title;
  final String? subtitle;
  final Widget? leading;
  final Widget? trailing;
  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return SoftScreenBackground(
      child: SafeArea(
        child: Padding(
          padding: padding,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FigmaHeader(
                title: title,
                subtitle: subtitle,
                leading: leading,
                trailing: trailing,
              ),
              const SizedBox(height: 18),
              Expanded(child: child),
            ],
          ),
        ),
      ),
    );
  }
}

class FigmaHeader extends StatelessWidget {
  const FigmaHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.leading,
    this.trailing,
  });

  final String title;
  final String? subtitle;
  final Widget? leading;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      children: [
        leading ??
            FigmaIconButton(
              icon: Icons.grid_view_rounded,
              onPressed: () {},
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
                  fontSize: 22,
                  fontWeight: FontWeight.w600,
                  color: scheme.onSurface,
                ),
              ),
              if (subtitle != null) ...[
                const SizedBox(height: 2),
                Text(
                  subtitle!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w400,
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
        ),
        if (trailing != null) ...[
          const SizedBox(width: 12),
          trailing!,
        ],
      ],
    );
  }
}

class FigmaIconButton extends StatelessWidget {
  const FigmaIconButton({super.key, required this.icon, required this.onPressed});

  final IconData icon;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.surface.withValues(alpha: 0.95),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(15),
        side: BorderSide(color: scheme.outline),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(15),
        onTap: onPressed,
        child: SizedBox(
          width: 42,
          height: 42,
          child: Icon(icon, size: 20, color: scheme.onSurface),
        ),
      ),
    );
  }
}

class GradientHeroCard extends StatelessWidget {
  const GradientHeroCard({
    super.key,
    required this.title,
    this.subtitle,
    this.child,
    this.height = 210,
  });

  final String title;
  final String? subtitle;
  final Widget? child;
  final double height;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      height: height,
      padding: const EdgeInsets.all(22),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(28),
        gradient: const RadialGradient(
          center: Alignment.topRight,
          radius: 1.15,
          colors: [
            Color(0xFFE8F3FF),
            Color(0xFFCFE3FF),
            Color(0xFFEFEAFF),
          ],
        ),
        boxShadow: const [
          BoxShadow(
            color: AppColors.shadowLight,
            blurRadius: 30,
            offset: Offset(0, 16),
          ),
        ],
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (child != null) child!,
          if (child != null) const SizedBox(height: 16),
          Text(
            title,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 23,
              height: 1.1,
              fontWeight: FontWeight.w600,
              color: scheme.onSurface,
            ),
          ),
          if (subtitle != null) ...[
            const SizedBox(height: 8),
            Text(
              subtitle!,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w400,
                color: scheme.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class FigmaSectionTitle extends StatelessWidget {
  const FigmaSectionTitle({super.key, required this.label, this.action});

  final String label;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      children: [
        Expanded(
          child: Text(
            label,
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: scheme.onSurface,
            ),
          ),
        ),
        if (action != null) action!,
      ],
    );
  }
}

class FigmaDesign {
  static const pageBackground = Color(0xFFF5F6FA);
  static const pageBackgroundDark = Color(0xFF0B1220);
  static const text = Color(0xFF151B2D);
  static const textDark = Color(0xFFF4F7FB);
  static const textSecondary = Color(0xFF8E99AA);
  static const textSecondaryDark = Color(0xFFB7C2D6);
  static const textMuted = Color(0xFF98A2B3);
  static const textMutedDark = Color(0xFF8995AA);
  static const divider = Color(0xFFE9EDF3);
  static const dividerDark = Color(0xFF26324A);
  static const toggleTrack = Color(0xFFEFF2F7);
  static const toggleTrackDark = Color(0xFF1B263A);
  static const toggleThumbDark = Color(0xFF2A3650);
  static const cardDark = Color(0xFF121C2F);
  static const fieldDark = Color(0xFF182338);
  static const activeBlue = Color(0xFF2F80FF);
  static const primaryGradient = [Color(0xFF4D9FFF), Color(0xFF2F80ED)];
  static const avatarGradient = [Color(0xFFB9C5FF), Color(0xFFA886FF)];

  static FigmaPalette of(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return dark ? FigmaPalette.dark : FigmaPalette.light;
  }
}

class FigmaPalette {
  const FigmaPalette({
    required this.pageBackground,
    required this.card,
    required this.cardShadow,
    required this.text,
    required this.textSecondary,
    required this.textMuted,
    required this.divider,
    required this.toggleTrack,
    required this.toggleThumb,
    required this.field,
    required this.fieldBorder,
    required this.codeBackground,
  });

  final Color pageBackground;
  final Color card;
  final Color cardShadow;
  final Color text;
  final Color textSecondary;
  final Color textMuted;
  final Color divider;
  final Color toggleTrack;
  final Color toggleThumb;
  final Color field;
  final Color fieldBorder;
  final Color codeBackground;

  static const light = FigmaPalette(
    pageBackground: FigmaDesign.pageBackground,
    card: Color(0xE6FFFFFF),
    cardShadow: Color(0x52CBD3DF),
    text: FigmaDesign.text,
    textSecondary: FigmaDesign.textSecondary,
    textMuted: FigmaDesign.textMuted,
    divider: FigmaDesign.divider,
    toggleTrack: FigmaDesign.toggleTrack,
    toggleThumb: Colors.white,
    field: Color(0xFFF7F9FC),
    fieldBorder: Color(0xFFE1E6EF),
    codeBackground: Color(0xFFF3F6FA),
  );

  static const dark = FigmaPalette(
    pageBackground: FigmaDesign.pageBackgroundDark,
    card: FigmaDesign.cardDark,
    cardShadow: Color(0x66000000),
    text: FigmaDesign.textDark,
    textSecondary: FigmaDesign.textSecondaryDark,
    textMuted: FigmaDesign.textMutedDark,
    divider: FigmaDesign.dividerDark,
    toggleTrack: FigmaDesign.toggleTrackDark,
    toggleThumb: FigmaDesign.toggleThumbDark,
    field: FigmaDesign.fieldDark,
    fieldBorder: FigmaDesign.dividerDark,
    codeBackground: Color(0xFF0F1728),
  );
}

class FigmaGlassCard extends StatelessWidget {
  const FigmaGlassCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.onTap,
    this.radius = 22,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final palette = FigmaDesign.of(context);
    final card = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: palette.card,
        borderRadius: BorderRadius.circular(radius),
        boxShadow: [
          BoxShadow(
            color: palette.cardShadow,
            blurRadius: 28,
            offset: const Offset(0, 16),
          ),
        ],
      ),
      child: child,
    );
    if (onTap == null) return card;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(radius),
      child: card,
    );
  }
}

class FigmaAvatarInitial extends StatelessWidget {
  const FigmaAvatarInitial({
    super.key,
    required this.name,
    this.size = 46,
    this.fontSize,
  });

  final String name;
  final double size;
  final double? fontSize;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: const BoxDecoration(
        shape: BoxShape.circle,
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: FigmaDesign.avatarGradient,
        ),
      ),
      child: Center(
        child: Text(
          figmaInitial(name),
          style: TextStyle(
            color: Colors.white,
            fontSize: fontSize ?? size * 0.35,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    );
  }
}

class FigmaPillButton extends StatelessWidget {
  const FigmaPillButton({
    super.key,
    required this.label,
    required this.onTap,
    this.compact = false,
  });

  final String label;
  final VoidCallback? onTap;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Opacity(
        opacity: onTap == null ? 0.55 : 1,
        child: Container(
          padding: EdgeInsets.symmetric(
            horizontal: compact ? 12 : 14,
            vertical: compact ? 8 : 10,
          ),
          decoration: BoxDecoration(
            gradient: const LinearGradient(colors: FigmaDesign.primaryGradient),
            borderRadius: BorderRadius.circular(999),
          ),
          child: Text(
            label,
            textAlign: TextAlign.center,
            style: TextStyle(
              color: Colors.white,
              fontSize: compact ? 12 : 13,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ),
    );
  }
}

class FigmaSlidingSegmentedToggle extends StatelessWidget {
  const FigmaSlidingSegmentedToggle({
    super.key,
    required this.options,
    required this.selectedIndex,
    required this.onChanged,
    this.height = 44,
    this.thumbRadius = 18,
    this.optionTextStyle,
    this.activeColor = FigmaDesign.activeBlue,
  }) : assert(options.length > 1);

  final List<FigmaSegmentOption> options;
  final int selectedIndex;
  final ValueChanged<int> onChanged;
  final double height;
  final double thumbRadius;
  final TextStyle? optionTextStyle;
  final Color activeColor;

  @override
  Widget build(BuildContext context) {
    final count = options.length;
    final clampedIndex = selectedIndex.clamp(0, count - 1).toInt();
    final palette = FigmaDesign.of(context);
    return Container(
      height: height,
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: palette.toggleTrack,
        borderRadius: BorderRadius.circular(height / 2),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final segmentWidth = constraints.maxWidth / count;
          return Stack(
            children: [
              AnimatedPositioned(
                duration: const Duration(milliseconds: 220),
                curve: Curves.easeOutCubic,
                left: segmentWidth * clampedIndex,
                top: 0,
                bottom: 0,
                width: segmentWidth,
                child: Container(
                  decoration: BoxDecoration(
                    color: palette.toggleThumb,
                    borderRadius: BorderRadius.circular(thumbRadius),
                    boxShadow: [
                      BoxShadow(
                        color: palette.cardShadow,
                        blurRadius: 12,
                        offset: const Offset(0, 4),
                      ),
                    ],
                  ),
                ),
              ),
              Row(
                children: [
                  for (var i = 0; i < options.length; i++)
                    Expanded(
                      child: GestureDetector(
                        behavior: HitTestBehavior.opaque,
                        onTap: () => onChanged(i),
                        child: Center(
                          child: options[i].icon == null
                              ? Text(
                                  options[i].label,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: (optionTextStyle ??
                                          const TextStyle(fontSize: 13))
                                      .copyWith(
                                    color: i == clampedIndex
                                        ? activeColor
                                        : palette.textSecondary,
                                    fontWeight: i == clampedIndex
                                        ? FontWeight.w600
                                        : FontWeight.w400,
                                  ),
                                )
                              : Icon(
                                  options[i].icon,
                                  size: options[i].iconSize ?? 19,
                                  color: i == clampedIndex
                                      ? activeColor
                                      : palette.textSecondary,
                                ),
                        ),
                      ),
                    ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }
}

class FigmaSegmentOption {
  const FigmaSegmentOption({
    required this.label,
    this.icon,
    this.iconSize,
  });

  final String label;
  final IconData? icon;
  final double? iconSize;
}

String figmaInitial(String value) {
  final trimmed = value.trim();
  return trimmed.isEmpty ? 'M' : trimmed.substring(0, 1).toUpperCase();
}

/// Large primary action button (56 dp) with loading state.
class PrimaryButton extends StatelessWidget {
  const PrimaryButton({
    super.key,
    required this.label,
    this.onPressed,
    this.loading = false,
    this.icon,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool loading;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final disabled = onPressed == null || loading;

    return Opacity(
      opacity: disabled ? 0.55 : 1,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: disabled ? null : onPressed,
        child: Container(
          height: 56,
          width: double.infinity,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(28),
            gradient: const LinearGradient(
              colors: [Color(0xFF4D9FFF), Color(0xFF2F80ED)],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            boxShadow: const [
              BoxShadow(
                color: Color(0x332F80ED),
                blurRadius: 24,
                offset: Offset(0, 12),
              ),
            ],
          ),
          child: Center(
            child: loading
                ? const SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.5,
                      color: Colors.white,
                    ),
                  )
                : Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (icon != null) ...[
                        Icon(icon, size: 20, color: Colors.white),
                        const SizedBox(width: 8),
                      ],
                      Text(
                        label,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          letterSpacing: 0,
                        ),
                      ),
                    ],
                  ),
          ),
        ),
      ),
    );
  }
}

class StatusChip extends StatelessWidget {
  const StatusChip({super.key, required this.status});

  final NoteStatus status;

  @override
  Widget build(BuildContext context) {
    final (label, color) = switch (status) {
      NoteStatus.done => ('Done', const Color(0xFF12B76A)),
      NoteStatus.failed => ('Failed', AppColors.recording),
      NoteStatus.pendingUpload => ('Pending upload', const Color(0xFFF79009)),
      _ => ('Processing', AppColors.accent),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(fontSize: 12, fontWeight: FontWeight.w400, color: color),
      ),
    );
  }
}

class NoteCard extends StatelessWidget {
  const NoteCard({super.key, required this.note, this.onTap});

  final MeetingNote note;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.card),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      note.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w500),
                    ),
                  ),
                  StatusChip(status: note.status),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                '${_formatDate(note.createdAt)} - ${note.durationLabel}',
                style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _formatDate(DateTime d) {
    final now = DateTime.now();
    if (d.year == now.year && d.month == now.month && d.day == now.day) {
      return 'Today ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    }
    return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.subtitle,
    this.action,
  });

  final IconData icon;
  final String title;
  final String? subtitle;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                color: scheme.primary.withValues(alpha: 0.08),
                shape: BoxShape.circle,
              ),
              child: Icon(icon, size: 34, color: scheme.primary),
            ),
            const SizedBox(height: 16),
            Text(title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w500)),
            if (subtitle != null) ...[
              const SizedBox(height: 8),
              Text(
                subtitle!,
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 14, color: scheme.onSurfaceVariant),
              ),
            ],
            if (action != null) ...[const SizedBox(height: 24), action!],
          ],
        ),
      ),
    );
  }
}
