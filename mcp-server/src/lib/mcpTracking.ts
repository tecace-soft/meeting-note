import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { getDataContext } from './supabase.js';
import { logError } from './logger.js';

export interface McpTrackingContext {
  sessionId: string;
  requestId: string;
  userId?: string;
  userHash?: string;
}

export interface McpSessionStartInput {
  requestId: string;
  userId?: string;
  endpoint?: string;
  platform?: string;
  authMode?: string;
  method?: string;
  path?: string;
  userAgent?: string;
  clientIp?: string;
}

export interface McpSessionFinishInput {
  status: 'completed' | 'failed' | 'aborted';
  statusCode?: number;
  durationMs?: number;
  errorMessage?: string;
}

export interface McpToolCallInput {
  toolName: string;
  argumentsValue?: unknown;
  resultValue?: unknown;
  isError: boolean;
  errorMessage?: string;
  durationMs: number;
  startedAt: Date;
}

const trackingStorage = new AsyncLocalStorage<McpTrackingContext | undefined>();
const MAX_PREVIEW_CHARS = 12_000;

export function getMcpTrackingContext(): McpTrackingContext | undefined {
  return trackingStorage.getStore();
}

export async function runWithMcpTrackingContext<T>(
  context: McpTrackingContext | undefined,
  callback: () => Promise<T>
): Promise<T> {
  return trackingStorage.run(context, callback);
}

export function hashForTracking(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function inferPlatform(userAgent: string | undefined, endpoint: string | undefined): string {
  const lower = userAgent?.toLowerCase() ?? '';
  if (endpoint === '/mcp-chatgpt' || lower.includes('chatgpt') || lower.includes('openai')) return 'chatgpt';
  if (lower.includes('claude') || lower.includes('anthropic')) return 'claude';
  if (lower.includes('inspector')) return 'mcp-inspector';
  if (lower.includes('cursor')) return 'cursor';
  return 'unknown';
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== 'object') return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/token|authorization|password|secret|key/i.test(key)) {
      redacted[key] = '[redacted]';
    } else {
      redacted[key] = redactSensitive(item);
    }
  }
  return redacted;
}

function truncate(value: string): string {
  return value.length > MAX_PREVIEW_CHARS ? `${value.slice(0, MAX_PREVIEW_CHARS)}\n\n[truncated]` : value;
}

function safeJsonPreview(value: unknown): unknown {
  const redacted = redactSensitive(value);
  try {
    const serialized = JSON.stringify(redacted);
    if (serialized.length <= MAX_PREVIEW_CHARS) return redacted;
    return { preview: truncate(serialized) };
  } catch {
    return { preview: truncate(String(redacted)) };
  }
}

function resultPreview(result: unknown): { text: string | null; contentType: string | null } {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (Array.isArray(content)) {
    const firstText = content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const record = item as Record<string, unknown>;
        return typeof record.text === 'string' ? record.text : '';
      })
      .filter(Boolean)
      .join('\n\n');
    return {
      text: firstText ? truncate(firstText) : truncate(JSON.stringify(safeJsonPreview(result))),
      contentType: 'mcp-content',
    };
  }
  try {
    return { text: truncate(JSON.stringify(safeJsonPreview(result))), contentType: 'json' };
  } catch {
    return { text: truncate(String(result)), contentType: 'text' };
  }
}

export async function startMcpSession(input: McpSessionStartInput): Promise<McpTrackingContext | undefined> {
  try {
    const { supabase } = getDataContext();
    const userHash = hashForTracking(input.userId);
    const { data, error } = await supabase
      .from('mcp_session')
      .insert({
        request_id: input.requestId,
        user_id: input.userId ?? null,
        user_hash: userHash ?? null,
        endpoint: input.endpoint ?? null,
        platform: input.platform ?? inferPlatform(input.userAgent, input.endpoint),
        auth_mode: input.authMode ?? null,
        method: input.method ?? null,
        path: input.path ?? null,
        user_agent: input.userAgent ?? null,
        client_ip: input.clientIp ?? null,
      })
      .select('id')
      .single();

    if (error) throw error;
    const sessionId = (data as { id?: string } | null)?.id;
    if (!sessionId) return undefined;
    return {
      sessionId,
      requestId: input.requestId,
      userId: input.userId,
      userHash,
    };
  } catch (error) {
    logError('mcp_tracking_session_start_failed', error, { requestId: input.requestId });
    return undefined;
  }
}

export async function finishMcpSession(
  context: McpTrackingContext | undefined,
  input: McpSessionFinishInput
): Promise<void> {
  if (!context) return;
  try {
    const { supabase } = getDataContext();
    const { error } = await supabase
      .from('mcp_session')
      .update({
        status: input.status,
        status_code: input.statusCode ?? null,
        duration_ms: input.durationMs ?? null,
        error_message: input.errorMessage ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq('id', context.sessionId);
    if (error) throw error;
  } catch (error) {
    logError('mcp_tracking_session_finish_failed', error, { requestId: context.requestId });
  }
}

export async function recordMcpToolCall(input: McpToolCallInput): Promise<void> {
  const context = getMcpTrackingContext();
  if (!context) return;
  try {
    const { supabase } = getDataContext();
    const preview = resultPreview(input.resultValue);
    const { error } = await supabase
      .from('mcp_tool_call')
      .insert({
        session_id: context.sessionId,
        request_id: context.requestId,
        user_id: context.userId ?? null,
        user_hash: context.userHash ?? null,
        tool_name: input.toolName,
        arguments_preview: safeJsonPreview(input.argumentsValue),
        result_preview: input.errorMessage ? truncate(input.errorMessage) : preview.text,
        result_content_type: preview.contentType,
        is_error: input.isError,
        error_message: input.errorMessage ?? null,
        duration_ms: input.durationMs,
        started_at: input.startedAt.toISOString(),
        completed_at: new Date().toISOString(),
      });
    if (error) throw error;
  } catch (error) {
    logError('mcp_tracking_tool_call_failed', error, {
      requestId: context.requestId,
      toolName: input.toolName,
    });
  }
}
