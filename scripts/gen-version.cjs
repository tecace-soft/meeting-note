// Git-derived build identity for the frontend. Prefers Render's injected
// RENDER_GIT_COMMIT / RENDER_GIT_BRANCH (set at build time on Render); falls
// back to a local `git` call for dev builds. Writes public/version.json so the
// deployed static site can be probed with `curl https://<host>/version.json`,
// and exports computeVersion() so vite.config can stamp the same value into the
// bundle (window.__APP_VERSION__ + a console line).
//
// This is a per-service traceability stamp (which commit is live), NOT a shared
// version number across the web/mobile/mcp apps.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function gitOutput(command, fallback) {
  try {
    return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || fallback;
  } catch {
    return fallback;
  }
}

function computeVersion() {
  const sha = process.env.RENDER_GIT_COMMIT || gitOutput('git rev-parse HEAD', 'dev');
  const branch = process.env.RENDER_GIT_BRANCH || gitOutput('git rev-parse --abbrev-ref HEAD', 'local');
  return {
    service: 'meeting-note-frontend',
    sha,
    shortSha: sha.slice(0, 7),
    branch,
    deployedAt: new Date().toISOString(),
  };
}

function writeVersionFile() {
  const version = computeVersion();
  const outDir = path.join(__dirname, '..', 'public');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'version.json'),
    `${JSON.stringify(version, null, 2)}\n`,
  );
  return version;
}

module.exports = { computeVersion, writeVersionFile };

if (require.main === module) {
  const version = writeVersionFile();
  console.log(`Wrote public/version.json: ${version.shortSha} (${version.branch})`);
}
