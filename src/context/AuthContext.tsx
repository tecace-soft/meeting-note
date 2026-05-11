import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import { AccountInfo, InteractionStatus } from '@azure/msal-browser';
import { loginRequest } from '../config/msalConfig';
import { shouldUseRedirectInteraction } from '../lib/msalRedirect';
import { ensureSelfSpeakerRowForUser } from '../lib/ensureSelfSpeakerRow';

interface User {
  id: string;
  displayName: string;
  /** Original Microsoft `account.name` when present; used for speaker identity + auto-create. */
  microsoftAccountName: string | null;
  email: string;
  avatar?: string;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: () => Promise<void>;
  logout: () => void;
  getAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { instance, accounts, inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (inProgress === InteractionStatus.None) {
      if (accounts.length > 0) {
        const account = accounts[0];
        setUser({
          id: account.localAccountId,
          displayName: account.name || 'User',
          microsoftAccountName: account.name ?? null,
          email: account.username,
        });
      } else {
        setUser(null);
      }
      setIsLoading(false);
    }
  }, [accounts, inProgress]);

  useEffect(() => {
    if (inProgress !== InteractionStatus.None || !isAuthenticated || !user?.id) return;
    const msName = user.microsoftAccountName?.trim();
    if (!msName) return;

    let cancelled = false;
    void (async () => {
      try {
        await ensureSelfSpeakerRowForUser(user.id, msName);
      } catch (e) {
        if (!cancelled) console.error('ensureSelfSpeakerRowForUser:', e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [inProgress, isAuthenticated, user?.id, user?.microsoftAccountName]);

  const login = useCallback(async () => {
    if (shouldUseRedirectInteraction()) {
      await instance.loginRedirect(loginRequest);
      return;
    }
    try {
      await instance.loginPopup(loginRequest);
    } catch (error) {
      console.error('Login failed:', error);
      throw error;
    }
  }, [instance]);

  const logout = useCallback(() => {
    const post = typeof window !== 'undefined' ? `${window.location.origin}/` : '/';
    if (shouldUseRedirectInteraction()) {
      void instance.logoutRedirect({ postLogoutRedirectUri: post });
    } else {
      instance.logoutPopup({
        postLogoutRedirectUri: post,
      });
    }
  }, [instance]);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const all = instance.getAllAccounts();
    if (all.length === 0) return null;
    const account = all[0] as AccountInfo;
    try {
      const response = await instance.acquireTokenSilent({
        ...loginRequest,
        account,
      });
      return response.accessToken;
    } catch (error) {
      console.error('Failed to acquire token silently:', error);
      if (shouldUseRedirectInteraction()) {
        try {
          await instance.acquireTokenRedirect({
            ...loginRequest,
            account,
          });
        } catch (redirectError) {
          console.error('acquireTokenRedirect failed:', redirectError);
        }
        return null;
      }
      try {
        const response = await instance.acquireTokenPopup({
          ...loginRequest,
          account,
        });
        return response.accessToken;
      } catch (popupError) {
        console.error('Failed to acquire token via popup:', popupError);
        return null;
      }
    }
  }, [instance]);

  const value: AuthContextType = {
    user,
    isAuthenticated,
    isLoading,
    login,
    logout,
    getAccessToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
