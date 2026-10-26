import './config/loadEnv.js';
import { raiseIncident } from './ops/incidents.js';
import { handleIssuesRequest } from './routes/issues.js';
import { handleTranscriptionTestRequest, ASSEMBLYAI_CODE_SWITCHING_MODEL_LABEL } from './routes/transcriptionTest.js';
import { HttpError, sendJson, sendNoContent, readBody, getHttpStatus, errorMessage, getBearerToken } from './http/shared.js';
import { getMicrosoftUserId } from './http/identity.js';
import { supabase } from './db/supabaseClient.js';
import { env, ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL } from './config/env.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { realpathSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { PROJECT_CHAT_MODEL, KNOWLEDGE_EXTRACTION_MODEL, liteModelFromEnv } from './gemini-models.js';
import type { TranscriptSegment } from './parsers.js';
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
import { resolveSummaryPromptForAndroid } from './pipeline/promptLoaders.js';
import type { SummarizeAudioRequest, SummarizeAudioInput, SummarizeAudioResult } from './pipeline/types.js';
import {
  ANDROID_AUDIO_MAX_BYTES, ASSEMBLYAI_AUDIO_EXTENSION_RE, ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS,
  createAndroidAudioFileRecord, isSupportedAndroidAudio, parseAndroidMultipartUpload, parseOptionalDate,
  sanitizeUploadFileName, uploadAndroidAudioToStorage,
} from './pipeline/androidUpload.js';
import { NoSpeechDetectedError } from './pipeline/errors.js';
import { parseSummarizeInput } from './pipeline/inputs.js';
import { runSummarizeAudio } from './pipeline/summarize.js';
import { finalizeNoteMemory } from './pipeline/finalize.js';
import { type WorkflowJobRow, updateWorkflowJob, JOB_HEARTBEAT_INTERVAL_MS, ORPHANED_JOB_THRESHOLD_MS, ORPHANED_JOB_SWEEP_INTERVAL_MS } from './jobs/store.js';






// PROJECT_CHAT_MODEL is imported from gemini-models.ts (the central registry).

async function summarizeAudio(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const input = parseSummarizeInput((await readBody(req, 110_000_000)) as SummarizeAudioRequest);
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  if (tokenUserId !== input.userId) throw new Error('Authenticated user does not match request userId.');

  const result = await runSummarizeAudio(input);
  sendJson(res, 200, result);
  // Enrich after responding so the web client isn't held behind memory/speaker-ID calls.
  await finalizeNoteMemory(input, result.transcript);
}

async function createSummarizeJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const input = parseSummarizeInput((await readBody(req, 110_000_000)) as SummarizeAudioRequest);
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  if (tokenUserId !== input.userId) throw new Error('Authenticated user does not match request userId.');

  // Idempotency: the mobile client generates noteId once per recording and
  // reuses it when it retries createNote (e.g. after a lost HTTP response or a
  // cold restart). Return the existing in-flight or completed job for this
  // (user_id, note_id) instead of starting a second transcription+summary run,
  // which would duplicate the note and double the Assembly/Gemini cost. A
  // 'failed' job is intentionally excluded so the user can retry after a
  // genuine failure.
  const existing = await supabase
    .from('workflow_job')
    .select('id, status, stage, progress')
    .eq('user_id', input.userId)
    .eq('note_id', input.noteId)
    .in('status', ['queued', 'processing', 'completed'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) {
    const row = existing.data as { id: string; status: WorkflowJobRow['status']; stage: string | null; progress: number | null };
    sendJson(res, 202, {
      jobId: row.id,
      status: row.status,
      stage: row.stage ?? row.status,
      progress: row.progress ?? 0,
      deduplicated: true,
    });
    return;
  }

  const { data, error } = await supabase.from('workflow_job').insert({
    user_id: input.userId,
    note_id: input.noteId,
    type: 'summarize_audio',
    status: 'queued',
    stage: 'queued',
    progress: 0,
    request: input,
    updated_at: new Date().toISOString(),
  }).select('id').single();
  if (error) {
    // FIX 1 (race): two concurrent requests for the same (user_id, note_id) can
    // both pass the idempotency SELECT above and both reach this INSERT. The new
    // partial unique index (NOT applied yet -- see the migration) makes the loser
    // fail with unique_violation instead of starting a duplicate pipeline. Treat
    // that as a dedup hit and return the job the winner created. Harmless when the
    // index is absent (this branch simply never triggers).
    if (error.code === '23505') {
      const raced = await supabase
        .from('workflow_job')
        .select('id, status, stage, progress')
        .eq('user_id', input.userId)
        .eq('note_id', input.noteId)
        .in('status', ['queued', 'processing', 'completed'])
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!raced.error && raced.data) {
        const row = raced.data as { id: string; status: WorkflowJobRow['status']; stage: string | null; progress: number | null };
        sendJson(res, 202, {
          jobId: row.id,
          status: row.status,
          stage: row.stage ?? row.status,
          progress: row.progress ?? 0,
          deduplicated: true,
        });
        return;
      }
    }
    throw error;
  }
  const jobId = (data as { id?: unknown }).id;
  if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Could not create workflow job.');

  void processSummarizeJob(jobId.trim(), input);
  sendJson(res, 202, { jobId, status: 'queued', stage: 'queued', progress: 0 });
}

