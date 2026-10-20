import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Server-held product docs. Bodies live under workflow-server/content/product-docs/
// (committed source that ships with the backend deploy, NOT in the frontend bundle),
// resolved one level up from the compiled module (mirrors how index.ts resolves .env:
// build/productDocs.js -> build/.. -> workflow-server/). Served ONLY through the authed,
// org-gated web routes and the MCP get_product_docs tool; this module does no auth itself.
const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'content', 'product-docs');
const MANIFEST_PATH = join(DOCS_DIR, 'manifest.json');

// A small, fixed doc set. Bound the on-disk inputs we validate and cache (Power of Ten 3/8).
const MAX_DOCS = 64;
const MAX_DOC_BYTES = 512 * 1024;

const SLUG_PATTERN = /^[a-z0-9-]+$/;

// The backend's current deploy commit, so freshness can report what code the docs are being
// served against. Unset (e.g. local dev) -> null -> surfaced as "unknown".
const CURRENT_COMMIT = (process.env.RENDER_GIT_COMMIT ?? '').trim() || null;

const docMetaSchema = z.object({
  slug: z.string().regex(SLUG_PATTERN),
  title: z.string().min(1),
  section: z.string().min(1),
  order: z.number().int().min(0),
  revision: z.string().min(1),
  summary: z.string().min(1).optional(),
  // Verification record (tied to the body, not just time) so an edited or regenerated body
  // flips to "needs re-verification". verified_revision = the commit a human last checked the
  // body against; verified_body_hash = sha256 of the stripped body at that verification.
  verified_revision: z.string().min(1).optional(),
  verified_at: z.string().min(1).optional(),
  verified_body_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  verified_by: z.string().min(1).optional(),
  // Code paths this doc describes / is derived from (globs allowed). Used by the CI drift check
  // (git-based) to flag a doc whose source changed since verified_revision. Not read at runtime.
  depends_on: z.array(z.string().min(1)).max(64).optional(),
  // Generated docs are extracted from code, so "generated" is not "verified".
  generated: z.boolean().optional(),
});
export type ProductDocMeta = z.infer<typeof docMetaSchema>;

const manifestSchema = z.object({
  sections: z.array(z.string().min(1)).min(1),
  docs: z.array(docMetaSchema).max(MAX_DOCS),
});
export type ProductDocsManifest = z.infer<typeof manifestSchema>;

export type Freshness = 'fresh' | 'stale' | 'unknown';

export interface DocFreshness {
  freshness: Freshness;
  checked_against_commit: string;
  stale_reasons: string[];
}

