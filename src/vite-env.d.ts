/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MSAL_CLIENT_ID: string
  readonly VITE_MSAL_AUTHORITY: string
  readonly VITE_MSAL_REDIRECT_URI: string
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

