import { AsyncLocalStorage } from 'node:async_hooks';
import { getDataContext } from './supabase.js';

export interface McpToolCallRecord {
  id: string;
  sessionId: string;
  time: string;
  tool: string;
  userId?: string;
  userIntent?: string;
  reasonForToolChoice?: string;
  expectedAnswerType?: string;
  input: unknown;
  outputPreview?: string;
  outcome: 'success' | 'error';
  durationMs: number;
  errorMessage?: string;
}

export interface McpTrackingContext {
  id: string;
  requestId: string;
  userId?: string;
  endpoint?: string;
  platform?: string;
  authMode?: string;
  method?: string;
  path?: string;
  userAgent?: string;
  clientIp?: string;
  startedAt: string;
  status?: 'completed' | 'failed' | 'aborted';
  statusCode?: number;
  durationMs?: number;
  errorMessage?: string;
  finalAnswer?: string;
  finalAnswerLoggedAt?: string;
  toolCalls: McpToolCallRecord[];
}

const trackingContext = new AsyncLocalStorage<McpTrackingContext>();
const sessions: McpTrackingContext[] = [];
const MAX_SESSIONS = 500;

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function pushSession(context: McpTrackingContext): void {
  const existingIndex = sessions.findIndex((session) => session.id === context.id);
  if (existingIndex >= 0) sessions.splice(existingIndex, 1);
  sessions.unshift({ ...context, toolCalls: [...context.toolCalls] });
  if (sessions.length > MAX_SESSIONS) sessions.length = MAX_SESSIONS;
}

function logTrackingPersistenceError(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`MCP tracking persistence failed during ${action}: ${message}\n`);
}

function toJsonValue(value: unknown): unknown {
  if (value == null) return {};
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return { value: String(value) };
  }
}

