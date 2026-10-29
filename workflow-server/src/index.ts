import './config/loadEnv.js';
import { resetDrain } from './runtime/executionScope.js';
import { createGracefulStop } from './runtime/shutdown.js';
import { raiseIncident } from './ops/incidents.js';
import { handleWorkflowRequest } from './http/router.js';
import { supabase } from './db/supabaseClient.js';
import { env, ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL } from './config/env.js';
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { KNOWLEDGE_EXTRACTION_MODEL, liteModelFromEnv } from './gemini-models.js';
import { createMeetingOutboxStore } from './knowledge/outbox.js';
import { startMeetingKnowledgeDelivery } from './knowledge/delivery.js';
import { createMeetingModelPolicyClient } from './knowledge/model-policy-client.js';
import { createGeminiMeetingGenerator } from './knowledge/extraction-provider.js';
import { createMeetingExtractionStore } from './knowledge/extraction-store.js';
import { startMeetingExtractionWorker } from './knowledge/extraction-worker.js';
import { recoverOrphanedJobs } from './jobs/orphanSweep.js';
import { ORPHANED_JOB_SWEEP_INTERVAL_MS } from './jobs/store.js';

export const server = createServer(handleWorkflowRequest);

// Importing this module only constructs the handler.
// Production startup stays explicit so tests can own all process resources.
export function startServer(options: { port?: number; host?: string; dispatcher?: Dispatcher } = {}): () => Promise<void> {
  if (server.listening) throw new Error('Workflow server is already listening.');
  resetDrain();
  const previousDispatcher = getGlobalDispatcher();
  const dispatcher = options.dispatcher ?? new Agent({
    headersTimeout: env.fetchHeadersTimeoutMs,
    bodyTimeout: env.fetchBodyTimeoutMs,
  });
  setGlobalDispatcher(dispatcher);
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  const workerStops: Array<() => void> = [];
  const onRejection = (error: unknown) => {
    console.error('Unhandled workflow rejection:', error);
    void raiseIncident({
      title: 'Unhandled workflow rejection',
      error,
      context: { source: 'process.unhandledRejection' },
    });
  };

  const onException = (error: Error) => {
    console.error('Uncaught workflow exception:', error);
    void raiseIncident({
      title: 'Uncaught workflow exception',
      error,
      context: { source: 'process.uncaughtException' },
    });
  };

  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  let dispatcherClosing: Promise<void> | undefined;
  const closeDispatcher = () => dispatcherClosing ??= dispatcher === previousDispatcher ? Promise.resolve() : dispatcher.close();
  let cleaned = false;
  const stopWorkers = () => {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = undefined; }
    for (const stopWorker of workerStops.splice(0)) stopWorker();
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    server.off('close', cleanup);
    server.off('error', cleanup);
    stopWorkers();
    process.off('SIGTERM', onSigterm);
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
    setGlobalDispatcher(previousDispatcher);
    if (dispatcher !== previousDispatcher) void closeDispatcher().catch(() => undefined);
  };
  const stop = createGracefulStop({
    server, stopWorkers, cleanup,
    closeDispatcher,
    destroyDispatcher: () => dispatcher === previousDispatcher ? Promise.resolve() : dispatcher.destroy(),
  });
  const onSigterm = () => { void stop().then(() => process.exit(0)); };
  process.on('SIGTERM', onSigterm);
  server.once('close', cleanup);
  server.once('error', cleanup);
  server.listen(options.port ?? env.port, options.host ?? env.listenHost, () => {
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : options.port ?? env.port;
    console.log(`Meeting Note workflow server listening on :${port}`);
    console.log(`Workflow env: transcription=assemblyai:${ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL}:no-language-settings, summary=${env.summaryModel}, headersTimeout=${env.fetchHeadersTimeoutMs}, bodyTimeout=${env.fetchBodyTimeoutMs}`);
    void recoverOrphanedJobs();
    sweepTimer = setInterval(() => void recoverOrphanedJobs(), ORPHANED_JOB_SWEEP_INTERVAL_MS);
    // Existing transcription and MCP startup remain independent of this opt-in.
    if (process.env.MEETING_KNOWLEDGE_DELIVERY_ENABLED === 'true') {
      try {
        if (!env.supabaseUrl || !env.serviceRoleKey) throw new Error('CONFIG_UNAVAILABLE');
        const stopDelivery = startMeetingKnowledgeDelivery(createMeetingOutboxStore({
          rpc: (name, args) => supabase.rpc(name, args).abortSignal(AbortSignal.timeout(5_000)),
        }), {
          MEETING_KNOWLEDGE_DELIVERY_ENABLED: process.env.MEETING_KNOWLEDGE_DELIVERY_ENABLED,
          MEETING_KNOWLEDGE_AXKH_URL: process.env.MEETING_KNOWLEDGE_AXKH_URL,
          MEETING_KNOWLEDGE_INGEST_KEY: process.env.MEETING_KNOWLEDGE_INGEST_KEY,
          MEETING_KNOWLEDGE_ACCESS_KEY: process.env.MEETING_KNOWLEDGE_ACCESS_KEY,
          MEETING_KNOWLEDGE_TENANT_ID: process.env.MEETING_KNOWLEDGE_TENANT_ID,
          MEETING_KNOWLEDGE_NOTE_BASE_URL: process.env.MEETING_KNOWLEDGE_NOTE_BASE_URL,
          MEETING_KNOWLEDGE_TIMEZONE: process.env.MEETING_KNOWLEDGE_TIMEZONE,
        });
        workerStops.push(stopDelivery);
      } catch {
        // Never print endpoint, secret, source data or upstream diagnostics.
        console.warn('Meeting knowledge delivery: CONFIG_UNAVAILABLE');
      }
    }
    if (process.env.MEETING_KNOWLEDGE_EXTRACTION_ENABLED === 'true') {
      try {
        if (!env.supabaseUrl || !env.serviceRoleKey || !env.geminiApiKey
          || process.env.MEETING_KNOWLEDGE_DELIVERY_ENABLED !== 'true') throw new Error('CONFIG_UNAVAILABLE');
        // Unset keeps extraction unconfigured; a set but non-lite value falls back to the lite default (DEC-0005).
        if (!process.env.MEETING_KNOWLEDGE_EXTRACTION_MODEL?.trim()) throw new Error('CONFIG_UNAVAILABLE');
        const model = liteModelFromEnv('MEETING_KNOWLEDGE_EXTRACTION_MODEL', process.env.MEETING_KNOWLEDGE_EXTRACTION_MODEL, KNOWLEDGE_EXTRACTION_MODEL);
        const stopExtraction = startMeetingExtractionWorker(createMeetingExtractionStore({
          rpc: (name, args) => supabase.rpc(name, args).abortSignal(AbortSignal.timeout(5_000)),
        }), {
          MEETING_KNOWLEDGE_EXTRACTION_ENABLED: process.env.MEETING_KNOWLEDGE_EXTRACTION_ENABLED,
          MEETING_KNOWLEDGE_TENANT_ID: process.env.MEETING_KNOWLEDGE_TENANT_ID,
          MEETING_KNOWLEDGE_EXTRACTION_MODEL: model,
          MEETING_KNOWLEDGE_EXTRACTION_MAX_CHUNKS: process.env.MEETING_KNOWLEDGE_EXTRACTION_MAX_CHUNKS,
        }, {
          generate: createGeminiMeetingGenerator({ apiKey: env.geminiApiKey, model }),
          authorizeModel: createMeetingModelPolicyClient({
            MEETING_KNOWLEDGE_EXTRACTION_ENABLED: process.env.MEETING_KNOWLEDGE_EXTRACTION_ENABLED,
            MEETING_KNOWLEDGE_AXKH_URL: process.env.MEETING_KNOWLEDGE_AXKH_URL,
            MEETING_KNOWLEDGE_MODEL_POLICY_KEY: process.env.MEETING_KNOWLEDGE_MODEL_POLICY_KEY,
            MEETING_KNOWLEDGE_INGEST_KEY: process.env.MEETING_KNOWLEDGE_INGEST_KEY,
            MEETING_KNOWLEDGE_ACCESS_KEY: process.env.MEETING_KNOWLEDGE_ACCESS_KEY,
            MEETING_KNOWLEDGE_TENANT_ID: process.env.MEETING_KNOWLEDGE_TENANT_ID,
            MEETING_KNOWLEDGE_EXTRACTION_MODEL: model,
          }),
        });
        workerStops.push(stopExtraction);
      } catch {
        console.warn('Meeting knowledge extraction: CONFIG_UNAVAILABLE');
      }
    }
  });
  return stop;
}

let isDirectExecution = false;

if (process.argv[1]) {
  try {
    isDirectExecution = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // Missing or inaccessible paths cannot establish direct execution.
    // Keep imports inert rather than failing while resolving an entrypoint.
  }
}

if (isDirectExecution) {
  startServer();
}
