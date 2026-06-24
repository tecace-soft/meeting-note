import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getMeetingNoteUserIdFromAzureToken } from '../lib/azureToken.js';
import { sendMcpAlert } from '../lib/alerts.js';
import { getEnv } from '../lib/env.js';
import { logError, logEvent } from '../lib/logger.js';
import { getDataContext, runWithScopedUserId } from '../lib/supabase.js';
import { createMeetingNoteMcpServer } from '../server.js';

const startedAt = new Date();
const metrics = {
  totalRequests: 0,
  activeRequests: 0,
  completedRequests: 0,
  failedRequests: 0,
  unauthorizedRequests: 0,
  disconnectedRequests: 0,
  healthChecks: 0,
  healthFailures: 0,
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendJsonWithHeaders(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string>
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'Unknown server error';
}

function hashForLog(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function getClientIp(req: IncomingMessage): string | undefined {
  const forwardedFor = getHeaderValue(req, 'x-forwarded-for');
  return forwardedFor?.split(',')[0]?.trim() || req.socket.remoteAddress || undefined;
}

function getRequestMetadata(req: IncomingMessage, requestId: string, url?: URL): Record<string, unknown> {
  return {
    requestId,
    method: req.method,
    path: url?.pathname ?? req.url,
    userAgent: getHeaderValue(req, 'user-agent'),
    clientIp: getClientIp(req),
  };
}

function getJwtRole(token: string): string {
  try {
    const payload = token.split('.')[1];
    if (!payload) return 'unknown';
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { role?: unknown };
    return typeof decoded.role === 'string' ? decoded.role : 'unknown';
  } catch {
    return 'unknown';
  }
}

function isAuthorized(req: IncomingMessage, apiKey: string | undefined): boolean {
  if (!apiKey) return true;
  return req.headers.authorization === `Bearer ${apiKey}`;
}

function hashMcpToken(token: string, pepper: string): string {
  return createHash('sha256').update(`${pepper}:${token}`).digest('hex');
}

async function resolveUserIdFromPersonalMcpToken(
  bearerToken: string | undefined,
  env: ReturnType<typeof getEnv>
): Promise<string | undefined> {
  if (!bearerToken || !env.mcpTokenPepper) return undefined;

  const tokenHash = hashMcpToken(bearerToken, env.mcpTokenPepper);
  const { supabase } = getDataContext();
  const { data, error } = await supabase
    .from('mcp_token')
    .select('id, user_id')
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .maybeSingle();

  if (error) {
    process.stderr.write(`Failed to resolve personal MCP token: ${describeError(error)}\n`);
    return undefined;
  }
  const row = data as { id?: string; user_id?: string } | null;
  if (!row?.id || !row.user_id) return undefined;

  void supabase
    .from('mcp_token')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', row.id)
    .then(({ error: updateError }) => {
      if (updateError) process.stderr.write(`Failed to update MCP token last_used_at: ${updateError.message}\n`);
    });

  return row.user_id;
}

function getBearerToken(req: IncomingMessage): string | undefined {
  const authorization = getHeaderValue(req, 'authorization');
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function getHeaderValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0]?.trim() || undefined;
  return value?.trim() || undefined;
}

function getRequestBaseUrl(req: IncomingMessage): string {
  const proto = getHeaderValue(req, 'x-forwarded-proto') ?? 'https';
  const host = getHeaderValue(req, 'x-forwarded-host') ?? getHeaderValue(req, 'host') ?? 'localhost';
  return `${proto}://${host}`.replace(/\/$/, '');
}

function getProtectedResourceMetadata(baseUrl: string, resource?: string, scope?: string) {
  const resolvedResource = resource ?? `${baseUrl}/mcp-chatgpt`;
  const resolvedScope = scope ?? 'https://graph.microsoft.com/User.Read';
  const scopes = Array.from(
    new Set([
      resolvedScope,
      // ChatGPT needs a refreshable OAuth connection. Azure only returns refresh
      // tokens when offline_access is requested, and openid/profile keep the
      // consent screen aligned with normal Microsoft sign-in expectations.
      'openid',
      'profile',
      'offline_access',
    ])
  );

  return {
    resource: resolvedResource,
    authorization_servers: ['https://login.microsoftonline.com/common/v2.0'],
    scopes_supported: scopes,
    bearer_methods_supported: ['header'],
    resource_name: 'Meeting Note MCP',
  };
}

async function getMicrosoftUserIdFromGraph(accessToken: string): Promise<string | undefined> {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id', {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) return undefined;

  const data = (await response.json()) as { id?: unknown };
  return typeof data.id === 'string' && data.id.trim() ? data.id.trim() : undefined;
}

async function resolveChatGptUserId(bearerToken: string | undefined, env: ReturnType<typeof getEnv>): Promise<string | undefined> {
  if (!bearerToken) return env.meetingNoteUserId;

  const mappedUserId = env.mcpUserTokens.get(bearerToken);
  if (mappedUserId) {
    process.stderr.write('MCP ChatGPT auth resolved through MCP_USER_TOKENS\n');
    return mappedUserId;
  }

  if (env.mcpOAuthResource && env.mcpAzureTenantId) {
    try {
      const scopeName = env.mcpOAuthScope?.split('/').pop();
      const azureUserId = await getMeetingNoteUserIdFromAzureToken(bearerToken, {
        audience: env.mcpOAuthResource,
        scope: scopeName,
        tenantId: env.mcpAzureTenantId,
      });
      if (azureUserId) {
        process.stderr.write('MCP ChatGPT auth resolved through Azure JWT oid\n');
        return azureUserId;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`MCP ChatGPT Azure JWT validation failed: ${message}\n`);
    }
  }

  const graphUserId = await getMicrosoftUserIdFromGraph(bearerToken);
  if (graphUserId) {
    process.stderr.write('MCP ChatGPT auth resolved through Microsoft Graph /me fallback\n');
    return graphUserId;
  }

  return env.meetingNoteUserId;
}

async function checkSupabaseHealth(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { supabase } = getDataContext();
    const { error } = await supabase
      .from('mcp_token')
      .select('id', { count: 'exact', head: true })
      .limit(1);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

function healthPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    service: 'meeting-note-mcp',
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    memory: process.memoryUsage(),
    metrics,
    ...extra,
  };
}

