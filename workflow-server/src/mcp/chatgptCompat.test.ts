import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMeetingNoteMcpServer } from './server.js';
import { buildFetchText, buildNoteUrl } from './tools/knowledge.js';
import { getProtectedResourceMetadata } from './transports/http.js';

// ---- protected resource metadata (ChatGPT OAuth discovery) ----

test('PRM pins the tenant-specific Entra issuer when a tenant is configured', () => {
  const prm = getProtectedResourceMetadata('https://api.example.com', 'https://api.example.com/mcp-chatgpt', 'https://api.example.com/mcp-chatgpt/mcp.access', 'tenant-123');
  assert.deepEqual(prm.authorization_servers, ['https://login.microsoftonline.com/tenant-123/v2.0']);
  assert.equal(prm.resource, 'https://api.example.com/mcp-chatgpt');
  assert.ok(prm.scopes_supported.includes('https://api.example.com/mcp-chatgpt/mcp.access'));
  assert.ok(prm.scopes_supported.includes('offline_access'));
});

test('PRM falls back to the common issuer and host-derived resource without config', () => {
  const prm = getProtectedResourceMetadata('https://api.example.com');
  assert.deepEqual(prm.authorization_servers, ['https://login.microsoftonline.com/common/v2.0']);
  assert.equal(prm.resource, 'https://api.example.com/mcp-chatgpt');
});

// ---- search/fetch helpers ----

test('buildNoteUrl produces a non-empty app URL so ChatGPT can cite the note', () => {
  assert.equal(buildNoteUrl('42'), 'https://meetingnote.tecace.com/history?note=42');
});

test('buildFetchText joins summary and transcript and handles empty notes', () => {
  assert.equal(buildFetchText('S', 'T'), 'Summary:\nS\n\nTranscript:\nT');
  assert.equal(buildFetchText('', ''), 'No summary or transcript for this note.');
});

// ---- tool listing ----

test('tools/list exposes OpenAI-compatible search/fetch and readOnlyHint on read tools only', async () => {
  const server = createMeetingNoteMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  // search/fetch keep exactly the schema ChatGPT expects (no tracking fields added).
  assert.deepEqual(byName.get('search')?.inputSchema.required, ['query']);
  assert.deepEqual(Object.keys(byName.get('search')?.inputSchema.properties ?? {}), ['query']);
  assert.deepEqual(byName.get('fetch')?.inputSchema.required, ['id']);
  assert.deepEqual(Object.keys(byName.get('fetch')?.inputSchema.properties ?? {}), ['id']);

  for (const name of ['search', 'fetch', 'search_notes', 'get_note']) {
    assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, `${name} should be read-only`);
  }
  for (const name of ['add_note_to_project', 'remove_note_from_project', 'log_final_answer']) {
    assert.notEqual(byName.get(name)?.annotations?.readOnlyHint, true, `${name} writes and must not be read-only`);
  }
  // Other tools still carry the evaluation tracking fields.
  assert.ok('user_intent' in (byName.get('search_notes')?.inputSchema.properties ?? {}));

  await client.close();
  await server.close();
});

test('PRM points at this server as the authorization server in OAuth proxy mode', () => {
  const prm = getProtectedResourceMetadata('https://api.example.com', undefined, undefined, 'tenant-123', 'https://api.example.com');
  assert.deepEqual(prm.authorization_servers, ['https://api.example.com']);
  assert.equal(prm.resource, 'https://api.example.com/mcp-chatgpt');
  assert.deepEqual(prm.scopes_supported, ['mcp']);
});
