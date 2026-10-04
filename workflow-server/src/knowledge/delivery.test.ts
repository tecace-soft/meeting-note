import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMeetingOutboxEvent, createMeetingKnowledgeDelivery, MEETING_EVENT_MAX_BYTES, MEETING_RAW_SPAN_MAX_UTF16, MeetingDeliveryError, type MeetingDeliveryEnvironment } from './delivery.js';
import { canonicalJson, hashPayload, sha256Text, type MeetingKnowledgeEvent, type UnitsPayload } from './contract.js';
import type { MeetingSourceAccessRecord } from './source-access.js';
import type { MeetingOutboxClaim, MeetingOutboxStore, MeetingDeliveryErrorCode } from './outbox.js';

const tenantId='11111111-1111-4111-8111-111111111111';
const owner={tenantId,objectId:'22222222-2222-4222-8222-000000000001'};
const participant={tenantId,objectId:'22222222-2222-4222-8222-000000000002'};
const direct={tenantId,objectId:'22222222-2222-4222-8222-000000000003'};
const projected={tenantId,objectId:'22222222-2222-4222-8222-000000000004'};
const workerId='55555555-5555-4555-8555-555555555555';
const plaintext=' 원본\r\n😀 결정은 보류.\n ';
const record=():MeetingSourceAccessRecord=>({
  tenantId,sourceId:'synthetic-note',contentRevision:2,speakerRevision:3,accessRevision:4,sourceHash:sha256Text(plaintext),
  integrationGeneration:1,owner,ownerIdentityVerified:true,active:true,integrationEnabled:true,
  confirmedParticipants:[{identity:participant,confirmedBy:owner,verificationRef:'synthetic-owner-confirmation'}],
  directShares:[direct],noteProjectIds:['synthetic-project'],projects:[{projectId:'synthetic-project',owner,sharedWith:[projected]}],denies:[direct],
});
const claim=(eventType:MeetingOutboxClaim['eventType']='source.upsert'):MeetingOutboxClaim=>({
  eventId:'33333333-3333-4333-8333-333333333333',eventSeq:1,sourceId:'synthetic-note',tenantId,
  integrationGeneration:1,eventType,snapshot:{record:record(),plaintext,title:'Synthetic meeting',meetingAt:'2026-01-02T03:04:05Z'},
  leaseToken:'44444444-4444-4444-8444-444444444444',attempts:1,
});
const environment:MeetingDeliveryEnvironment={
  MEETING_KNOWLEDGE_DELIVERY_ENABLED:'true',MEETING_KNOWLEDGE_AXKH_URL:'https://axkh.example.test',
  MEETING_KNOWLEDGE_INGEST_KEY:'synthetic-ingest-key-for-offline-test-only',
  MEETING_KNOWLEDGE_ACCESS_KEY:'synthetic-access-key-for-offline-test-only',
  MEETING_KNOWLEDGE_TENANT_ID:tenantId,MEETING_KNOWLEDGE_NOTE_BASE_URL:'https://meeting.example.test',
  MEETING_KNOWLEDGE_TIMEZONE:'America/Los_Angeles',
};
const json=(value:unknown,init?:ResponseInit)=>new Response(JSON.stringify(value),{...init,headers:{'content-type':'application/json',...init?.headers}});
function fixture(items:MeetingOutboxClaim[]=[claim()]) {
  const prepared:MeetingKnowledgeEvent[]=[];const acknowledged:string[]=[];const failures:MeetingDeliveryErrorCode[]=[];
  let claimCalls=0;let sealed:MeetingKnowledgeEvent|null=null;
  const store:MeetingOutboxStore={
    async claim(tenant,worker){claimCalls++;assert.equal(tenant,tenantId);assert.equal(worker,workerId);return items;},
    async prepare(_item,_worker,event){sealed??=JSON.parse(canonicalJson(event));prepared.push(event);return sealed;},
    async ack(_item,_worker,hash){acknowledged.push(hash);return true;},
    async fail(_item,_worker,code){failures.push(code);return true;},
  };
  const bodies:MeetingKnowledgeEvent[]=[];
  const fetch:typeof globalThis.fetch=async(_url,init)=>{
    const event=JSON.parse(init?.body as string) as MeetingKnowledgeEvent;bodies.push(event);
    return json({eventId:event.eventId,eventSeq:event.eventSeq,payloadHash:event.payloadHash,status:'applied'});
  };
  return {store,fetch,bodies,prepared,acknowledged,failures,get claimCalls(){return claimCalls;}};
}
const failure=(code:MeetingDeliveryErrorCode)=>(error:unknown)=>error instanceof MeetingDeliveryError&&error.code===code&&error.message===code;