function startDiagnostics(env: ReturnType<typeof getEnv>): void {
  let lastDisconnectAlertCount = 0;

  setInterval(() => {
    logEvent('info', 'mcp_heartbeat', healthPayload());
  }, env.mcpHeartbeatLogIntervalMs).unref();

  setInterval(() => {
    void (async () => {
      const result = await checkSupabaseHealth();
      metrics.healthChecks += 1;
      if (result.ok) {
        logEvent('debug', 'mcp_dependency_health_ok', { dependency: 'supabase' });
      } else {
        metrics.healthFailures += 1;
        logEvent('error', 'mcp_dependency_health_failed', {
          dependency: 'supabase',
          error: result.error,
        });
        await sendMcpAlert({
          title: 'MCP dependency health check failed',
          severity: 'critical',
          message: 'The MCP server is running, but its Supabase health check failed.',
          context: {
            dependency: 'supabase',
            error: result.error,
            metrics,
            uptimeSeconds: Math.round(process.uptime()),
          },
          dedupeKey: 'mcp-supabase-health',
        });
      }

      const disconnectsSinceLastAlert = metrics.disconnectedRequests - lastDisconnectAlertCount;
      if (disconnectsSinceLastAlert >= env.mcpDisconnectAlertThreshold) {
        lastDisconnectAlertCount = metrics.disconnectedRequests;
        logEvent('warn', 'mcp_disconnect_threshold_exceeded', {
          disconnectsSinceLastAlert,
          threshold: env.mcpDisconnectAlertThreshold,
          metrics,
        });
        await sendMcpAlert({
          title: 'MCP repeated client disconnects detected',
          severity: 'warning',
          message: `${disconnectsSinceLastAlert} MCP request disconnects were observed since the previous disconnect alert.`,
          context: {
            disconnectsSinceLastAlert,
            threshold: env.mcpDisconnectAlertThreshold,
            metrics,
            uptimeSeconds: Math.round(process.uptime()),
          },
          dedupeKey: 'mcp-disconnect-threshold',
        });
      }
    })();
  }, env.mcpHealthCheckIntervalMs).unref();
}

