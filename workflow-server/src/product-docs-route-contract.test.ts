import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowFixture, USER, OTHER } from './test-support/workflow.js';

test('T1-4 product docs preserve tenant gate, token cache, paths and JSON',async(t)=>{
 const f=await workflowFixture();t.after(()=>f.close());t.mock.method(console,'error',()=>undefined);
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 const graphs=()=>f.state.calls.filter(c=>c.url.hostname==='graph.microsoft.com').length;
 await t.test('index and detail share one token cache until 60-second expiry',async()=>{
  assert.equal((await f.request('/product-docs?x=1',{method:'GET'})).status,200);
  assert.equal((await f.request('/product-docs/architecture?x=1',{method:'GET'})).status,200);
  assert.equal(graphs(),1);now+=59000;
  assert.equal((await f.request('/product-docs',{method:'GET'})).status,200);assert.equal(graphs(),1);
  now+=1001;assert.equal((await f.request('/product-docs',{method:'GET'})).status,200);assert.equal(graphs(),2);
 });
 await t.test('unknown slug and invalid path/method keep their original responses',async()=>{
  const r=await f.request('/product-docs/no-such-contract',{method:'GET'});assert.equal(r.status,404);assert.deepEqual(r.body,{error:'Unknown product doc.'});
  assert.equal((await f.request('/product-docs/UPPERCASE',{method:'GET'})).status,404);
  assert.equal((await f.request('/product-docs',{method:'POST'})).status,404);
  assert.equal((await f.request('/product-docs',{method:'GET',authenticated:false})).status,401);
 });
 await t.test('new tokens fail closed for an unconfigured or foreign tenant and rejected Graph token',async()=>{
  f.state.caller=OTHER;const allowed=process.env.ALLOWED_MS_TENANT_IDS;delete process.env.ALLOWED_MS_TENANT_IDS;
  try{assert.equal((await f.request('/product-docs',{method:'GET'})).status,403);}finally{process.env.ALLOWED_MS_TENANT_IDS=allowed;}
  f.state.tenant=OTHER;assert.equal((await f.request('/product-docs',{method:'GET'})).status,403);
  f.reset();f.state.caller=OTHER;f.state.graphStatus=503;assert.equal((await f.request('/product-docs',{method:'GET'})).status,401);f.reset();
 });
 await t.test('cache bound evicts the original token after 257 distinct validated tokens',async()=>{
  for(let i=1;i<=257;i++){
   f.state.caller=i.toString(16).padStart(8,'0')+'-4444-4444-8444-444444444444';
   assert.equal((await f.request('/product-docs/no-such-contract',{method:'GET'})).status,404);
  }
  const before=graphs();f.state.caller=USER;
  assert.equal((await f.request('/product-docs',{method:'GET'})).status,200);assert.equal(graphs(),before+1);
 });
});
