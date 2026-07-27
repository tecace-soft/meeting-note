const microsoftClientId = 'f81ec595-e95f-4b99-8143-fb4b198df787';

const microsoftTenantId = 'a141d6e8-fddb-4309-8b71-44753a78495a';

const microsoftAuthority = 'https://login.microsoftonline.com/$microsoftTenantId';

const microsoftAndroidRedirectUri =
    'msauth://com.example.meeting_note_mobile/guC64kbNdu%2Bbu67b7Ujd62XWb3s%3D';

const microsoftLoginScopes = <String>[
  'https://graph.microsoft.com/user.read',
  'https://graph.microsoft.com/User.ReadBasic.All',
];

const microsoftGraphScopes = <String>[
  'Chat.Read',
  'Chat.ReadWrite',
  'ChatMessage.Read',
  'Files.ReadWrite',
  'Files.ReadWrite.All',
  'User.ReadBasic.All',
  'Calendars.Read',
];

bool get isMicrosoftAuthConfigured => microsoftClientId.isNotEmpty;
