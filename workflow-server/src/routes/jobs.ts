import { isDraining, ServerDrainingError } from '../runtime/executionScope.js';
// Summarize job routes: the synchronous /summarize-audio route, job creation for web
// (/summarize-audio/jobs) and Android multipart uploads (/android/recordings/jobs), and
// job status reads. Starts runs through jobs/runner.ts; imports pipeline, jobs and http
// modules only (never index.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { HttpError, sendJson, readBody, getBearerToken } from '../http/shared.js';
import { getMicrosoftUserId } from '../http/identity.js';
import { supabase } from '../db/supabaseClient.js';
import { resolveSummaryPromptForAndroid } from '../pipeline/promptLoaders.js';
import type { SummarizeAudioRequest, SummarizeAudioInput } from '../pipeline/types.js';
import {
  ANDROID_AUDIO_MAX_BYTES, ASSEMBLYAI_AUDIO_EXTENSION_RE, ASSEMBLYAI_SUPPORTED_AUDIO_EXTENSIONS,
  createAndroidAudioFileRecord, isSupportedAndroidAudio, parseAndroidMultipartUpload, parseOptionalDate,
  sanitizeUploadFileName, uploadAndroidAudioToStorage,
} from '../pipeline/androidUpload.js';
import { parseSummarizeInput } from '../pipeline/inputs.js';
import { runSummarizeAudio } from '../pipeline/summarize.js';
import { finalizeNoteMemory } from '../pipeline/finalize.js';
import { type WorkflowJobRow } from '../jobs/store.js';
import { processSummarizeJob, completedJobResults } from '../jobs/runner.js';

async function summarizeAudio(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const input = parseSummarizeInput((await readBody(req, 110_000_000)) as SummarizeAudioRequest);
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  if (tokenUserId !== input.userId) throw new Error('Authenticated user does not match request userId.');

  if (isDraining()) throw new ServerDrainingError();
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

  if (isDraining()) throw new ServerDrainingError();
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
    if (isDraining()) throw new ServerDrainingError();
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
    if (isDraining()) throw new ServerDrainingError();
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

export async function handleSummarizeAudioRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'POST' || req.url !== '/summarize-audio') return false;
  await summarizeAudio(req, res);
  return true;
}

export async function handleSummarizeJobsRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === 'POST' && req.url === '/summarize-audio/jobs') {
    await createSummarizeJob(req, res);
    return true;
  }
  if (req.method === 'POST' && req.url === '/android/recordings/jobs') {
    await createAndroidRecordingJob(req, res);
    return true;
  }
  const jobMatch = url.pathname.match(/^\/summarize-audio\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && jobMatch?.[1]) {
    await getSummarizeJob(req, res, decodeURIComponent(jobMatch[1]));
    return true;
  }
  return false;
}
