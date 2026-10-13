import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorResult, jsonResult } from '../lib/formatters.js';
import { isScopedCallerOrgVerified } from '../lib/supabase.js';
import { loadProductDoc, loadProductDocsIndex } from '../../productDocs.js';

// Product docs are shared TecAce-internal specs: every caller receives the same bytes, so the
// per-user note scoping does NOT protect them. Require an org-verified caller (static key /
// personal token / tenant-checked). An unverified caller (e.g. the ChatGPT Graph-/me fallback)
// is refused here even though it may still read its OWN notes via the user-scoped tools.
const ORG_REQUIRED =
  'Reading product docs requires an organization-verified Meeting Note connection (static key or personal token).';

export function registerProductDocsTools(server: McpServer): void {
  server.registerTool(
    'get_product_docs',
    {
      title: 'Get Product Docs',
      description:
        'Read Meeting Note product documentation written for AI agents and people: product overview, the AI-agent guide, the F2 feedback/issues spec, the MCP connection guide, and release history. Call with no slug to list the available docs; call with a slug to fetch that doc as markdown. TecAce-internal; requires an org-verified connection.',
      inputSchema: {
        slug: z.string().regex(/^[a-z0-9-]+$/, 'Use a lowercase-kebab slug.').optional(),
      },
    },
    async ({ slug }) => {
      if (!isScopedCallerOrgVerified()) return errorResult(ORG_REQUIRED);
      if (!slug) {
        return jsonResult(await loadProductDocsIndex());
      }
      const doc = await loadProductDoc(slug);
      if (!doc) return errorResult(`Unknown product doc slug: ${slug}`);
      return jsonResult(doc);
    },
  );
}
