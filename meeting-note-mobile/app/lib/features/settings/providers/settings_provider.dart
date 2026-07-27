import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

final themeModeProvider =
    NotifierProvider<ThemeModeNotifier, ThemeMode>(ThemeModeNotifier.new);

final appLanguageProvider =
    NotifierProvider<AppLanguageNotifier, AppLanguage>(AppLanguageNotifier.new);

enum AppLanguage {
  en('English', 'en'),
  ko('Korean', 'ko');

  const AppLanguage(this.label, this.code);

  final String label;
  final String code;
}

class ThemeModeNotifier extends Notifier<ThemeMode> {
  static const _storage = FlutterSecureStorage();
  static const _key = 'settings_theme_mode';

  @override
  ThemeMode build() {
    Future.microtask(_restore);
    return ThemeMode.light;
  }

  Future<void> _restore() async {
    final value = await _storage.read(key: _key);
    state = switch (value) {
      'dark' => ThemeMode.dark,
      _ => ThemeMode.light,
    };
  }

  Future<void> set(ThemeMode mode) async {
    state = mode;
    await _storage.write(key: _key, value: mode.name);
  }
}

class AppLanguageNotifier extends Notifier<AppLanguage> {
  static const _storage = FlutterSecureStorage();
  static const _key = 'settings_app_language';

  @override
  AppLanguage build() {
    Future.microtask(_restore);
    return AppLanguage.en;
  }

  Future<void> _restore() async {
    final value = await _storage.read(key: _key);
    state = value == AppLanguage.ko.code ? AppLanguage.ko : AppLanguage.en;
  }

  Future<void> set(AppLanguage language) async {
    state = language;
    await _storage.write(key: _key, value: language.code);
  }
}
