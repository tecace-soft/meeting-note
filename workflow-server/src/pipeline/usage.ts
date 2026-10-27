import { env } from '../config/env.js';
import { supabase } from '../db/supabaseClient.js';
import { calculateGeminiUsageCost } from '../costs.js';
import type { GeminiUsageMetadata } from '../gemini.js';

export async function recordGeminiUsage(input: {
  noteId: string;
  userId: string;
  stage: string;
  model: string;
  inputType: 'audio' | 'text';
  usageMetadata: GeminiUsageMetadata;
  latencyMs: number;
}): Promise<void> {
  const usage = calculateGeminiUsageCost({
    model: input.model,
    inputType: input.inputType,
    usageMetadata: input.usageMetadata,
  });
  const { error } = await supabase.from('workflow_usage').insert({
    note_id: input.noteId,
    user_id: input.userId,
    stage: input.stage,
    provider: 'google-gemini',
    model: input.model,
    input_type: input.inputType,
    prompt_tokens: usage.promptTokens,
    candidates_tokens: usage.candidatesTokens,
    total_tokens: usage.totalTokens,
    cached_content_tokens: usage.cachedContentTokens,
    thoughts_tokens: usage.thoughtsTokens,
    latency_ms: input.latencyMs,
    estimated_cost_usd: usage.estimatedCostUsd,
    usage_metadata: input.usageMetadata,
  });
  if (error) {
    console.warn(`Could not record Gemini usage for ${input.stage}: ${error.message}`);
  }
}

export async function recordAssemblyUsage(input: {
  noteId: string;
  userId: string;
  model: string;
  latencyMs: number;
  transcriptId: string;
  audioDurationSeconds: number;
  // S10 annotations (resumed poll, resubmission); omitted keys keep the pre-S10 shape.
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const durationHours = Math.max(0, input.audioDurationSeconds) / 3600;
  const estimatedCostUsd = Number.isFinite(env.assemblyAiPricePerHourUsd)
    ? durationHours * env.assemblyAiPricePerHourUsd
    : 0;
  const { error } = await supabase.from('workflow_usage').insert({
    note_id: input.noteId,
    user_id: input.userId,
    stage: 'transcription',
    provider: 'assemblyai',
    model: input.model,
    input_type: 'audio',
    latency_ms: input.latencyMs,
    estimated_cost_usd: Number(estimatedCostUsd.toFixed(6)),
    usage_metadata: {
      transcriptId: input.transcriptId,
      audioDurationSeconds: input.audioDurationSeconds,
      pricePerHourUsd: env.assemblyAiPricePerHourUsd,
      ...(input.metadata ?? {}),
    },
  });
  if (error) {
    console.warn(`Could not record AssemblyAI usage for transcription: ${error.message}`);
  }
}

// S10 (DEC-0022): a recovered job is about to submit its audio to AssemblyAI again
// although an earlier execution may already have been charged for it (the provider
// accepted a submission whose id was never saved, or a pre-S10 run was cut off).
// Written BEFORE the new submission so the possible duplicate charge stays traceable
// even if this execution dies too. Its cost is unknown here (0); the duration of the
// same note's 'transcription' row, flagged `resubmission`, prices it.
export async function recordAssemblyResubmission(input: {
  noteId: string;
  userId: string;
  model: string;
  jobId: string;
  executionGeneration: number;
  attempt: number;
  submissionCount: number | null;
  reason: 'submit-outcome-unknown' | 'pre-s10-run-outcome-unknown' | 'submit-marker-missing';
}): Promise<void> {
  console.warn(`AssemblyAI resubmission for workflow job ${input.jobId} (note ${input.noteId}, attempt ${input.attempt}, reason ${input.reason}); an earlier submission may also have been charged.`);
  const { error } = await supabase.from('workflow_usage').insert({
    note_id: input.noteId,
    user_id: input.userId,
    stage: 'transcription-resubmission',
    provider: 'assemblyai',
    model: input.model,
    input_type: 'audio',
    latency_ms: 0,
    estimated_cost_usd: 0,
    usage_metadata: {
      jobId: input.jobId,
      executionGeneration: input.executionGeneration,
      attempt: input.attempt,
      submissionCount: input.submissionCount,
      reason: input.reason,
      priorSubmissionOutcome: 'unknown',
    },
  });
  if (error) {
    console.warn(`Could not record the AssemblyAI resubmission for workflow job ${input.jobId}: ${error.message}`);
  }
}