async function createAndroidRecordingJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
    const upload = await parseAndroidMultipartUpload(req);

  try {
    if (!isSupportedAndroidAudio(upload.file)) {
      throw new HttpError(400, `Unsupported audio file. Upload an audio file supported by AssemblyAI: ${ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS.join(', ')}.`);
    }
    if (upload.file.sizeBytes <= 0) {
      throw new HttpError(400, 'Uploaded audio file is empty.');
    }
    if (upload.file.sizeBytes > ANDROID_AUDIO_MAX_BYTES) {
      throw new HttpError(413, 'Audio file exceeds the 100 MB maximum size.');
    }

    const noteId = randomUUID();
    const fileId = randomUUID();
    const submittedFileName = upload.fields.fileName?.trim() || upload.file.originalName || 'android-recording.ogg';
    const submittedHasSupportedExt = ASSEMBLYAI_AUDIO_EXTENSION_RE.test(submittedFileName);
    const originalExt = upload.file.originalName.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    const fallbackExt = originalExt && ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS.includes(originalExt as typeof ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS[number])
      ? originalExt
      : 'ogg';
    const safeFileName = sanitizeUploadFileName(
      submittedHasSupportedExt ? submittedFileName : `${submittedFileName}.${fallbackExt}`,
      `android-recording.${fallbackExt}`
    );
    const recordedAt = parseOptionalDate(upload.fields.recordingEndedAt);
    const summaryPrompt = await resolveSummaryPromptForAndroid({
      promptId: upload.fields.promptId,
      userId: tokenUserId,
    });
    const { storagePath, signedUrl } = await uploadAndroidAudioToStorage({
      userId: tokenUserId,
      noteId,
      fileName: safeFileName,
      mimeType: upload.file.mimeType || 'audio/ogg',
      tempPath: upload.file.tempPath,
    });
    await createAndroidAudioFileRecord({
      id: fileId,
      userId: tokenUserId,
      fileName: safeFileName,
      storagePath,
      mimeType: upload.file.mimeType || 'audio/ogg',
      sizeBytes: upload.file.sizeBytes,
      recordedAt,
    });

    const input: SummarizeAudioInput = {
      downloadUrl: signedUrl,
      fileName: safeFileName,
      promptId: summaryPrompt.promptId,
      summaryRulesOverride: summaryPrompt.summaryRulesOverride,
      userId: tokenUserId,
      userName: '',
      noteId,
      meetingAt: recordedAt,
      userTimeZone: upload.fields.userTimeZone?.trim() || null,
      fileId,
      instructions: upload.fields.instructions ?? '',
      speakerContext: '',
      attachments: [],
      language: upload.fields.language === 'ko' ? 'ko' : 'en',
    };
    const { data, error } = await supabase.from('workflow_job').insert({
      user_id: tokenUserId,
      note_id: noteId,
      type: 'summarize_audio',
      status: 'queued',
      stage: 'queued',
      progress: 0,
      request: {
        ...input,
        source: 'android_recording',
        storagePath,
        originalFileName: upload.file.originalName,
        mimeType: upload.file.mimeType,
        sizeBytes: upload.file.sizeBytes,
      },
      updated_at: new Date().toISOString(),
    }).select('id').single();
    if (error) throw error;
    const jobId = (data as { id?: unknown }).id;
    if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Could not create workflow job.');

    void processSummarizeJob(jobId.trim(), input);
    sendJson(res, 202, {
      jobId,
      noteId,
      fileId,
      status: 'queued',
      stage: 'queued',
      progress: 0,
    });
  } finally {
    await unlink(upload.file.tempPath).catch(() => undefined);
  }
}

