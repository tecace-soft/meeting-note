import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../theme/ThemeProvider';
import { Sun, Moon } from 'lucide-react';
import brandIcon from '../images/meeting note ICON.svg';
import brandIconDark from '../images/meeting note dark mode.svg';
import brandIconLight from '../images/meeting note light mode.svg';

const Login: React.FC = () => {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { isAuthenticated, isLoading, login } = useAuth();
  const [loginError, setLoginError] = React.useState<string | null>(null);
  const [isLoginLoading, setIsLoginLoading] = React.useState(false);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate('/transcription-summary');
    }
  }, [isAuthenticated, isLoading, navigate]);

  const handleMicrosoftLogin = async () => {
    setIsLoginLoading(true);
    setLoginError(null);
    try {
      await login();
    } catch (error: any) {
      console.error('Login error:', error);
      setLoginError(error.message || 'Failed to sign in with Microsoft');
    } finally {
      setIsLoginLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--bg)' }}>
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 mx-auto mb-4" style={{ borderColor: 'var(--accent)' }}></div>
          <p style={{ color: 'var(--text-secondary)' }}>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--bg)' }}>
      {/* Header */}
      <div className="flex justify-end items-center p-4">
        <button
          onClick={toggleTheme}
          className="p-2 rounded-md"
          style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
        >
          {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-grow flex items-center justify-center px-4 sm:px-6 lg:px-8 mobile-safe-bottom">
        <div className="max-w-md w-full space-y-8">
          {/* Header */}
          <div className="text-center">
            <div className="mb-6">
              <img 
                src={theme === 'dark' ? brandIconDark : brandIconLight} 
                alt="Meeting Note" 
                className="mx-auto"
                style={{ height: '120px', width: 'auto' }}
              />
            </div>
          </div>

          {/* Login Card */}
          <div className="card py-8 px-6 rounded-lg">
            <div className="space-y-6">
              <div className="text-center">
                <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
                  Sign in with your Microsoft account to access your Teams chats and upload audio files for transcription.
                </p>
              </div>

              {/* MS Teams Login Button */}
              <button
                onClick={handleMicrosoftLogin}
                disabled={isLoginLoading}
                className="w-full flex items-center justify-center gap-3 py-3 px-4 rounded-md text-sm font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: '#0078d4',
                  color: '#ffffff',
                  border: '1px solid #0078d4',
                }}
              >
                {isLoginLoading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                    <span>Signing in...</span>
                  </>
                ) : (
                  <>
                    {/* Microsoft Logo */}
                    <svg className="w-5 h-5" viewBox="0 0 21 21" fill="none">
                      <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
                      <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
                      <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
                      <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
                    </svg>
                    <span>Sign in with Microsoft</span>
                  </>
                )}
              </button>

              {/* Error Message */}
              {loginError && (
                <div className="p-3 rounded-md error">
                  <p className="text-sm">{loginError}</p>
                </div>
              )}

              {/* Info Text */}
              <div className="text-center pt-4 border-t" style={{ borderColor: 'var(--border)' }}>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  We'll request access to your Teams chats and profile information.
                </p>
              </div>
            </div>
          </div>

          {/* Features Preview */}
          <div className="grid grid-cols-2 gap-4 mt-8">
            <div className="p-4 rounded-lg text-center" style={{ backgroundColor: 'var(--bg-secondary)' }}>
              <svg className="w-8 h-8 mx-auto mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--accent)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
              </svg>
              <p className="text-xs font-medium" style={{ color: 'var(--text)' }}>Audio Transcription</p>
            </div>
            <div className="p-4 rounded-lg text-center" style={{ backgroundColor: 'var(--bg-secondary)' }}>
              <svg className="w-8 h-8 mx-auto mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--accent)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
              </svg>
              <p className="text-xs font-medium" style={{ color: 'var(--text)' }}>Teams Chats</p>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="mt-auto py-6 px-4 border-t" style={{ borderColor: 'var(--border)' }}>
        <div className="max-w-6xl mx-auto text-center">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            © {new Date().getFullYear()} TecAce Software, Ltd. All rights reserved. |{' '}
            <a 
              href="https://tecace.com" 
              target="_blank" 
              rel="noopener noreferrer"
              className="hover:opacity-80 transition-opacity"
              style={{ color: 'var(--accent)' }}
            >
              tecace.com
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
};

export default Login;

