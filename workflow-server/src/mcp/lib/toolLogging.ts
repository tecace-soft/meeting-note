import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { recordMcpToolCall } from './mcpTracking.js';

type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
};

type ToolCallback = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult> | CallToolResult;

const EVALUATION_TOOL_NAMES = new Set(['log_final_answer']);
const TRACKING_FIELD_DESCRIPTIONS = {
  user_intent: 'Required. Restate the user request or goal that caused this tool call. Include the relevant original phrasing when available.',
  reason_for_tool_choice: 'Required. Explain why this tool is the correct tool for the user request.',
  expected_answer_type: 'Optional. Describe what kind of answer this tool call should help produce.',
};

function previewResult(result: CallToolResult): string {
  const text = result.content
    ?.map((item) => ('text' in item && typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim() ?? '';
  return text.length > 2000 ? `${text.slice(0, 2000)}\n\n[truncated]` : text;
}

function sanitizeInput(args: Record<string, unknown>): Record<string, unknown> {
  const { user_intent: _userIntent, reason_for_tool_choice: _reason, expected_answer_type: _expected, ...rest } = args;
  return rest;
}

function withTrackingSchema(toolName: string, config: ToolConfig): ToolConfig {
  if (EVALUATION_TOOL_NAMES.has(toolName)) return config;
  return {
    ...config,
    description: [
      config.description,
      'For evaluation, always provide user_intent and reason_for_tool_choice. These fields help Meeting Note audit whether the correct MCP tool was used.',
    ].filter(Boolean).join('\n\n'),
    inputSchema: {
      ...(config.inputSchema ?? {}),
      user_intent: z.string().min(1).describe(TRACKING_FIELD_DESCRIPTIONS.user_intent),
      reason_for_tool_choice: z.string().min(1).describe(TRACKING_FIELD_DESCRIPTIONS.reason_for_tool_choice),
      expected_answer_type: z.string().optional().describe(TRACKING_FIELD_DESCRIPTIONS.expected_answer_type),
    },
  };
}

export function addToolExecutionLogging(server: McpServer): void {
  const target = server as unknown as {
    registerTool: (name: string, config: ToolConfig, callback: ToolCallback) => unknown;
  };
  const originalRegisterTool = target.registerTool.bind(server);

  target.registerTool = (name: string, config: ToolConfig, callback: ToolCallback) => {
    const nextConfig = withTrackingSchema(name, config);
    return originalRegisterTool(name, nextConfig, async (args, extra) => {
      const startedAt = performance.now();
      try {
        const result = await callback(args, extra);
        recordMcpToolCall({
          tool: name,
          userIntent: typeof args.user_intent === 'string' ? args.user_intent : undefined,
          reasonForToolChoice: typeof args.reason_for_tool_choice === 'string' ? args.reason_for_tool_choice : undefined,
          expectedAnswerType: typeof args.expected_answer_type === 'string' ? args.expected_answer_type : undefined,
          input: sanitizeInput(args),
          outputPreview: previewResult(result),
          outcome: result.isError ? 'error' : 'success',
          durationMs: Math.round(performance.now() - startedAt),
          errorMessage: result.isError ? previewResult(result) : undefined,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordMcpToolCall({
          tool: name,
          userIntent: typeof args.user_intent === 'string' ? args.user_intent : undefined,
          reasonForToolChoice: typeof args.reason_for_tool_choice === 'string' ? args.reason_for_tool_choice : undefined,
          expectedAnswerType: typeof args.expected_answer_type === 'string' ? args.expected_answer_type : undefined,
          input: sanitizeInput(args),
          outcome: 'error',
          durationMs: Math.round(performance.now() - startedAt),
          errorMessage: message,
        });
        throw error;
      }
    });
  };
}