export async function startHttpServer(): Promise<void> {
  const env = getEnv();
  startDiagnostics(env);

  const httpServer = createServer(async (req, res) => {
    const requestId = randomUUID();
    const requestStartedAt = performance.now();
    metrics.totalRequests += 1;
    metrics.activeRequests += 1;
    let requestUrl: URL | undefined;
    let completed = false;

    req.on('aborted', () => {
      metrics.disconnectedRequests += 1;
      logEvent('warn', 'mcp_request_aborted', getRequestMetadata(req, requestId, requestUrl));
    });

    res.on('close', () => {
      if (!completed && !res.writableEnded) {
        completed = true;
        metrics.activeRequests = Math.max(0, metrics.activeRequests - 1);
        metrics.disconnectedRequests += 1;
        logEvent('warn', 'mcp_response_closed_before_finish', getRequestMetadata(req, requestId, requestUrl));
      }
    });

    res.on('finish', () => {
      completed = true;
      metrics.activeRequests = Math.max(0, metrics.activeRequests - 1);
      metrics.completedRequests += 1;
      const durationMs = Math.round(performance.now() - requestStartedAt);
      const statusCode = res.statusCode;
      if (statusCode >= 500) metrics.failedRequests += 1;
      if (statusCode === 401 || statusCode === 403) metrics.unauthorizedRequests += 1;
      logEvent(statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info', 'mcp_request_finished', {
        ...getRequestMetadata(req, requestId, requestUrl),
        statusCode,
        durationMs,
      });
    });

    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      requestUrl = url;
      logEvent('info', 'mcp_request_started', getRequestMetadata(req, requestId, url));

      if (url.pathname === '/health') {
        const deep = url.searchParams.get('deep') === '1';
        const dependency = deep ? await checkSupabaseHealth() : { ok: true as const };
        if (!dependency.ok) {
          metrics.healthFailures += 1;
          sendJson(res, 503, healthPayload({
            ok: false,
            dependency: {
              supabase: dependency,
            },
          }));
          return;
        }
        sendJson(res, 200, healthPayload({
          dependency: {
            supabase: deep ? dependency : { ok: 'not_checked' },
          },
        }));
        return;
      }

      const requestBaseUrl = env.mcpPublicBaseUrl ?? getRequestBaseUrl(req);

      if (
        url.pathname === '/.well-known/oauth-protected-resource' ||
        url.pathname === '/.well-known/oauth-protected-resource/mcp-chatgpt'
      ) {
        sendJson(res, 200, getProtectedResourceMetadata(requestBaseUrl, env.mcpOAuthResource, env.mcpOAuthScope));
        return;
      }

      const isClaudeEndpoint = url.pathname === '/mcp';
      const isChatGptEndpoint = url.pathname === '/mcp-chatgpt';

      if (!isClaudeEndpoint && !isChatGptEndpoint) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      const bearerToken = getBearerToken(req);
      const staticKeyAuthorized = isClaudeEndpoint && isAuthorized(req, env.mcpApiKey);
      const personalTokenUserId = staticKeyAuthorized
        ? undefined
        : await resolveUserIdFromPersonalMcpToken(bearerToken, env);

      if (isClaudeEndpoint && !personalTokenUserId && !staticKeyAuthorized) {
        logEvent('warn', 'mcp_unauthorized_request', {
          ...getRequestMetadata(req, requestId, url),
          endpoint: url.pathname,
          hasBearerToken: Boolean(bearerToken),
          staticKeyConfigured: Boolean(env.mcpApiKey),
        });
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      const userId = isChatGptEndpoint
        ? personalTokenUserId ?? (await resolveChatGptUserId(bearerToken, env))
        : personalTokenUserId ?? getHeaderValue(req, 'x-meeting-note-user-id') ?? env.meetingNoteUserId;

      if (!userId) {
        logEvent('warn', 'mcp_missing_user_scope', {
          ...getRequestMetadata(req, requestId, url),
          endpoint: url.pathname,
          hasBearerToken: Boolean(bearerToken),
        });
        const body = {
          error: isChatGptEndpoint
            ? 'A valid Microsoft OAuth bearer token, ChatGPT bearer token, or MEETING_NOTE_USER_ID is required.'
            : 'Missing meeting note user id.',
        };

        if (isChatGptEndpoint) {
          const resourceMetadataUrl = `${requestBaseUrl}/.well-known/oauth-protected-resource/mcp-chatgpt`;
          sendJsonWithHeaders(res, 401, body, {
            'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
          });
        } else {
          sendJson(res, 401, body);
        }
        return;
      }

      await runWithScopedUserId(userId, async () => {
        logEvent('info', 'mcp_request_user_resolved', {
          ...getRequestMetadata(req, requestId, url),
          endpoint: url.pathname,
          userHash: hashForLog(userId),
          authMode: personalTokenUserId ? 'personal-token' : staticKeyAuthorized ? 'static-key' : isChatGptEndpoint ? 'chatgpt-oauth' : 'fallback',
        });
        const server = createMeetingNoteMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        res.on('finish', () => {
          void server.close().catch((closeError) => {
            logError('mcp_request_server_close_failed', closeError, getRequestMetadata(req, requestId, url));
          });
        });
        await transport.handleRequest(req, res);
      });
    } catch (error) {
      const message = getErrorMessage(error);
      logError('mcp_http_request_failed', error, getRequestMetadata(req, requestId, requestUrl));
      void sendMcpAlert({
        title: 'MCP HTTP request failed',
        severity: 'warning',
        message,
        error,
        context: {
          ...getRequestMetadata(req, requestId, requestUrl),
          metrics,
        },
        dedupeKey: 'mcp-http-request-failed',
      });
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.end();
    }
  });

  httpServer.on('clientError', (error, socket) => {
    metrics.failedRequests += 1;
    logError('mcp_http_client_error', error, {
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
    });
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  httpServer.on('error', (error) => {
    logError('mcp_http_server_error', error, { port: env.port });
    void sendMcpAlert({
      title: 'MCP HTTP server error',
      severity: 'critical',
      error,
      context: {
        port: env.port,
        metrics,
      },
      dedupeKey: 'mcp-http-server-error',
    });
  });

  httpServer.listen(env.port, () => {
    logEvent('info', 'mcp_http_server_started', {
      port: env.port,
      supabaseKeyRole: getJwtRole(env.supabaseServiceRoleKey),
      staticAuth: env.mcpApiKey ? 'configured' : 'not_configured',
      personalTokenLookup: env.mcpTokenPepper ? 'enabled' : 'disabled',
      healthCheckIntervalMs: env.mcpHealthCheckIntervalMs,
      heartbeatLogIntervalMs: env.mcpHeartbeatLogIntervalMs,
    });
    void sendMcpAlert({
      title: 'MCP server started',
      severity: 'info',
      message: `Meeting Note MCP HTTP server started on port ${env.port}.`,
      context: {
        port: env.port,
        supabaseKeyRole: getJwtRole(env.supabaseServiceRoleKey),
        staticAuth: env.mcpApiKey ? 'configured' : 'not_configured',
        personalTokenLookup: env.mcpTokenPepper ? 'enabled' : 'disabled',
      },
      dedupeKey: 'mcp-server-started',
    });
  });
}
