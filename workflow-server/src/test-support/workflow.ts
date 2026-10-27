// Offline HTTP boundary fixture for the actual workflow dispatcher and handlers.
import { mock } from 'node:test';
import { once } from 'node:events';
import { ISSUE_ADMIN_MICROSOFT_IDS } from '../issues.js';

export const USER = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const TENANT = '33333333-3333-4333-8333-333333333333';
export const ADMIN = [...ISSUE_ADMIN_MICROSOFT_IDS][1]!;
export const segments = [{ speaker: 'Speaker 1', text: 'Fixture meeting.', start: 0, end: 1 }];
export const summarizeBody = {
  downloadUrl: 'https://audio.invalid/fixture.ogg', fileName: 'fixture.ogg', promptId: 'fixture',
  summaryRulesOverride: 'Summarize.', userId: USER, noteId: 'fixture-note', language: 'en',
};
export const regenerateBody = { noteId: 'fixture-note', diarization: segments };
const summary = { title: 'Fixture title', summary: 'Fixture summary', tags: ['fixture'], actions: [], decisions: [], events: [], topics: [], people: [], companies: [], rootCauses: [], checks: [], fixPlan: [], verification: [], confidence: 'high' };

export async function workflowFixture() {
  process.env.SUPABASE_URL = 'https://supabase.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role';
  process.env.GEMINI_API_KEY = 'synthetic-gemini';
  process.env.ASSEMBLYAI_API_KEY = 'synthetic-assembly';
  process.env.ALLOWED_MS_TENANT_IDS = TENANT;
  const state = {
    caller: USER, tenant: TENANT, graphStatus: 200, dbFailure: false, aiFailure: false,
    noteOwner: USER, projectOwner: USER, emptyNotes: false, existingJob: true,
    jobStatus: 'processing', jobUpdates: [] as Record<string, unknown>[],
    calls: [] as { url: URL; method: string; body: any }[],
    // S10 (DEC-0022): true emulates the applied migration (claim, renew, fenced write and
    // submission RPCs); false answers them like PostgREST before the migration.
    s10Schema: true,
    // What workflow_job_load_request answers for a resumed job (the stored request).
    jobRequest: { ...summarizeBody } as unknown,
  };
  const nativeFetch = globalThis.fetch;
  const mocked = mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === '127.0.0.1') return nativeFetch(input, init);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    state.calls.push({ url, method, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url.hostname === 'graph.microsoft.com') return json({ id: state.caller, displayName: 'Fixture user' }, state.graphStatus);
    if (url.hostname === 'generativelanguage.googleapis.com') {
      if (state.aiFailure) return json({ error: { message: 'Fixture AI failure' } }, 400);
      if (url.pathname.endsWith(':streamGenerateContent')) return new Response('data: {"candidates":[{"content":{"parts":[{"text":"Fixture answer"}]}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(summary) }] } }], usageMetadata: {} });
    }
    if (url.hostname === 'api.assemblyai.com') {
      if (state.aiFailure) return json({ error: 'Fixture transcription failure' }, 400);
      if (url.pathname.includes('/upload')) return json({ upload_url: 'https://audio.invalid/uploaded' });
      return json({ id: 'fixture-transcript', status: 'completed', text: 'Fixture meeting.', utterances: [{ speaker: 'A', text: 'Fixture meeting.', start: 0, end: 1000 }] });
    }
    if (url.hostname !== 'supabase.invalid') throw new Error('Unmocked external request in workflow fixture');
    if (state.dbFailure) return json({ message: 'Fixture DB failure', code: 'FIXTURE' }, 400);
    if (url.pathname.includes('/storage/v1/object/sign/')) return json({ signedURL: '/object/fixture' });
    if (url.pathname.includes('/storage/')) return json({ Key: 'fixture' });
    const table = url.pathname.split('/').pop();
    if (url.pathname.startsWith('/rest/v1/rpc/workflow_job_')) {
      if (!state.s10Schema) return json({ code: 'PGRST202', message: `Could not find the function public.${table} in the schema cache` }, 404);
      if (table === 'workflow_job_claim') {
        return json([{ id: body.p_job_id, user_id: USER, note_id: 'fixture-note', status: 'queued', stage: 'queued',
          execution_generation: 1, attempt_count: 1, claim_count: 1, assembly_transcript_id: null, transcript_submission_state: 'none',
          transcript_submission_count: 0, claim_outcome: 'claimed' }]);
      }
      if (table === 'workflow_job_load_request') return json(state.jobRequest);
      if (table === 'workflow_job_begin_execution') return json(2);
      if (table === 'workflow_job_write') {
        state.jobUpdates.push(body.p_patch);
        if (body.p_patch.status) state.jobStatus = body.p_patch.status;
        return json(true);
      }
      if (table === 'workflow_job_begin_transcript_submission') return json(1);
      return json(true);
    }
    if (table === 'workflow_job' && method === 'PATCH') {
      state.jobUpdates.push(body);
      if (body.status) state.jobStatus = body.status;
      return json(null);
    }
    if (method !== 'GET') return json(table === 'workflow_job' ? { id: 'fixture-job' } : []);
    if (url.pathname.includes('/rpc/')) return json([]);
    if (table === 'workflow_job') {
      if (url.searchParams.has('lt') || url.searchParams.has('updated_at') || url.searchParams.has('or') || !state.existingJob) return json(null);
      return json({ id: 'fixture-job', user_id: USER, note_id: 'fixture-note', status: state.jobStatus, stage: state.jobStatus, progress: 25, result: null, error: null });
    }
    if (table === 'workflow_transcript_checkpoint') return json({ segments, audio_duration_seconds: 1, detected_language: null });
    if (table === 'project') {
      if (url.searchParams.has('shared_users')) return json([]);
      return json({ id: 'fixture-project', user_id: state.projectOwner, shared_users: [] });
    }
    if (table === 'note') {
      if (url.searchParams.has('id') && !url.searchParams.get('id')?.startsWith('in.')) return json({ id: 'fixture-note', user_id: state.noteOwner, shared_users: [], transcription: 'Fixture meeting.', diarization: segments });
      return json(state.emptyNotes ? [] : [{ id: 'fixture-note', name: 'Fixture title', transcription: 'Fixture meeting.', summary: 'Fixture summary' }]);
    }
    if (table === 'feedback_issues') return json({ issue_key: 'FB-20261022-AAAAAAAA', title: 'Fixture issue', author_id: state.noteOwner, attachments: [], created_at: new Date().toISOString(), status: 'OPEN' });
    if (table === 'summary_prompt') return json(url.searchParams.has('id') ? { prompt: 'Summarize.' } : [{ name: 'Default', prompt: 'Summarize.' }]);
    if (table === 'user_memory') return json({ memory: { version: 2, items: [] }, processed_note_ids: ['fixture-note'] });
    if (table === 'app_settings') return json(null);
    return json([]);
  });
  const { server } = await import('../index.js');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    state, server, base,
    async request(path: string, options: { method?: string; body?: unknown; authenticated?: boolean } = {}) {
      const token = `fixture.${Buffer.from(JSON.stringify({ oid: state.caller, tid: state.tenant })).toString('base64url')}.fixture`;
      const response = await fetch(base + path, {
        method: options.method ?? 'POST',
        headers: { 'content-type': 'application/json', ...(options.authenticated === false ? {} : { authorization: `Bearer ${token}` }) },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      const text = await response.text();
      await new Promise<void>((resolve) => setImmediate(resolve));
      return { status: response.status, headers: response.headers, text, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text || 'null') : null };
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      mocked.mock.restore();
    },
    reset() {
      Object.assign(state, { caller: USER, tenant: TENANT, graphStatus: 200, dbFailure: false, aiFailure: false, noteOwner: USER, projectOwner: USER, emptyNotes: false, existingJob: true, jobStatus: 'processing', s10Schema: true, jobRequest: { ...summarizeBody } });
      state.calls.length = 0;
      state.jobUpdates.length = 0;
    },
  };
}
