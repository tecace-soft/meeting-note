import assert from 'node:assert/strict';
import test from 'node:test';

test('test runs skip the local .env and cannot send alerts', () => {
  assert.equal(process.env.MEETING_NOTE_SKIP_DOTENV, '1');
  assert.equal(process.env.WORKFLOW_ALERTS_ENABLED, 'false');
  assert.equal(process.env.RESEND_API_KEY, undefined);
});

test('importing the env module does not load dotenv values', async () => {
  // SUPABASE_SERVICE_ROLE_KEY is a key the local .env normally defines; it must
  // be absent unless the invoking shell exported it explicitly.
  const before = process.env.SUPABASE_SERVICE_ROLE_KEY;
  await import('./mcp/lib/env.js');
  assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY, before);
});

test('outbound network to real hosts is refused', async () => {
  await assert.rejects(() => fetch('https://example.com/'), /Outbound network is blocked/);
});
