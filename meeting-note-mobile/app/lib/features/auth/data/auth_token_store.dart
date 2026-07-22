import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class AuthTokenStore {
  const AuthTokenStore();

  static const _storage = FlutterSecureStorage();
  static const accessTokenKey = 'access_token';
  static const idTokenKey = 'id_token';
  static const microsoftUserIdKey = 'microsoft_user_id';
  static const accessTokenExpiresAtKey = 'access_token_expires_at';
  static const supabaseAccessTokenKey = 'supabase_access_token';
  static const supabaseAccessTokenExpiresAtKey =
      'supabase_access_token_expires_at';
  static const supabaseUserIdKey = 'supabase_user_id';

  Future<void> saveMicrosoftTokens({
    required String accessToken,
    required DateTime expiresOn,
    String? idToken,
    String? userId,
  }) async {
    await _storage.write(key: accessTokenKey, value: accessToken);
    if (userId != null && userId.isNotEmpty) {
      await _storage.write(key: microsoftUserIdKey, value: userId);
    }
    await _storage.write(
      key: accessTokenExpiresAtKey,
      value: expiresOn.toIso8601String(),
    );
    if (idToken != null) {
      await _storage.write(key: idTokenKey, value: idToken);
    }
  }

  Future<void> clear() async {
    await _storage.delete(key: accessTokenKey);
    await _storage.delete(key: idTokenKey);
    await _storage.delete(key: microsoftUserIdKey);
    await _storage.delete(key: accessTokenExpiresAtKey);
    await _storage.delete(key: supabaseAccessTokenKey);
    await _storage.delete(key: supabaseAccessTokenExpiresAtKey);
    await _storage.delete(key: supabaseUserIdKey);
  }

  Future<void> saveSupabaseToken({
    required String accessToken,
    required DateTime expiresOn,
    String? userId,
  }) async {
    await _storage.write(key: supabaseAccessTokenKey, value: accessToken);
    await _storage.write(
      key: supabaseAccessTokenExpiresAtKey,
      value: expiresOn.toIso8601String(),
    );
    if (userId != null && userId.isNotEmpty) {
      await _storage.write(key: supabaseUserIdKey, value: userId);
    }
  }
}
