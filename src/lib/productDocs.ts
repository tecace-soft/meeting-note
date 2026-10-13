// Product docs web API client. Mirrors the meetingBriefing.ts shape (reads
// VITE_WORKFLOW_API_URL, sends a Microsoft bearer token from useAuth().getAccessToken),
// but unlike the best-effort briefing these fetches THROW on a missing token, a non-ok
// response, or a malformed payload so the /docs page can show an explicit error state
// instead of a blank screen. Contract matches workflow-server/src/productDocs.ts, which
// includes per-doc freshness (fresh | stale | unknown) so the reader can tell whether a
// doc is still trustworthy against the deployed code.

const WORKFLOW_API_URL = ((import.meta.env.VITE_WORKFLOW_API_URL as string | undefined) ?? '').replace(/\/$/, '');

export type Freshness = 'fresh' | 'stale' | 'unknown';

export interface ProductDocMeta {
  slug: string;
  title: string;
  section: string;
  order: number;
  revision: string;
  summary?: string;
  verified_at?: string;
  freshness: Freshness;
  checked_against_commit: string;
  stale_reasons: string[];
}

export interface ProductDocsIndex {
  sections: string[];
  docs: ProductDocMeta[];
}

export interface ProductDoc {
  slug: string;
  title: string;
  section: string;
  order: number;
  revision: string;
  summary?: string;
  verified_at?: string;
  verified_revision?: string;
  verified_by?: string;
  freshness: Freshness;
  checked_against_commit: string;
  stale_reasons: string[];
  markdown: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`Product docs: "${key}" is missing or not a string in ${context}.`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

// We own this enum server-side; be lenient and treat anything unexpected as "unknown"
// rather than throwing, so a future freshness value never breaks the whole page.
function toFreshness(value: unknown): Freshness {
  return value === 'fresh' || value === 'stale' ? value : 'unknown';
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function requireFiniteNumber(record: Record<string, unknown>, key: string, context: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Product docs: "${key}" is missing or not a finite number in ${context}.`);
  }
  return value;
}

/** Validate one index entry at the boundary; throw on any missing/typed-wrong required field. */
function parseDocMeta(value: unknown, index: number): ProductDocMeta {
  if (!isRecord(value)) {
    throw new Error(`Product docs: entry #${index} is not an object.`);
  }
  const context = `doc entry #${index}`;
  return {
    slug: requireString(value, 'slug', context),
    title: requireString(value, 'title', context),
    section: requireString(value, 'section', context),
    order: requireFiniteNumber(value, 'order', context),
    revision: requireString(value, 'revision', context),
    summary: optionalString(value, 'summary'),
    verified_at: optionalString(value, 'verified_at'),
    freshness: toFreshness(value.freshness),
    checked_against_commit: requireString(value, 'checked_against_commit', context),
    stale_reasons: toStringArray(value.stale_reasons),
  };
}

function assertConfigured(): string {
  if (!WORKFLOW_API_URL) {
    throw new Error('Product docs: VITE_WORKFLOW_API_URL is not configured.');
  }
  return WORKFLOW_API_URL;
}

async function requireToken(getAccessToken: () => Promise<string | null>): Promise<string> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('Product docs: you must be signed in with Microsoft to view docs.');
  }
  return token;
}

/** GET {API}/product-docs: the sidebar index (sections + doc metadata + freshness). */
export async function fetchProductDocsIndex(
  getAccessToken: () => Promise<string | null>,
): Promise<ProductDocsIndex> {
  const apiUrl = assertConfigured();
  const token = await requireToken(getAccessToken);
  const res = await fetch(`${apiUrl}/product-docs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Product docs: failed to load index (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as unknown;
  if (!isRecord(data)) {
    throw new Error('Product docs: index response is not an object.');
  }
  if (!Array.isArray(data.sections) || !data.sections.every((s) => typeof s === 'string')) {
    throw new Error('Product docs: index "sections" is missing or not a string array.');
  }
  if (!Array.isArray(data.docs)) {
    throw new Error('Product docs: index "docs" is missing or not an array.');
  }
  return {
    sections: data.sections as string[],
    docs: data.docs.map((entry, i) => parseDocMeta(entry, i)),
  };
}

/** GET {API}/product-docs/{slug}: a single doc with raw markdown (no frontmatter) + freshness. */
export async function fetchProductDoc(
  getAccessToken: () => Promise<string | null>,
  slug: string,
): Promise<ProductDoc> {
  const apiUrl = assertConfigured();
  if (!slug) {
    throw new Error('Product docs: a document slug is required.');
  }
  const token = await requireToken(getAccessToken);
  const res = await fetch(`${apiUrl}/product-docs/${encodeURIComponent(slug)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`Product docs: "${slug}" was not found.`);
    }
    throw new Error(`Product docs: failed to load "${slug}" (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as unknown;
  if (!isRecord(data)) {
    throw new Error('Product docs: document response is not an object.');
  }
  const context = `document "${slug}"`;
  return {
    slug: requireString(data, 'slug', context),
    title: requireString(data, 'title', context),
    section: requireString(data, 'section', context),
    order: requireFiniteNumber(data, 'order', context),
    revision: requireString(data, 'revision', context),
    summary: optionalString(data, 'summary'),
    verified_at: optionalString(data, 'verified_at'),
    verified_revision: optionalString(data, 'verified_revision'),
    verified_by: optionalString(data, 'verified_by'),
    freshness: toFreshness(data.freshness),
    checked_against_commit: requireString(data, 'checked_against_commit', context),
    stale_reasons: toStringArray(data.stale_reasons),
    markdown: requireString(data, 'markdown', context),
  };
}
