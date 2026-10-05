import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingExtractionWorker, MeetingExtractionWorkerError, type MeetingExtractionEnvironment } from './extraction-worker.js';
import { hashPayload, sha256Text, type SourceUpsertEvent } from './contract.js';
import type { ExtractionRequest, ExtractionResult } from './extraction.js';
import { MeetingExtractionStoreError, type MeetingExtractionClaim, type MeetingExtractionFailureCode, type MeetingExtractionStore } from './extraction-store.js';

const tenantId='11111111-1111-4111-8111-111111111111';const workerId='22222222-2222-4222-8222-222222222222';
const jobId='33333333-3333-4333-8333-333333333333';const model='synthetic-model-v1';
const environment:MeetingExtractionEnvironment={MEETING_KNOWLEDGE_EXTRACTION_ENABLED:'true',MEETING_KNOWLEDGE_TENANT_ID:tenantId,MEETING_KNOWLEDGE_EXTRACTION_MODEL:model};
function source(parts=['A pilot was proposed.😀']):SourceUpsertEvent{
  let start=0;const spans=parts.map((text,index)=>{const span={spanId:`synthetic-${index}`,start,end:start+text.length,textHash:sha256Text(text)};start=span.end;return span;});
  const plaintext=parts.join('');const payload={contentRevision:1,speakerRevision:2,sourceHash:sha256Text(plaintext),plaintext,title:'Synthetic',sourceUrl:'https://meeting.example.test',meetingAt:null,timezone:'UTC',spans};
  return{schemaVersion:1,eventId:'55555555-5555-4555-8555-555555555555',eventSeq:2,integrationGeneration:1,sourceApp:'meeting-note',sourceId:'synthetic-source',tenantId,eventType:'source.upsert',payload,payloadHash:hashPayload(payload)};
}
function fixture(currentSource=source()){
  const claim:MeetingExtractionClaim={jobId,tenantId,sourceId:currentSource.sourceId,integrationGeneration:1,sourceEvent:currentSource,leaseToken:'44444444-4444-4444-8444-444444444444',attempts:1};
  const completed:ExtractionResult[]=[];const failures:MeetingExtractionFailureCode[]=[];let claims=0;let renewals=0;let models=0;let policies=0;
  const store:MeetingExtractionStore={
    async beginProviderAttempt(){return true;},
    async claim(tenant,worker){claims++;assert.equal(tenant,tenantId);assert.equal(worker,workerId);return[claim];},
    async current(item,worker){renewals++;assert.equal(item.jobId,jobId);assert.equal(worker,workerId);return true;},
    async complete(_item,_worker,result){completed.push(result);return true;},async fail(_item,_worker,code){failures.push(code);return true;},
  };
  const generate=async(request:ExtractionRequest)=>{models++;return {model,finishReason:'stop',text:JSON.stringify({candidates:[{
    text:'A pilot was proposed.',factType:'proposal',speechAct:'proposal',epistemic:'reported',spanIds:[request.chunk.sourceSpanIds[0]],
  }]})};};
  const authorizeModel=async()=>{policies++;return true;};
  return{store,claim,completed,failures,generate,authorizeModel,get claims(){return claims;},get renewals(){return renewals;},get models(){return models;},get policies(){return policies;}};
}
test('worker default off never claims or calls a model even with missing other settings',async()=>{
  const f=fixture();const worker=createMeetingExtractionWorker(f.store,{}, {...f,workerId});
  assert.equal(worker.enabled,false);assert.deepEqual(await worker.processOnce(),{claimed:0,completed:0,failed:0,lostLease:0});assert.equal(f.claims,0);assert.equal(f.models,0);
});
for(const [name,settings] of Object.entries({
  noTenant:{MEETING_KNOWLEDGE_TENANT_ID:undefined},badTenant:{MEETING_KNOWLEDGE_TENANT_ID:'name'},
  noModel:{MEETING_KNOWLEDGE_EXTRACTION_MODEL:undefined},badModel:{MEETING_KNOWLEDGE_EXTRACTION_MODEL:'model\nsecret'},
  tooManyChunks:{MEETING_KNOWLEDGE_EXTRACTION_MAX_CHUNKS:'65'},zeroChunks:{MEETING_KNOWLEDGE_EXTRACTION_MAX_CHUNKS:'0'},
  fractionalChunks:{MEETING_KNOWLEDGE_EXTRACTION_MAX_CHUNKS:'1.5'},
}))test(`worker enabled configuration rejects ${name}`,()=>{
  const f=fixture();assert.throws(()=>createMeetingExtractionWorker(f.store,{...environment,...settings},{...f,workerId}),error=>error instanceof MeetingExtractionWorkerError&&error.message==='CONFIG_UNAVAILABLE');
});
test('worker renews current state, gates before model and commits candidates with provenance',async()=>{
  const f=fixture();assert.deepEqual(await createMeetingExtractionWorker(f.store,environment,{...f,workerId}).processOnce(),{claimed:1,completed:1,failed:0,lostLease:0});
  assert.equal(f.models,1);assert.ok(f.policies>=2);assert.ok(f.renewals>=4);assert.equal(f.completed[0].payload.extractorRun.runId,jobId);
  assert.equal(f.completed[0].payload.units[0].lifecycle,'candidate');assert.equal(f.completed[0].run.inputHash,hashPayload(f.claim.sourceEvent));
});
test('empty queue does not call policy or provider',async()=>{
  const f=fixture();f.store.claim=async()=>[];
  assert.equal((await createMeetingExtractionWorker(f.store,environment,{...f,workerId}).processOnce()).claimed,0);assert.equal(f.models,0);assert.equal(f.policies,0);
});
test('oversized completion preserves the job with an explicit operator hold instead of repeating model calls',async()=>{
  const f=fixture();f.store.complete=async()=>{throw new MeetingExtractionStoreError('PAYLOAD_TOO_LARGE');};
  assert.equal((await createMeetingExtractionWorker(f.store,environment,{...f,workerId}).processOnce()).failed,1);
  assert.deepEqual(f.failures,['PAYLOAD_TOO_LARGE']);assert.equal(f.models,1);assert.equal(f.completed.length,0);
});
for(const code of ['POLICY_DENIED','POLICY_UNAVAILABLE'] as const)test(`${code} retries without erasing earlier safe units`,async()=>{
  const f=fixture();const authorizeModel=async()=>{if(code==='POLICY_UNAVAILABLE')throw new Error('private policy diagnostic');return false;};
  assert.equal((await createMeetingExtractionWorker(f.store,environment,{...f,workerId,authorizeModel}).processOnce()).failed,1);
  assert.equal(f.models,0);assert.equal(f.completed.length,0);assert.deepEqual(f.failures,[code]);assert.equal(f.claims,1);
});
test('current-source failure aborts work and keeps the pending job without completion',async()=>{
  const f=fixture();f.store.current=async()=>{throw new Error('private database failure');};
  assert.equal((await createMeetingExtractionWorker(f.store,environment,{...f,workerId}).processOnce()).failed,1);
  assert.equal(f.models,0);assert.equal(f.completed.length,0);assert.deepEqual(f.failures,['CURRENT_UNAVAILABLE']);
});
test('source becoming stale after provider response discards candidates',async()=>{
  const f=fixture();let calls=0;f.store.current=async()=>++calls===1;
  assert.equal((await createMeetingExtractionWorker(f.store,environment,{...f,workerId}).processOnce()).failed,1);
  assert.equal(f.models,1);assert.equal(f.completed.length,0);assert.deepEqual(f.failures,['SOURCE_STALE']);
});
test('ordinary model failure completes with explicit raw fallback coverage',async()=>{
  const f=fixture();const generate=async()=>{throw new Error('private model failure');};
  assert.equal((await createMeetingExtractionWorker(f.store,environment,{...f,workerId,generate}).processOnce()).completed,1);
  assert.equal(f.completed[0].payload.units.length,0);assert.equal(f.completed[0].coverage[0].errorCode,'MODEL_FAILED');assert.equal(f.completed[0].coverage[0].rawFallback,true);
});
test('partial model failure preserves earlier candidates and coverage for failed chunks',async()=>{
  const f=fixture(source(['a'.repeat(8000),'b'.repeat(8000)]));let calls=0;
  const generate=async(request:ExtractionRequest)=>{if(++calls===2)throw new Error('provider failure');return f.generate(request);};
  assert.equal((await createMeetingExtractionWorker(f.store,environment,{...f,workerId,generate}).processOnce()).completed,1);
  assert.equal(f.completed[0].payload.units.length,1);assert.deepEqual(f.completed[0].coverage.map(c=>c.status),['success','failed']);
});
test('default16-chunk operating budget retains complete skipped remainder coverage',async()=>{
  const f=fixture(source(Array.from({length:18},()=> 'a'.repeat(8000))));
  assert.equal((await createMeetingExtractionWorker(f.store,environment,{...f,workerId}).processOnce()).completed,1);
  const result=f.completed[0];assert.equal(f.models,16);assert.equal(result.coverage.length,17);
  assert.equal(result.coverage[16].status,'skipped');assert.equal(result.coverage[16].errorCode,'LIMIT_REACHED');assert.equal(result.coverage[16].rawFallback,true);
  assert.equal(result.coverage.at(-1)?.end,f.claim.sourceEvent.payload.plaintext.length);
});
test('policy revoked at final gate does not publish the core emptied result',async()=>{
  const f=fixture();let checks=0;const authorizeModel=async()=>++checks===1;
  assert.equal((await createMeetingExtractionWorker(f.store,environment,{...f,workerId,authorizeModel}).processOnce()).failed,1);
  assert.equal(f.models,1);assert.equal(f.completed.length,0);assert.deepEqual(f.failures,['POLICY_DENIED']);
});
test('lost atomic completion lease is counted without a second model run',async()=>{
  const f=fixture();f.store.complete=async()=>false;
  assert.equal((await createMeetingExtractionWorker(f.store,environment,{...f,workerId}).processOnce()).lostLease,1);assert.equal(f.models,1);assert.equal(f.failures.length,0);
});
test('concurrent processOnce calls cannot duplicate a job',async()=>{
  const f=fixture();let entered!:()=>void;let release!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});const blocked=new Promise<void>(resolve=>{release=resolve;});
  const generate=async(request:ExtractionRequest)=>{entered();await blocked;return f.generate(request);};
  const worker=createMeetingExtractionWorker(f.store,environment,{...f,workerId,generate});const pending=worker.processOnce();await waiting;
  assert.deepEqual(await worker.processOnce(),{claimed:0,completed:0,failed:0,lostLease:0});release();assert.equal((await pending).completed,1);assert.equal(f.claims,1);
});
test('heartbeat failure aborts an in-flight provider and discards its result',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});const f=fixture();let renewals=0;f.store.current=async()=>++renewals===1;
  let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});let aborted=false;
  const generate=async(request:ExtractionRequest)=>{entered();return new Promise<never>((_resolve,reject)=>request.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('abort'));},{once:true}));};
  const pending=createMeetingExtractionWorker(f.store,environment,{...f,workerId,generate}).processOnce();await waiting;t.mock.timers.tick(15_000);
  assert.equal((await pending).failed,1);assert.equal(aborted,true);assert.equal(f.completed.length,0);assert.deepEqual(f.failures,['SOURCE_STALE']);
});
test('heartbeat RPC deadline aborts the model even when a store ignores cancellation and never settles',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});const f=fixture();let renewals=0;
  let heartbeatEntered!:()=>void;const heartbeatWaiting=new Promise<void>(resolve=>{heartbeatEntered=resolve;});
  f.store.current=async()=>{if(++renewals===1)return true;heartbeatEntered();return new Promise<boolean>(()=>undefined);};
  let modelEntered!:()=>void;const modelWaiting=new Promise<void>(resolve=>{modelEntered=resolve;});let aborted=false;
  const generate=async(request:ExtractionRequest)=>{modelEntered();return new Promise<never>((_resolve,reject)=>request.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('abort'));},{once:true}));};
  const pending=createMeetingExtractionWorker(f.store,environment,{...f,workerId,generate}).processOnce();
  await modelWaiting;t.mock.timers.tick(15_000);await heartbeatWaiting;t.mock.timers.tick(5_000);
  assert.equal((await pending).failed,1);assert.equal(aborted,true);assert.equal(f.completed.length,0);assert.deepEqual(f.failures,['CURRENT_UNAVAILABLE']);
});
test('model deadline records timeout/raw fallback if all publication gates remain current',async()=>{
  const f=fixture();const generate=async()=>new Promise<never>(()=>undefined);
  assert.equal((await createMeetingExtractionWorker(f.store,environment,{...f,workerId,generate,modelTimeoutMs:10}).processOnce()).completed,1);
  assert.equal(f.completed[0].coverage[0].errorCode,'TIMEOUT');assert.equal(f.completed[0].coverage[0].rawFallback,true);
});
test('stop aborts the provider and leaves its durable lease for expiry',async()=>{
  const f=fixture();let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});let aborted=false;
  const generate=async(request:ExtractionRequest)=>{entered();return new Promise<never>((_resolve,reject)=>request.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('abort'));},{once:true}));};
  const worker=createMeetingExtractionWorker(f.store,environment,{...f,workerId,generate});const pending=worker.processOnce();await waiting;worker.stop();
  assert.equal((await pending).completed,0);assert.equal(aborted,true);assert.equal(f.completed.length,0);assert.equal(f.failures.length,0);
  assert.equal((await worker.processOnce()).claimed,0);
});

