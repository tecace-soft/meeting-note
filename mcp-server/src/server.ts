import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerNoteResources } from './resources/noteResources.js';
import { registerSpeakerResources } from './resources/speakerResources.js';
import { registerContextTools } from './tools/context.js';
import { registerNoteTools } from './tools/notes.js';
import { registerProjectTools } from './tools/projects.js';
import { registerSpeakerTools } from './tools/speakers.js';

export function createMeetingNoteMcpServer(): McpServer {
  const server = new McpServer({
    name: 'meeting-note',
    version: '0.1.0',
  });

  registerNoteTools(server);
  registerSpeakerTools(server);
  registerProjectTools(server);
  registerContextTools(server);
  registerNoteResources(server);
  registerSpeakerResources(server);

  return server;
}
