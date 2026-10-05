import assert from 'node:assert/strict';
import test from 'node:test';
import { checkMeetingSourceAccess, evaluateMeetingSourceAccess, type MeetingSourceAccessRecord } from './source-access.js';
import { isMeetingLiveAccessRequest, type MeetingLiveAccessRequest } from './access-contract.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const owner = { tenantId, objectId: '22222222-2222-4222-8222-000000000001' };
const participant = { tenantId, objectId: '22222222-2222-4222-8222-000000000002' };
const shared = { tenantId, objectId: '22222222-2222-4222-8222-000000000003' };
const projectMember = { tenantId, objectId: '22222222-2222-4222-8222-000000000004' };
function source(): MeetingSourceAccessRecord {
  return {
    tenantId, sourceId: 'synthetic-note', contentRevision: 1, speakerRevision: 1, accessRevision: 1,
    integrationGeneration: 1, sourceHash: 'a'.repeat(64), owner, ownerIdentityVerified: true,
    active: true, integrationEnabled: true,
    confirmedParticipants: [{ identity: participant, confirmedBy: owner, verificationRef: 'synthetic-confirmation' }],
    directShares: [shared], denies: [], noteProjectIds: ['synthetic-project'],
    projects: [{ projectId: 'synthetic-project', owner, sharedWith: [projectMember] }],
  };
}
function request(identity = participant): MeetingLiveAccessRequest {
  const { sourceId, contentRevision, speakerRevision, accessRevision, sourceHash, integrationGeneration } = source();
  return { ...identity, sourceId, contentRevision, speakerRevision, accessRevision, sourceHash, integrationGeneration };
}

test('accepts confirmed participant, direct share and owner-matched project share', () => {
  for (const identity of [participant, shared, projectMember]) assert.ok(evaluateMeetingSourceAccess(identity, source()).allowed);
  assert.ok(!evaluateMeetingSourceAccess(owner, source()).allowed, 'owner must explicitly participate or be shared');
});

test('deny overrides attendance and every alternative share grant', () => {
  const record = source();
  record.directShares.push(participant);
  record.projects[0].sharedWith.push(participant);
  record.denies.push(participant);
  assert.deepEqual(evaluateMeetingSourceAccess(participant, record), { allowed: false, errorCode: 'ACCESS_REVOKED' });
  record.confirmedParticipants = [];
  assert.ok(!evaluateMeetingSourceAccess(participant, record).allowed);
});

test('foreign tenant, guessed names and unverified note owners cannot grant access', () => {
  assert.ok(!evaluateMeetingSourceAccess({ ...participant, tenantId: owner.objectId }, source()).allowed);
  assert.ok(!evaluateMeetingSourceAccess({ ...participant, objectId: 'Speaker B' }, source()).allowed);
  assert.ok(!evaluateMeetingSourceAccess(participant, { ...source(), ownerIdentityVerified: false }).allowed);
  assert.ok(!evaluateMeetingSourceAccess(participant, { ...source(), owner: { ...owner, tenantId: owner.objectId } }).allowed);
});

for (const problem of ['other-owner', 'other-tenant', 'not-member', 'removed-share'] as const) {
  test(`rejects project ${problem}`, () => {
    const record = source();
    if (problem === 'other-owner') record.projects[0].owner = shared;
    if (problem === 'other-tenant') record.projects[0].owner = { ...owner, tenantId: owner.objectId };
    if (problem === 'not-member') record.noteProjectIds = [];
    if (problem === 'removed-share') record.projects[0].sharedWith = [];
    assert.ok(!evaluateMeetingSourceAccess(projectMember, record).allowed);
  });
}

test('attendance confirmed by a non-owner and removed direct shares are denied', () => {
  const record = source();
  record.confirmedParticipants[0].confirmedBy = shared;
  record.directShares = [];
  assert.ok(!evaluateMeetingSourceAccess(participant, record).allowed);
  assert.ok(!evaluateMeetingSourceAccess(shared, record).allowed);
});

test('deleted, disabled or unavailable policy state fails closed', () => {
  for (const record of [{ ...source(), active: false }, { ...source(), integrationEnabled: false },
    { ...source(), denies: undefined }]) {
    assert.ok(!evaluateMeetingSourceAccess(participant, record as MeetingSourceAccessRecord).allowed);
  }
});

test('current trusted snapshot returns the same exact source-check binding', async () => {
  const input = request();
  assert.ok(isMeetingLiveAccessRequest(input));
  assert.deepEqual(await checkMeetingSourceAccess(input, async () => source()), { ...input, allowed: true });
});

for (const field of ['tenantId', 'sourceId', 'contentRevision', 'speakerRevision', 'accessRevision', 'sourceHash', 'integrationGeneration'] as const) {
  test(`denies a source check whose current ${field} differs`, async () => {
    const record = source();
    Object.assign(record, { [field]: typeof record[field] === 'number' ? Number(record[field]) + 1 : 'different' });
    assert.deepEqual(await checkMeetingSourceAccess(request(), async () => record), { ...request(), allowed: false });
  });
}

test('lookup errors and missing sources expose no source metadata', async () => {
  for (const loader of [async () => null, async () => { throw new Error('private lookup detail'); }]) {
    const result = await checkMeetingSourceAccess(request(), loader);
    assert.deepEqual(result, { ...request(), allowed: false });
    assert.ok(!JSON.stringify(result).includes('private'));
  }
});

test('malformed source-check requests never invoke the privileged loader', async () => {
  for (const invalid of [{ ...request(), objectId: 'name' }, { ...request(), clearance: 5 },
    { ...request(), accessRevision: 0 }, { ...request(), sourceHash: 'x' }]) {
    assert.ok(!isMeetingLiveAccessRequest(invalid));
    await assert.rejects(checkMeetingSourceAccess(invalid, async () => { assert.fail('must not query'); }), /INVALID_SOURCE_ACCESS_REQUEST/);
  }
});
