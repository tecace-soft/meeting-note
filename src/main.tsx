import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary'
import { getMissingEnvVars } from './config/validateEnv'
import './index.css'
import './styles/theme.css'

// Surface which commit the deployed web app is running (no visible UI chrome, to
// stay out of the design surface). Read it in devtools or via `window.__APP_VERSION__`,
// and externally at `/version.json`.
;(window as unknown as { __APP_VERSION__: typeof __APP_VERSION__ }).__APP_VERSION__ = __APP_VERSION__
// Intentional one-time startup banner so the live commit is discoverable in
// devtools without opening /version.json. eslint's no-console allows only
// warn/error, but info is the right level for a non-error diagnostic here.
// eslint-disable-next-line no-console
console.info(
  `[meeting-note] frontend ${__APP_VERSION__.shortSha} (${__APP_VERSION__.branch}), built ${__APP_VERSION__.deployedAt}`,
)

// Fail fast on misconfiguration: booting with placeholder credentials only fails
// later with cryptic auth/DB errors, so show a clear message up front instead.
const missingEnvVars = getMissingEnvVars()

const EnvConfigError = ({ missing }: { missing: string[] }) => (
  <div
    style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      fontFamily: 'system-ui, sans-serif',
      background: '#0f172a',
      color: '#e2e8f0',
    }}
  >
    <div style={{ maxWidth: '32rem', textAlign: 'center' }}>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.75rem' }}>
        Configuration error
      </h1>
      <p style={{ fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '1rem' }}>
        The app can&rsquo;t start because required environment variables are missing.
        Set them in your <code>.env</code> (or the hosting dashboard) and reload.
      </p>
      <ul
        style={{
          display: 'inline-block',
          textAlign: 'left',
          fontFamily: 'ui-monospace, monospace',
          fontSize: '0.85rem',
          color: '#fca5a5',
        }}
      >
        {missing.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </div>
  </div>
)

ReactDOM.createRoot(document.getElementById('root')!).render(
  missingEnvVars.length > 0 ? (
    <EnvConfigError missing={missingEnvVars} />
  ) : (
    <ErrorBoundary label="root">
      <App />
    </ErrorBoundary>
  ),
)