export interface ProductDocListItem {
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

export interface ProductDoc extends ProductDocMeta, DocFreshness {
  markdown: string;
}

// Manifest and bodies are immutable per deploy; read + validate once, then cache. The derived
// index (freshness + body hashes) is likewise constant per process, so it is memoized too.
let manifestCache: ProductDocsManifest | null = null;
const bodyCache = new Map<string, string>();
let indexCache: { sections: string[]; docs: ProductDocListItem[] } | null = null;

export async function loadProductDocsManifest(): Promise<ProductDocsManifest> {
  if (manifestCache) return manifestCache;
  let raw: string;
  try {
    raw = await readFile(MANIFEST_PATH, 'utf8');
  } catch (error) {
    // Propagate with context rather than swallowing: a missing manifest is a deploy fault,
    // not an empty doc set, so callers should surface an error (not pretend there are no docs).
    throw new Error(`Product docs manifest is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Product docs manifest is not valid JSON.');
  }
  // Validate the manifest at the trust boundary before any consumer reads it.
  manifestCache = manifestSchema.parse(parsed);
  return manifestCache;
}

// Normalize line endings (CRLF / lone CR -> LF). A Windows checkout can hold CRLF while git
// commits (and the deploy serves) LF, so every body is normalized BEFORE stripping/hashing:
// the hash then depends on content only, never on the checkout's line endings.
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// Strip a leading YAML frontmatter block so the returned markdown renders cleanly for humans
// and reads cleanly for agents. Only a frontmatter block at the very start is removed.
// Expects LF input (see normalizeLineEndings).
export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown;
  const closeIndex = markdown.indexOf('\n---', 3);
  if (closeIndex === -1) return markdown;
  const bodyStart = markdown.indexOf('\n', closeIndex + 1);
  return bodyStart === -1 ? '' : markdown.slice(bodyStart + 1).replace(/^\s+/, '');
}

// THE single definition of "a doc's body" and its hash. Used by the runtime loader and by the
// docs:verify / docs:check scripts so all three always agree.
export function extractBody(rawFile: string): string {
  return stripFrontmatter(normalizeLineEndings(rawFile));
}

export function bodyHash(body: string): string {
  return createHash('sha256').update(normalizeLineEndings(body), 'utf8').digest('hex');
}

// Runtime freshness the agent/human SEES, computed WITHOUT git: it detects only an edited body
// (hash != verified_body_hash) and reports the current deploy commit. It does NOT detect
// depends_on code drift, so a doc whose documented code changed (but whose body was not edited)
// still reads 'fresh'. The git-based depends_on drift check runs in CI (check.ts) but is ADVISORY
// (it does not fail the build), so code-drift is caught by human re-verification, not by this
// signal. The guide tells agents to cross-check stale/unknown docs against the code.
export function computeFreshness(meta: ProductDocMeta, body: string): DocFreshness {
  const checked_against_commit = CURRENT_COMMIT ?? 'unknown';
  const stale_reasons: string[] = [];
  if (!meta.verified_body_hash || !meta.verified_revision) {
    return { freshness: 'unknown', checked_against_commit, stale_reasons: ['no verification record'] };
  }
  if (bodyHash(body) !== meta.verified_body_hash) {
    stale_reasons.push('body edited since verification');
    return { freshness: 'stale', checked_against_commit, stale_reasons };
  }
  return { freshness: 'fresh', checked_against_commit, stale_reasons };
}

async function readBody(slug: string): Promise<string> {
  const cached = bodyCache.get(slug);
  if (cached !== undefined) return cached;
  const path = join(DOCS_DIR, `${slug}.md`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Product doc "${slug}" is in the manifest but its file is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_DOC_BYTES) {
    throw new Error(`Product doc "${slug}" exceeds the ${MAX_DOC_BYTES}-byte limit.`);
  }
  const body = extractBody(raw);
  bodyCache.set(slug, body);
  return body;
}

// The index list, with per-doc freshness. Memoized (immutable per deploy). One unreadable or
// oversized doc degrades to 'unknown' for THAT doc rather than failing the whole index.
export async function loadProductDocsIndex(): Promise<{ sections: string[]; docs: ProductDocListItem[] }> {
  if (indexCache) return indexCache;
  const manifest = await loadProductDocsManifest();
  const docs: ProductDocListItem[] = [];
  for (const meta of manifest.docs) {
    let fresh: DocFreshness;
    try {
      fresh = computeFreshness(meta, await readBody(meta.slug));
    } catch (error) {
      fresh = {
        freshness: 'unknown',
        checked_against_commit: CURRENT_COMMIT ?? 'unknown',
        stale_reasons: [`body unavailable: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
    docs.push({
      slug: meta.slug,
      title: meta.title,
      section: meta.section,
      order: meta.order,
      revision: meta.revision,
      summary: meta.summary,
      verified_at: meta.verified_at,
      freshness: fresh.freshness,
      checked_against_commit: fresh.checked_against_commit,
      stale_reasons: fresh.stale_reasons,
    });
  }
  indexCache = { sections: manifest.sections, docs };
  return indexCache;
}

export async function loadProductDoc(slug: string): Promise<ProductDoc | null> {
  // Validate the slug shape BEFORE any filesystem access (blocks path traversal), then require
  // it to exist in the manifest allowlist (the single source of truth for what is published).
  if (!SLUG_PATTERN.test(slug)) return null;
  const manifest = await loadProductDocsManifest();
  const meta = manifest.docs.find((doc) => doc.slug === slug);
  if (!meta) return null;

  const body = await readBody(slug);
  const fresh = computeFreshness(meta, body);
  return { ...meta, ...fresh, markdown: body };
}
