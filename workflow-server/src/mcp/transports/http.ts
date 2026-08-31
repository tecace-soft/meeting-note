import { type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { handleAdminRequest } from '../admin/dashboard.js';
import { getMeetingNoteUserIdFromAzureToken } from '../lib/azureToken.js';
import { sendMcpAlert } from '../lib/alerts.js';
import { getEnv } from '../lib/env.js';
import { logError, logEvent } from '../lib/logger.js';
import { finishMcpSession, inferPlatform, runWithMcpTrackingContext, startMcpSession, type McpTrackingContext } from '../lib/mcpTracking.js';
import { getDataContext, runWithScopedUserId } from '../lib/supabase.js';
import { createMeetingNoteMcpServer } from '../server.js';

// In-process request counters. Kept for lifecycle logging; when the MCP ran as
// its own Render web service these were surfaced via /health + a diagnostics
// timer. Merged into the workflow-server, /health + /version are owned by the
// host, so those pieces were dropped (see handleMcpRequest).
const metrics = {
  totalRequests: 0,
  activeRequests: 0,
  completedRequests: 0,
  failedRequests: 0,
  unauthorizedRequests: 0,
  disconnectedRequests: 0,
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

function safeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function isAuthorized(req: IncomingMessage, apiKey: string | undefined): boolean {
  // Fail closed: when no static key is configured, the static-key path grants
  // nothing (callers must use a personal MCP token instead). Previously this
  // returned true when apiKey was unset, which left /mcp fully open.
  if (!apiKey) return false;
  const header = getHeaderValue(req, 'authorization');
  if (!header) return false;
  return safeStringEqual(header, `Bearer ${apiKey}`);
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
    .select('id, user_id, expires_at')
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .maybeSingle();

  if (error) {
    process.stderr.write(`Failed to resolve personal MCP token: ${describeError(error)}\n`);
    return undefined;
  }
  const row = data as { id?: string; user_id?: string; expires_at?: string | null } | null;
  if (!row?.id || !row.user_id) return undefined;

  // Enforce expiry in code, not just in the schema. A null expires_at means "no
  // expiry"; a past expires_at is rejected even though the DB row still exists.
  if (row.expires_at) {
    const expiresAtMs = Date.parse(row.expires_at);
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      process.stderr.write('Personal MCP token rejected: expired\n');
      return undefined;
    }
  }

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
  let response: Response;
  try {
    response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id', {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
      // Bound the auth hot path: without a timeout a stalled Graph call hangs the whole
      // request (and leaks an "active" tracking session) indefinitely. Fail closed instead.
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    console.warn(`[auth] Graph /me lookup failed or timed out: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  if (!response.ok) return undefined;

  const data = (await response.json()) as { id?: unknown };
  return typeof data.id === 'string' && data.id.trim() ? data.id.trim() : undefined;
}

async function resolveChatGptUserId(bearerToken: string | undefined, env: ReturnType<typeof getEnv>): Promise<string | undefined> {
  if (!bearerToken) {
    // No credential presented. Only fall back to the single-user default when
    // explicitly opted in (MCP_ALLOW_ANON_CHATGPT_FALLBACK). Default is closed
    // so a public /mcp-chatgpt does not serve the default user's meetings.
    return env.mcpAllowAnonChatgptFallback ? env.meetingNoteUserId : undefined;
  }

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

  // A token was presented but resolved to no user (invalid/expired/unknown).
  // Fail closed rather than silently serving the default user's meetings.
  process.stderr.write('MCP ChatGPT auth rejected: bearer token did not resolve to a user\n');
  return undefined;
}

// Paths this handler owns. Everything else falls through to the host
// (workflow-server) so it can serve its own routes. /health and /version are
// intentionally NOT owned here: the merged process serves those from the host.
function isMcpOwnedPath(pathname: string): boolean {
  return (
    pathname === '/mcp' ||
    pathname === '/mcp-chatgpt' ||
    pathname === '/.well-known/oauth-protected-resource' ||
    pathname === '/.well-known/oauth-protected-resource/mcp-chatgpt' ||
    pathname === '/admin' ||
    pathname === '/admin/' ||
    pathname === '/admin/msal-browser.min.js' ||
    pathname === '/admin/api/overview' ||
    pathname === '/admin/health'
  );
}

// MCP HTTP entry, merged into the workflow-server process. Returns true when the
// request was an MCP-owned route (already handled here), false when the caller
// should continue to its own routing. Formerly startHttpServer() ran a dedicated
// node:http server; the server + always-on diagnostics timers were dropped when
// this merged into one Render web service.
export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!isMcpOwnedPath(url.pathname)) return false;

  const env = getEnv();
  const requestId = randomUUID();
  const requestStartedAt = performance.now();
  metrics.totalRequests += 1;
  metrics.activeRequests += 1;
  const requestUrl: URL = url;
  let trackingContext: McpTrackingContext | undefined;
  let completed = false;
  let trackingFinished = false;

  req.on('aborted', () => {
    metrics.disconnectedRequests += 1;
    logEvent('warn', 'mcp_request_aborted', getRequestMetadata(req, requestId, requestUrl));
    if (!trackingFinished) {
      trackingFinished = true;
      void finishMcpSession(trackingContext, {
        status: 'aborted',
        durationMs: Math.round(performance.now() - requestStartedAt),
        errorMessage: 'Request aborted by client.',
      });
    }
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
    if (!trackingFinished) {
      trackingFinished = true;
      void finishMcpSession(trackingContext, {
        status: statusCode >= 500 ? 'failed' : 'completed',
        statusCode,
        durationMs,
      });
    }
  });

  try {
    logEvent('info', 'mcp_request_started', getRequestMetadata(req, requestId, url));

    if (await handleAdminRequest(req, res, url)) {
      return true;
    }

    const requestBaseUrl = env.mcpPublicBaseUrl ?? getRequestBaseUrl(req);

    if (
      url.pathname === '/.well-known/oauth-protected-resource' ||
      url.pathname === '/.well-known/oauth-protected-resource/mcp-chatgpt'
    ) {
      sendJson(res, 200, getProtectedResourceMetadata(requestBaseUrl, env.mcpOAuthResource, env.mcpOAuthScope));
      return true;
    }

    const isClaudeEndpoint = url.pathname === '/mcp';
    const isChatGptEndpoint = url.pathname === '/mcp-chatgpt';

    if (!isClaudeEndpoint && !isChatGptEndpoint) {
      // Reachable only if isMcpOwnedPath and the branches above drift out of sync.
      sendJson(res, 404, { error: 'Not found' });
      return true;
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
      return true;
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
      return true;
    }

    await runWithScopedUserId(userId, async () => {
      const authMode = personalTokenUserId ? 'personal-token' : staticKeyAuthorized ? 'static-key' : isChatGptEndpoint ? 'chatgpt-oauth' : 'fallback';
      logEvent('info', 'mcp_request_user_resolved', {
        ...getRequestMetadata(req, requestId, url),
        endpoint: url.pathname,
        userHash: hashForLog(userId),
        authMode,
      });
      trackingContext = await startMcpSession({
        requestId,
        userId,
        endpoint: url.pathname,
        platform: inferPlatform(getHeaderValue(req, 'user-agent'), url.pathname),
        authMode,
        method: req.method,
        path: url.pathname,
        userAgent: getHeaderValue(req, 'user-agent'),
        clientIp: getClientIp(req),
      });
      await runWithMcpTrackingContext(trackingContext, async () => {
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
    });
    return true;
  } catch (error) {
    const message = getErrorMessage(error);
    if (!trackingFinished) {
      trackingFinished = true;
      void finishMcpSession(trackingContext, {
        status: 'failed',
        statusCode: res.statusCode >= 400 ? res.statusCode : 500,
        durationMs: Math.round(performance.now() - requestStartedAt),
        errorMessage: message,
      });
    }
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
    return true;
  }
}
