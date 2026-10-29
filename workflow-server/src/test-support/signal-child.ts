// Spawned only by the offline S12 tests; never imported by production startup.
import { once } from 'node:events';
import { getGlobalDispatcher } from 'undici';
import { workflowFixture, USER, TENANT, summarizeBody } from './workflow.js';

const mode = process.argv[2];
const f = await workflowFixture();
await new Promise<void>((resolve) => f.server.close(() => resolve()));
const previousFetch = globalThis.fetch;
let memoryReads = 0;
let postprocessingPending = false;
let providerPending = false;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === 'generativelanguage.googleapis.com' && mode === 'processing') {
    providerPending = true;
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('Fixture aborted')), { once: true }));
  }
  if (url.hostname === 'supabase.invalid' && url.pathname.endsWith('/user_memory') && ++memoryReads >= 2 && mode === 'completed') {
    postprocessingPending = true;
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('Fixture aborted')), { once: true }));
  }
  const response = await previousFetch(input, init);
  if (url.hostname === 'supabase.invalid' && url.pathname.includes('/rpc/workflow_job_')) {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    if (url.pathname.endsWith('/workflow_job_claim')) process.send?.({ event: 'claim', fenced: true, durableLease: true });
    if (url.pathname.endsWith('/workflow_job_write')) process.send?.({ event: 'write', status: body.p_patch.status,
      postprocessingStatus: body.p_patch.status === 'completed' ? 'pending' : undefined, fenced: typeof body.p_generation === 'number' });
    if (url.pathname.endsWith('/workflow_job_release')) process.send?.({ event: 'release', status: f.state.jobStatus === 'completed' ? 'completed' : 'queued',
      fenced: typeof body.p_generation === 'number', postprocessingStatus: f.state.jobStatus === 'completed' ? 'pending' : undefined });
  }
  return response;
}) as typeof fetch;
const { server, startServer } = await import('../index.js');
startServer({ port: 0, host: '127.0.0.1', dispatcher: getGlobalDispatcher() });
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Fixture has no address');
f.state.existingJob = false;
const token = `fixture.${Buffer.from(JSON.stringify({ oid: USER, tid: TENANT })).toString('base64url')}.fixture`;
const response = await fetch(`http://127.0.0.1:${address.port}/summarize-audio/jobs`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(summarizeBody),
});
await response.text();
for (let turn = 0; turn < 100; turn++) {
  if (mode === 'processing' ? f.state.jobStatus === 'processing' && providerPending : f.state.jobStatus === 'completed' && postprocessingPending) break;
  await new Promise<void>((resolve) => setImmediate(resolve));
}
process.send?.({ event: 'ready', status: f.state.jobStatus, postprocessingPending });
