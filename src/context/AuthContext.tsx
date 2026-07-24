import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import { AccountInfo, InteractionStatus } from '@azure/msal-browser';
import { loginRequest } from '../config/msalConfig';
import { shouldUseRedirectInteraction } from '../lib/msalRedirect';
import { ensureSelfSpeakerRowForUser } from '../lib/ensureSelfSpeakerRow';
import { registerAppUser } from '../lib/registerAppUser';
import {
  setSupabaseAccessTokenProvider,
  setSupabaseAuthResolvedWithoutUser,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
} from '../config/supabaseConfig';

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
  getAccessToken: (scopes?: string[]) => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Refresh the Supabase JWT this long before it actually expires so requests
// never race the ~60min expiry cliff.
const SUPABASE_TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { instance, accounts, inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const supabaseTokenRef = React.useRef<{ token: string; expiresAt: number } | null>(null);
  const supabaseExchangeInFlightRef = React.useRef<Promise<string | null> | null>(null);

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
        setSupabaseAuthResolvedWithoutUser(false);
      } else {
        setUser(null);
        // Auth settled with no user: let pending Supabase queries proceed with
        // the anon key instead of stalling on a token that will never arrive.
        setSupabaseAuthResolvedWithoutUser(true);
      }
      setIsLoading(false);
    }
  }, [accounts, inProgress]);

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

  const getAccessToken = useCallback(async (scopes?: string[]): Promise<string | null> => {
    const all = instance.getAllAccounts();
    if (all.length === 0) return null;
    const account = all[0] as AccountInfo;
    const tokenRequest = scopes?.length
      ? { scopes, account }
      : { ...loginRequest, account };
    try {
      const response = await instance.acquireTokenSilent(tokenRequest);
      return response.accessToken;
    } catch (error) {
      console.error('Failed to acquire token silently:', error);
      if (shouldUseRedirectInteraction()) {
        try {
          await instance.acquireTokenRedirect(tokenRequest);
        } catch (redirectError) {
          console.error('acquireTokenRedirect failed:', redirectError);
        }
        return null;
      }
      try {
        const response = await instance.acquireTokenPopup(tokenRequest);
        return response.accessToken;
      } catch (popupError) {
        console.error('Failed to acquire token via popup:', popupError);
        return null;
      }
    }
  }, [instance]);

  const exchangeSupabaseToken = useCallback(async (): Promise<string | null> => {
    const microsoftToken = await getAccessToken();
    if (!microsoftToken || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;

    const MAX_ATTEMPTS = 3;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/supabase-token`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
            'x-ms-access-token': microsoftToken,
          },
          body: '{}',
        });
        const data = (await response.json().catch(() => ({}))) as {
          access_token?: unknown;
          expires_at?: unknown;
          error?: unknown;
        };
        if (!response.ok || typeof data.access_token !== 'string') {
          throw new Error(
            typeof data.error === 'string' ? data.error : `supabase-token exchange failed (${response.status}).`
          );
        }
        const expiresAt =
          typeof data.expires_at === 'number' ? data.expires_at * 1000 : Date.now() + 55 * 60 * 1000;
        supabaseTokenRef.current = { token: data.access_token, expiresAt };
        return data.access_token;
      } catch (error) {
        lastError = error;
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** (attempt - 1), 4000)));
        }
      }
    }
    console.error('supabase-token exchange failed after retries:', lastError);
    throw lastError instanceof Error ? lastError : new Error('Could not get Supabase access token.');
  }, [getAccessToken]);

  const getSupabaseAccessToken = useCallback(async (): Promise<string | null> => {
    const cached = supabaseTokenRef.current;
    if (cached && cached.expiresAt - Date.now() > SUPABASE_TOKEN_REFRESH_BUFFER_MS) return cached.token;
    // Single-flight: concurrent callers (and the background refresher) share one
    // exchange instead of stampeding the edge function at expiry.
    if (!supabaseExchangeInFlightRef.current) {
      supabaseExchangeInFlightRef.current = exchangeSupabaseToken().finally(() => {
        supabaseExchangeInFlightRef.current = null;
      });
    }
    try {
      return await supabaseExchangeInFlightRef.current;
    } catch (error) {
      // A transient exchange failure shouldn't break a live session: if the
      // cached token is still valid, keep using it rather than failing the query.
      const stillValid = supabaseTokenRef.current;
      if (stillValid && stillValid.expiresAt - Date.now() > 30_000) return stillValid.token;
      throw error;
    }
  }, [exchangeSupabaseToken]);

  useEffect(() => {
    if (!isAuthenticated || !user?.id) {
      supabaseTokenRef.current = null;
      setSupabaseAccessTokenProvider(null);
      return;
    }
    setSupabaseAccessTokenProvider(getSupabaseAccessToken);
    return () => setSupabaseAccessTokenProvider(null);
  }, [getSupabaseAccessToken, isAuthenticated, user?.id]);

  // Proactively refresh the Supabase token in the background so an idle session
  // never blocks a request on a cold exchange and never hits the ~60min expiry
  // cliff. getSupabaseAccessToken refreshes only when inside the buffer window,
  // and single-flight dedup keeps this from colliding with on-demand calls.
  useEffect(() => {
    if (!isAuthenticated || !user?.id) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      if (cancelled) return;
      void getSupabaseAccessToken().catch(() => {
        /* retried on the next tick or the next on-demand request */
      });
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [getSupabaseAccessToken, isAuthenticated, user?.id]);

  useEffect(() => {
    if (inProgress !== InteractionStatus.None || !isAuthenticated || !user?.id) return;
    const msName = user.microsoftAccountName?.trim();

    let cancelled = false;
    void (async () => {
      try {
        try {
          await registerAppUser({
            id: user.id,
            displayName: user.displayName,
            email: user.email,
          });
        } catch (registerError) {
          if (!cancelled) console.error('registerAppUser:', registerError);
        }
        if (msName) {
          await ensureSelfSpeakerRowForUser(user.id, msName, user.id, user.email);
        }
      } catch (e) {
        if (!cancelled) console.error('Auth user bootstrap:', e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [inProgress, isAuthenticated, user?.displayName, user?.email, user?.id, user?.microsoftAccountName]);

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
