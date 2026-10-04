import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingOutboxStore, MeetingOutboxError, type MeetingOutboxClaim } from './outbox.js';
import { hashPayload, sha256Text, type MeetingKnowledgeEvent } from './contract.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const workerId = '22222222-2222-4222-8222-222222222222';
const claim: MeetingOutboxClaim = {
  eventId: '33333333-3333-4333-8333-333333333333', eventSeq: 1, sourceId: 'synthetic-source', tenantId,
  integrationGeneration: 1, eventType: 'integration.disabled', snapshot: { record: {accessRevision:1} },
  leaseToken: '44444444-4444-4444-8444-444444444444', attempts: 1,
};
const payload = { lifecycleRevision: 1, reason: 'user-disabled' as const };
const event: MeetingKnowledgeEvent = { schemaVersion: 1, sourceApp: 'meeting-note', eventId: claim.eventId,
  eventSeq: claim.eventSeq, tenantId, sourceId: claim.sourceId, integrationGeneration: 1,
  eventType: 'integration.disabled', payload, payloadHash: hashPayload(payload) };
const failure = (error: unknown) => error instanceof MeetingOutboxError && error.message === 'OUTBOX_UNAVAILABLE';

test('claim accepts the exact nine-field SQL DTO and supplies bounded lease args', async () => {
  const store = createMeetingOutboxStore({ rpc: async (name,args) => {
    assert.equal(name,'meeting_knowledge_outbox_claim');
    assert.deepEqual(args,{p_tenant_id:tenantId,p_worker_id:workerId,p_limit:2,p_lease_seconds:60});
    return {data:[claim],error:null};
  } });
  assert.deepEqual(await store.claim(tenantId,workerId),[claim]);
});
test('claim permits an empty durable queue', async () => {
  assert.deepEqual(await createMeetingOutboxStore({rpc:async()=>({data:[],error:null})}).claim(tenantId,workerId),[]);
});
test('claim accepts two distinct events within the batch lease budget',async()=>{
  const second={...claim,eventId:'33333333-3333-4333-8333-333333333334',eventSeq:2};
  assert.deepEqual(await createMeetingOutboxStore({rpc:async()=>({data:[claim,second],error:null})}).claim(tenantId,workerId),[claim,second]);
});
for(const [name, data] of Object.entries({
  foreignTenant:[{...claim,tenantId:workerId}], duplicate:[claim,claim], oversized:[claim,
    {...claim,eventId:'33333333-3333-4333-8333-333333333334',eventSeq:2},
    {...claim,eventId:'33333333-3333-4333-8333-333333333335',eventSeq:3}],
  invalidSequence:[{...claim,eventSeq:0}], unsafeSequence:[{...claim,eventSeq:Number.MAX_SAFE_INTEGER+1}],
  invalidLease:[{...claim,leaseToken:'name'}], missingSnapshot:[{...claim,snapshot:null}],
  unknownEvent:[{...claim,eventType:'units.upsert'}], extra:[{...claim,secret:'not-authoritative'}],
  invalidAttempts:[{...claim,attempts:0}], missingData:null,
})) {
  test(`claim refuses untrusted ${name} result`,async()=>{
    await assert.rejects(createMeetingOutboxStore({rpc:async()=>({data,error:null})}).claim(tenantId,workerId),failure);
  });
}
test('invalid tenant/worker never invokes RPC',async()=>{
  const store=createMeetingOutboxStore({rpc:()=>assert.fail('invalid identity reached SQL')});
  await assert.rejects(store.claim('named-tenant',workerId),failure);
  await assert.rejects(store.claim(tenantId,'named-worker'),failure);
});
test('prepare fences lease and submits the exact schema-valid event',async()=>{
  const store=createMeetingOutboxStore({rpc:async(name,args)=>{
    assert.equal(name,'meeting_knowledge_outbox_prepare');
    assert.deepEqual(args,{p_event_id:claim.eventId,p_worker_id:workerId,p_lease_token:claim.leaseToken,p_event:event});
    return {data:event,error:null};
  }});
  assert.deepEqual(await store.prepare(claim,workerId,event),event);
});
test('prepare represents expired/lost lease as null',async()=>{
  assert.equal(await createMeetingOutboxStore({rpc:async()=>({data:null,error:null})}).prepare(claim,workerId,event),null);
});
test('prepare returns the original sealed payload even when the new candidate differs',async()=>{
  const text='synthetic';const sourceHash=sha256Text(text);
  const sourceClaim:MeetingOutboxClaim={...claim,eventType:'source.upsert',snapshot:{record:{contentRevision:1,speakerRevision:1,sourceHash},plaintext:text}};
  const sourcePayload={contentRevision:1,speakerRevision:1,sourceHash,plaintext:text,title:'Synthetic',sourceUrl:'https://meeting.example.test/old',
    meetingAt:null,timezone:'UTC',spans:[{spanId:'synthetic-span',start:0,end:text.length,textHash:sourceHash}]};
  const original:MeetingKnowledgeEvent={...event,eventType:'source.upsert',payload:sourcePayload,payloadHash:hashPayload(sourcePayload)};
  const proposedPayload={...sourcePayload,sourceUrl:'https://meeting.example.test/new'};
  const candidate:MeetingKnowledgeEvent={...original,payload:proposedPayload,payloadHash:hashPayload(proposedPayload)};
  assert.deepEqual(await createMeetingOutboxStore({rpc:async()=>({data:original,error:null})}).prepare(sourceClaim,workerId,candidate),original);
});
test('prepare refuses a schema-valid lifecycle revision from another snapshot',async()=>{
  const revised={lifecycleRevision:2,reason:'user-disabled' as const};
  const tampered:MeetingKnowledgeEvent={...event,payload:revised,payloadHash:hashPayload(revised)};
  await assert.rejects(createMeetingOutboxStore({rpc:async()=>({data:tampered,error:null})}).prepare(claim,workerId,event),failure);
});
for(const [name,value] of Object.entries({
  tenant:{...event,tenantId:workerId}, source:{...event,sourceId:'other'}, sequence:{...event,eventSeq:2},
  generation:{...event,integrationGeneration:2}, eventId:{...event,eventId:workerId},
  hash:{...event,payloadHash:'a'.repeat(64)}, schema:{...event,schemaVersion:2},
})) {
  test(`prepare refuses ${name} on both proposed and stored envelopes`,async()=>{
    const noRpc=createMeetingOutboxStore({rpc:()=>assert.fail('bad candidate reached SQL')});
    await assert.rejects(noRpc.prepare(claim,workerId,value as MeetingKnowledgeEvent),failure);
    await assert.rejects(createMeetingOutboxStore({rpc:async()=>({data:value,error:null})}).prepare(claim,workerId,event),failure);
  });
}
test('ACK and failure bind event, worker and lease and expose only boolean status',async()=>{
  const calls:Array<{name:string,args:Record<string,unknown>}>=[];
  const store=createMeetingOutboxStore({rpc:async(name,args)=>{calls.push({name,args});return{data:false,error:null};}});
  assert.equal(await store.ack(claim,workerId,event.payloadHash),false);
  assert.equal(await store.fail(claim,workerId,'DELIVERY_FAILED'),false);
  assert.deepEqual(calls,[
    {name:'meeting_knowledge_outbox_ack',args:{p_event_id:claim.eventId,p_worker_id:workerId,p_lease_token:claim.leaseToken,p_payload_hash:event.payloadHash}},
    {name:'meeting_knowledge_outbox_fail',args:{p_event_id:claim.eventId,p_worker_id:workerId,p_lease_token:claim.leaseToken,p_error_code:'DELIVERY_FAILED'}},
  ]);
});
test('ACK/error inputs and malformed SQL statuses fail closed',async()=>{
  const store=createMeetingOutboxStore({rpc:async()=>({data:'private upstream detail',error:null})});
  await assert.rejects(store.ack(claim,workerId,'not-a-hash'),failure);
  await assert.rejects(store.ack(claim,workerId,event.payloadHash),failure);
  await assert.rejects(store.fail(claim,workerId,'CONFIG_UNAVAILABLE'),failure);
  await assert.rejects(store.fail(claim,workerId,'private-code' as 'DELIVERY_FAILED'),failure);
});
test('RPC failures never expose upstream secrets',async()=>{
  for(const rpc of [async()=>({data:null,error:{message:'private secret'}}),async()=>{throw new Error('private secret');}]) {
    await assert.rejects(createMeetingOutboxStore({rpc}).claim(tenantId,workerId),failure);
  }
});
