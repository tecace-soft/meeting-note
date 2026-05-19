import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getEnv } from '../lib/env.js';
import { createMeetingNoteMcpServer } from '../server.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function isAuthorized(req: IncomingMessage, apiKey: string | undefined): boolean {
  if (!apiKey) return true;
  return req.headers.authorization === `Bearer ${apiKey}`;
}

export async function startHttpServer(): Promise<void> {
  const env = getEnv();
  const server = createMeetingNoteMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

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

      await transport.handleRequest(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown server error';
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.end();
    }
  });

  httpServer.listen(env.port, () => {
    process.stderr.write(`Meeting Note MCP HTTP server listening on port ${env.port}\n`);
  });
}
