// Preloaded in every test process before application imports.
import { after } from 'node:test';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

// Remove inherited service configuration without reading or printing its values.
for (const key of Object.keys(process.env)) {
  if (/^(SUPABASE_|VITE_|GEMINI_|ASSEMBLYAI_|OPENAI_|RESEND_|WORKFLOW_|MCP_|MEETING_KNOWLEDGE_|MEETING_NOTE_USER_|F9_|MS_|MSAL_|ALLOWED_MS_|APP_FRONTEND_|PORT$)/.test(key) || /(?:_KEY|_TOKEN|_SECRET|_PASSWORD)$/.test(key)) {
    delete process.env[key];
  }
}
process.env.MEETING_NOTE_SKIP_DOTENV = '1';
process.env.WORKFLOW_ALERTS_ENABLED = 'false';
process.env.F9_OPS_AGENT_ENABLED = 'false';

// The dispatcher checks every connection, including fetch redirects.
// Literal 127.0.0.1 matches the IPv4 address every test server binds to.
// localhost depends on DNS/hosts configuration and may resolve to ::1; allowing
// that hostname would not guarantee a connection to the bound IPv4 loopback.
const previousDispatcher = getGlobalDispatcher();
export const testDispatcher = new MockAgent();
testDispatcher.disableNetConnect();
testDispatcher.enableNetConnect(/^127\.0\.0\.1(?::\d+)?$/);
setGlobalDispatcher(testDispatcher);

after(async () => {
  setGlobalDispatcher(previousDispatcher);
  await testDispatcher.close();
});
