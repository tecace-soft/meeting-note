import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowFixture, ADMIN, USER } from './test-support/workflow.js';

test('T1-2 issues preserve methods, validation, triage, notification and parser contracts', async (t) => {
  const f = await workflowFixture(); t.after(() => f.close());
  t.mock.method(console, 'error', () => undefined);
  const { parseIssueResolution, issueDeepLink } = await import('./index.js');
  await t.test('lenient ops parser and shared link retain their exact behavior', () => {
    assert.equal(parseIssueResolution('{}'), null); assert.equal(parseIssueResolution('invalid'), null);
    assert.deepEqual(parseIssueResolution('```json\n{"summary":" x ","rootCauses":[" a ",1],"confidence":"HIGH"}\n```'), { summary: 'x', rootCauses: ['a'], checks: [], fixPlan: [], verification: [], confidence: 'high' });
    const old = process.env.APP_FRONTEND_ORIGIN; process.env.APP_FRONTEND_ORIGIN='https://first.invalid/,https://second.invalid';
    try { assert.equal(issueDeepLink('a b'), 'https://first.invalid/issues?issue=a%20b'); }
    finally { if (old === undefined) delete process.env.APP_FRONTEND_ORIGIN; else process.env.APP_FRONTEND_ORIGIN=old; }
  });
  await t.test('resolution matches pathname with query and rejects methods before auth', async () => {
    assert.deepEqual((await f.request('/issue-resolution?x=1',{method:'GET',authenticated:false})).body,{error:'POST 요청만 받습니다.'});
    assert.equal((await f.request('/issue-resolution',{method:'GET'})).status,405);
    assert.equal((await f.request('/issue-resolution',{body:{title:'a',description:'b'}})).status,403);
    f.state.caller=ADMIN;
    assert.equal((await f.request('/issue-resolution',{body:{}})).status,400);
    const r=await f.request('/issue-resolution?x=1',{body:{title:'Fixture',description:'Details'}});
    assert.equal(r.status,200);assert.deepEqual(Object.keys(r.body).sort(),['model','resolution']);
    assert.ok(!f.state.calls.some(c=>c.url.pathname.endsWith('/feedback_issues')&&c.method!=='GET'));
  });
  await t.test('invalid AI schema remains a 502', async (sub) => {
    const previous=globalThis.fetch;sub.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>String(input).includes('generativelanguage.googleapis.com')?Response.json({candidates:[{content:{parts:[{text:'{}'}]}}]}):previous(input,init));
    assert.equal((await f.request('/issue-resolution',{body:{title:'Fixture',description:'Details'}})).status,502);
  });
  await t.test('notify keeps exact URL, validation, missing row and DB failure',async(sub)=>{
    f.reset();f.state.caller=ADMIN;
    assert.equal((await f.request('/issue-notify?x=1',{body:{}})).status,404);
    assert.equal((await f.request('/issue-notify',{body:{kind:'other'}})).status,400);
    const previous=globalThis.fetch;sub.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>String(input).includes('/rest/v1/feedback_issues')?Response.json(null):previous(input,init));
    const r=await f.request('/issue-notify',{body:{kind:'assigned',issueKey:'FB-20261022-AAAAAAAA'}});assert.equal(r.status,404);assert.deepEqual(r.body,{error:'이슈를 찾을 수 없습니다.'});
  });
  await t.test('notification permissions and failure remain observable without sending email',async()=>{
    f.reset();f.state.caller=USER;
    assert.equal((await f.request('/issue-notify',{body:{kind:'assigned',issueKey:'FB-20261022-AAAAAAAA'}})).status,403);
    f.state.caller=ADMIN;f.state.dbFailure=true;
    assert.equal((await f.request('/issue-notify',{body:{kind:'assigned',issueKey:'FB-20261022-AAAAAAAA'}})).status,500);
    assert.ok(!f.state.calls.some(c=>c.url.hostname==='api.resend.com'));
  });
});
