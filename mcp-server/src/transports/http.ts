import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getEnv } from '../lib/env.js';
import { runWithScopedUserId } from '../lib/supabase.js';
import { createMeetingNoteMcpServer } from '../server.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function isAuthorized(req: IncomingMessage, apiKey: string | undefined): boolean {
  if (!apiKey) return true;
  return req.headers.authorization === `Bearer ${apiKey}`;
}

function getHeaderValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0]?.trim() || undefined;
  return value?.trim() || undefined;
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

      if (url.pathname !== '/mcp') {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      if (!isAuthorized(req, env.mcpApiKey)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      const userId = getHeaderValue(req, 'x-meeting-note-user-id') ?? env.meetingNoteUserId;

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
