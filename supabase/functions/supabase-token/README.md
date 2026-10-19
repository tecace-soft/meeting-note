# Verified identity for meeting knowledge (PR1 foundation)

The optional identity upgrade validates a Microsoft **ID token** for an explicitly configured Meeting Note app. It does not infer a tenant from a display name, an email domain, an opaque Graph token, or decoded unsigned claims. The existing Graph `/me` call still validates the paired Graph access token and supplies the object ID; that ID must match the signed ID-token object ID.

The browser sends `x-ms-id-token` from the same MSAL acquisition result as `x-ms-access-token`. The server verifies RS256 using the allowlisted tenant's fixed Microsoft JWKS endpoint, exact v2 issuer, configured app audience, mandatory time/identity claims and Graph object-ID binding. Its new JWT claim is:

```json
{"app_metadata":{"meeting_knowledge_identity":{"tenantId":"<verified tenant UUID>","objectId":"<verified object UUID>","verified":true}}}
```

The signed Supabase JWT retains the existing authenticated role and object-ID subject. Its lifetime cannot exceed the verified ID token's expiry. `user_metadata` is not an authorization authority. The workflow-server's `knowledge/identity.ts` verifies the resulting Supabase signature, issuer/audience/role/time/allowlist and exact subject binding before exposing this identity to future knowledge-management endpoints.

## Rollout settings

Configure these in **Supabase Edge Function secrets**, not browser variables:

| Setting | Use |
| --- | --- |
| `MEETING_KNOWLEDGE_VERIFY_IDENTITY` | Exact `true` opts in; default is disabled |
| `ALLOWED_MS_TENANT_IDS` | Existing comma-separated allowed tenant UUIDs, required for the identity upgrade |
| `MS_ID_TOKEN_CLIENT_IDS` | Comma-separated UUID audiences for explicitly approved Meeting Note app registrations |
| `MSAL_CLIENT_ID` | Explicit single-app fallback if the audience list is absent |
| `SUPABASE_TOKEN_REQUIRE_ID_TOKEN` | Exact `true` refuses every exchange without a verified ID token (legacy path off). Default off; requires `MEETING_KNOWLEDGE_VERIFY_IDENTITY=true`, else 503 |
| `MS_KNOWN_CLIENT_IDS` | Extra app registrations (UUID list) whose Graph tokens are expected, added to `MS_ID_TOKEN_CLIENT_IDS` / `MSAL_CLIENT_ID` for the `appid`/`azp` check |
| `MS_TOKEN_REQUIRE_KNOWN_CLIENT` | Exact `true` denies (403) a Graph token issued to an app that is not a known client; 500 if none is configured. Default off: unknown clients are only logged as `{"event":"ms_token_client_check","reason","client","knownClient":false,"enforced"}` (no client id) |

## Login gate (security review 2026-10-15)

`ALLOWED_MS_TENANT_IDS` is the only login gate for this function and for every function that imports `_shared/msGraphAllowlist.ts`. An empty value fails closed (500). The email or Graph `mail` domain is never consulted: any Entra tenant admin can set `mail` to an address in a domain they do not own, so the former "tenant OR email domain" rule let an outside tenant mint an app JWT. `ALLOWED_EMAIL_DOMAINS` is ignored and only logs a warning; remove the secret.

The tenant comes from the verified ID token, or, on the legacy path (no `x-ms-id-token`), from the `tid` of the access token that Graph `/me` has just accepted. Personal Microsoft account tokens are opaque, carry no tenant and are denied. The Graph `/me` id must be a UUID and equal the token's `oid` (401 otherwise); a Graph timeout (8 s) is a 503. B2B guests of an allowlisted tenant who sign in through that tenant's authority carry its `tid` and are allowed.

Every legacy exchange logs one line `{"event":"supabase_token_legacy_exchange","reason":...,"client":"mobile|browser|other","outcome":...}` with no user or token data. When those lines stop appearing for a release cycle, set `SUPABASE_TOKEN_REQUIRE_ID_TOKEN=true`, then delete the legacy branch in `handler.ts`.

The existing JWT signing secret remains server-only. Do not assume AXKH's Vercel SSO app audience is the Meeting Note app audience. Obtain the approved app/tenant IDs from existing configuration rather than broadening the allowlist. An enabled but incomplete configuration returns503. An invalid supplied ID token returns401 without falling back to weaker knowledge identity. Disabled verification or a legacy client without an ID token receives no new verified identity; knowledge operations must deny such tokens. Legacy login is not evidence of a verified knowledge identity.

Deploy this Edge Function **before** the frontend: the new `x-ms-id-token` header must be accepted by CORS preflight even while verification is disabled. Keep the identity flag disabled until actual MS SSO, token refresh and cross-tenant rejection have been tested against a development deployment. Both frontend and backend code are prepared here; no deployment or flag activation has been performed.

The new source policy and AXKH gate are internal modules. Confirmed attendance/revocation persistence, verified tenant ownership mapping, an authenticated HTTP/MCP access-check transport, current revision lookup and database/RLS tests still need implementation before meeting search/export can use them. No new audience grant is created by this exchange.

## Tests

The shared helper and actual exchange handler have Deno tests using ephemeral local RSA keys to exercise real signatures, signed Supabase responses, CORS, legacy compatibility and negative tenant/audience/object/time cases. Graph/JWKS HTTP replies are synthetic; they do not contact Microsoft or substitute for multi-user SSO tests. The entrypoint uses the current Supabase-documented native `Deno.serve`, and the handler is separate so tests never start a server.

Run `deno check supabase/functions/supabase-token/index.ts`. Run the three test files with permission for the ten synthetic configuration keys used by the handler:

```sh
deno test --allow-env=MEETING_KNOWLEDGE_VERIFY_IDENTITY,ALLOWED_MS_TENANT_IDS,ALLOWED_EMAIL_DOMAINS,MS_ID_TOKEN_CLIENT_IDS,MSAL_CLIENT_ID,SUPABASE_JWT_SECRET,JWT_SECRET,SUPABASE_TOKEN_REQUIRE_ID_TOKEN,MS_TOKEN_REQUIRE_KNOWN_CLIENT,MS_KNOWN_CLIENT_IDS supabase/functions/_shared/verified-microsoft-identity.test.ts supabase/functions/_shared/msGraphAllowlist.test.ts supabase/functions/supabase-token/handler.test.ts
```

Test dependencies are pinned (`jose@6.2.10`) and may be fetched into an isolated cache. Never use production credentials in these tests.
