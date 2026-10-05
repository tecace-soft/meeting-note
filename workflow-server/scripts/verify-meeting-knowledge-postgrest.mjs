// Use only after verify-meeting-knowledge-native in labelled local containers.
// Synthetic JWT signing tests PostgREST role isolation, not Microsoft SSO.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
const [databaseContainer, restContainer] = process.argv.slice(2);
for (const name of [databaseContainer,restContainer]) {
  if (!name || !/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new Error('Provide two local test container names.');
  const label = execFileSync('docker',['--host=unix:///var/run/docker.sock','inspect','--format','{{index .Config.Labels "codex.synthetic"}}',name],{encoding:'utf8',timeout:5000}).trim();
  assert.equal(label,'meeting-knowledge');
}
const port = JSON.parse(execFileSync('docker',['--host=unix:///var/run/docker.sock','inspect','--format','{{json .NetworkSettings.Ports}}',restContainer],{encoding:'utf8',timeout:5000}))['3000/tcp'];
assert.equal(port.length,1); assert.equal(port[0].HostIp,'127.0.0.1');
const endpoint = `http://127.0.0.1:${port[0].HostPort}`;
const tenant='11111111-1111-4111-8111-111111111111';
const member='22222222-2222-4222-8222-000000000003';
const record=JSON.parse(execFileSync('docker',['--host=unix:///var/run/docker.sock','exec',databaseContainer,'psql','-X','-q','-t','-A','-U','postgres','-d','codex_knowledge_bigint','-c',`select public.meeting_knowledge_current_source('${tenant}','native-source');`],{encoding:'utf8',timeout:5000}));
const body={p_tenant_id:tenant,p_source_id:'native-source',p_object_id:member,p_content_revision:record.contentRevision,
  p_speaker_revision:record.speakerRevision,p_access_revision:record.accessRevision,p_integration_generation:record.integrationGeneration,p_source_hash:record.sourceHash};
const jwt=role=>{
  const prefix=[{alg:'HS256',typ:'JWT'},{role,exp:Math.floor(Date.now()/1000)+120}].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return prefix+'.'+createHmac('sha256','synthetic-local-only-not-a-production-secret').update(prefix).digest('base64url');
};
async function rpc(role, patch={}) {
  return fetch(endpoint+'/rpc/meeting_knowledge_current_evidence',{method:'POST',headers:{'content-type':'application/json',...(role?{authorization:'Bearer '+jwt(role)}:{})},body:JSON.stringify({...body,...patch}),signal:AbortSignal.timeout(5000)});
}
let checks=0;
for (const role of [null,'anon','authenticated']) { const response=await rpc(role); assert.ok([401,403,404].includes(response.status)); assert.ok(!(await response.text()).includes('Synthetic native source')); checks++; }
const allowed=await rpc('service_role'); assert.equal(allowed.status,200);
const evidence=await allowed.json(); assert.equal(evidence.plaintext,'Synthetic native source. 한국어 🎤 edit'); checks++;
for (const patch of [{p_object_id:'22222222-2222-4222-8222-000000000001'}, {p_tenant_id:'33333333-3333-4333-8333-333333333333'}, {p_content_revision:1}, {p_access_revision:record.accessRevision+1}, {p_source_hash:'a'.repeat(64)}, {p_source_id:'unknown'}]) {
  const response=await rpc('service_role',patch); assert.equal(response.status,200); assert.equal(await response.json(),null); checks++;
}
const privateTable=await fetch(endpoint+'/source',{headers:{authorization:'Bearer '+jwt('service_role'),'accept-profile':'meeting_knowledge'},signal:AbortSignal.timeout(5000)});
assert.ok([400,404,406].includes(privateTable.status)); checks++;
const forged=await fetch(endpoint+'/rpc/meeting_knowledge_current_evidence',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+jwt('service_role').slice(0,-2)+'xx'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
assert.equal(forged.status,401); checks++;
process.stdout.write(JSON.stringify({checks,nativePostgrest:true,syntheticJwt:true,microsoftSsoTested:false,hostedDatabaseUsed:false})+'\n');
