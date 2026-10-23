import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowFixture, USER, OTHER } from './test-support/workflow.js';
import { PROJECT_CHAT_MODEL, GEMINI_2_5_FLASH_LITE } from './gemini-models.js';

test('T1-7 project chat keeps per-note access, numeric ids, SSE framing and model order',async(t)=>{
 const f=await workflowFixture();t.after(()=>f.close());t.mock.method(console,'error',()=>undefined);
 const {parseProjectChatInput,projectChatContext,projectChatDelta}=await import('./routes/projectChat.js');
 const body={project_id:'0007',message:'Question'};let mode='ok';const calls:URL[]=[];const previous=globalThis.fetch;
 t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const url=new URL(String(input));calls.push(url);
  if(url.hostname==='supabase.invalid'&&url.pathname.endsWith('/project')&&url.searchParams.get('id')==='eq.0007')return Response.json(null);
  if(url.hostname==='generativelanguage.googleapis.com'){
   if(mode==='fail'||(mode==='fallback'&&url.pathname.includes(PROJECT_CHAT_MODEL)))return new Response('fixture unavailable',{status:400});
   if(url.pathname.endsWith(':streamGenerateContent')){
    const bytes=new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"가"},{"text":" A"}]}}]}\r\n\r\ndata: [DONE]\n\n');
    return new Response(new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));controller.close();}}));
   }
   return Response.json({candidates:[{content:{parts:[{text:'Answer'}]}}]});
  }
  return previous(input,init);
 });
 await t.test('pure parser and context formatting retain coercion, trimming and deltas',()=>{
  assert.deepEqual(parseProjectChatInput({project_id:'0007',message:' Q '}),{projectId:'0007',projectIdFilterValue:7,message:'Q'});
  assert.throws(()=>parseProjectChatInput({project_id:false,message:'Q'}),{message:'project_id is required.'});
  assert.equal(projectChatContext([{transcription:' t ',summary:' s '}]),'transcription1:\nt\n\nsummary1:\ns\n\n');
  assert.equal(projectChatDelta({candidates:[{content:{parts:[{text:'a'},{text:1},{text:'b'}]}}]}),'ab');
 });
 await t.test('numeric project fallback and service-role per-note visibility survive',async()=>{
  const r=await f.request('/project-chat',{body});assert.deepEqual(r.body,{response:'Answer'});
  assert.ok(calls.some(c=>c.pathname.endsWith('/project')&&c.searchParams.get('id')==='eq.0007'));
  assert.ok(calls.some(c=>c.pathname.endsWith('/project')&&c.searchParams.get('id')==='eq.7'));
  const notes=calls.find(c=>c.pathname.endsWith('/note'));assert.ok(notes?.searchParams.get('or')?.includes(USER));assert.ok(notes?.searchParams.get('projects')?.includes('7'));
 });
 await t.test('UTF-8 and CRLF split SSE retains exact headers and one done event',async()=>{
  const r=await f.request('/project-chat/stream',{body});assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'text/event-stream');assert.equal(r.headers.get('x-accel-buffering'),'no');
  assert.equal(r.headers.get('cache-control'),'no-cache, no-transform');assert.equal(r.text,'data: {"delta":""}\n\ndata: {"delta":"가 A"}\n\ndata: {"done":true}\n\n');
 });
 await t.test('stream fallback order stays primary then flash-lite',async()=>{
  calls.length=0;mode='fallback';assert.equal((await f.request('/project-chat/stream',{body})).status,200);
  assert.deepEqual(calls.filter(c=>c.pathname.endsWith(':streamGenerateContent')).map(c=>c.pathname.split('/').pop()?.split(':')[0]),[PROJECT_CHAT_MODEL,GEMINI_2_5_FLASH_LITE]);mode='ok';
 });
 await t.test('empty context skips AI, denied and failed dependencies preserve JSON statuses',async()=>{
  f.state.emptyNotes=true;calls.length=0;const empty=await f.request('/project-chat/stream',{body});assert.equal(empty.status,200);assert.ok(empty.text.endsWith('data: {"done":true}\n\n'));assert.ok(!calls.some(c=>c.hostname==='generativelanguage.googleapis.com'));f.state.emptyNotes=false;
  f.state.projectOwner=OTHER;assert.equal((await f.request('/project-chat/stream',{body})).status,403);f.state.projectOwner=USER;
  mode='fail';const failed=await f.request('/project-chat/stream',{body});assert.equal(failed.status,500);assert.equal(failed.headers.get('content-type'),'application/json');
  assert.equal((await f.request('/project-chat/stream?x=1',{body})).status,404);
 });
});
