import 'package:flutter/material.dart';

/// Meeting Note design tokens — premium enterprise, white/navy.
class AppColors {
  static const navy = Color(0xFF0F2A4A);
  static const accent = Color(0xFF2F6FED);
  static const recording = Color(0xFFE5484D);

  static const bgLight = Color(0xFFF8FAFF);
  static const surfaceLight = Color(0xFFFFFFFF);
  static const textPrimaryLight = Color(0xFF101828);
  static const textSecondaryLight = Color(0xFF667085);
  static const borderLight = Color(0xFFE6EAF2);
  static const blueSoft = Color(0xFFEAF2FF);
  static const blueSoft2 = Color(0xFFF3F7FF);
  static const lavenderSoft = Color(0xFFF1EDFF);
  static const cyanSoft = Color(0xFFE8FBFF);
  static const shadowLight = Color(0x22101828);

  static const bgDark = Color(0xFF0B1220);
  static const surfaceDark = Color(0xFF111A2C);
  static const textPrimaryDark = Color(0xFFF1F5F9);
  static const textSecondaryDark = Color(0xFF94A3B8);
  static const borderDark = Color(0xFF23304A);
}

class AppRadius {
  static const card = 18.0;
  static const sheet = 24.0;
  static const button = 16.0;
}

class AppTheme {
  static ThemeData get light => _base(Brightness.light);
  static ThemeData get dark => _base(Brightness.dark);

  static ThemeData _base(Brightness b) {
    final isDark = b == Brightness.dark;
    final scheme = ColorScheme(
      brightness: b,
      primary: isDark ? AppColors.accent : AppColors.navy,
      onPrimary: Colors.white,
      secondary: AppColors.accent,
      onSecondary: Colors.white,
      error: AppColors.recording,
      onError: Colors.white,
      surface: isDark ? AppColors.surfaceDark : AppColors.surfaceLight,
      onSurface: isDark ? AppColors.textPrimaryDark : AppColors.textPrimaryLight,
      onSurfaceVariant:
          isDark ? AppColors.textSecondaryDark : AppColors.textSecondaryLight,
      outline: isDark ? AppColors.borderDark : AppColors.borderLight,
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      // Poppins for Latin, Pretendard as fallback for Korean glyphs.
      // Add both font families under assets/fonts/ and declare in pubspec.yaml.
      fontFamily: 'Poppins',
      fontFamilyFallback: const ['Pretendard'],
      scaffoldBackgroundColor: isDark ? AppColors.bgDark : AppColors.bgLight,
      appBarTheme: AppBarTheme(
        backgroundColor: isDark ? AppColors.bgDark : AppColors.bgLight,
        foregroundColor: scheme.onSurface,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          fontSize: 22,
          fontWeight: FontWeight.w800,
          color: scheme.onSurface,
        ),
      ),
      cardTheme: CardThemeData(
        color: scheme.surface,
        elevation: isDark ? 0 : 1,
        shadowColor: AppColors.shadowLight,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.card),
          side: BorderSide(color: scheme.outline),
        ),
        margin: EdgeInsets.zero,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: scheme.primary,
          foregroundColor: scheme.onPrimary,
          minimumSize: const Size.fromHeight(56),
          padding: const EdgeInsets.symmetric(horizontal: 20),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.button),
          ),
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surface,
        contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 18),
        labelStyle: TextStyle(color: scheme.onSurfaceVariant),
        hintStyle: TextStyle(color: scheme.onSurfaceVariant.withValues(alpha: 0.78)),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.button),
          borderSide: BorderSide(color: scheme.outline),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.button),
          borderSide: BorderSide(color: scheme.outline),
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: scheme.surface,
        indicatorColor: AppColors.blueSoft,
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: scheme.surface,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadius.sheet)),
        ),
      ),
    );
  }
}
