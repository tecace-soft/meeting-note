import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'

// Stamp the git-derived build identity into the bundle. computeVersion() prefers
// Render's RENDER_GIT_COMMIT and falls back to a local git call (see
// scripts/gen-version.cjs, which also writes public/version.json via `prebuild`).
const require = createRequire(import.meta.url)
const { computeVersion } = require('./scripts/gen-version.cjs') as {
  computeVersion: () => Record<string, string>
}
const APP_VERSION = computeVersion()

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  server: {
    port: 5174,
    open: true,
    host: '0.0.0.0',
    allowedHosts: ['meeting-note-fxms.onrender.com', 'meetingnote.tecace.com']
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: ['meeting-note-fxms.onrender.com', 'meetingnote.tecace.com']
  }
})
