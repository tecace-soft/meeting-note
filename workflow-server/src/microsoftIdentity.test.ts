import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MicrosoftIdentityError,
  assertGraphIdentityBinding,
  checkKnownClient,
  decideTenant,
  knownClientIdsFromEnv,
  parseTenantIds,
  resolveMicrosoftCaller,
  tenantGateMode,
  tenantIdFromGraphAcceptedToken,
} from './microsoftIdentity.js';

// Offline: only the Graph /me reply is synthetic. Graph signature checks are Microsoft's job;
// these tokens are JWT-shaped so the tenant decode runs on realistic input.
const MEMBER_TENANT = '11111111-1111-4111-8111-111111111111';
const OUTSIDE_TENANT = '99999999-9999-4999-8999-999999999999';
const MEMBER_OID = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
const OUTSIDER_OID = '77777777-7777-4777-8777-777777777777';
const APP = '44444444-4444-4444-8444-444444444444';
const FOREIGN_APP = '55555555-5555-4555-8555-555555555555';

function graphToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.synthetic-signature`;
}

function graph(profile: Record<string, unknown> | null): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    assert.ok(String(url).startsWith('https://graph.microsoft.com/v1.0/me?'));
    calls += 1;
    return profile ? Response.json(profile) : new Response('denied', { status: 401 });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

test('tenant ids parse trimmed and lower-cased; mode follows the list', () => {
  assert.deepEqual(parseTenantIds(` ${MEMBER_TENANT.toUpperCase()} ,, `), [MEMBER_TENANT]);
  assert.equal(tenantGateMode([MEMBER_TENANT]), 'enforced');
  assert.equal(tenantGateMode([]), 'unconfigured');
});

test('tenant decode reads only JWT-shaped tokens with a string tid', () => {
  assert.equal(tenantIdFromGraphAcceptedToken(graphToken({ tid: MEMBER_TENANT.toUpperCase() })), MEMBER_TENANT);
  assert.equal(tenantIdFromGraphAcceptedToken('EwBopaque-personal-account'), '');
  assert.equal(tenantIdFromGraphAcceptedToken('a.b'), '');
  assert.equal(tenantIdFromGraphAcceptedToken(graphToken({ tid: 7 })), '');
  assert.equal(tenantIdFromGraphAcceptedToken('x.%%%.y'), '');
});

test('member tenant resolves with orgVerified; email is display data', async () => {
  const { fetchImpl } = graph({ id: MEMBER_OID, displayName: 'Member', mail: 'Member@TecAce.com' });
  const caller = await resolveMicrosoftCaller(graphToken({ tid: MEMBER_TENANT, oid: MEMBER_OID, azp: APP }), { allowedTenantIds: [MEMBER_TENANT], knownClientIds: [APP], fetchImpl });
  assert.deepEqual(caller, { id: MEMBER_OID, email: 'member@tecace.com', name: 'Member', tenantId: MEMBER_TENANT, orgVerified: true });
});

test('outside tenant with a spoofed allowlisted-domain mail is 403 (nOAuth)', async () => {
  const { fetchImpl } = graph({ id: OUTSIDER_OID, displayName: 'Hansoo Lee', mail: 'hansoo@tecace.com' });
  await assert.rejects(
    resolveMicrosoftCaller(graphToken({ tid: OUTSIDE_TENANT, oid: OUTSIDER_OID }), { allowedTenantIds: [MEMBER_TENANT], fetchImpl }),
    (error: unknown) => error instanceof MicrosoftIdentityError && error.status === 403,
  );
});

test('opaque personal-account token has no tenant and is 403 when enforced', async () => {
  const { fetchImpl } = graph({ id: OUTSIDER_OID, userPrincipalName: 'hansoo@tecace.com' });
  await assert.rejects(
    resolveMicrosoftCaller('EwBopaque-personal-account', { allowedTenantIds: [MEMBER_TENANT], fetchImpl }),
    (error: unknown) => error instanceof MicrosoftIdentityError && error.status === 403,
  );
});

test('Graph rejection is 401 and never reaches the tenant decision', async () => {
  const { fetchImpl } = graph(null);
  await assert.rejects(
    resolveMicrosoftCaller(graphToken({ tid: MEMBER_TENANT }), { allowedTenantIds: [MEMBER_TENANT], fetchImpl }),
    (error: unknown) => error instanceof MicrosoftIdentityError && error.status === 401,
  );
});

test('unconfigured allowlist: ordinary routes keep working unverified; requireOrg fails closed', async () => {
  const { fetchImpl } = graph({ id: OUTSIDER_OID, mail: 'x@elsewhere.test' });
  const caller = await resolveMicrosoftCaller(graphToken({ tid: OUTSIDE_TENANT, oid: OUTSIDER_OID }), { allowedTenantIds: [], fetchImpl });
  assert.equal(caller.orgVerified, false);
  assert.equal(caller.id, OUTSIDER_OID);
  await assert.rejects(
    resolveMicrosoftCaller(graphToken({ tid: MEMBER_TENANT, oid: OUTSIDER_OID }), { allowedTenantIds: [], requireOrg: true, fetchImpl }),
    (error: unknown) => error instanceof MicrosoftIdentityError && error.status === 403,
  );
});

test('decideTenant: empty tid never matches a configured list', () => {
  assert.throws(() => decideTenant('', [MEMBER_TENANT], false), MicrosoftIdentityError);
  assert.equal(decideTenant(MEMBER_TENANT, [MEMBER_TENANT], true), true);
});

test('binding: Graph id must be a UUID equal to the token oid (401)', async () => {
  assert.doesNotThrow(() => assertGraphIdentityBinding(graphToken({ oid: MEMBER_OID }), MEMBER_OID.toUpperCase()));
  assert.doesNotThrow(() => assertGraphIdentityBinding('EwBopaque', MEMBER_OID));
  const is401 = (error: unknown) => error instanceof MicrosoftIdentityError && error.status === 401;
  assert.throws(() => assertGraphIdentityBinding(graphToken({ oid: OUTSIDER_OID }), MEMBER_OID), is401);
  assert.throws(() => assertGraphIdentityBinding(graphToken({ tid: MEMBER_TENANT }), MEMBER_OID), is401);
  assert.throws(() => assertGraphIdentityBinding('EwBopaque', '0123456789abcdef'), is401);
  const { fetchImpl } = graph({ id: MEMBER_OID });
  await assert.rejects(
    resolveMicrosoftCaller(graphToken({ tid: MEMBER_TENANT, oid: OUTSIDER_OID }), { allowedTenantIds: [MEMBER_TENANT], fetchImpl }),
    is401,
  );
});

test('known clients come from the app, MCP OAuth and MCP admin registrations', () => {
  const ids = knownClientIdsFromEnv({ MS_ID_TOKEN_CLIENT_IDS: APP, VITE_MSAL_CLIENT_ID: APP.toUpperCase(), MCP_OAUTH_CLIENT_ID: FOREIGN_APP, MCP_ADMIN_CLIENT_ID: ' ' });
  assert.deepEqual(ids, [APP, FOREIGN_APP]);
});

test('unknown appid: logged without its value, allowed when log-only, 403 when enforced', () => {
  const realInfo = console.info;
  const lines: string[] = [];
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const foreign = graphToken({ tid: MEMBER_TENANT, oid: MEMBER_OID, appid: FOREIGN_APP });
    checkKnownClient(foreign, 'api', [APP], 'log-only');
    assert.deepEqual(JSON.parse(lines.at(-1)!), { event: 'ms_token_client_check', reason: 'unknown_client', client: 'api', knownClient: false, enforced: false });
    assert.ok(!lines.join(' ').includes(FOREIGN_APP));
    assert.throws(() => checkKnownClient(foreign, 'api', [APP], 'enforced'),
      (error: unknown) => error instanceof MicrosoftIdentityError && error.status === 403);
    const before = lines.length;
    checkKnownClient(graphToken({ azp: APP }), 'api', [APP], 'enforced');
    assert.equal(lines.length, before);
    assert.throws(() => checkKnownClient(graphToken({ azp: APP }), 'api', [], 'enforced'), MicrosoftIdentityError);
  } finally {
    console.info = realInfo;
  }
});