async function processSummarizeJob(jobId: string, input: SummarizeAudioInput): Promise<void> {
  // Keep updated_at fresh across long silent stages (e.g. the multi-minute
  // AssemblyAI poll) so a concurrent boot sweep never mistakes this live job
  // for an orphan.
  const heartbeat = setInterval(() => {
    void updateWorkflowJob(jobId, {});
  }, JOB_HEARTBEAT_INTERVAL_MS);
  try {
    const result = await runSummarizeAudio(input, jobId);
    // Terminal writes retry: a transient DB blip here would otherwise strand the
    // job at 'processing' forever and the client would poll until it times out.
    const marked = await updateWorkflowJob(jobId, {
      status: 'completed',
      stage: 'completed',
      progress: 100,
      result,
      error: null,
    }, { retries: 4 });
    if (!marked) {
      // FIX 1: the note is already persisted (runSummarizeAudio inserted it), but
      // the terminal 'completed' write failed after all retries, leaving the job
      // at 'processing'. Do not re-run anything: the periodic orphan sweep
      // reconciles this job to 'completed' from the existing note once it goes
      // stale. Surface it so the divergence is observable.
      console.warn(`Workflow job ${jobId} completed but its terminal status write failed; the note is persisted and the orphan sweep will reconcile it.`);
    }
    completedJobResults.set(jobId, result);
    // Post-completion enrichment (memory fold + speaker-ID). Runs after the job is
    // marked completed so the client sees the summary immediately; awaited here so the
    // work still finishes in-process (heartbeat keeps the row fresh). Never throws.
    await finalizeNoteMemory(input, result.transcript);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A no-speech recording is a normal user outcome, not a system failure: mark
    // the job failed so the user sees the guidance message, but do not log it as
    // an error or raise an ops incident (that would be pure noise).
    if (error instanceof NoSpeechDetectedError) {
      console.log(`Workflow job ${jobId} ended with no detectable speech in the audio; surfacing to the user without an incident.`);
    } else {
      console.error(`Workflow job ${jobId} failed:`, error);
      void raiseIncident({
        title: 'Summarize audio job failed',
        error,
        context: {
          jobId,
          noteId: input.noteId,
          userId: input.userId,
          fileName: input.fileName,
          promptId: input.promptId,
          meetingAt: input.meetingAt,
        },
      });
    }
    await updateWorkflowJob(jobId, {
      status: 'failed',
      stage: 'failed',
      progress: 100,
      error: message,
    }, { retries: 4 });
  } finally {
    clearInterval(heartbeat);
  }
}

const completedJobResults = new Map<string, SummarizeAudioResult>();

