import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerContextTools(_server: McpServer): void {
  // Reserved for v2 synthesis tools such as build_summary_context and build_speaker_context.
  // V1 intentionally stays read-only and retrieval-focused.
}
