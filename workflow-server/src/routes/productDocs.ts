import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { getBearerToken, sendJson } from '../http/shared.js';
import { resolveMicrosoftCaller } from '../microsoftIdentity.js';
import { loadProductDoc, loadProductDocsIndex } from '../productDocs.js';

// Short-lived identity cache for the click-heavy docs path, so browsing N docs does not make
// N+1 Graph /me calls (and risk 429). Keyed by a hash of the token (never the raw token); small
// TTL so a revoked token stops resolving quickly. Only successful MEMBER lookups are cached;
// non-members are re-checked every time. Bounded size (Power of Ten rule 8).
const PRODUCT_DOCS_IDENTITY_TTL_MS = 60_000;

const PRODUCT_DOCS_IDENTITY_CACHE_MAX = 256;

const productDocsIdentityCache = new Map<string, { id: string; expiresAt: number }>();

// TecAce org gate for product docs. These are internal specs served identically to every
// caller, so a valid Microsoft token is not enough: the token's tenant must be allowlisted.
// The mail / UPN domain is NOT used (an outside tenant admin can set mail to x@tecace.com).
// requireOrg: an unconfigured tenant allowlist refuses docs instead of serving everyone.
// Throws 401 (bad token) or 403 (outside tenant / gate unconfigured).
async function assertProductDocsMember(req: IncomingMessage): Promise<string> {
  const token = getBearerToken(req);
  const key = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  const cached = productDocsIdentityCache.get(key);
  if (cached && cached.expiresAt > now) return cached.id;

  const caller = await resolveMicrosoftCaller(token, { requireOrg: true, surface: 'product-docs' });
  // Simple bound: clear when full rather than tracking LRU (the set is tiny and TTL-bounded).
  if (productDocsIdentityCache.size >= PRODUCT_DOCS_IDENTITY_CACHE_MAX) productDocsIdentityCache.clear();
  productDocsIdentityCache.set(key, { id: caller.id, expiresAt: now + PRODUCT_DOCS_IDENTITY_TTL_MS });
  return caller.id;
}

async function getProductDocsIndexRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await assertProductDocsMember(req);
  const index = await loadProductDocsIndex();
  sendJson(res, 200, index);
}

async function getProductDocRoute(req: IncomingMessage, res: ServerResponse, slug: string): Promise<void> {
  await assertProductDocsMember(req);
  const doc = await loadProductDoc(slug);
  if (!doc) {
    sendJson(res, 404, { error: 'Unknown product doc.' });
    return;
  }
  sendJson(res, 200, doc);
}

export async function handleProductDocsRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/product-docs') { await getProductDocsIndexRoute(req, res); return true; }
  const productDocMatch = url.pathname.match(/^\/product-docs\/([a-z0-9-]+)$/);
  if (req.method === 'GET' && productDocMatch?.[1]) { await getProductDocRoute(req, res, productDocMatch[1]); return true; }
  return false;
}
