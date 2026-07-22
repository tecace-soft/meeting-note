class MicrosoftUser {
  const MicrosoftUser({
    required this.id,
    required this.displayName,
    required this.email,
  });

  final String id;
  final String displayName;
  final String email;
}

class MicrosoftAuthResult {
  const MicrosoftAuthResult({
    required this.accessToken,
    required this.expiresOn,
    required this.user,
    this.idToken,
  });

  final String accessToken;
  final String? idToken;
  final DateTime expiresOn;
  final MicrosoftUser user;
}
