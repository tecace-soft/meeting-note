import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getMeetingNoteUserIdFromAzureToken } from '../lib/azureToken.js';
import { getEnv } from '../lib/env.js';
import { runWithScopedUserId } from '../lib/supabase.js';
import { createMeetingNoteMcpServer } from '../server.js';

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

function isAuthorized(req: IncomingMessage, apiKey: string | undefined): boolean {
  if (!apiKey) return true;
  return req.headers.authorization === `Bearer ${apiKey}`;
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
  return {
    resource: resolvedResource,
    authorization_servers: ['https://login.microsoftonline.com/common/v2.0'],
    scopes_supported: [resolvedScope],
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

export async function startHttpServer(): Promise<void> {
  const env = getEnv();

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (url.pathname === '/health') {
        sendJson(res, 200, { ok: true, service: 'meeting-note-mcp' });
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

      if (isClaudeEndpoint && !isAuthorized(req, env.mcpApiKey)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      const bearerToken = getBearerToken(req);
      const userId = isChatGptEndpoint
        ? await resolveChatGptUserId(bearerToken, env)
        : getHeaderValue(req, 'x-meeting-note-user-id') ?? env.meetingNoteUserId;

      if (!userId) {
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
        const server = createMeetingNoteMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        res.on('finish', () => {
          void server.close().catch((closeError) => {
            const closeMessage = closeError instanceof Error ? closeError.message : String(closeError);
            process.stderr.write(`Failed to close MCP request server: ${closeMessage}\n`);
          });
        });
        await transport.handleRequest(req, res);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown server error';
      const stack = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`MCP HTTP request failed: ${stack}\n`);
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.end();
    }
  });

  httpServer.listen(env.port, () => {
    process.stderr.write(`Meeting Note MCP HTTP server listening on port ${env.port}\n`);
  });
}
