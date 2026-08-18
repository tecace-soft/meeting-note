import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function jsonResource(uri: string, value: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

// Honest pagination signal. Callers fetch `limit + 1` rows; this returns the first
// `limit` to show plus `hasMore` telling the model whether more rows exist beyond the
// window. Without it, a bare capped array reads as "these are all" when it is only the
// top N, producing confidently-incomplete answers at scale.
export function applyLimitWindow<T>(rows: T[], limit: number): { shown: T[]; hasMore: boolean } {
  return { shown: rows.slice(0, limit), hasMore: rows.length > limit };
}

export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!limit || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(Math.floor(limit), max));
}

export function truncateText(text: string, maxCharacters: number | undefined): string {
  if (!maxCharacters || maxCharacters <= 0 || text.length <= maxCharacters) return text;
  return `${text.slice(0, maxCharacters)}\n\n[truncated to ${maxCharacters} characters]`;
}