test('source envelope preserves raw UTF-16 text, whitespace/newlines and unchanged SHA256',()=>{
  const event=buildMeetingOutboxEvent(claim(),environment.MEETING_KNOWLEDGE_NOTE_BASE_URL!,'America/Los_Angeles');
  assert.equal(event.eventType,'source.upsert');if(event.eventType!=='source.upsert')assert.fail();
  assert.equal(event.payload.plaintext,plaintext);assert.equal(event.payload.sourceHash,sha256Text(plaintext));
  assert.equal(event.payload.spans[0].end,plaintext.length);assert.notEqual(plaintext.length,[...plaintext].length);
  assert.equal(event.payload.spans[0].textHash,sha256Text(plaintext));assert.equal(event.payloadHash,hashPayload(event.payload));
  assert.equal(event.payload.sourceUrl,'https://meeting.example.test/summary-history?note_id=synthetic-note');
  assert.equal(event.payload.meetingAt,'2026-01-02T03:04:05.000Z');
  assert.equal(event.payload.spans.length,1);
});
test('multilingual raw spans cover a long transcript exactly with per-substring hashes',()=>{
  const text=('한😀A\r\n中文e\u0301 ').repeat(1800);assert.ok(text.length>16_000);
  const item=claim();item.snapshot.plaintext=text;(item.snapshot.record as MeetingSourceAccessRecord).sourceHash=sha256Text(text);
  const event=buildMeetingOutboxEvent(item,'https://meeting.example.test','UTC');if(event.eventType!=='source.upsert')assert.fail();
  let offset=0;let reconstructed='';
  for(const span of event.payload.spans){
    assert.equal(span.start,offset);assert.ok(span.end>span.start);assert.ok(span.end-span.start<=MEETING_RAW_SPAN_MAX_UTF16);
    const slice=text.slice(span.start,span.end);assert.equal(span.textHash,sha256Text(slice));reconstructed+=slice;offset=span.end;
  }
  assert.equal(offset,text.length);assert.equal(reconstructed,text);assert.equal(event.payload.sourceHash,sha256Text(text));
  assert.equal(new Set(event.payload.spans.map(span=>span.spanId)).size,event.payload.spans.length);
});
test('raw span boundary moves before a surrogate pair exactly at the UTF-16 limit',()=>{
  const text='A'.repeat(7_999)+'😀'+'B'.repeat(8_000)+'🚀終';
  const item=claim();item.snapshot.plaintext=text;(item.snapshot.record as MeetingSourceAccessRecord).sourceHash=sha256Text(text);
  const event=buildMeetingOutboxEvent(item,'https://meeting.example.test','UTC');if(event.eventType!=='source.upsert')assert.fail();
  assert.equal(event.payload.spans[0].end,7_999);assert.equal(event.payload.spans[1].start,7_999);
  assert.equal(text.slice(event.payload.spans[1].start,event.payload.spans[1].start+2),'😀');
  for(const span of event.payload.spans){
    const before=text.charCodeAt(span.end-1);const after=text.charCodeAt(span.end);
    assert.ok(!(before>=0xd800&&before<=0xdbff&&after>=0xdc00&&after<=0xdfff));
  }
});
test('raw span identities are stable across speaker, ACL and metadata changes',()=>{
  const item=claim();const text='合意😀\n'.repeat(4000);item.snapshot.plaintext=text;
  const source=item.snapshot.record as MeetingSourceAccessRecord;source.sourceHash=sha256Text(text);
  const original=buildMeetingOutboxEvent(item,'https://meeting.example.test','UTC');if(original.eventType!=='source.upsert')assert.fail();
  source.speakerRevision++;source.accessRevision++;source.directShares=[];
  const revised=buildMeetingOutboxEvent(item,'https://changed.example.test','America/Los_Angeles');if(revised.eventType!=='source.upsert')assert.fail();
  assert.deepEqual(revised.payload.spans,original.payload.spans);
  source.contentRevision++;
  const newContent=buildMeetingOutboxEvent(item,'https://meeting.example.test','UTC');if(newContent.eventType!=='source.upsert')assert.fail();
  assert.ok(newContent.payload.spans.every((span,index)=>span.spanId!==original.payload.spans[index].spanId));
});
test('access envelope includes explicit confirmed/shared audience and denies, without implicit owner',()=>{
  const event=buildMeetingOutboxEvent(claim('access.changed'),'https://meeting.example.test','UTC');
  if(event.eventType!=='access.changed')assert.fail();
  assert.deepEqual(event.payload.grants.map(g=>[g.identity.objectId,g.kind]),[
    [participant.objectId,'participant'],[direct.objectId,'direct-share'],[projected.objectId,'project-share'],
  ]);
  assert.deepEqual(event.payload.denies,[direct]);
  assert.ok(event.payload.grants.every(g=>g.identity.objectId!==owner.objectId&&g.verification.authority==='meeting-note-server'));
});
test('grant dedupe retains different explicit grant kinds for the same person',()=>{
  const item=claim('access.changed');const source=item.snapshot.record as MeetingSourceAccessRecord;
  source.directShares=[direct,direct,participant];
  const event=buildMeetingOutboxEvent(item,'https://meeting.example.test','UTC');
  if(event.eventType!=='access.changed')assert.fail();
  assert.equal(event.payload.grants.filter(g=>g.identity.objectId===direct.objectId).length,1);
  assert.equal(event.payload.grants.filter(g=>g.identity.objectId===participant.objectId).length,2);
});
for(const type of ['source.deleted','integration.disabled'] as const) {
  test(`tombstone ${type} does not contain plaintext or audience`,()=>{
    const item=claim(type);const source=item.snapshot.record as MeetingSourceAccessRecord;source.active=false;source.integrationEnabled=false;
    const event=buildMeetingOutboxEvent(item,'https://meeting.example.test','UTC');
    assert.deepEqual(event.payload,{lifecycleRevision:4,reason:type==='source.deleted'?'source-deleted':'user-disabled'});
    assert.ok(!canonicalJson(event).includes(plaintext));
  });
}
for(const [name,mutate] of Object.entries({
  foreignTenant:(item:MeetingOutboxClaim)=>{(item.snapshot.record as MeetingSourceAccessRecord).tenantId=owner.objectId;},
  wrongSource:(item:MeetingOutboxClaim)=>{(item.snapshot.record as MeetingSourceAccessRecord).sourceId='different';},
  wrongGeneration:(item:MeetingOutboxClaim)=>{(item.snapshot.record as MeetingSourceAccessRecord).integrationGeneration=2;},
  unverifiedOwner:(item:MeetingOutboxClaim)=>{(item.snapshot.record as MeetingSourceAccessRecord).ownerIdentityVerified=false;},
  wrongHash:(item:MeetingOutboxClaim)=>{(item.snapshot.record as MeetingSourceAccessRecord).sourceHash='a'.repeat(64);},
  emptyText:(item:MeetingOutboxClaim)=>{item.snapshot.plaintext='';},
  absentText:(item:MeetingOutboxClaim)=>{delete item.snapshot.plaintext;},
  disabled:(item:MeetingOutboxClaim)=>{(item.snapshot.record as MeetingSourceAccessRecord).integrationEnabled=false;},
})) {
  test(`event builder rejects ${name} without disclosing source contents`,()=>{
    const item=claim();mutate(item);assert.throws(()=>buildMeetingOutboxEvent(item,'https://meeting.example.test','UTC'),failure('INVALID_SNAPSHOT'));
  });
}
test('access builder rejects non-owner confirmation, foreign audience and unrelated project',()=>{
  for(const mutate of [
    (source:MeetingSourceAccessRecord)=>{source.confirmedParticipants[0].confirmedBy=participant;},
    (source:MeetingSourceAccessRecord)=>{source.directShares=[{...direct,tenantId:owner.objectId}];},
    (source:MeetingSourceAccessRecord)=>{source.noteProjectIds=[];},
  ]){
    const item=claim('access.changed');mutate(item.snapshot.record as MeetingSourceAccessRecord);
    assert.throws(()=>buildMeetingOutboxEvent(item,'https://meeting.example.test','UTC'),failure('INVALID_SNAPSHOT'));
  }
});
test('delivery is default off even with absent/invalid other settings',async()=>{
  const f=fixture();const worker=createMeetingKnowledgeDelivery(f.store,{}, {workerId,fetch:f.fetch});
  assert.equal(worker.enabled,false);assert.deepEqual(await worker.runBatch(),{claimed:0,delivered:0,failed:0,lostLease:0});assert.equal(f.claimCalls,0);
});
for(const [name,settings] of Object.entries({
  reusedKey:{MEETING_KNOWLEDGE_INGEST_KEY:environment.MEETING_KNOWLEDGE_ACCESS_KEY},
  missingKey:{MEETING_KNOWLEDGE_INGEST_KEY:undefined},shortKey:{MEETING_KNOWLEDGE_INGEST_KEY:'short'},
  oversizedKey:{MEETING_KNOWLEDGE_INGEST_KEY:'x'.repeat(513)},badTenant:{MEETING_KNOWLEDGE_TENANT_ID:'email@example.test'},
  insecureURL:{MEETING_KNOWLEDGE_AXKH_URL:'http://axkh.example.test'},credentials:{MEETING_KNOWLEDGE_AXKH_URL:'https://key@axkh.example.test'},
  query:{MEETING_KNOWLEDGE_AXKH_URL:'https://axkh.example.test/?token=secret'},badTimezone:{MEETING_KNOWLEDGE_TIMEZONE:'invalid-zone'},
  insecureLink:{MEETING_KNOWLEDGE_NOTE_BASE_URL:'http://meeting.example.test'},
})) {
  test(`enabled delivery refuses ${name} configuration`,()=>{
    assert.throws(()=>createMeetingKnowledgeDelivery(fixture().store,{...environment,...settings},{workerId}),failure('CONFIG_UNAVAILABLE'));
  });
}
test('worker posts uncached exact sealed packet, then ACKs its hash',async()=>{
  const f=fixture();let options:RequestInit|undefined;let url:string|URL|Request|undefined;
  const fetch:typeof globalThis.fetch=async(input,init)=>{url=input;options=init;return f.fetch(input,init);};
  assert.deepEqual(await createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch}).runBatch(),{claimed:1,delivered:1,failed:0,lostLease:0});
  assert.equal(url,'https://axkh.example.test/api/integrations/meeting-note/v1/events');
  assert.equal(options?.redirect,'error');assert.equal(options?.cache,'no-store');assert.equal(options?.credentials,'omit');
  assert.equal((options?.headers as Record<string,string>).authorization,`Bearer ${environment.MEETING_KNOWLEDGE_INGEST_KEY}`);
  assert.equal(f.acknowledged[0],f.bodies[0].payloadHash);assert.equal(f.prepared.length,1);
});
test('delivery retries the immutable sealed packet despite changed source URL/timezone configuration',async()=>{
  const f=fixture();let attempts=0;
  const fetch:typeof globalThis.fetch=async(input,init)=>{attempts++;if(attempts===1){const event=JSON.parse(init?.body as string);f.bodies.push(event);return json({bad:'ack'});}return f.fetch(input,init);};
  const first=await createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch}).runBatch();assert.equal(first.failed,1);
  const second=await createMeetingKnowledgeDelivery(f.store,{...environment,MEETING_KNOWLEDGE_NOTE_BASE_URL:'https://changed.example.test',MEETING_KNOWLEDGE_TIMEZONE:'UTC'},{workerId,fetch}).runBatch();
  assert.equal(second.delivered,1);assert.deepEqual(f.bodies[1],f.bodies[0]);
  assert.notEqual(f.prepared[0].payloadHash,f.prepared[1].payloadHash);assert.equal(f.acknowledged[0],f.bodies[0].payloadHash);
});
test('lost prepare lease does not POST, ACK or reschedule a cancelled event',async()=>{
  const f=fixture();f.store.prepare=async()=>null;
  assert.deepEqual(await createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch:f.fetch}).runBatch(),{claimed:1,delivered:0,failed:0,lostLease:1});
  assert.equal(f.bodies.length,0);assert.equal(f.acknowledged.length,0);assert.equal(f.failures.length,0);
});
test('malformed stored seal is not posted even from an injected store',async()=>{
  const f=fixture();f.store.prepare=async(_item,_worker,event)=>({...event,payloadHash:'a'.repeat(64)});
  const stats=await createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch:f.fetch}).runBatch();
  assert.equal(stats.failed,1);assert.equal(f.bodies.length,0);assert.deepEqual(f.failures,['INVALID_SNAPSHOT']);
});
for(const field of ['contentRevision','speakerRevision','plaintext'] as const){
  test(`schema/hash-valid stored source seal cannot change snapshot ${field}`,async()=>{
    const f=fixture();f.store.prepare=async(_item,_worker,event)=>{
      if(event.eventType!=='source.upsert')assert.fail();
      const payload={...event.payload};
      if(field==='plaintext'){
        payload.plaintext='tampered synthetic text';payload.sourceHash=sha256Text(payload.plaintext);
        payload.spans=[{...payload.spans[0],end:payload.plaintext.length,textHash:payload.sourceHash}];
      }else payload[field]++;
      return {...event,payload,payloadHash:hashPayload(payload)};
    };
    const result=await createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch:f.fetch}).runBatch();
    assert.equal(result.failed,1);assert.equal(f.bodies.length,0);assert.deepEqual(f.failures,['INVALID_SNAPSHOT']);
  });
}
for(const eventType of ['access.changed','source.deleted','integration.disabled'] as const){
  test(`schema/hash-valid ${eventType} seal cannot change snapshot revision`,async()=>{
    const f=fixture([claim(eventType)]);f.store.prepare=async(_item,_worker,event)=>{
      if(event.eventType==='access.changed'){
        const payload={...event.payload,accessRevision:event.payload.accessRevision+1};return {...event,payload,payloadHash:hashPayload(payload)};
      }
      if(event.eventType==='source.deleted'||event.eventType==='integration.disabled'){
        const payload={...event.payload,lifecycleRevision:event.payload.lifecycleRevision+1};return {...event,payload,payloadHash:hashPayload(payload)} as MeetingKnowledgeEvent;
      }
      assert.fail();
    };
    assert.equal((await createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch:f.fetch}).runBatch()).failed,1);
    assert.equal(f.bodies.length,0);assert.deepEqual(f.failures,['INVALID_SNAPSHOT']);
  });
}
test('foreign tenant snapshot is never prepared or transmitted',async()=>{
  const f=fixture([{...claim(),tenantId:owner.objectId}]);
  assert.equal((await createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch:f.fetch}).runBatch()).failed,1);
  assert.equal(f.prepared.length,0);assert.equal(f.bodies.length,0);
});
test('overlarge source packet is retried as safe error without preparing or POST',async()=>{
  const item=claim();const text='x'.repeat(MEETING_EVENT_MAX_BYTES);item.snapshot.plaintext=text;
  (item.snapshot.record as MeetingSourceAccessRecord).sourceHash=sha256Text(text);
  const f=fixture([item]);const result=await createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch:f.fetch}).runBatch();
  assert.equal(result.failed,1);assert.deepEqual(f.failures,['PAYLOAD_TOO_LARGE']);assert.equal(f.prepared.length,0);assert.equal(f.bodies.length,0);
});
test('concurrent batches on the same worker cannot duplicate a claimed delivery',async()=>{
  const f=fixture();let unblock!:()=>void;const pending=new Promise<void>(resolve=>{unblock=resolve;});
  const originalClaim=f.store.claim;f.store.claim=async(tenant,worker)=>{await pending;return originalClaim(tenant,worker);};
  const worker=createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch:f.fetch});const batch=worker.runBatch();
  assert.deepEqual(await worker.runBatch(),{claimed:0,delivered:0,failed:0,lostLease:0});unblock();assert.equal((await batch).delivered,1);assert.equal(f.claimCalls,1);
});
for(const [name,reply] of Object.entries({
  hash:{payloadHash:'a'.repeat(64)},sequence:{eventSeq:2},event:{eventId:owner.objectId},status:{status:'unknown'},extra:{secret:'private'},
})){
  test(`bad ACK ${name} leaves the packet retriable instead of acknowledging`,async()=>{
    const f=fixture();const fetch:typeof globalThis.fetch=async(_input,init)=>{
      const event=JSON.parse(init?.body as string);return json({eventId:event.eventId,eventSeq:event.eventSeq,payloadHash:event.payloadHash,status:'applied',...reply});
    };
    assert.equal((await createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch}).runBatch()).failed,1);
    assert.deepEqual(f.failures,['DELIVERY_FAILED']);assert.equal(f.acknowledged.length,0);
  });
}
for(const status of ['duplicate','ignored'] as const){
  test(`valid ${status} receipt ACKs durable delivery`,async()=>{
    const f=fixture();const fetch:typeof globalThis.fetch=async(_input,init)=>{const e=JSON.parse(init?.body as string);return json({eventId:e.eventId,eventSeq:e.eventSeq,payloadHash:e.payloadHash,status});};
    assert.equal((await createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch}).runBatch()).delivered,1);
  });
}
test('oversized chunked or declared ACKs are bounded and never acknowledge',async()=>{
  for(const response of [new Response('x'.repeat(16_385),{headers:{'content-type':'application/json'}}),json({}, {headers:{'content-length':'16385'}})]){
    const f=fixture();assert.equal((await createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch:async()=>response}).runBatch()).failed,1);
    assert.equal(f.acknowledged.length,0);assert.deepEqual(f.failures,['DELIVERY_FAILED']);
  }
});
test('HTTP rejection is content-free and lost ACK/failure leases are counted',async()=>{
  const f=fixture();const worker=createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch:async()=>json({error:'private diagnostic'},{status:401})});
  assert.equal((await worker.runBatch()).failed,1);assert.deepEqual(f.failures,['IMPORT_REJECTED']);
  f.store.ack=async()=>false;
  assert.equal((await createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch:f.fetch}).runBatch()).lostLease,1);
  f.store.fail=async()=>false;
  assert.equal((await worker.runBatch()).lostLease,1);
});
test('HTTP timeout aborts and retries without acknowledging',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture();let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
  const fetch:typeof globalThis.fetch=async(_input,init)=>{entered();return new Promise((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new Error('private timeout')),{once:true});});};
  const pending=createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch}).runBatch();await waiting;t.mock.timers.tick(5_000);
  assert.equal((await pending).failed,1);assert.deepEqual(f.failures,['DELIVERY_FAILED']);assert.equal(f.acknowledged.length,0);
});
test('stop aborts current HTTP work and future polling without discarding lease',async()=>{
  const f=fixture();let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
  const fetch:typeof globalThis.fetch=async(_input,init)=>{entered();return new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('abort')),{once:true}));};
  const worker=createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch});const pending=worker.runBatch();await waiting;worker.stop();
  assert.equal((await pending).delivered,0);assert.equal(f.failures.length,0);
  assert.deepEqual(await worker.runBatch(),{claimed:0,delivered:0,failed:0,lostLease:0});assert.equal(f.claimCalls,1);
});
function unitsItem():MeetingOutboxClaim{
  const item=claim();const sourceEvent=buildMeetingOutboxEvent(item,'https://meeting.example.test','UTC');if(sourceEvent.eventType!=='source.upsert')assert.fail();
  const payload:UnitsPayload={contentRevision:sourceEvent.payload.contentRevision,speakerRevision:sourceEvent.payload.speakerRevision,sourceHash:sourceEvent.payload.sourceHash,
    extractorRun:{runId:'66666666-6666-4666-8666-666666666666',model:'synthetic-model-v1',promptVersion:'meeting-candidates-v1'},
    units:[{unitId:'synthetic-candidate',text:'A pilot was proposed.',lifecycle:'candidate',epistemic:'reported',
      evidence:[{...sourceEvent.payload.spans[0],sourceId:item.sourceId,contentRevision:sourceEvent.payload.contentRevision,sourceHash:sourceEvent.payload.sourceHash}]}]};
  return{...item,eventId:'77777777-7777-4777-8777-777777777777',eventSeq:3,eventType:'units.upsert',snapshot:{
    record:{tenantId:item.tenantId,sourceId:item.sourceId,integrationGeneration:item.integrationGeneration,contentRevision:payload.contentRevision,
      speakerRevision:payload.speakerRevision,sourceHash:payload.sourceHash,accessRevision:4},sourceEvent,payload}};
}
test('units delivery builds only from persisted payload and exact source context with minimal binding',async()=>{
  const item=unitsItem();const built=buildMeetingOutboxEvent(item,'https://changed.example.test','America/Los_Angeles');
  assert.equal(built.eventType,'units.upsert');assert.deepEqual(built.payload,item.snapshot.payload);assert.equal(built.payloadHash,hashPayload(item.snapshot.payload));
  const f=fixture([item]);assert.equal((await createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch:f.fetch}).runBatch()).delivered,1);
  assert.deepEqual(f.bodies[0],built);assert.equal(f.acknowledged[0],built.payloadHash);
});
test('units delivery rejects absent source context or mismatched original evidence without POST',async()=>{
  for(const mutate of [
    (item:MeetingOutboxClaim)=>{delete item.snapshot.sourceEvent;},
    (item:MeetingOutboxClaim)=>{(item.snapshot.payload as UnitsPayload).units[0].evidence[0].end--;},
  ]){
    const item=unitsItem();mutate(item);const f=fixture([item]);
    assert.equal((await createMeetingKnowledgeDelivery(f.store,environment,{workerId,fetch:f.fetch}).runBatch()).failed,1);
    assert.equal(f.bodies.length,0);assert.deepEqual(f.failures,['INVALID_SNAPSHOT']);
  }
});
