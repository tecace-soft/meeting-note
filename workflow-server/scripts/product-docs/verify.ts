// Stamp a verification record into content/product-docs/manifest.json for each doc (or one
// doc via --slug). The record ties a doc to the exact body a human last checked:
//   verified_body_hash = sha256 of the frontmatter-stripped body (matches the runtime loader)
//   verified_revision  = current git HEAD
//   verified_at        = today (YYYY-MM-DD)
//   verified_by        = --by=<name> (default "Andrew Yoo")
// Legacy fields (last_verified_commit / last_verified_at) are removed. All other fields are
// preserved. The manifest is validated as JSON before and after writing.
//
// Usage:
//   npm run docs:verify                         # stamp every doc
//   npm run docs:verify -- --slug=product-overview
//   npm run docs:verify -- --by="Jane Dev"
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DOCS_DIR,
  MANIFEST_PATH,
  MAX_DOCS,
  headCommit,
  parseManifest,
  sha256Hex,
  stripFrontmatter,
  todayIso,
} from './shared.js';

function argValue(flag: string): string | undefined {
  const prefix = `${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function bodyHashForSlug(slug: string): Promise<string> {
  const path = join(DOCS_DIR, `${slug}.md`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Doc "${slug}" is in the manifest but ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return sha256Hex(stripFrontmatter(raw));
}

async function main(): Promise<void> {
  const onlySlug = argValue('--slug');
  const verifiedBy = argValue('--by') ?? 'Andrew Yoo';
  if (!verifiedBy.trim()) throw new Error('--by must be a non-empty name.');

  const rawManifest = await readFile(MANIFEST_PATH, 'utf8');
  const manifest = parseManifest(rawManifest); // validates "before"

  if (manifest.docs.length > MAX_DOCS) throw new Error(`Manifest has too many docs (${manifest.docs.length}).`);
  if (onlySlug && !manifest.docs.some((d) => d.slug === onlySlug)) {
    throw new Error(`--slug=${onlySlug} is not a doc in the manifest.`);
  }

  const revision = headCommit();
  const verifiedAt = todayIso();
  let stamped = 0;

  for (const doc of manifest.docs) {
    if (onlySlug && doc.slug !== onlySlug) continue;
    const hash = await bodyHashForSlug(doc.slug);
    // Remove legacy fields regardless of whether we re-stamp this doc's hash.
    delete doc.last_verified_commit;
    delete doc.last_verified_at;
    doc.verified_body_hash = hash;
    doc.verified_revision = revision;
    doc.verified_at = verifiedAt;
    // Generated docs are extracted from code, not human-reviewed, so attribute them to the
    // generator instead of a person (generated != verified). The body hash is still stamped so a
    // manual edit of a generated doc is still detected as stale.
    doc.verified_by = doc.generated ? 'docs:generate (generated)' : verifiedBy;
    stamped += 1;
    console.log(`[docs:verify] ${doc.slug}: hash ${hash.slice(0, 12)}… @ ${revision.slice(0, 7)}`);
  }

  const out = `${JSON.stringify(manifest, null, 2)}\n`;
  parseManifest(out); // validates "after" (throws before we write anything bad)
  await writeFile(MANIFEST_PATH, out, 'utf8');
  console.log(`[docs:verify] stamped ${stamped} doc(s) by "${verifiedBy}" at ${verifiedAt} (${revision.slice(0, 7)}).`);
}

main().catch((error) => {
  console.error('[docs:verify] FAILED:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
