// Summarize stage of the pipeline: loads inputs, runs the transcript stage, generates
// the Gemini summary (with attachments and the parallel transcript translation), writes
// stage/progress to the job row, persists the note idempotently and clears the transcript
// checkpoint. Imports shared config, db, AI, store and pipeline modules (never index.ts
// or routes); the job runner owns terminal job status and post-completion finalize.
import { env, ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL, TRANSLATION_ENABLED } from '../config/env.js';
import { supabase } from '../db/supabaseClient.js';
import { callGeminiWithFallback } from '../ai/geminiFallback.js';
import { STANDARD_FALLBACK_CHAIN } from '../gemini-models.js';
import { buildNoteName, formatMeetingDateForPrompt, parseSummary, formatTranscriptText, type TranscriptSegment } from '../parsers.js';
import { buildSummaryPrompt } from '../prompts.js';
import { updateWorkflowJob, deleteTranscriptCheckpoint, type JobRef } from '../jobs/store.js';
import { recordGeminiUsage } from './usage.js';
import { getPersonalMemoryContext } from './memoryContext.js';
import { loadSummaryPrompt } from './promptLoaders.js';
import { getOppositeTranscriptLanguage, loadTranscriptionSettings, transcribeOrReuseCheckpoint, translateTranscriptSegments } from './transcription.js';
import { buildGeminiAttachmentParts, fallbackAttachmentSection, generateAttachmentSummarySection, parseAttachmentSection, summaryHasAttachmentSection } from './attachments.js';
import type { SummarizeAudioInput, SummarizeAudioResult } from './types.js';

export function inferMeetingStartAt(recordingEndedAt: string | null, durationSeconds: number | null): string | null {
  if (!recordingEndedAt) return null;
  const end = new Date(recordingEndedAt);
  if (Number.isNaN(end.getTime())) return null;
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return end.toISOString();
  }
  return new Date(end.getTime() - Math.round(durationSeconds * 1000)).toISOString();
}

export async function insertNote(input: {
  noteId: string;
  userId: string;
  userName: string;
  downloadUrl: string;
  transcriptText: string;
  transcriptionLanguage: 'en' | 'ko' | null;
  transcriptionTranslations: Partial<Record<'en' | 'ko', string>>;
  summary: string;
  summaryTranslations: Record<'en' | 'ko', string>;
  title: string;
  tags: string[];
  segments: TranscriptSegment[];
  diarizationTranslations: Partial<Record<'en' | 'ko', TranscriptSegment[]>>;
  meetingAt: string | null;
  fileId: string | null;
  audioDurationSeconds: number | null;
}): Promise<void> {
  const notePayload = {
    transcription: input.transcriptText,
    transcription_language: input.transcriptionLanguage,
    transcription_translations: input.transcriptionTranslations,
    summary: input.summary,
    summary_translations: input.summaryTranslations,
    user_id: input.userId,
    user_name: input.userName,
    id: input.noteId,
    audio_file: input.downloadUrl,
    name: input.title,
    tags: input.tags,
    diarization: input.segments,
    diarization_translations: input.diarizationTranslations,
    meeting_at: input.meetingAt,
    audio_file_id: input.fileId,
    duration_seconds: input.audioDurationSeconds,
  };
  // FIX 1: idempotent on the note primary key. A terminal-status write can fail
  // (DB outage) AFTER this insert succeeds, which later strands the job and
  // triggers a retry. If that retry reuses the same noteId, a bare .insert()
  // would create a DUPLICATE note (and double the Assembly/Gemini spend). Upsert
  // with ON CONFLICT (id) DO NOTHING makes a same-id retry a no-op: the first
  // successful write wins and is never silently overwritten.
  const { error } = await supabase.from('note').upsert(notePayload, { onConflict: 'id', ignoreDuplicates: true });
  if (
    error?.code === 'PGRST204' &&
    (
      error.message.includes("'transcription_language'") ||
      error.message.includes("'transcription_translations'") ||
      error.message.includes("'diarization_translations'")
    )
  ) {
    const {
      transcription_language: _transcriptionLanguage,
      transcription_translations: _transcriptionTranslations,
      diarization_translations: _diarizationTranslations,
      ...payloadWithoutTranslations
    } = notePayload;
    const { error: retryError } = await supabase.from('note').upsert(payloadWithoutTranslations, { onConflict: 'id', ignoreDuplicates: true });
    if (retryError) throw retryError;
    console.warn('Inserted note without transcript translation columns because the PostgREST schema cache is missing them.');
    return;
  }
  if (error?.code === 'PGRST204' && error.message.includes("'duration_seconds'")) {
    const { duration_seconds: _durationSeconds, ...payloadWithoutDuration } = notePayload;
    const { error: retryError } = await supabase.from('note').upsert(payloadWithoutDuration, { onConflict: 'id', ignoreDuplicates: true });
    if (retryError) throw retryError;
    console.warn('Inserted note without duration_seconds because the column is missing from the PostgREST schema cache.');
    return;
  }
  if (error) throw error;
}

