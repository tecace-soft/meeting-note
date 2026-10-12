// Fail-fast validation for required client environment variables.
//
// Without this, a missing var boots the app with placeholder values
// (e.g. MSAL clientId 'YOUR_CLIENT_ID_HERE', a placeholder Supabase URL) and
// then fails much later with cryptic auth/DB errors that are hard to trace back
// to configuration. Instead we detect it at startup and show a clear message.
//
// Only vars with NO safe fallback are listed here. Vars that already default
// sensibly (VITE_MSAL_AUTHORITY -> 'common', redirect URI -> window.origin)
// are intentionally omitted so a normal deploy is never blocked.
const REQUIRED_ENV_VARS = [
  'VITE_MSAL_CLIENT_ID',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
] as const;

// Placeholder values that are present in the code as fallbacks but are not a
// real configuration, so they count as "missing".
const PLACEHOLDER_VALUES = new Set(['YOUR_CLIENT_ID_HERE']);

/** Returns the names of required env vars that are missing or still placeholders. */
export function getMissingEnvVars(): string[] {
  // Read each var by its literal name so Vite inlines ONLY these values. A
  // dynamic `env[key]` over the whole import.meta.env object would make Vite
  // bake the entire env object (every secret VITE_-prefixed var) into the
  // client bundle. The Record type forces a literal entry for each required
  // var, so adding one here without a literal access fails to compile.
  const values: Record<(typeof REQUIRED_ENV_VARS)[number], string | undefined> = {
    VITE_MSAL_CLIENT_ID: import.meta.env.VITE_MSAL_CLIENT_ID,
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
  };
  return REQUIRED_ENV_VARS.filter((key) => {
    const value = values[key];
    return !value || !value.trim() || PLACEHOLDER_VALUES.has(value.trim());
  });
}
