import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getScopedUserId } from './supabase.js';
import { logError, logEvent } from './logger.js';
import { recordMcpToolCall } from './mcpTracking.js';

function hashUserId(userId: string | undefined): string | null {
  if (!userId) return null;
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function addToolExecutionLogging(server: McpServer): void {
  const target = server as unknown as {
    registerTool: (...args: unknown[]) => unknown;
  };
  const registerTool = target.registerTool.bind(server);

  target.registerTool = (...args: unknown[]) => {
    const toolName = typeof args[0] === 'string' ? args[0] : 'unknown_tool';
    const handler = args[2];
    if (typeof handler !== 'function') return registerTool(...args);

    args[2] = async (...handlerArgs: unknown[]) => {
      const startedAtMs = Date.now();
      const startedAt = new Date();
      const userHash = hashUserId(getScopedUserId());
      logEvent('info', 'mcp_tool_started', { toolName, userHash });
      try {
        const result = await handler(...handlerArgs);
        const durationMs = Date.now() - startedAtMs;
        logEvent('info', 'mcp_tool_completed', {
          toolName,
          userHash,
          durationMs,
          isError: Boolean((result as { isError?: boolean } | undefined)?.isError),
        });
        void recordMcpToolCall({
          toolName,
          argumentsValue: handlerArgs[0],
          resultValue: result,
          isError: Boolean((result as { isError?: boolean } | undefined)?.isError),
          durationMs,
          startedAt,
        });
        return result;
      } catch (error) {
        const durationMs = Date.now() - startedAtMs;
        logError('mcp_tool_failed', error, {
          toolName,
          userHash,
          durationMs,
        });
        void recordMcpToolCall({
          toolName,
          argumentsValue: handlerArgs[0],
          isError: true,
          errorMessage: error instanceof Error ? error.message : String(error),
          durationMs,
          startedAt,
        });
        throw error;
      }
    };

    return registerTool(...args);
  };
}
