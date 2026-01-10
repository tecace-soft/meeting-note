import { Configuration, LogLevel } from '@azure/msal-browser';

// MSAL configuration for MS Teams authentication
// You'll need to register your app in Azure AD portal:
// https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade
export const msalConfig: Configuration = {
  auth: {
    // Replace with your Azure AD app registration client ID
    clientId: import.meta.env.VITE_MSAL_CLIENT_ID || 'YOUR_CLIENT_ID_HERE',
    // Replace with your tenant ID or use 'common' for multi-tenant
    authority: import.meta.env.VITE_MSAL_AUTHORITY || 'https://login.microsoftonline.com/common',
    // Redirect URI - must match what's registered in Azure AD
    redirectUri: import.meta.env.VITE_MSAL_REDIRECT_URI || 'http://localhost:5174',
    postLogoutRedirectUri: '/',
    navigateToLoginRequestUrl: true,
  },
  cache: {
    cacheLocation: 'localStorage',
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return;
        switch (level) {
          case LogLevel.Error:
            console.error(message);
            break;
          case LogLevel.Warning:
            console.warn(message);
            break;
          case LogLevel.Info:
            console.info(message);
            break;
          case LogLevel.Verbose:
            console.debug(message);
            break;
        }
      },
      logLevel: LogLevel.Warning,
    },
  },
};

// Scopes needed for MS Teams chat access and OneDrive
export const loginRequest = {
  scopes: [
    'User.Read',
    'Chat.Read',
    'Chat.ReadWrite',
    'ChatMessage.Read',
    'Files.ReadWrite',
    'Files.ReadWrite.All',
  ],
};

// Graph API scopes for accessing Teams data and OneDrive
export const graphScopes = {
  chats: ['Chat.Read', 'Chat.ReadWrite'],
  messages: ['ChatMessage.Read'],
  user: ['User.Read'],
  files: ['Files.ReadWrite', 'Files.ReadWrite.All'],
};

