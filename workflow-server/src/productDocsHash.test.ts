import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bodyHash, computeFreshness, extractBody, normalizeLineEndings, type ProductDocMeta } from './productDocs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(ROOT, 'content', 'product-docs');

const LF_DOC = '---\ntitle: "T"\nslug: t\n---\n\n# Heading\n\nline one\nline two\n';

test('CRLF, CR and LF documents produce the same body and hash', () => {
  const crlf = LF_DOC.replace(/\n/g, '\r\n');
  const cr = LF_DOC.replace(/\n/g, '\r');
  assert.equal(extractBody(crlf), extractBody(LF_DOC));
  assert.equal(extractBody(cr), extractBody(LF_DOC));
  assert.equal(bodyHash(extractBody(crlf)), bodyHash(extractBody(LF_DOC)));
  assert.equal(bodyHash(extractBody(cr)), bodyHash(extractBody(LF_DOC)));
});

test('normalizeLineEndings leaves LF-only text untouched', () => {
  assert.equal(normalizeLineEndings('a\nb\n'), 'a\nb\n');
  assert.equal(normalizeLineEndings('a\r\nb\rc\n'), 'a\nb\nc\n');
});

test('computeFreshness is fresh for a CRLF checkout of a verified LF body, stale when edited', () => {
  const meta = {
    slug: 't', title: 'T', section: 's', order: 0, revision: 'r',
    verified_revision: 'abc1234', verified_body_hash: bodyHash(extractBody(LF_DOC)),
  } as ProductDocMeta;
  assert.equal(computeFreshness(meta, extractBody(LF_DOC.replace(/\n/g, '\r\n'))).freshness, 'fresh');
  const edited = computeFreshness(meta, extractBody(`${LF_DOC}extra\n`));
  assert.equal(edited.freshness, 'stale');
  assert.deepEqual(edited.stale_reasons, ['body edited since verification']);
});

// Guards the real manifest: every doc's verified_body_hash must validate against the content
// GIT stores (what the deploy serves), independent of the local checkout's line endings.
test('every manifest verified_body_hash matches the committed (HEAD) content', (t) => {
  let headHasDocs = true;
  try {
    execFileSync('git', ['cat-file', '-e', 'HEAD:workflow-server/content/product-docs/manifest.json'], { cwd: ROOT, stdio: 'ignore' });
  } catch {
    headHasDocs = false;
  }
  if (!headHasDocs) {
    t.skip('no git HEAD content available');
    return;
  }
  const manifest = JSON.parse(readFileSync(join(DOCS_DIR, 'manifest.json'), 'utf8')) as { docs: ProductDocMeta[] };
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'content/product-docs'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty) {
    t.skip('product-docs have uncommitted edits; HEAD comparison only valid on a clean tree');
    return;
  }
  for (const doc of manifest.docs) {
    const committed = execFileSync('git', ['show', `HEAD:workflow-server/content/product-docs/${doc.slug}.md`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    assert.equal(bodyHash(extractBody(committed)), doc.verified_body_hash, `${doc.slug} hash mismatch vs committed content`);
  }
});

test('product-doc manifest dependency paths are unique within each document', () => {
  const manifest = JSON.parse(readFileSync(join(DOCS_DIR, 'manifest.json'), 'utf8')) as { docs: ProductDocMeta[] };
  for (const doc of manifest.docs) {
    const paths = doc.depends_on ?? [];
    assert.equal(new Set(paths).size, paths.length, `${doc.slug} has duplicate depends_on paths`);
  }
});