// `job` is a pre-S10 job id (id-only writes), an owned S10 execution (every job write
// fenced; a lost lease throws JobLeaseLostError at the next write), or null for the
// synchronous route.
export async function runSummarizeAudio(input: SummarizeAudioInput, job: JobRef = null): Promise<SummarizeAudioResult> {
  if (!env.supabaseUrl || !env.serviceRoleKey) throw new Error('Supabase service configuration is missing.');
  if (!env.geminiApiKey) throw new Error('Gemini API key is missing.');
  if (!env.assemblyAiApiKey) throw new Error('AssemblyAI API key is missing.');

  await updateWorkflowJob(job, { status: 'processing', stage: 'loading inputs', progress: 10 });
  const summaryRules = input.summaryRulesOverride?.trim() || await loadSummaryPrompt(input.promptId, input.userId);
  const transcriptionSettings = await loadTranscriptionSettings();
  console.log(`Processing audio ${input.fileName} with AssemblyAI ${ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODEL_LABEL} and no explicit language settings. Selected summary language: ${input.language}`);

  await updateWorkflowJob(job, { stage: 'transcribing audio', progress: 25 });
  const { segments, audioDurationSeconds, detectedLanguage } = await transcribeOrReuseCheckpoint({
    noteId: input.noteId,
    userId: input.userId,
    downloadUrl: input.downloadUrl,
    fileId: input.fileId,
    language: input.language,
    settings: transcriptionSettings,
    ...(job && typeof job === 'object' ? { job } : {}),
  });
  const transcriptText = formatTranscriptText(segments, 'original');
  const translationLanguage = getOppositeTranscriptLanguage(detectedLanguage);
  const diarizationTranslations: Partial<Record<'en' | 'ko', TranscriptSegment[]>> = {};
  const transcriptionTranslations: Partial<Record<'en' | 'ko', string>> = {};
  // Translate the transcript to the opposite language (the bilingual-transcript feature)
  // IN PARALLEL with summary generation. The translation output feeds only insertNote
  // (storage) and is never read by the summary, so running it sequentially ahead of the
  // summary only added a fixed multi-second stall to every note. Best-effort: a
  // translation failure is logged and never fails the note. Awaited before insertNote.
  const translationPromise: Promise<void> = translationLanguage
    ? translateTranscriptSegments({
        segments,
        targetLanguage: translationLanguage,
        noteId: input.noteId,
        userId: input.userId,
      })
        .then((translatedSegments) => {
          if (translatedSegments.length > 0) {
            diarizationTranslations[translationLanguage] = translatedSegments;
            transcriptionTranslations[translationLanguage] = formatTranscriptText(translatedSegments, 'original');
          }
        })
        .catch((translationError) => {
          console.warn(`Transcript translation to ${translationLanguage} failed:`, translationError);
        })
    : Promise.resolve();
  const meetingStartAt = inferMeetingStartAt(input.meetingAt, audioDurationSeconds);
  const meetingDateForPrompt = meetingStartAt
    ? formatMeetingDateForPrompt(new Date(meetingStartAt), input.userTimeZone)
    : null;
  const attachmentParts = await buildGeminiAttachmentParts(input.attachments);
  const hasGeminiAttachments = attachmentParts.some((part) => Boolean(part.fileData));

  // F1' -> summary: inject the user's personal memory as BACKGROUND context so the summary
  // connects this meeting to their ongoing work. Best-effort (never blocks the summary);
  // buildSummaryPrompt's GROUNDING RULES forbid it from adding facts absent from the transcript.
  const personalMemoryContext = await getPersonalMemoryContext(input.userId);
  await updateWorkflowJob(job, { stage: 'generating summary', progress: 75 });
  const summaryRaw = await callGeminiWithFallback({
    stage: 'Summarization',
    model: env.summaryModel,
    fallbackModels: [...STANDARD_FALLBACK_CHAIN],
    responseMimeType: 'application/json',
    maxOutputTokens: 16384,
    thinkingBudget: 0,
    parts: [
      {
        text: buildSummaryPrompt({
          now: new Date().toISOString(),
          meetingDate: meetingDateForPrompt,
          instructions: input.instructions,
          summaryRules,
          fileName: input.fileName,
          transcript: transcriptText,
          speakerContext: input.speakerContext,
          globalSummaryContext: transcriptionSettings.summaryContext,
          personalMemoryContext,
          outputLanguage: input.language,
          hasAttachments: hasGeminiAttachments,
        }),
      },
      ...attachmentParts,
    ],
  });
  await recordGeminiUsage({
    noteId: input.noteId,
    userId: input.userId,
    stage: 'summarization',
    model: summaryRaw.model,
    inputType: 'text',
    usageMetadata: summaryRaw.usageMetadata,
    latencyMs: summaryRaw.latencyMs,
  });
  const parsedSummary = parseSummary(summaryRaw.text);
  if (hasGeminiAttachments && !summaryHasAttachmentSection(parsedSummary.summary, input.language)) {
    await updateWorkflowJob(job, { stage: 'generating attachment summary', progress: 82 });
    try {
      const attachmentSectionRaw = await generateAttachmentSummarySection({
        attachmentParts,
        attachments: input.attachments,
        transcriptText,
        existingSummary: parsedSummary.summary,
        language: input.language,
      });
      await recordGeminiUsage({
        noteId: input.noteId,
        userId: input.userId,
        stage: 'attachment-summary-section',
        model: attachmentSectionRaw.model,
        inputType: 'text',
        usageMetadata: attachmentSectionRaw.usageMetadata,
        latencyMs: attachmentSectionRaw.latencyMs,
      });
      parsedSummary.summary = `${parsedSummary.summary.trim()}\n\n${parseAttachmentSection(attachmentSectionRaw.text, input.language)}`;
    } catch (attachmentSectionError) {
      console.warn('Attachment summary section generation failed:', attachmentSectionError);
      parsedSummary.summary = `${parsedSummary.summary.trim()}\n\n${fallbackAttachmentSection(input.attachments, input.language)}`;
    }
  }
  const summaryTranslations: Record<'en' | 'ko', string> = {
    en: input.language === 'en' ? parsedSummary.summary : '',
    ko: input.language === 'ko' ? parsedSummary.summary : '',
  };

  // Alternate-language summary is temporarily disabled (see TRANSLATION_ENABLED) to
  // shorten processing time; only the selected-language summary above is generated.
  if (TRANSLATION_ENABLED) {
    const alternateLanguage: 'en' | 'ko' = input.language === 'ko' ? 'en' : 'ko';
    const alternateTranscriptText = formatTranscriptText(segments, alternateLanguage);
    await updateWorkflowJob(job, { stage: `generating ${alternateLanguage === 'ko' ? 'Korean' : 'English'} summary`, progress: 84 });
    const alternateSummaryRaw = await callGeminiWithFallback({
      stage: `Summarization (${alternateLanguage})`,
      model: env.summaryModel,
      fallbackModels: [...STANDARD_FALLBACK_CHAIN],
      responseMimeType: 'application/json',
      maxOutputTokens: 16384,
      parts: [
        {
          text: buildSummaryPrompt({
            now: new Date().toISOString(),
            meetingDate: meetingDateForPrompt,
            instructions: input.instructions,
            summaryRules,
            fileName: input.fileName,
            transcript: alternateTranscriptText,
            speakerContext: input.speakerContext,
            globalSummaryContext: transcriptionSettings.summaryContext,
            personalMemoryContext,
            outputLanguage: alternateLanguage,
            hasAttachments: hasGeminiAttachments,
          }),
        },
        ...attachmentParts,
      ],
    });
    await recordGeminiUsage({
      noteId: input.noteId,
      userId: input.userId,
      stage: `summarization-${alternateLanguage}`,
      model: alternateSummaryRaw.model,
      inputType: 'text',
      usageMetadata: alternateSummaryRaw.usageMetadata,
      latencyMs: alternateSummaryRaw.latencyMs,
    });
    const parsedAlternateSummary = parseSummary(alternateSummaryRaw.text);
    summaryTranslations[alternateLanguage] = parsedAlternateSummary.summary;
  }

  // The transcript translation ran in parallel with the summary; make sure it has
  // landed (or failed best-effort) before we persist, since insertNote stores it.
  await translationPromise;
  await updateWorkflowJob(job, { stage: 'saving note', progress: 92 });
  const noteName = buildNoteName({
    title: parsedSummary.title,
    tags: parsedSummary.tags,
    summary: parsedSummary.summary,
    createdAt: meetingStartAt ? new Date(meetingStartAt) : undefined,
    timeZone: input.userTimeZone,
  });
  await insertNote({
    noteId: input.noteId,
    userId: input.userId,
    userName: input.userName,
    downloadUrl: input.downloadUrl,
    transcriptText,
    transcriptionLanguage: detectedLanguage,
    transcriptionTranslations,
    summary: parsedSummary.summary,
    summaryTranslations,
    title: noteName,
    tags: parsedSummary.tags,
    segments,
    diarizationTranslations,
    meetingAt: meetingStartAt,
    fileId: input.fileId,
    audioDurationSeconds,
  });

  // FIX 2: the note (which embeds the transcript) is now durably persisted, so
  // the transcript checkpoint is no longer needed. Best-effort cleanup keeps the
  // checkpoint table small.
  await deleteTranscriptCheckpoint(input.noteId);

  // Memory fold (F1') + auto speaker-ID (F5.1) used to run here, blocking job
  // completion behind 2-3 more Gemini calls the user never waits to see. They no
  // longer affect the returned summary, so the caller now runs finalizeNoteMemory()
  // AFTER marking the job completed / sending the response (see processSummarizeJob
  // and summarizeAudio). The note itself is already persisted above.
  return {
    transcript: segments,
    summary: parsedSummary.summary,
    summaryTranslations,
    transcriptionLanguage: detectedLanguage,
    transcriptionTranslations,
    diarizationTranslations,
    title: noteName,
    tags: parsedSummary.tags,
    audioDurationSeconds,
    meetingStartAt,
  };
}
