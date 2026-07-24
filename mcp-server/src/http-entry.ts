#!/usr/bin/env node
import { sendMcpAlert } from './lib/alerts.js';
import { logError, logEvent } from './lib/logger.js';
import { startHttpServer } from './transports/http.js';

startHttpServer().catch(async (error) => {
  logError('mcp_http_server_start_failed', error);
  await sendMcpAlert({
    title: 'MCP server failed to start',
    severity: 'critical',
    error,
    dedupeKey: 'mcp-server-start-failed',
  });
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  logError('mcp_unhandled_rejection', error);
  void sendMcpAlert({
    title: 'MCP unhandled rejection',
    severity: 'critical',
    error,
    dedupeKey: 'mcp-unhandled-rejection',
  });
});

process.on('uncaughtException', (error) => {
  logError('mcp_uncaught_exception', error);
  void sendMcpAlert({
    title: 'MCP uncaught exception',
    severity: 'critical',
    error,
    dedupeKey: 'mcp-uncaught-exception',
  }).finally(() => process.exit(1));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logEvent('warn', 'mcp_shutdown_signal', { signal });
    void sendMcpAlert({
      title: 'MCP server received shutdown signal',
      severity: 'warning',
      message: `The MCP server received ${signal}. Render may be restarting or stopping the service.`,
      context: { signal },
      dedupeKey: `mcp-shutdown-${signal}`,
    }).finally(() => process.exit(0));
  });
}
