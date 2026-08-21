import { Configuration, LogLevel } from '@azure/msal-browser';

// Get the current origin for redirect URI (works with any domain)
const getRedirectUri = (): string => {
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  return import.meta.env.VITE_MSAL_REDIRECT_URI || 'http://localhost:5174';
};

// MSAL configuration for MS Teams authentication
// You'll need to register your app in Azure AD portal:
// https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade
export const msalConfig: Configuration = {
  auth: {
    // Replace with your Azure AD app registration client ID
    clientId: import.meta.env.VITE_MSAL_CLIENT_ID || 'YOUR_CLIENT_ID_HERE',
    // Replace with your tenant ID or use 'common' for multi-tenant
    authority: import.meta.env.VITE_MSAL_AUTHORITY || 'https://login.microsoftonline.com/common',
    // Redirect URI - dynamically uses current domain, must match what's registered in Azure AD
    redirectUri: getRedirectUri(),
    postLogoutRedirectUri: '/',
    navigateToLoginRequestUrl: true,
  },
  cache: {
    cacheLocation: 'localStorage',
    /** Helps some mobile Safari flows when using redirect-based auth. */
    storeAuthStateInCookie: true,
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
          case LogLevel.Verbose:
            break;
        }
      },
      logLevel: LogLevel.Warning,
    },
  },
};

// Minimal scopes: sign-in + directory read (speaker roster) + calendar (meeting brief).
// Teams-chat and OneDrive export were removed (rarely used; team decision 2026-08-21), so
// their Chat.*/Files.* scopes are no longer requested — keeps consent to the minimum.
export const loginRequest = {
  scopes: [
    'User.Read',
    'User.ReadBasic.All',
    'Calendars.Read',
  ],
};

// Graph API scopes by feature.
export const graphScopes = {
  user: ['User.Read', 'User.ReadBasic.All'],
  calendar: ['Calendars.Read'],
};
