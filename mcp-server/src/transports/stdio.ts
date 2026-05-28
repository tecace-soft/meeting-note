import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMeetingNoteMcpServer } from '../server.js';

export async function startStdioServer(): Promise<void> {
  const server = createMeetingNoteMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
