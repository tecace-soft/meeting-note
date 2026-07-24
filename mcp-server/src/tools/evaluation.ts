import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult } from '../lib/formatters.js';
import { recordMcpFinalAnswer } from '../lib/mcpTracking.js';

export function registerEvaluationTools(server: McpServer): void {
  server.registerTool(
    'log_final_answer',
    {
      title: 'Log Final Answer',
      description:
        'Optional evaluation tool. Call this after producing the final user-facing answer when the MCP client allows it, so Meeting Note can evaluate the final response quality.',
      inputSchema: {
        user_query: z.string().optional().describe('The original user query when available.'),
        final_answer: z.string().min(1).describe('The final answer that will be shown to the user.'),
        answer_quality_notes: z.string().optional().describe('Optional notes about uncertainty, missing data, or tool limitations.'),
      },
    },
    async ({ final_answer, user_query, answer_quality_notes }) => {
      recordMcpFinalAnswer(String(final_answer));
      return jsonResult({
        logged: true,
        userQueryProvided: Boolean(user_query),
        qualityNotesProvided: Boolean(answer_quality_notes),
      });
    },
  );
}
