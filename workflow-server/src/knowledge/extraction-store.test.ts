import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingExtractionStore, MeetingExtractionStoreError, type MeetingExtractionClaim } from './extraction-store.js';
import { extractMeetingCandidates, type ExtractionResult } from './extraction.js';
import { hashPayload, sha256Text, type SourceUpsertEvent } from './contract.js';

const tenantId='11111111-1111-4111-8111-111111111111';const workerId='22222222-2222-4222-8222-222222222222';
const jobId='33333333-3333-4333-8333-333333333333';const model='synthetic-model-v1';const text='Synthetic pilot proposed.😀';
const sourcePayload={contentRevision:1,speakerRevision:2,sourceHash:sha256Text(text),plaintext:text,title:'Synthetic',
  sourceUrl:'https://meeting.example.test',meetingAt:null,timezone:'UTC',spans:[{spanId:'synthetic-span',start:0,end:text.length,textHash:sha256Text(text)}]};
const source:SourceUpsertEvent={schemaVersion:1,eventId:'55555555-5555-4555-8555-555555555555',eventSeq:2,
  integrationGeneration:1,sourceApp:'meeting-note',sourceId:'synthetic-source',tenantId,eventType:'source.upsert',payload:sourcePayload,payloadHash:hashPayload(sourcePayload)};
const claim:MeetingExtractionClaim={jobId,tenantId,sourceId:source.sourceId,integrationGeneration:1,sourceEvent:source,
  leaseToken:'44444444-4444-4444-8444-444444444444',attempts:1};
const error=(value:unknown)=>value instanceof MeetingExtractionStoreError&&value.message==='EXTRACTION_STORE_UNAVAILABLE';
const result=()=>extractMeetingCandidates(source,{authorizeModel:async()=>true,isCurrent:async()=>true,generate:async()=>({
  text:JSON.stringify({candidates:[{text:'A pilot was proposed.',factType:'proposal',speechAct:'proposal',epistemic:'reported',spanIds:['synthetic-span']}]}),model,finishReason:'stop',
})},{runId:jobId,model,maxChunks:16});

