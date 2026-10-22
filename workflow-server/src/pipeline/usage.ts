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
    },
  });
  if (error) {
    console.warn(`Could not record AssemblyAI usage for transcription: ${error.message}`);
  }
}
