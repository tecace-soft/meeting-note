// HTTP router: the request dispatch for the workflow-server (knowledge, then OPTIONS,
// then MCP, then /health and /version, then the route modules in order, then 404) and
// the error-to-status mapping for anything a handler throws. Building the server here
// does not listen; process resources stay in index.ts startServer (T1-11).
import { raiseIncident } from '../ops/incidents.js';
import { handleIssuesRequest } from '../routes/issues.js';
import { handleTranscriptionTestRequest, ASSEMBLYAI_CODE_SWITCHING_MODEL_LABEL } from '../routes/transcriptionTest.js';
import { sendJson, sendNoContent, getHttpStatus, errorMessage } from './shared.js';
import { supabase } from '../db/supabaseClient.js';
import { env, ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL } from '../config/env.js';
import { createServer } from 'node:http';
import { PROJECT_CHAT_MODEL } from '../gemini-models.js';
import { handleMcpRequest } from '../mcp/transports/http.js';
import { clientGateMode, tenantGateMode } from '../microsoftIdentity.js';
import { createMeetingKnowledgeHttpHandler } from '../knowledge/http.js';
import { createMeetingKnowledgeStore } from '../knowledge/store.js';
import { handleProductDocsRequest } from '../routes/productDocs.js';
import { handleBriefingRequest } from '../routes/briefing.js';
import { handleBackfillInsightRequest, handleRefreshNoteInsightRequest } from '../routes/insight.js';
import { handleProjectChatRequest } from '../routes/projectChat.js';
import { handleRegenerateSummaryRequest } from '../routes/regenerateSummary.js';
import { handleSummarizeAudioRequest, handleSummarizeJobsRequest } from '../routes/jobs.js';

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
