import React, { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { PublicClientApplication } from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';
import { ThemeProvider as AppThemeProvider } from './theme/ThemeProvider';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LanguageProvider } from './context/LanguageContext';
import { msalConfig } from './config/msalConfig';
import Login from './pages/Login';
import TranscriptionSummary from './pages/TranscriptionSummary';
import SummaryHistory from './pages/SummaryHistory';
import Project from './pages/Project';
import AccountSettings from './pages/AccountSettings';
import Issues from './pages/Issues';
import AdminAnalytics from './pages/AdminAnalytics';
import AdminControls from './pages/AdminControls';
import TranscriptionModelTest from './pages/TranscriptionModelTest';
import AppShell from './components/AppShell';
import { ConfirmProvider } from './components/ConfirmDialog';
import { canAccessTranscriptionModelTest } from './lib/adminAccess';

const msalInstance = new PublicClientApplication(msalConfig);

const ModelTestRoute: React.FC = () => {
  const { user, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center" style={{ color: 'var(--text-secondary)' }}>
        <p className="text-sm">Loading…</p>
      </div>
    );
  }
  return canAccessTranscriptionModelTest(user?.id) ? <TranscriptionModelTest /> : <Navigate to="/history" replace />;
};

const App: React.FC = () => {
  const [msalReady, setMsalReady] = useState(false);
  const [initError, setInitError] = useState<Error | null>(null);

  useEffect(() => {
    setInitError(null);
    void msalInstance
      .initialize()
      .then(() => msalInstance.handleRedirectPromise())
      .then(() => setMsalReady(true))
      .catch((e) => {
        console.error('MSAL init or redirect handling failed:', e);
        setInitError(e instanceof Error ? e : new Error(String(e)));
      });
  }, []);

  if (initError) {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-6"
        style={{ backgroundColor: 'var(--bg, #0f172a)', color: 'var(--text, #e2e8f0)' }}
      >
        <div
          className="max-w-md w-full rounded-lg p-6 text-center"
          style={{ backgroundColor: 'var(--bg-secondary, #1e293b)', border: '1px solid var(--border, #334155)' }}
        >
          <p className="text-base font-semibold mb-2">Sign-in could not start</p>
          <p className="text-sm mb-4" style={{ color: 'var(--text-secondary, #94a3b8)' }}>
            Authentication failed to initialize. This is usually a temporary network or configuration issue.
          </p>
          <p
            className="text-xs mb-4 break-words rounded px-3 py-2 text-left"
            style={{ backgroundColor: 'var(--bg, #0f172a)', color: 'var(--text-secondary, #94a3b8)' }}
          >
            {initError.message}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="text-sm rounded px-4 py-2"
            style={{ backgroundColor: 'var(--accent, #2563eb)', color: '#fff' }}
          >
            Reload app
          </button>
        </div>
      </div>
    );
  }

  if (!msalReady) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ backgroundColor: 'var(--bg, #0f172a)', color: 'var(--text, #e2e8f0)' }}
      >
        <p className="text-sm">Loading…</p>
      </div>
    );
  }

  return (
    <MsalProvider instance={msalInstance}>
      <AppThemeProvider>
        <AuthProvider>
          <LanguageProvider>
            <ConfirmProvider>
              <Router>
              <div className="App app-skin">
                <Routes>
                  <Route path="/" element={<Login />} />
                  <Route element={<AppShell />}>
                    <Route path="/transcription-summary" element={<TranscriptionSummary />} />
                    <Route path="/history" element={<SummaryHistory />} />
                    <Route path="/summary-history" element={<Navigate to="/history" replace />} />
                    <Route path="/project" element={<Project />} />
                    <Route path="/account-settings" element={<AccountSettings />} />
                    <Route path="/issues" element={<Issues />} />
                    <Route path="/admin-analytics" element={<AdminAnalytics />} />
                    <Route path="/admin-controls" element={<AdminControls />} />
                    <Route path="/transcription-model-test" element={<ModelTestRoute />} />
                  </Route>
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </div>
              </Router>
            </ConfirmProvider>
          </LanguageProvider>
        </AuthProvider>
      </AppThemeProvider>
    </MsalProvider>
  );
};

export default App;
