// One command → the whole picture: which commit each deployed component is
// running right now. Probes the frontend, workflow-server, and MCP server
// version endpoints and prints a table, then compares each SHA against local
// git HEAD so you can see what is ahead/behind.
//
// These are INDEPENDENT per-service stamps, not a shared version number: a
// component only advances when it is redeployed, so mismatched SHAs are normal
// and informative (e.g. mobile built ahead of the last web deploy).
//
// Note: the Render free tier suspends the backend + MCP services, and a cold
// start can take ~30-60s, so a probe may time out even when the service is fine.
const { execSync } = require('node:child_process');

const TARGETS = [
  { name: 'frontend', url: 'https://meetingnote.tecace.com/version.json' },
  { name: 'workflow-server', url: 'https://meeting-note-backend-njfb.onrender.com/version' },
];

const TIMEOUT_MS = 65000; // tolerate a Render cold start

function localHead() {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

async function probe(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(target.url, { signal: controller.signal });
    if (!res.ok) return { ...target, error: `HTTP ${res.status}` };
    const body = await res.json();
    return { ...target, ...body };
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? 'timeout (cold start?)' : (error && error.message) || 'unreachable';
    return { ...target, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

function pad(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

async function main() {
  const head = localHead();
  const rows = await Promise.all(TARGETS.map(probe));

  console.log('');
  console.log(`local git HEAD: ${head ? head.slice(0, 7) : '(unknown)'}`);
  console.log('');
  console.log(`${pad('component', 18)}${pad('sha', 12)}${pad('branch', 14)}${pad('vs HEAD', 12)}deployedAt`);
  console.log('-'.repeat(78));
  for (const row of rows) {
    if (row.error) {
      console.log(`${pad(row.name, 18)}${pad('-', 12)}${pad('-', 14)}${pad('-', 12)}${row.error}`);
      continue;
    }
    const vsHead = head && row.sha ? (row.sha === head ? 'up to date' : 'differs') : '?';
    console.log(`${pad(row.name, 18)}${pad(row.shortSha || '?', 12)}${pad(row.branch || '?', 14)}${pad(vsHead, 12)}${row.deployedAt || ''}`);
  }
  console.log('');
}

main();
