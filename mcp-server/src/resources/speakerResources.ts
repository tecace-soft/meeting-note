import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonResource } from '../lib/formatters.js';
import { fetchProject, fetchSpeakerByIdOrName, hasMcpScope } from '../lib/supabase.js';

function variableToString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export function registerSpeakerResources(server: McpServer): void {
  server.registerResource(
    'speaker',
    new ResourceTemplate('speaker://{speakerId}', { list: undefined }),
    {
      title: 'Speaker Profile',
      description: 'Saved speaker profile/ontology context.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      if (!hasMcpScope('notes:summary')) {
        return jsonResource(uri.href, { error: 'This MCP token does not include the notes:summary scope.' });
      }
      const speakerId = variableToString(variables.speakerId);
      const speaker = await fetchSpeakerByIdOrName({ speakerId });
      return jsonResource(
        uri.href,
        speaker
          ? { id: speaker.id, name: speaker.name, profile: speaker.profile ?? null, createdAt: speaker.created_at ?? null }
          : { error: `Speaker not found: ${speakerId}` },
      );
    },
  );

  server.registerResource(
    'project',
    new ResourceTemplate('project://{projectId}', { list: undefined }),
    {
      title: 'Project Context',
      description: 'Project metadata and note pointers.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      if (!hasMcpScope('notes:metadata')) {
        return jsonResource(uri.href, { error: 'This MCP token does not include the notes:metadata scope.' });
      }
      const projectId = variableToString(variables.projectId);
      const project = await fetchProject(projectId);
      return jsonResource(
        uri.href,
        project
          ? { id: project.id, name: project.name, noteIds: project.notes ?? [], createdAt: project.created_at ?? null }
          : { error: `Project not found: ${projectId}` },
      );
    },
  );
}
