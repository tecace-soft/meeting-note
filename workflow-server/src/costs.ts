import type { GeminiUsageMetadata } from './gemini.js';

interface Pricing {
  textInputPerMillion: number;
  audioInputPerMillion?: number;
  outputPerMillion: number;
}

export interface UsageCost {
  promptTokens: number;
  candidatesTokens: number;
  totalTokens: number;
  cachedContentTokens: number;
  thoughtsTokens: number;
  estimatedCostUsd: number;
}

const DEFAULT_GEMINI_PRICING: Record<string, Pricing> = {
  'gemini-3.1-flash-lite': {
    textInputPerMillion: 0.25,
    audioInputPerMillion: 0.5,
    outputPerMillion: 1.5,
  },
  'gemini-2.5-flash': {
    textInputPerMillion: 0.3,
    audioInputPerMillion: 1.0,
    outputPerMillion: 2.5,
  },
  'gemini-2.5-flash-lite': {
    textInputPerMillion: 0.1,
    audioInputPerMillion: 0.3,
    outputPerMillion: 0.4,
  },
};

function numberFromMetadata(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function pricingForModel(model: string): Pricing | null {
  const normalized = model.trim().toLowerCase();
  if (DEFAULT_GEMINI_PRICING[normalized]) return DEFAULT_GEMINI_PRICING[normalized];
  if (normalized.includes('flash-lite')) return DEFAULT_GEMINI_PRICING['gemini-3.1-flash-lite'];
  if (normalized.includes('flash')) return DEFAULT_GEMINI_PRICING['gemini-2.5-flash'];
  return null;
}

function envNumber(key: string): number | null {
  const raw = process.env[key];
  if (!raw?.trim()) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function resolvePricing(model: string, inputType: 'audio' | 'text'): { input: number; output: number } {
  const envInput = envNumber(`GEMINI_${inputType.toUpperCase()}_INPUT_PRICE_PER_1M_TOKENS`)
    ?? envNumber('GEMINI_INPUT_PRICE_PER_1M_TOKENS');
  const envOutput = envNumber('GEMINI_OUTPUT_PRICE_PER_1M_TOKENS');
  const defaults = pricingForModel(model);

  return {
    input: envInput ?? (inputType === 'audio' ? defaults?.audioInputPerMillion ?? defaults?.textInputPerMillion : defaults?.textInputPerMillion) ?? 0,
    output: envOutput ?? defaults?.outputPerMillion ?? 0,
  };
}

export function calculateGeminiUsageCost(input: {
  model: string;
  inputType: 'audio' | 'text';
  usageMetadata: GeminiUsageMetadata;
}): UsageCost {
  const promptTokens = numberFromMetadata(input.usageMetadata.promptTokenCount);
  const candidatesTokens = numberFromMetadata(input.usageMetadata.candidatesTokenCount);
  const totalTokens = numberFromMetadata(input.usageMetadata.totalTokenCount);
  const cachedContentTokens = numberFromMetadata(input.usageMetadata.cachedContentTokenCount);
  const thoughtsTokens = numberFromMetadata(input.usageMetadata.thoughtsTokenCount);
  const pricing = resolvePricing(input.model, input.inputType);
  const estimatedCostUsd = (promptTokens / 1_000_000) * pricing.input + (candidatesTokens / 1_000_000) * pricing.output;

  return {
    promptTokens,
    candidatesTokens,
    totalTokens,
    cachedContentTokens,
    thoughtsTokens,
    estimatedCostUsd,
  };
}
