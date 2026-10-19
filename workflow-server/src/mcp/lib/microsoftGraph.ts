import { MicrosoftIdentityError, resolveMicrosoftCaller } from '../../microsoftIdentity.js';

export interface GraphCaller {
  userId: string;
  /** True only when ALLOWED_MS_TENANT_IDS is set and the token's tenant is in it. */
  orgVerified: boolean;
}

// Graph /me + the shared tenant gate (microsoftIdentity.ts). An outside-tenant token, an
// invalid token or a Graph timeout all resolve to undefined, so callers fail closed.
export async function resolveGraphCaller(accessToken: string, surface = 'mcp-graph'): Promise<GraphCaller | undefined> {
  try {
    const caller = await resolveMicrosoftCaller(accessToken, { surface });
    return { userId: caller.id, orgVerified: caller.orgVerified };
  } catch (error) {
    const reason = error instanceof MicrosoftIdentityError ? `status ${error.status}` : error instanceof Error ? error.message : String(error);
    console.warn(`[auth] Graph caller rejected (${reason}).`);
    return undefined;
  }
}

export async function getMicrosoftUserIdFromGraph(accessToken: string): Promise<string | undefined> {
  return (await resolveGraphCaller(accessToken))?.userId;
}
