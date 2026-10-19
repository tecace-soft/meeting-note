import assert from 'node:assert/strict';
import {
  authorizeMicrosoftGraphToken,
  enforceMsAllowlist,
  graphAccessTokenTenantId,
  graphIdentityBindingError,
  knownClientIds,
} from './msGraphAllowlist.ts';

// Shared by supabase-token, mcp-token, admin-analytics, admin-controls, generate-profile,
// identify-speakers and note-audio-url. Offline: only the Graph HTTP reply is synthetic.
const member = '11111111-1111-4111-8111-111111111111';
const outsider = '99999999-9999-4999-8999-999999999999';
const env = (values: Record<string, string>) => (name: string) => values[name];
const app = '44444444-4444-4444-8444-444444444444';
const foreignApp = '55555555-5555-4555-8555-555555555555';
const memberOid = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
const outsiderOid = '77777777-7777-4777-8777-777777777777';
const configured = env({ ALLOWED_MS_TENANT_IDS: ` ${member.toUpperCase()} `, ALLOWED_EMAIL_DOMAINS: 'tecace.com', MS_ID_TOKEN_CLIENT_IDS: app });
const enforcing = env({ ALLOWED_MS_TENANT_IDS: member, MS_ID_TOKEN_CLIENT_IDS: app, MS_TOKEN_REQUIRE_KNOWN_CLIENT: 'true' });

function graphToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.synthetic-signature`;
}

async function withGraph<T>(profile: Record<string, unknown> | null, run: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((url: string | URL | Request) => {
    if (!String(url).startsWith('https://graph.microsoft.com/v1.0/me?')) throw new Error('Unexpected network request');
    calls += 1;
    return Promise.resolve(profile ? Response.json(profile) : new Response('private', { status: 401 }));
  }) as typeof fetch;
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

Deno.test('policy: the tenant id is the only signal; email domains never grant access', () => {
  assert.deepEqual(enforceMsAllowlist({ tenantId: member }, configured), { allowed: true });
  assert.equal(enforceMsAllowlist({ tenantId: outsider }, configured).status, 403);
  assert.equal(enforceMsAllowlist({ tenantId: '' }, configured).status, 403);
});

Deno.test('policy: an empty tenant allowlist fails closed even with ALLOWED_EMAIL_DOMAINS', () => {
  const decision = enforceMsAllowlist({ tenantId: member }, env({ ALLOWED_EMAIL_DOMAINS: 'tecace.com' }));
  assert.equal(decision.allowed, false);
  assert.equal(decision.status, 500);
});

Deno.test('tenant is read from a JWT-shaped token only; opaque tokens have none', () => {
  assert.equal(graphAccessTokenTenantId(graphToken({ tid: member.toUpperCase() })), member);
  assert.equal(graphAccessTokenTenantId('EwBopaque'), '');
  assert.equal(graphAccessTokenTenantId('a.b'), '');
  assert.equal(graphAccessTokenTenantId(graphToken({ tid: 42 })), '');
});

Deno.test('Graph auth: member tenant passes, outside tenant with a spoofed mail is denied', async () => {
  const ok = await withGraph({ id: memberOid, mail: 'x@other.test' },
    () => authorizeMicrosoftGraphToken(graphToken({ tid: member, oid: memberOid, azp: app }), configured));
  assert.deepEqual(ok.result, { userId: memberOid });

  const spoof = await withGraph({ id: outsiderOid, mail: 'hansoo@tecace.com' },
    () => authorizeMicrosoftGraphToken(graphToken({ tid: outsider, oid: outsiderOid }), configured));
  assert.equal(spoof.result.userId, null);
  assert.equal(spoof.result.status, 403);

  const opaque = await withGraph({ id: outsiderOid, userPrincipalName: 'hansoo@tecace.com' },
    () => authorizeMicrosoftGraphToken('EwBopaque', configured));
  assert.equal(opaque.result.status, 403);
});

Deno.test('Graph auth: invalid token is 401; unconfigured gate is 500 without a Graph call', async () => {
  const invalid = await withGraph(null, () => authorizeMicrosoftGraphToken(graphToken({ tid: member }), configured));
  assert.equal(invalid.result.status, 401);
  assert.ok(!String(invalid.result.error).includes('private'));

  const unconfigured = await withGraph({ id: memberOid },
    () => authorizeMicrosoftGraphToken(graphToken({ tid: member, oid: memberOid }), env({})));
  assert.equal(unconfigured.result.status, 500);
  assert.equal(unconfigured.calls, 0);
});

Deno.test('binding: Graph id must be a UUID and equal the token oid', () => {
  assert.equal(graphIdentityBindingError(graphToken({ oid: memberOid }), memberOid.toUpperCase()), null);
  assert.ok(graphIdentityBindingError(graphToken({ oid: outsiderOid }), memberOid));
  assert.ok(graphIdentityBindingError(graphToken({ tid: member }), memberOid));
  assert.ok(graphIdentityBindingError('EwBopaque', '0123456789abcdef'));
  assert.equal(graphIdentityBindingError('EwBopaque', memberOid), null);
});

Deno.test('Graph auth: oid mismatch is 401', async () => {
  const mismatch = await withGraph({ id: memberOid },
    () => authorizeMicrosoftGraphToken(graphToken({ tid: member, oid: outsiderOid, azp: app }), configured));
  assert.equal(mismatch.result.status, 401);
});

Deno.test('known clients: app registration plus MS_KNOWN_CLIENT_IDS, deduplicated', () => {
  assert.deepEqual(knownClientIds(env({ MS_ID_TOKEN_CLIENT_IDS: app, MSAL_CLIENT_ID: app.toUpperCase(), MS_KNOWN_CLIENT_IDS: foreignApp })), [foreignApp, app]);
});

Deno.test('Graph auth: unknown appid is allowed when log-only and 403 when enforced', async () => {
  const realInfo = console.info;
  const lines: string[] = [];
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const logged = await withGraph({ id: memberOid },
      () => authorizeMicrosoftGraphToken(graphToken({ tid: member, oid: memberOid, appid: foreignApp }), configured, { client: 'browser' }));
    assert.deepEqual(logged.result, { userId: memberOid });
    assert.deepEqual(JSON.parse(lines.at(-1)!), { event: 'ms_token_client_check', reason: 'unknown_client', client: 'browser', knownClient: false, enforced: false });
    assert.ok(!lines.join(' ').includes(foreignApp));

    const blocked = await withGraph({ id: memberOid },
      () => authorizeMicrosoftGraphToken(graphToken({ tid: member, oid: memberOid, appid: foreignApp }), enforcing));
    assert.equal(blocked.result.status, 403);
    const known = await withGraph({ id: memberOid },
      () => authorizeMicrosoftGraphToken(graphToken({ tid: member, oid: memberOid, appid: app }), enforcing));
    assert.deepEqual(known.result, { userId: memberOid });
  } finally {
    console.info = realInfo;
  }
});
