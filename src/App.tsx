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
import SaveSummary from './pages/SaveSummary';
import Project from './pages/Project';
import AccountSettings from './pages/AccountSettings';
import AdminAnalytics from './pages/AdminAnalytics';
import AdminControls from './pages/AdminControls';
import TranscriptionModelTest from './pages/TranscriptionModelTest';
import AppShell from './components/AppShell';
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

  useEffect(() => {
    void msalInstance
      .initialize()
      .then(() => msalInstance.handleRedirectPromise())
      .catch((e) => console.error('MSAL init or redirect handling failed:', e))
      .finally(() => setMsalReady(true));
  }, []);

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
            <Router>
              <div className="App app-skin">
                <Routes>
                  <Route path="/" element={<Login />} />
                  <Route element={<AppShell />}>
                    <Route path="/transcription-summary" element={<TranscriptionSummary />} />
                    <Route path="/history" element={<SummaryHistory />} />
                    <Route path="/summary-history" element={<Navigate to="/history" replace />} />
                    <Route path="/save-summary" element={<SaveSummary />} />
                    <Route path="/project" element={<Project />} />
                    <Route path="/account-settings" element={<AccountSettings />} />
                    <Route path="/admin-analytics" element={<AdminAnalytics />} />
                    <Route path="/admin-controls" element={<AdminControls />} />
                    <Route path="/transcription-model-test" element={<ModelTestRoute />} />
                  </Route>
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </div>
            </Router>
          </LanguageProvider>
        </AuthProvider>
      </AppThemeProvider>
    </MsalProvider>
  );
};

export default App;
