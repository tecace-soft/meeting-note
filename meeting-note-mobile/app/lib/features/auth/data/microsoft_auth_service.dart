import 'microsoft_auth_models.dart';
import 'microsoft_auth_service_factory_stub.dart'
    if (dart.library.io) 'microsoft_auth_service_factory_msal.dart';

abstract class MicrosoftAuthService {
  Future<MicrosoftAuthResult> signIn();
  Future<MicrosoftAuthResult> acquireTokenSilent();
  Future<void> signOut();
}

MicrosoftAuthService createMicrosoftAuthService() =>
    createPlatformMicrosoftAuthService();
