import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowFixture, USER, OTHER } from './test-support/workflow.js';

test('T1-5 briefing keeps owner-only reads, bounded output, empty and failure contracts',async(t)=>{
 const f=await workflowFixture();t.after(()=>f.close());t.mock.method(console,'error',()=>undefined);
 const {coerceBriefingDecisions,coerceBriefingEvents}=await import('./routes/briefing.js');
 let empty=false,failed='';const queries:URL[]=[];const previous=globalThis.fetch;
 t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const url=new URL(String(input)),table=url.pathname.split('/').pop();
  if(url.hostname==='supabase.invalid'&&['user_memory','note','note_insight'].includes(table??'')){
   queries.push(url);if(table===failed)return Response.json({message:'fixture '+table+' failure'},{status:400});
   if(table==='user_memory')return Response.json({memory:{version:2,items:[{text:'active',updatedAt:'2026-01-01',entities:[]},{text:'old',status:'archived'}]}});
   if(table==='note')return Response.json(empty?[]:[{id:'n1',name:'  Meeting  ',created_at:'2026-01-01'},{id:'n2',name:'skip'}]);
   return Response.json([{note_id:'n1',decisions:Array.from({length:8},()=>({text:' decision ',rationale:' reason '})),events:[{cause:' cause ',effect:' effect '}]}]);
  }
  return previous(input,init);
 });
 await t.test('pure coercion keeps six entries and exact truncation semantics',()=>{
  assert.deepEqual(coerceBriefingDecisions(null),[]);assert.deepEqual(coerceBriefingEvents([{}]),[]);
  const result=coerceBriefingDecisions(Array.from({length:9},()=>({text:'x'.repeat(500)})));assert.equal(result.length,6);assert.equal(result[0].text.length,400);assert.equal(result[0].rationale,'');
  assert.deepEqual(coerceBriefingEvents([{cause:' x '}]),[{cause:'x',effect:''}]);
 });
 await t.test('query userId is ignored, reads are owner scoped and output shape is unchanged',async()=>{
  const r=await f.request('/meeting-briefing?userId='+OTHER,{method:'GET'});assert.equal(r.status,200);
  assert.deepEqual(Object.keys(r.body).sort(),['generatedAt','memoryItems','recent']);assert.equal(r.body.memoryItems.length,1);assert.equal(r.body.recent.length,1);
  assert.equal(r.body.recent[0].decisions.length,6);assert.equal(r.body.recent[0].noteName,'Meeting');assert.equal(r.body.recent[0].date,'2026-01-01');
  for(const q of queries.filter(q=>q.pathname.endsWith('/note')||q.pathname.endsWith('/user_memory')))assert.equal(q.searchParams.get('user_id'),'eq.'+USER);
  assert.ok(queries.some(q=>q.pathname.endsWith('/note')&&q.searchParams.get('limit')==='8'));
  assert.ok(queries.every(q=>!q.searchParams.get('select')?.includes('actions')));
  assert.ok(!f.state.calls.some(c=>c.url.hostname==='generativelanguage.googleapis.com'));
 });
 await t.test('no recent notes skips insight lookup',async()=>{
  empty=true;queries.length=0;const r=await f.request('/meeting-briefing',{method:'GET'});assert.equal(r.status,200);assert.deepEqual(r.body.recent,[]);assert.ok(!queries.some(q=>q.pathname.endsWith('/note_insight')));empty=false;
 });
 for(const table of ['user_memory','note','note_insight'])await t.test(table+' failure propagates as 500',async()=>{failed=table;assert.equal((await f.request('/meeting-briefing',{method:'GET'})).status,500);failed='';});
 await t.test('invalid Graph credentials and wrong method preserve status',async()=>{f.state.graphStatus=401;assert.equal((await f.request('/meeting-briefing',{method:'GET'})).status,401);assert.equal((await f.request('/meeting-briefing')).status,404);});
});
