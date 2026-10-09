import { defineConfig } from 'vitest/config'

// Self-contained test config. Intentionally does NOT load the app's
// vite.config.ts (which pulls in @vitejs/plugin-react pinned to Vite 4 and
// runs scripts/gen-version.cjs as a side effect). Vitest ships its own Vite,
// so we let esbuild handle the JSX transform via the automatic runtime instead
// of the react plugin. This keeps the app build toolchain (Vite 4) untouched.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
  },
})
