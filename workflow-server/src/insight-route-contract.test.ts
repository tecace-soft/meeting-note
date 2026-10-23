import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowFixture, USER, OTHER, ADMIN } from './test-support/workflow.js';

test('T1-6 insight refresh and backfill retain authorization, ownership, bounds and failures',async(t)=>{
 const f=await workflowFixture();t.after(()=>f.close());t.mock.method(console,'error',()=>undefined);t.mock.method(console,'warn',()=>undefined);
 let note:any={id:'note',user_id:OTHER,shared_users:[USER],diarization:[{speaker:'Pat',text:'Named transcript.'}],transcription:'OLD transcript'};
 let batch:any[]=[];const limits:unknown[]=[];const previous=globalThis.fetch;
 t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const url=new URL(String(input));
  if(url.hostname==='supabase.invalid'&&url.pathname.endsWith('/note')&&(init?.method??'GET')==='GET')return Response.json(note);
  if(url.hostname==='supabase.invalid'&&url.pathname.endsWith('/rpc/notes_needing_insight')){limits.push(JSON.parse(String(init?.body)).p_limit);return Response.json(batch);}
  return previous(input,init);
 });
 await t.test('shared reader refreshes the owner insight from named labels without memory fold',async()=>{
  const r=await f.request('/refresh-note-insight',{body:{noteId:'note'}});assert.equal(r.status,200,r.text);assert.deepEqual(r.body,{ok:true,noteId:'note'});
  const write=f.state.calls.find(c=>c.url.pathname.endsWith('/note_insight')&&c.method==='POST');assert.equal(write?.body.user_id,OTHER);
  const ai=f.state.calls.find(c=>c.url.hostname==='generativelanguage.googleapis.com');assert.match(JSON.stringify(ai?.body),/Pat/);assert.ok(!JSON.stringify(ai?.body).includes('OLD transcript'));
  assert.ok(!f.state.calls.some(c=>c.url.pathname.endsWith('/user_memory')));
 });
 await t.test('validation, missing note, denied note and no transcript retain exact codes',async()=>{
  assert.equal((await f.request('/refresh-note-insight',{body:{}})).status,400);
  const original=note;note=null;assert.equal((await f.request('/refresh-note-insight',{body:{noteId:'note'}})).status,404);
  note={...original,shared_users:[]};assert.equal((await f.request('/refresh-note-insight',{body:{noteId:'note'}})).status,403);
  note={...original,diarization:[],transcription:' '};assert.equal((await f.request('/refresh-note-insight',{body:{noteId:'note'}})).status,422);note=original;
  assert.equal((await f.request('/refresh-note-insight?x=1',{body:{noteId:'note'}})).status,404);
 });
 await t.test('refresh extraction failure stays a 502',async()=>{f.state.aiFailure=true;assert.equal((await f.request('/refresh-note-insight',{body:{noteId:'note'}})).status,502);f.state.aiFailure=false;});
 await t.test('backfill admin gate and numeric limit contract are unchanged',async()=>{
  assert.equal((await f.request('/admin/backfill-insight',{body:{}})).status,403);f.state.caller=ADMIN;
  for(const limit of [undefined,0,-3,1000,3.9]){const r=await f.request('/admin/backfill-insight',{body:{limit}});assert.equal(r.status,200);assert.deepEqual(r.body,{processed:0,written:0,failed:0,sampleFailures:[]});}
  assert.deepEqual(limits,[25,25,1,50,3]);
 });
 await t.test('batch attribution and capped failure samples remain per-note',async()=>{
  batch=Array.from({length:6},(_,i)=>({id:'fixture-'+i,user_id:OTHER,transcription:'Fixture meeting.'}));f.state.calls.length=0;
  const r=await f.request('/admin/backfill-insight',{body:{limit:6}});assert.equal(r.status,200);assert.equal(r.body.written,6);assert.equal(r.body.failed,0);
  for(const call of f.state.calls.filter(c=>c.url.pathname.endsWith('/note_insight')&&c.method==='POST'))assert.equal(call.body.user_id,OTHER);
  f.state.aiFailure=true;const failed=await f.request('/admin/backfill-insight',{body:{limit:6}});assert.equal(failed.body.failed,6);assert.equal(failed.body.sampleFailures.length,5);
 });
});
