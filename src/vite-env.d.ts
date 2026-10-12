/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MSAL_CLIENT_ID: string
  readonly VITE_MSAL_AUTHORITY: string
  readonly VITE_MSAL_REDIRECT_URI: string
  readonly VITE_SUPABASE_URL: string | undefined
  readonly VITE_SUPABASE_ANON_KEY: string | undefined
  readonly VITE_DEBUG_SUPABASE_AUTH: string | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Git-derived build identity, injected by vite.config.ts `define`. See
// scripts/gen-version.cjs. Lets the console/devtools show which commit is live.
declare const __APP_VERSION__: {
  service: string
  sha: string
  shortSha: string
  branch: string
  deployedAt: string
}

