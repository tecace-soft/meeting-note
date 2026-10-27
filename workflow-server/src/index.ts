import './config/loadEnv.js';
import { raiseIncident } from './ops/incidents.js';
import { handleIssuesRequest } from './routes/issues.js';
import { handleTranscriptionTestRequest, ASSEMBLYAI_CODE_SWITCHING_MODEL_LABEL } from './routes/transcriptionTest.js';
import { sendJson, sendNoContent, getHttpStatus, errorMessage } from './http/shared.js';
import { supabase } from './db/supabaseClient.js';
import { env, ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL } from './config/env.js';
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { PROJECT_CHAT_MODEL, KNOWLEDGE_EXTRACTION_MODEL, liteModelFromEnv } from './gemini-models.js';
import { handleMcpRequest } from './mcp/transports/http.js';
import { clientGateMode, tenantGateMode } from './microsoftIdentity.js';
import { createMeetingKnowledgeHttpHandler } from './knowledge/http.js';
import { createMeetingKnowledgeStore } from './knowledge/store.js';
import { createMeetingOutboxStore } from './knowledge/outbox.js';
import { startMeetingKnowledgeDelivery } from './knowledge/delivery.js';
import { createMeetingModelPolicyClient } from './knowledge/model-policy-client.js';
import { createGeminiMeetingGenerator } from './knowledge/extraction-provider.js';
import { createMeetingExtractionStore } from './knowledge/extraction-store.js';
import { startMeetingExtractionWorker } from './knowledge/extraction-worker.js';
import { handleProductDocsRequest } from './routes/productDocs.js';
import { handleBriefingRequest } from './routes/briefing.js';
import { handleBackfillInsightRequest, handleRefreshNoteInsightRequest } from './routes/insight.js';
import { handleProjectChatRequest } from './routes/projectChat.js';
import { handleRegenerateSummaryRequest } from './routes/regenerateSummary.js';
import { handleSummarizeAudioRequest, handleSummarizeJobsRequest } from './routes/jobs.js';
import { recoverOrphanedJobs } from './jobs/orphanSweep.js';
import { ORPHANED_JOB_SWEEP_INTERVAL_MS } from './jobs/store.js';

// PROJECT_CHAT_MODEL is imported from gemini-models.ts (the central registry).

// Git-derived build identity. Render injects RENDER_GIT_COMMIT / RENDER_GIT_BRANCH
// at build + runtime; locally they are unset so we report 'dev'/'local'. This is a
// per-service traceability stamp (which commit is live right now), NOT a shared
// version number across the web/mobile/mcp apps — each deployable reports its own.
const VERSION_INFO = {
  service: 'meeting-note-workflow-server',
  sha: process.env.RENDER_GIT_COMMIT ?? 'dev',
  shortSha: (process.env.RENDER_GIT_COMMIT ?? 'dev').slice(0, 7),
  branch: process.env.RENDER_GIT_BRANCH ?? 'local',
  deployedAt: new Date().toISOString(),
} as const;

const handleMeetingKnowledgeRequest = createMeetingKnowledgeHttpHandler(createMeetingKnowledgeStore({
  // Bound each new integration RPC independently of existing long workflow jobs.
  rpc: (name, args) => supabase.rpc(name, args).abortSignal(AbortSignal.timeout(2_000)),
}), process.env);

export const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // New private routes own their CORS, credential checks and content-free errors.
    if (await handleMeetingKnowledgeRequest(req, res, url)) return;
    if (req.method === 'OPTIONS') {
      sendNoContent(res);
      return;
    }
    // MCP server, merged into this process (formerly its own Render web service).
    // Owns /mcp, /mcp-chatgpt, /.well-known/oauth-protected-resource*, and /admin/*
    // dashboard routes; returns false (falls through) for everything else,
    // including /health and /version which this host owns.
    if (await handleMcpRequest(req, res, url)) return;
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      sendJson(res, 200, {
        ok: true,
        service: 'meeting-note-workflow-server',
        version: VERSION_INFO,
        transcriptionProvider: 'assemblyai',
        transcriptionModel: ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL,
        transcriptionLanguageMode: 'no explicit AssemblyAI language settings',
        selectedLanguageAffectsTranscription: false,
        codeSwitchingModel: ASSEMBLYAI_CODE_SWITCHING_MODEL_LABEL,
        summaryModel: env.summaryModel,
        regenerateSummaryModel: env.regenerateSummaryModel,
        projectChatModel: PROJECT_CHAT_MODEL,
        // 'enforced' = ALLOWED_MS_TENANT_IDS is set (no value is exposed). Post-deploy check.
        msTenantGate: tenantGateMode(),
        // 'log-only' until MS_TOKEN_REQUIRE_KNOWN_CLIENT=true (appid / azp check).
        msClientGate: clientGateMode(),
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/version') {
      sendJson(res, 200, VERSION_INFO);
      return;
    }
    if (await handleSummarizeAudioRequest(req, res)) return;
    if (await handleTranscriptionTestRequest(req, res)) return;
    if (await handleBackfillInsightRequest(req, res)) return;
    if (await handleRegenerateSummaryRequest(req, res)) return;
    if (await handleRefreshNoteInsightRequest(req, res)) return;
    if (await handleBriefingRequest(req, res, url)) return;
    if (await handleProductDocsRequest(req, res, url)) return;
    if (await handleIssuesRequest(req, res, url)) return;
    if (await handleProjectChatRequest(req, res)) return;
    if (await handleSummarizeJobsRequest(req, res, url)) return;
    sendJson(res, 404, { error: 'Not found' });
  })().catch((error) => {
    const message = errorMessage(error);
    const status = getHttpStatus(error);
    console.error('Workflow request failed:', error);
    if (status >= 500) {
      void raiseIncident({
        title: 'Workflow request failed',
        error,
        context: {
          method: req.method,
          url: req.url,
          status,
        },
      });
    }
    sendJson(res, status, { error: message });
  });
});

// Importing this module only constructs the handler.
// Production startup stays explicit so tests can own all process resources.
export function startServer(options: { port?: number; host?: string; dispatcher?: Dispatcher } = {}): () => Promise<void> {
  if (server.listening) throw new Error('Workflow server is already listening.');
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
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    server.off('close', cleanup);
    server.off('error', cleanup);
    if (sweepTimer) clearInterval(sweepTimer);
    for (const stopWorker of workerStops.splice(0)) stopWorker();
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
    setGlobalDispatcher(previousDispatcher);
    if (dispatcher !== previousDispatcher) void dispatcher.close();
  };
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
  return () => new Promise<void>((resolveStop, rejectStop) => {
    server.close((error) => error ? rejectStop(error) : resolveStop());
    server.closeIdleConnections();
  });
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