async function getSummarizeJob(req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  const { data, error } = await supabase
    .from('workflow_job')
    .select('id, user_id, note_id, status, stage, progress, result, error')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    sendJson(res, 404, { error: 'Workflow job not found.' });
    return;
  }
  const row = data as WorkflowJobRow;
  if (row.user_id !== tokenUserId) throw new Error('Authenticated user does not match workflow job userId.');

  sendJson(res, 200, {
    jobId: row.id,
    noteId: row.note_id,
    status: row.status,
    stage: row.stage ?? row.status,
    progress: row.progress ?? 0,
    result: row.status === 'completed' ? completedJobResults.get(jobId) ?? row.result : null,
    error: row.error,
  });
  if (row.status === 'completed') completedJobResults.delete(jobId);
}

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
    if (req.method === 'POST' && req.url === '/summarize-audio') {
      await summarizeAudio(req, res);
      return;
    }
    if (await handleTranscriptionTestRequest(req, res)) return;
    if (await handleBackfillInsightRequest(req, res)) return;
    if (await handleRegenerateSummaryRequest(req, res)) return;
    if (await handleRefreshNoteInsightRequest(req, res)) return;
    if (await handleBriefingRequest(req, res, url)) return;
    if (await handleProductDocsRequest(req, res, url)) return;
    if (await handleIssuesRequest(req, res, url)) return;
    if (await handleProjectChatRequest(req, res)) return;
    if (req.method === 'POST' && req.url === '/summarize-audio/jobs') {
      await createSummarizeJob(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/android/recordings/jobs') {
      await createAndroidRecordingJob(req, res);
      return;
    }
    const jobMatch = url.pathname.match(/^\/summarize-audio\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch?.[1]) {
      await getSummarizeJob(req, res, decodeURIComponent(jobMatch[1]));
      return;
    }
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

// Jobs run in-process via fire-and-forget, so a crash/redeploy leaves their
// rows stuck at 'queued'/'processing' forever and clients poll for the full
// hour. On boot, fail such rows that have gone stale (older than the orphan
// threshold) so clients get a prompt, retryable error. The staleness guard
// (backed by the per-job heartbeat) prevents sweeping a live job owned by an
// overlapping instance during a zero-downtime deploy.
// Cap how many stale jobs one sweep reconciles so a pathological backlog cannot
// unbound the per-note existence query or the per-job recovery updates.
const MAX_ORPHAN_RECONCILE = 200;

// FIX 1 (convergence): rebuild a job result from a note that was already
// persisted. Lets a stranded job be recovered to 'completed' instead of 'failed',
// so the client never retries (and never spawns a duplicate pipeline) for work
// that already finished. Selected with '*' and read defensively so historical
// schema drift (missing translation / duration columns) cannot break recovery.
function reconstructResultFromNote(noteRow: Record<string, unknown>): SummarizeAudioResult {
  const summaryTranslations = (noteRow.summary_translations ?? {}) as Record<'en' | 'ko', string>;
  const transcriptionTranslations = (noteRow.transcription_translations ?? {}) as Partial<Record<'en' | 'ko', string>>;
  const diarizationTranslations = (noteRow.diarization_translations ?? {}) as Partial<Record<'en' | 'ko', TranscriptSegment[]>>;
  const detected = noteRow.transcription_language;
  return {
    transcript: Array.isArray(noteRow.diarization) ? (noteRow.diarization as TranscriptSegment[]) : [],
    summary: typeof noteRow.summary === 'string' ? noteRow.summary : '',
    summaryTranslations,
    transcriptionLanguage: detected === 'en' || detected === 'ko' ? detected : null,
    transcriptionTranslations,
    diarizationTranslations,
    title: typeof noteRow.name === 'string' ? noteRow.name : '',
    tags: Array.isArray(noteRow.tags) ? (noteRow.tags as string[]) : [],
    audioDurationSeconds: typeof noteRow.duration_seconds === 'number' ? noteRow.duration_seconds : null,
    meetingStartAt: typeof noteRow.meeting_at === 'string' ? noteRow.meeting_at : null,
  };
}

async function failOrphanedJobs(): Promise<void> {
  if (!env.supabaseUrl || !env.serviceRoleKey) return;
  const cutoff = new Date(Date.now() - ORPHANED_JOB_THRESHOLD_MS).toISOString();
  const { data, error } = await supabase
    .from('workflow_job')
    .select('id, user_id, note_id')
    .in('status', ['queued', 'processing'])
    .lt('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    .limit(MAX_ORPHAN_RECONCILE);
  if (error) {
    console.warn(`Could not scan for orphaned workflow jobs: ${error.message}`);
    return;
  }
  const rows = (data ?? []) as Array<{ id: string; user_id: string | null; note_id: string | null }>;
  if (rows.length === 0) return;

  // FIX 1 (convergence): a stranded job whose note was already persisted (the
  // 'completed' status write failed after the note insert succeeded) must NOT be
  // marked 'failed' -- that prompts the client to retry and spawn a second full
  // transcribe+summary run, duplicating the note and double-billing. Recover such
  // jobs to 'completed' from the existing note; fail only the rest.
  const noteIds = Array.from(new Set(rows.map((row) => row.note_id).filter((id): id is string => Boolean(id))));
  const notesById = new Map<string, Record<string, unknown>>();
  if (noteIds.length > 0) {
    const { data: noteData, error: noteError } = await supabase
      .from('note')
      .select('*')
      .in('id', noteIds);
    if (noteError) {
      // If the note lookup fails we cannot safely recover; fall back to the
      // original fail-all behavior rather than leaving jobs stranded.
      console.warn(`Could not look up notes while reconciling orphaned jobs: ${noteError.message}`);
    } else {
      for (const note of (noteData ?? []) as Array<Record<string, unknown>>) {
        if (typeof note.id === 'string') notesById.set(note.id, note);
      }
    }
  }

  const recoverable: Array<{ jobId: string; note: Record<string, unknown> }> = [];
  const failedIds: string[] = [];
  for (const row of rows) {
    const note = row.note_id ? notesById.get(row.note_id) : undefined;
    // Only recover when the note belongs to the same user as the job.
    if (note && (typeof note.user_id !== 'string' || note.user_id === row.user_id)) {
      recoverable.push({ jobId: row.id, note });
    } else {
      failedIds.push(row.id);
    }
  }

  for (const { jobId, note } of recoverable) {
    const recovered = await updateWorkflowJob(jobId, {
      status: 'completed',
      stage: 'completed',
      progress: 100,
      result: reconstructResultFromNote(note),
      error: null,
    }, { retries: 2 });
    if (!recovered) {
      // Could not converge to 'completed'; fail it so the client is not left
      // polling forever. The persisted note remains intact either way.
      failedIds.push(jobId);
    }
  }
  if (recoverable.length > 0) {
    console.log(`Recovered ${recoverable.length} orphaned workflow job(s) to completed from an existing note.`);
  }

  if (failedIds.length === 0) return;
  const { error: updateError } = await supabase
    .from('workflow_job')
    .update({
      status: 'failed',
      stage: 'failed',
      error: 'Server restarted while this job was running. Please try again.',
      updated_at: new Date().toISOString(),
    })
    .in('id', failedIds);
  if (updateError) {
    console.warn(`Could not fail ${failedIds.length} orphaned workflow job(s): ${updateError.message}`);
    return;
  }
  console.log(`Marked ${failedIds.length} orphaned workflow job(s) as failed.`);
}

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
    void failOrphanedJobs();
    sweepTimer = setInterval(() => void failOrphanedJobs(), ORPHANED_JOB_SWEEP_INTERVAL_MS);
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