test('policy waiting does not consume provider budget and later approval resumes', async () => {
  const f=fixture(); let marks=0; let approved=false;
  f.store.beginProviderAttempt=async()=>{marks++;return true;};
  const worker=createMeetingExtractionWorker(f.store,environment,{...f,workerId,authorizeModel:async()=>approved});
  assert.equal((await worker.processOnce()).failed,1);assert.equal(marks,0);assert.equal(f.models,0);
  approved=true;assert.equal((await worker.processOnce()).completed,1);assert.equal(marks,1);assert.equal(f.models,1);
});
test('provider budget is charged once per leased run across multiple chunks', async () => {
  const f=fixture(source(['A '.repeat(4000),'B '.repeat(4000)]));let marks=0;
  f.store.beginProviderAttempt=async()=>{marks++;return true;};
  assert.equal((await createMeetingExtractionWorker(f.store,environment,{...f,workerId}).processOnce()).completed,1);
  assert.ok(f.models>=2);assert.equal(marks,1);
});
test('missing or exhausted durable provider budget prevents every paid model call', async () => {
  for(const missing of [true,false]) {
    const f=fixture();f.store.beginProviderAttempt=missing?undefined:async()=>false;
    assert.equal((await createMeetingExtractionWorker(f.store,environment,{...f,workerId}).processOnce()).failed,1);
    assert.equal(f.models,0);assert.equal(f.completed.length,0);assert.deepEqual(f.failures,['EXTRACTION_FAILED']);
  }
});
