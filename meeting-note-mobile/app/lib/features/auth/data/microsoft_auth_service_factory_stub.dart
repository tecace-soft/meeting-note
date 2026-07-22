import 'microsoft_auth_service.dart';
import 'microsoft_auth_models.dart';

MicrosoftAuthService createPlatformMicrosoftAuthService() =>
    const StubMicrosoftAuthService();

class StubMicrosoftAuthService implements MicrosoftAuthService {
  const StubMicrosoftAuthService();

  @override
  Future<MicrosoftAuthResult> signIn() {
    throw UnsupportedError(
      'Microsoft sign-in is available on Android and iOS builds.',
    );
  }

  @override
  Future<MicrosoftAuthResult> acquireTokenSilent() => signIn();

  @override
  Future<void> signOut() async {}
}
