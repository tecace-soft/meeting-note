import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { PublicClientApplication } from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';
import { ThemeProvider } from './theme/ThemeProvider';
import { AuthProvider } from './context/AuthContext';
import { msalConfig } from './config/msalConfig';
import Login from './pages/Login';
import TranscriptionSummary from './pages/TranscriptionSummary';
import SummaryHistory from './pages/SummaryHistory';
import SaveSummary from './pages/SaveSummary';

const msalInstance = new PublicClientApplication(msalConfig);

const App: React.FC = () => {
  return (
    <MsalProvider instance={msalInstance}>
      <ThemeProvider>
        <AuthProvider>
          <Router>
            <div className="App">
              <Routes>
                <Route path="/" element={<Login />} />
                <Route path="/transcription-summary" element={<TranscriptionSummary />} />
                <Route path="/summary-history" element={<SummaryHistory />} />
                <Route path="/save-summary" element={<SaveSummary />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </div>
          </Router>
        </AuthProvider>
      </ThemeProvider>
    </MsalProvider>
  );
};

export default App;

