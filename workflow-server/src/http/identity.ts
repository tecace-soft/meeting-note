import { resolveMicrosoftCaller, type MicrosoftCaller } from '../microsoftIdentity.js';

// Delegates to getMicrosoftProfile (single Graph /me implementation) and returns just the id.
// Keeps all authed routes on one validated, timeout-bounded, tenant-gated Graph call.
export async function getMicrosoftUserId(accessToken: string): Promise<string> {
  const profile = await getMicrosoftProfile(accessToken);
  return profile.id;
}

// Resolve the caller's Microsoft identity through the shared tenant gate (microsoftIdentity.ts):
// Graph /me validates the token, and the `tid` of that same token must be in
// ALLOWED_MS_TENANT_IDS. `email` is display data only (Graph mail, else UPN), matching the
// Supabase JWT email claim; ownership checks use `id` (the Microsoft object id).
export async function getMicrosoftProfile(accessToken: string): Promise<MicrosoftCaller> {
  return resolveMicrosoftCaller(accessToken);
}
