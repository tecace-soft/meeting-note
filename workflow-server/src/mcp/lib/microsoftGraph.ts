export async function getMicrosoftUserIdFromGraph(accessToken: string): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id', {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
      // Bound the auth hot path: without a timeout a stalled Graph call hangs the whole
      // request (and leaks an "active" tracking session) indefinitely. Fail closed instead.
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    console.warn(`[auth] Graph /me lookup failed or timed out: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  if (!response.ok) return undefined;

  const data = (await response.json()) as { id?: unknown };
  return typeof data.id === 'string' && data.id.trim() ? data.id.trim() : undefined;
}
