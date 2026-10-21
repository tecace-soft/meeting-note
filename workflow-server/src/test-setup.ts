// Loaded by `npm test` via `tsx --import` before every test file (each file runs
// in its own process, and --import is inherited). Makes tests deterministic and
// isolated: never read the local .env, never send alerts, never reach the network.

process.env.MEETING_NOTE_SKIP_DOTENV = '1';
process.env.WORKFLOW_ALERTS_ENABLED = 'false';
for (const key of ['RESEND_API_KEY', 'WORKFLOW_ALERT_RESEND_API_KEY', 'MCP_ALERT_RESEND_API_KEY']) {
  delete process.env[key];
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const realFetch = globalThis.fetch;

// Single choke point for outbound HTTP in this server is global fetch.
// Loopback stays allowed so tests can talk to their own in-process servers.
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let host = '';
  try {
    host = new URL(raw).hostname;
  } catch {
    // Relative or malformed URL: let the real fetch reject it.
  }
  if (host && !LOOPBACK_HOSTS.has(host)) {
    return Promise.reject(new Error(`Outbound network is blocked in tests: ${host}`));
  }
  return realFetch(input, init);
}) as typeof fetch;
