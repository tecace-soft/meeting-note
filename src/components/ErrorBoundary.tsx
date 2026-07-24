import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional label to identify where the boundary sits (e.g. route name). */
  label?: string;
  /** Optional custom fallback renderer. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors in the subtree so a single failing page
 * does not white-screen the whole app. Use one at the app root and one per
 * route inside AppShell's <Outlet />.
 */
class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) {
        return this.props.fallback(error, this.reset);
      }
      return (
        <div
          className="min-h-screen flex items-center justify-center p-6"
          style={{ backgroundColor: 'var(--bg, #0f172a)', color: 'var(--text, #e2e8f0)' }}
        >
          <div
            className="max-w-md w-full rounded-lg p-6 text-center"
            style={{ backgroundColor: 'var(--bg-secondary, #1e293b)', border: '1px solid var(--border, #334155)' }}
          >
            <p className="text-base font-semibold mb-2">Something went wrong</p>
            <p className="text-sm mb-4" style={{ color: 'var(--text-secondary, #94a3b8)' }}>
              This page hit an unexpected error. You can try again without losing the rest of the app.
            </p>
            <p
              className="text-xs mb-4 break-words rounded px-3 py-2 text-left"
              style={{ backgroundColor: 'var(--bg, #0f172a)', color: 'var(--text-secondary, #94a3b8)' }}
            >
              {error.message || String(error)}
            </p>
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={this.reset}
                className="text-sm rounded px-4 py-2"
                style={{ backgroundColor: 'var(--accent, #2563eb)', color: '#fff' }}
              >
                Try again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="text-sm rounded px-4 py-2"
                style={{ border: '1px solid var(--border, #334155)', color: 'var(--text, #e2e8f0)' }}
              >
                Reload app
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
