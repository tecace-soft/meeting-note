import assert from 'node:assert/strict';
import test from 'node:test';
import { incidentFingerprint } from './opsAgent.js';
import { workflowFixture } from './test-support/workflow.js';

test('T1-3 ops incidents keep guards, dedupe, caps, owner metadata and non-throwing behavior',async(t)=>{
  // Only the fake DB ticket path is enabled. Real alerts stay disabled by preload.
  process.env.F9_OPS_AGENT_ENABLED='true';
  const f=await workflowFixture();t.after(()=>f.close());t.mock.method(console,'warn',()=>undefined);
  const {fileOpsIncident,raiseIncident}=await import('./ops/incidents.js');const {env}=await import('./config/env.js');
  const input={title:'fixture incident',error:new Error('fixture failure')};
  const fingerprint=incidentFingerprint(input.title,'Error','fixture failure');
  let rows:unknown[]=[];let count=0;let dbFail=false;let writes:{method:string;body:any}[]=[];let queries:URL[]=[];
  const previous=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const url=new URL(String(input));
    if(url.hostname==='supabase.invalid'&&url.pathname.endsWith('/feedback_issues')){
      queries.push(url);if(dbFail)return Response.json({message:'fixture DB failure'},{status:400});
      if(init?.method==='HEAD')return new Response(null,{headers:{'content-range':`0-0/${count}`}});
      if(init?.method==='POST'||init?.method==='PATCH'){writes.push({method:init.method,body:JSON.parse(String(init.body))});return Response.json(null);}
      return Response.json(rows);
    }
    return previous(input,init);
  });
  const reset=()=>{rows=[];count=0;dbFail=false;writes=[];queries=[];f.state.calls.length=0;f.state.aiFailure=false;};
  await t.test('dedupe is filtered server-side and only bumps existing ticket metadata',async()=>{
    reset();rows=[{id:'ticket',ai_suggestion:{source:'f9-ops-agent',fingerprint,occurrences:2,firstSeen:'t0',lastSeen:'t0',environment:'test',severity:'error'}}];
    await fileOpsIncident(input);assert.equal(writes.length,1);assert.equal(writes[0].method,'PATCH');
    assert.deepEqual(Object.keys(writes[0].body),['ai_suggestion']);assert.equal(writes[0].body.ai_suggestion.occurrences,3);
    assert.ok(queries.some(q=>q.searchParams.get('ai_suggestion->>fingerprint')==='eq.'+fingerprint));
    assert.ok(!f.state.calls.some(c=>c.url.hostname==='generativelanguage.googleapis.com'));
  });
  await t.test('new incident cap prevents inserts and RCA calls',async()=>{
    reset();count=10;await fileOpsIncident(input);assert.equal(writes.length,0);
    assert.ok(!f.state.calls.some(c=>c.url.hostname==='generativelanguage.googleapis.com'));
  });
  await t.test('new warning preserves metadata and RCA while never sending real mail',async()=>{
    reset();await fileOpsIncident({...input,severity:'warning'});
    assert.equal(writes.length,1);const row=writes[0].body;assert.equal(row.area,'ops');assert.equal(row.priority,'P3');assert.equal(row.severity,'Medium');
    assert.equal(row.ai_suggestion.occurrences,1);assert.equal(row.ai_suggestion.fingerprint,fingerprint);assert.equal(row.resolution.summary,'Fixture summary');
    assert.ok(!f.state.calls.some(c=>c.url.hostname==='api.resend.com'));
  });
  await t.test('RCA failure still files a ticket, DB failure is swallowed, missing DB is inert',async()=>{
    reset();f.state.aiFailure=true;await fileOpsIncident(input);assert.equal(writes[0].body.resolution,null);
    reset();dbFail=true;await assert.doesNotReject(fileOpsIncident(input));assert.equal(writes.length,0);
    reset();const url=env.supabaseUrl;env.supabaseUrl='';try{await fileOpsIncident(input);assert.equal(queries.length,0);}finally{env.supabaseUrl=url;}
  });
  await t.test('raiseIncident remains synchronous fire-and-forget on a failing boundary',async()=>{
    reset();dbFail=true;assert.equal(raiseIncident(input),undefined);
    for(let i=0;i<10;i++)await new Promise<void>(r=>setImmediate(r));
    assert.ok(queries.length>0);assert.equal(writes.length,0);
  });
});