test('claim scopes tenant and worker and accepts one exact seven-field job',async()=>{
  const store=createMeetingExtractionStore({rpc:async(name,args)=>{
    assert.equal(name,'meeting_knowledge_extraction_claim');assert.deepEqual(args,{p_tenant_id:tenantId,p_worker_id:workerId});return{data:[claim],error:null};
  }});assert.deepEqual(await store.claim(tenantId,workerId),[claim]);
});
test('claim permits an empty queue',async()=>{
  assert.deepEqual(await createMeetingExtractionStore({rpc:async()=>({data:[],error:null})}).claim(tenantId,workerId),[]);
});
test('oversized completion reports only the safe hold code',async()=>{
  const store=createMeetingExtractionStore({rpc:async()=>({data:null,error:{code:'P0001',message:'EXTRACTION_PAYLOAD_TOO_LARGE'}})});
  await assert.rejects(store.complete(claim,workerId,await result()),value=>value instanceof MeetingExtractionStoreError&&value.code==='PAYLOAD_TOO_LARGE'&&value.message==='EXTRACTION_PAYLOAD_TOO_LARGE');
});
for(const [name,data] of Object.entries({
  tenant:[{...claim,tenantId:workerId}],source:[{...claim,sourceId:'other'}],generation:[{...claim,integrationGeneration:2}],
  lease:[{...claim,leaseToken:'named'}],attempts:[{...claim,attempts:0}],extra:[{...claim,private:'value'}],
  twoJobs:[claim,{...claim,jobId:workerId}],badSource:[{...claim,sourceEvent:{...source,payloadHash:'a'.repeat(64)}}],
}))test(`claim rejects ${name} without leaking upstream data`,async()=>{
  await assert.rejects(createMeetingExtractionStore({rpc:async()=>({data,error:null})}).claim(tenantId,workerId),error);
});
test('invalid identities never reach SQL',async()=>{
  const store=createMeetingExtractionStore({rpc:()=>assert.fail('invalid identity reached SQL')});
  await assert.rejects(store.claim('email@example.test',workerId),error);await assert.rejects(store.current(claim,'worker-name'),error);
});
test('current and failure RPCs bind job, worker and lease token',async()=>{
  const calls:Array<{name:string,args:Record<string,unknown>}>=[];
  const store=createMeetingExtractionStore({rpc:async(name,args)=>{calls.push({name,args});return{data:false,error:null};}});
  assert.equal(await store.current(claim,workerId),false);assert.equal(await store.fail(claim,workerId,'POLICY_UNAVAILABLE'),false);
  assert.deepEqual(calls,[
    {name:'meeting_knowledge_extraction_current',args:{p_job_id:jobId,p_worker_id:workerId,p_lease_token:claim.leaseToken}},
    {name:'meeting_knowledge_extraction_fail',args:{p_job_id:jobId,p_worker_id:workerId,p_lease_token:claim.leaseToken,p_error_code:'POLICY_UNAVAILABLE'}},
  ]);
});
test('complete submits exact source-bound candidates, complete coverage and provenance',async()=>{
  const extracted=await result();const store=createMeetingExtractionStore({rpc:async(name,args)=>{
    assert.equal(name,'meeting_knowledge_extraction_complete');assert.deepEqual(args,{p_job_id:jobId,p_worker_id:workerId,p_lease_token:claim.leaseToken,
      p_payload:extracted.payload,p_coverage:extracted.coverage,p_run:extracted.run});return{data:true,error:null};
  }});assert.equal(await store.complete(claim,workerId,extracted),true);
});
const mutations:Record<string,(value:ExtractionResult)=>void>={
  wrongRunId:r=>{r.run.runId=workerId;},inputHash:r=>{r.run.inputHash='a'.repeat(64);},runModel:r=>{r.run.model='another-model';},
  unsafeCalls:r=>{r.run.calls=65;},unsafeUsage:r=>{r.run.usage.inputTokens=-1;},coverageGap:r=>{r.coverage[0].start=1;},
  incompleteCoverage:r=>{r.coverage[0].end--;},unknownSpan:r=>{r.coverage[0].sourceSpanIds=['nonexistent'];},
  wrongCounter:r=>{r.coverage[0].acceptedCandidates=0;},policyFailure:r=>{r.coverage[0].errorCode='POLICY_UNAVAILABLE';},
  cancelled:r=>{r.coverage[0].status='cancelled';},confirmed:r=>{r.payload.units[0].lifecycle='confirmed';},
  verified:r=>{r.payload.units[0].epistemic='verified';},wrongEvidence:r=>{r.payload.units[0].evidence[0].end--;},
};
for(const [name,mutate] of Object.entries(mutations))test(`complete rejects ${name} before RPC`,async()=>{
  const extracted=await result();mutate(extracted);const store=createMeetingExtractionStore({rpc:()=>assert.fail('invalid result reached SQL')});
  await assert.rejects(store.complete(claim,workerId,extracted),error);
});
test('unknown failure codes and nonboolean RPC statuses fail closed',async()=>{
  const store=createMeetingExtractionStore({rpc:async()=>({data:'private database diagnostic',error:null})});
  await assert.rejects(store.current(claim,workerId),error);
  await assert.rejects(store.fail(claim,workerId,'private-error' as 'POLICY_DENIED'),error);
});
test('RPC throws and SQL errors expose no secrets',async()=>{
  for(const rpc of [async()=>({data:null,error:{message:'private secret'}}),async()=>{throw new Error('private secret');}])
    await assert.rejects(createMeetingExtractionStore({rpc}).claim(tenantId,workerId),error);
});
test('RPC timeout bounds a transport that never settles',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
  const store=createMeetingExtractionStore({rpc:()=>{entered();return new Promise(()=>undefined);}});
  const pending=store.current(claim,workerId);await waiting;t.mock.timers.tick(5_000);await assert.rejects(pending,error);
});