async function persistSessionStart(context: McpTrackingContext): Promise<void> {
  try {
    const { supabase } = getDataContext();
    const { error } = await supabase.from('mcp_session').upsert({
      id: context.id,
      request_id: context.requestId,
      user_id: context.userId ?? null,
      endpoint: context.endpoint ?? null,
      platform: context.platform ?? null,
      auth_mode: context.authMode ?? null,
      method: context.method ?? null,
      path: context.path ?? null,
      user_agent: context.userAgent ?? null,
      client_ip: context.clientIp ?? null,
      started_at: context.startedAt,
      status: 'active',
      tool_names: [],
      tool_call_count: 0,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  } catch (error) {
    logTrackingPersistenceError('session start', error);
  }
}

async function persistSessionUpdate(context: McpTrackingContext): Promise<void> {
  try {
    const { supabase } = getDataContext();
    const { error } = await supabase
      .from('mcp_session')
      .update({
        status: context.status ?? 'active',
        status_code: context.statusCode ?? null,
        duration_ms: context.durationMs ?? null,
        error_message: context.errorMessage ?? null,
        finished_at: context.status ? new Date().toISOString() : null,
        final_answer: context.finalAnswer ?? null,
        final_answer_logged_at: context.finalAnswerLoggedAt ?? null,
        tool_names: context.toolCalls.map((call) => call.tool),
        tool_call_count: context.toolCalls.length,
        updated_at: new Date().toISOString(),
      })
      .eq('id', context.id);
    if (error) throw error;
  } catch (error) {
    logTrackingPersistenceError('session update', error);
  }
}

async function persistToolCall(call: McpToolCallRecord): Promise<void> {
  try {
    const { supabase } = getDataContext();
    const { error } = await supabase.from('mcp_tool_call').insert({
      id: call.id,
      session_id: call.sessionId,
      request_id: trackingContext.getStore()?.requestId ?? null,
      user_id: call.userId ?? null,
      time: call.time,
      tool: call.tool,
      user_intent: call.userIntent ?? null,
      reason_for_tool_choice: call.reasonForToolChoice ?? null,
      expected_answer_type: call.expectedAnswerType ?? null,
      input: toJsonValue(call.input),
      output_preview: call.outputPreview ?? null,
      outcome: call.outcome,
      duration_ms: call.durationMs,
      error_message: call.errorMessage ?? null,
    });
    if (error) throw error;
  } catch (error) {
    logTrackingPersistenceError('tool call insert', error);
  }
}

export function inferPlatform(userAgent?: string, endpoint?: string): string {
  const agent = (userAgent ?? '').toLowerCase();
  if (endpoint?.includes('chatgpt') || agent.includes('chatgpt')) return 'ChatGPT';
  if (agent.includes('claude')) return 'Claude';
  if (agent.includes('curl')) return 'curl';
  if (agent.includes('insomnia') || agent.includes('postman')) return 'API test';
  return 'unknown';
}

export async function startMcpSession(input: Omit<Partial<McpTrackingContext>, 'id' | 'startedAt' | 'toolCalls'> & { requestId: string }): Promise<McpTrackingContext> {
  const context = {
    id: randomId('mcp-session'),
    requestId: input.requestId,
    userId: input.userId,
    endpoint: input.endpoint,
    platform: input.platform,
    authMode: input.authMode,
    method: input.method,
    path: input.path,
    userAgent: input.userAgent,
    clientIp: input.clientIp,
    startedAt: new Date().toISOString(),
    toolCalls: [],
  };
  await persistSessionStart(context);
  return context;
}

export async function finishMcpSession(
  context: McpTrackingContext | undefined,
  result: {
    status: 'completed' | 'failed' | 'aborted';
    statusCode?: number;
    durationMs?: number;
    errorMessage?: string;
  }
): Promise<void> {
  if (!context) return;
  context.status = result.status;
  context.statusCode = result.statusCode;
  context.durationMs = result.durationMs;
  context.errorMessage = result.errorMessage;
  pushSession(context);
  await persistSessionUpdate(context);
}

export async function runWithMcpTrackingContext<T>(
  context: McpTrackingContext | undefined,
  callback: () => Promise<T>
): Promise<T> {
  if (!context) return callback();
  return trackingContext.run(context, callback);
}

export function getMcpTrackingContext(): McpTrackingContext | undefined {
  return trackingContext.getStore();
}

export function recordMcpToolCall(call: Omit<McpToolCallRecord, 'id' | 'sessionId' | 'time' | 'userId'>): void {
  const context = trackingContext.getStore();
  if (!context) return;
  const record = {
    id: randomId('mcp-tool'),
    sessionId: context.id,
    time: new Date().toISOString(),
    userId: context.userId,
    ...call,
  };
  context.toolCalls.push(record);
  void persistToolCall(record);
  void persistSessionUpdate(context);
}

export function recordMcpFinalAnswer(answer: string): void {
  const context = trackingContext.getStore();
  if (!context) return;
  context.finalAnswer = answer;
  context.finalAnswerLoggedAt = new Date().toISOString();
  void persistSessionUpdate(context);
}

export function getMcpDashboardData() {
  const completedSessions = sessions.filter((session) => session.status === 'completed');
  const failedSessions = sessions.filter((session) => session.status === 'failed');
  const toolCalls = sessions.flatMap((session) => session.toolCalls);
  const uniqueUsers = new Set(sessions.map((session) => session.userId).filter(Boolean)).size;
  const avgLatencyMs = completedSessions.length
    ? Math.round(completedSessions.reduce((sum, session) => sum + (session.durationMs ?? 0), 0) / completedSessions.length)
    : 0;

  const dailyMap = new Map<string, { date: string; users: Set<string>; requests: number; toolCalls: number; failures: number }>();
  for (const session of sessions) {
    const date = session.startedAt.slice(0, 10);
    const row = dailyMap.get(date) ?? { date, users: new Set<string>(), requests: 0, toolCalls: 0, failures: 0 };
    if (session.userId) row.users.add(session.userId);
    row.requests += 1;
    row.toolCalls += session.toolCalls.length;
    if (session.status === 'failed') row.failures += 1;
    dailyMap.set(date, row);
  }

  const platformMap = new Map<string, { platform: string; users: Set<string>; requests: number; toolCalls: number }>();
  for (const session of sessions) {
    const platform = session.platform ?? 'unknown';
    const row = platformMap.get(platform) ?? { platform, users: new Set<string>(), requests: 0, toolCalls: 0 };
    if (session.userId) row.users.add(session.userId);
    row.requests += 1;
    row.toolCalls += session.toolCalls.length;
    platformMap.set(platform, row);
  }

  return {
    summary: {
      totalRequests: sessions.length,
      completedRequests: completedSessions.length,
      failedRequests: failedSessions.length,
      uniqueUsers,
      totalToolCalls: toolCalls.length,
      avgLatencyMs,
      estimatedTokens: null,
    },
    dailyUsage: [...dailyMap.values()].map((row) => ({
      date: row.date,
      users: row.users.size,
      requests: row.requests,
      toolCalls: row.toolCalls,
      tokens: null,
      failures: row.failures,
    })),
    platformUsage: [...platformMap.values()].map((row) => ({
      platform: row.platform,
      users: row.users.size,
      requests: row.requests,
      toolCalls: row.toolCalls,
    })),
    sessions: sessions.map((session) => ({
      id: session.id,
      startedAt: session.startedAt,
      user: session.userId ?? 'Unknown',
      platform: session.platform ?? 'unknown',
      status: session.status ?? 'active',
      query: session.toolCalls[0]?.userIntent ?? '',
      response: session.finalAnswer ?? session.toolCalls.at(-1)?.outputPreview ?? '',
      toolCalls: session.toolCalls.map((call) => call.tool),
      latencyMs: session.durationMs ?? null,
      tokens: null,
      endpoint: session.endpoint,
      authMode: session.authMode,
      errorMessage: session.errorMessage,
    })),
    toolCalls: toolCalls.map((call) => ({
      time: call.time,
      tool: call.tool,
      user: call.userId ?? 'Unknown',
      userIntent: call.userIntent,
      reasonForToolChoice: call.reasonForToolChoice,
      expectedAnswerType: call.expectedAnswerType,
      input: call.input,
      outputPreview: call.outputPreview,
      outcome: call.outcome,
      durationMs: call.durationMs,
      notes: call.errorMessage ?? call.reasonForToolChoice ?? '',
    })),
  };
}
