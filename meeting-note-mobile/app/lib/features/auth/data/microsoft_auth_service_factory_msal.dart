import 'package:msal_auth/msal_auth.dart';

import 'auth_config.dart';
import 'microsoft_auth_models.dart';
import 'microsoft_auth_service.dart';

MicrosoftAuthService createPlatformMicrosoftAuthService() =>
    MsalMicrosoftAuthService();

class MsalMicrosoftAuthService implements MicrosoftAuthService {
  SingleAccountPca? _pca;

  Future<SingleAccountPca> _client() async {
    final existing = _pca;
    if (existing != null) return existing;

    if (!isMicrosoftAuthConfigured) {
      throw StateError(
        'Microsoft sign-in is not configured in auth_config.dart.',
      );
    }

    final created = await SingleAccountPca.create(
      clientId: microsoftClientId,
      androidConfig: AndroidConfig(
        configFilePath: 'assets/msal_config.json',
        redirectUri: microsoftAndroidRedirectUri,
      ),
      appleConfig: AppleConfig(
        authority: microsoftAuthority,
        authorityType: AuthorityType.aad,
        broker: Broker.safariBrowser,
      ),
    );
    _pca = created;
    return created;
  }

  @override
  Future<MicrosoftAuthResult> signIn() async {
    final result = await (await _client()).acquireToken(
      scopes: microsoftLoginScopes,
      prompt: Prompt.whenRequired,
      authority: microsoftAuthority,
    );
    return _toAuthResult(result);
  }

  @override
  Future<MicrosoftAuthResult> acquireTokenSilent() async {
    final result = await (await _client()).acquireTokenSilent(
      scopes: microsoftLoginScopes,
      authority: microsoftAuthority,
    );
    return _toAuthResult(result);
  }

  @override
  Future<void> signOut() async {
    final client = await _client();
    await client.signOut();
  }

  MicrosoftAuthResult _toAuthResult(AuthenticationResult result) {
    final account = result.account;
    return MicrosoftAuthResult(
      accessToken: result.accessToken,
      idToken: result.idToken,
      expiresOn: result.expiresOn,
      user: MicrosoftUser(
        id: account.id,
        displayName: account.name?.trim().isNotEmpty == true
            ? account.name!.trim()
            : 'User',
        email: account.username ?? '',
      ),
    );
  }
}
