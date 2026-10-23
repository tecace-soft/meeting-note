import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowFixture, USER, OTHER, regenerateBody } from './test-support/workflow.js';

test('T1-8 regeneration keeps prompt ownership and attributes memory/insight to the note owner',async(t)=>{
 const f=await workflowFixture();t.after(()=>f.close());t.mock.method(console,'warn',()=>undefined);t.mock.method(console,'error',()=>undefined);
 const {parseRegenerateSummaryInput}=await import('./routes/regenerateSummary.js');
 const {loadSummaryPrompt,resolveSummaryPromptForAndroid,resolveRegenerateSummaryRules,DEFAULT_SUMMARY_PROMPT}=await import('./pipeline/promptLoaders.js');
 let selected:string|null=' selected ';let rows:any[]=[{name:'Default',prompt:' default ',created_at:'2026-02'},{name:'early',prompt:' first ',created_at:'2026-01'}];let promptError=false,missing=false,access=true,updateFail=false;
 const reads:URL[]=[];const previous=globalThis.fetch;
 t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const url=new URL(String(input)),table=url.pathname.split('/').pop();
  if(url.hostname==='supabase.invalid'&&(init?.method??'GET')==='GET'){
   reads.push(url);
   if(table==='summary_prompt'){
    if(promptError)return Response.json({message:'fixture prompt error'},{status:400});
    return Response.json(url.searchParams.has('id')?{prompt:selected}:rows);
   }
   if(table==='note')return Response.json(missing?null:{id:'fixture-note',user_id:OTHER,shared_users:access?[USER]:[]});
   if(table==='user_memory')return Response.json({memory:{version:2,items:[{text:'OWNER_ONLY_CONTEXT',status:'active',id:'memory',entities:[],createdAt:'2026-01-01',updatedAt:'2026-01-01',sourceNoteIds:[]}]},processed_note_ids:[]});
  }
  if(url.hostname==='supabase.invalid'&&table==='note'&&init?.method==='PATCH'&&updateFail)return Response.json({message:'fixture write failure'},{status:400});
  if(url.hostname==='generativelanguage.googleapis.com'){
   const payload=JSON.parse(String(init?.body));
   if(JSON.stringify(payload).includes('OPERATIONS (emit an ordered JSON array'))return Response.json({candidates:[{content:{parts:[{text:'[]'}]}}]});
  }
  return previous(input,init);
 });
 await t.test('parser retains normalized segments, numeric prompt id and validation errors',()=>{
  const parsed=parseRegenerateSummaryInput({...regenerateBody,promptId:7,previousSummary:' old ',diarization:[null,{speaker:' Pat ',speaker_key:'A',text:' words ',start:0}]});
  assert.equal(parsed.promptId,'7');assert.equal(parsed.previousSummary,'old');assert.deepEqual(parsed.segments,[{speaker:'Pat',speakerKey:'A',text:'words',start:0}]);
  assert.throws(()=>parseRegenerateSummaryInput({}),{message:'noteId is required.'});
  assert.throws(()=>parseRegenerateSummaryInput({noteId:'n'}),{message:'diarization must include at least one transcript segment.'});
 });
 await t.test('selected prompts remain requester scoped and Android default is unchanged',async()=>{
  assert.equal(await loadSummaryPrompt('p',USER),'selected');assert.equal(reads.at(-1)?.searchParams.get('user_id'),'eq.'+USER);
  assert.deepEqual(await resolveSummaryPromptForAndroid({userId:USER}),{promptId:'android-default',summaryRulesOverride:DEFAULT_SUMMARY_PROMPT});
  assert.deepEqual(await resolveSummaryPromptForAndroid({userId:USER,promptId:' p '}),{promptId:'p'});
  selected=null;await assert.rejects(loadSummaryPrompt('p',USER),{message:'Selected summary prompt was not found for this user.'});
 });
 await t.test('prompt fallback retains Default, earliest, then built-in order',async()=>{
  assert.equal(await resolveRegenerateSummaryRules('missing',USER),'default');
  rows=rows.filter(r=>r.name!=='Default');assert.equal(await resolveRegenerateSummaryRules(undefined,USER),'first');
  promptError=true;assert.equal(await resolveRegenerateSummaryRules(undefined,USER),DEFAULT_SUMMARY_PROMPT);promptError=false;selected=' request rules ';
 });
 await t.test('shared requester uses own rules but owner context, fold and insight',async()=>{
  f.state.calls.length=0;reads.length=0;
  const r=await f.request('/regenerate-summary',{body:{...regenerateBody,promptId:'p'}});assert.equal(r.status,200,r.text);assert.equal(r.body.summary,'Fixture summary');
  for(let i=0;i<100;i++){
   if(f.state.calls.some(c=>c.url.pathname.endsWith('/user_memory')&&c.method==='POST')&&f.state.calls.some(c=>c.url.pathname.endsWith('/note_insight')&&c.method==='POST'))break;
   await new Promise<void>(resolve=>setImmediate(resolve));
  }
  const ownerWrites=f.state.calls.filter(c=>(c.url.pathname.endsWith('/user_memory')||c.url.pathname.endsWith('/note_insight'))&&c.method==='POST');
  assert.equal(ownerWrites.length,2);for(const call of ownerWrites)assert.equal(call.body.user_id,OTHER);
  for(const read of reads.filter(q=>q.pathname.endsWith('/user_memory')))assert.equal(read.searchParams.get('user_id'),'eq.'+OTHER);
  assert.ok(reads.some(q=>q.pathname.endsWith('/summary_prompt')&&q.searchParams.get('user_id')==='eq.'+USER));
  const summary=f.state.calls.find(c=>c.url.hostname==='generativelanguage.googleapis.com');assert.match(JSON.stringify(summary?.body),/OWNER_ONLY_CONTEXT/);assert.match(JSON.stringify(summary?.body),/request rules/);
  assert.equal(f.state.calls.find(c=>c.url.pathname.endsWith('/workflow_usage'))?.body.user_id,USER);
 });
 await t.test('missing, denied, query path, AI and note-write errors retain statuses',async()=>{
  missing=true;assert.equal((await f.request('/regenerate-summary',{body:regenerateBody})).status,404);missing=false;
  access=false;assert.equal((await f.request('/regenerate-summary',{body:regenerateBody})).status,403);access=true;
  assert.equal((await f.request('/regenerate-summary?x=1',{body:regenerateBody})).status,404);
  f.state.aiFailure=true;assert.equal((await f.request('/regenerate-summary',{body:regenerateBody})).status,500);f.state.aiFailure=false;
  updateFail=true;assert.equal((await f.request('/regenerate-summary',{body:regenerateBody})).status,500);updateFail=false;
 });
});
