import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileDocument, Moon, Sun } from 'react-coolicons';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../theme/ThemeProvider';
import { AppSpinner } from '../ui/AppSpinner';
import { Box, Button, IconButton, Typography } from '../ui/wantedCompat';

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
    } catch (error: unknown) {
      console.error('Login error:', error);
      const message = error instanceof Error ? error.message : 'Failed to sign in with Microsoft';
      setLoginError(message);
    } finally {
      setIsLoginLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ backgroundColor: 'var(--bg)' }}>
        <div className="text-center">
          <div className="mx-auto mb-4 flex justify-center text-[var(--accent)]">
            <AppSpinner className="h-8 w-8 animate-spin" aria-label="Loading" />
          </div>
          <Typography variant="body2" color="semantic.label.alternative">
            Loading…
          </Typography>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col" style={{ backgroundColor: 'var(--bg)' }}>
      <div className="fixed bottom-8 right-4 z-10">
        <IconButton
          type="button"
          variant="background"
          onClick={toggleTheme}
          aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
        >
          {theme === 'light' ? <Moon className="h-5 w-5" aria-hidden /> : <Sun className="h-5 w-5" aria-hidden />}
        </IconButton>
      </div>

      <div className="flex flex-1 items-center justify-center px-4 sm:px-6 lg:px-8">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center">
            <div className="mb-6 flex justify-center" style={{ color: 'var(--accent)' }}>
              <FileDocument width={56} height={56} aria-hidden />
            </div>
            <Typography variant="title2" weight="medium" as="h1">
              Meeting Note
            </Typography>
            <Typography variant="body2" color="semantic.label.alternative" className="mt-2 block">
              Transcribe audio files and access your Teams chats
            </Typography>
          </div>

          <Box className="app-surface-elevated p-6 sm:p-7" sx={{ borderRadius: '12px' }}>
            <div className="space-y-6">
              <Typography variant="body2" color="semantic.label.alternative" align="center" as="p">
                Sign in with your Microsoft account to access your Teams chats and upload audio files for
                transcription.
              </Typography>

              <Button
                type="button"
                variant="solid"
                color="primary"
                fullWidth
                loading={isLoginLoading}
                onClick={() => {
                  void handleMicrosoftLogin();
                }}
                leadingContent={
                  <svg className="h-5 w-5 shrink-0" viewBox="0 0 21 21" fill="none" aria-hidden>
                    <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                    <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                    <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                    <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                  </svg>
                }
              >
                Sign in with Microsoft
              </Button>

              {loginError ? (
                <div className="error rounded-lg p-3">
                  <Typography variant="body2" as="p">
                    {loginError}
                  </Typography>
                </div>
              ) : null}

              <div
                className="border-t pt-4 text-center"
                style={{ borderColor: 'color-mix(in srgb, var(--border) 45%, transparent)' }}
              >
                <Typography variant="caption1" color="semantic.label.alternative" as="p">
                  We&apos;ll request access to your Teams chats and profile information.
                </Typography>
              </div>
            </div>
          </Box>

          <div className="mt-8 grid grid-cols-2 gap-4">
            <div
              className="rounded-lg p-4 text-center"
              style={{ backgroundColor: 'var(--bg-secondary)', borderRadius: '8px' }}
            >
              <Typography variant="label2" weight="medium" className="mt-2 block">
                Audio transcription
              </Typography>
            </div>
            <div
              className="rounded-lg p-4 text-center"
              style={{ backgroundColor: 'var(--bg-secondary)', borderRadius: '8px' }}
            >
              <Typography variant="label2" weight="medium" className="mt-2 block">
                Teams chats
              </Typography>
            </div>
          </div>
        </div>
      </div>

      <footer
        className="mt-auto border-t px-4 py-6"
        style={{ borderColor: 'color-mix(in srgb, var(--border) 45%, transparent)' }}
      >
        <div className="mx-auto max-w-6xl text-center">
          <Typography variant="caption2" color="semantic.label.alternative" as="p">
            © {new Date().getFullYear()} TecAce Software, Ltd. All rights reserved. |{' '}
            <a
              href="https://tecace.com"
              target="_blank"
              rel="noopener noreferrer"
              className="link font-medium"
            >
              tecace.com
            </a>
          </Typography>
        </div>
      </footer>
    </div>
  );
};

export default Login;
