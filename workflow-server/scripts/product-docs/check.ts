// CI check for the product-docs system.
//
// 1. GATING: regenerate the mcp-tools generated region IN MEMORY and compare it to the region
//    committed in mcp-tools-reference.md. On any difference (including a missing file/markers),
//    print a diff summary and exit 1. Never writes.
// 2. ADVISORY (non-failing): for each doc with depends_on + verified_revision, use
//    `git diff --name-only <verified_revision>..HEAD` to report docs whose source globs changed
//    since they were verified. Advisory in v1 to avoid over-detection; does NOT affect exit code.
//
// 3. ADVISORY (non-failing): body-hash drift. Uses the SAME computeFreshness the live server uses
//    (line-ending-normalized), so a doc reported 'stale: body edited since verification' live is
//    reported here too. Advisory like (2) so it does not break CI; fix with docs:verify.
//
// Exit 1 ONLY on the generated-doc mismatch.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DOCS_DIR,
  GENERATED_FILE,
  MANIFEST_PATH,
  extractMcpTools,
  extractRegion,
  git,
  parseManifest,
  renderGeneratedRegion,
  type ManifestDocEntry,
} from './shared.js';
import { computeFreshness, extractBody, type ProductDocMeta } from '../../src/productDocs.js';

function toLines(text: string): string[] {
  return text.split('\n');
}

// Bounded, readable summary of how two region texts differ (not a full unified diff).
function diffSummary(committed: string, expected: string): string[] {
  const out: string[] = [];
  const a = toLines(committed);
  const b = toLines(expected);
  out.push(`committed region: ${a.length} lines; expected region: ${b.length} lines`);
  const headings = (lines: string[]) => new Set(lines.filter((l) => l.startsWith('### ')).map((l) => l.trim()));
  const ha = headings(a);
  const hb = headings(b);
  const added = [...hb].filter((h) => !ha.has(h));
  const removed = [...ha].filter((h) => !hb.has(h));
  if (added.length) out.push(`tools present after regen but missing in committed doc: ${added.join(', ')}`);
  if (removed.length) out.push(`tools in committed doc but gone after regen: ${removed.join(', ')}`);
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && out.length < 20; i += 1) {
    if (a[i] !== b[i]) {
      out.push(`first differing line ${i + 1}:`);
      out.push(`  committed: ${a[i] ?? '(none)'}`);
      out.push(`  expected : ${b[i] ?? '(none)'}`);
      break;
    }
  }
  return out;
}

// Minimal glob -> RegExp (supports ** , * , ?). Bounded; anchored full-match.
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i += 1; } else { re += '[^/]*'; }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function matchGlobs(files: string[], globs: string[]): string[] {
  const regexes = globs.map(globToRegExp);
  return files.filter((f) => regexes.some((r) => r.test(f)));
}

async function checkGeneratedDoc(): Promise<boolean> {
  const path = join(DOCS_DIR, GENERATED_FILE);
  const tools = await extractMcpTools();
  const expected = renderGeneratedRegion(tools);

  let committedFull: string | null = null;
  try {
    committedFull = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (committedFull === null) {
    console.error(`[docs:check] FAIL: ${GENERATED_FILE} is missing. Run "npm run docs:generate".`);
    return false;
  }
  const committedRegion = extractRegion(committedFull);
  if (committedRegion === null) {
    console.error(`[docs:check] FAIL: generated-region markers not found in ${GENERATED_FILE}.`);
    return false;
  }
  if (committedRegion === expected) {
    console.log(`[docs:check] OK: ${GENERATED_FILE} generated region matches (${tools.length} tools).`);
    return true;
  }
  console.error(`[docs:check] FAIL: ${GENERATED_FILE} generated region is stale. Run "npm run docs:generate".`);
  for (const line of diffSummary(committedRegion, expected)) console.error(`  ${line}`);
  return false;
}

function advisoryDependsOnDrift(docs: ManifestDocEntry[]): void {
  const withDeps = docs.filter(
    (d) => Array.isArray(d.depends_on) && d.depends_on.length > 0 && typeof d.verified_revision === 'string',
  );
  if (withDeps.length === 0) {
    console.log('[docs:check] advisory: no docs declare depends_on + verified_revision; nothing to check.');
    return;
  }
  let stale = 0;
  for (const doc of withDeps) {
    const rev = doc.verified_revision as string;
    const globs = (doc.depends_on as unknown[]).filter((g): g is string => typeof g === 'string');
    let changed: string[];
    try {
      const raw = git(['diff', '--name-only', `${rev}..HEAD`]);
      changed = raw ? raw.split('\n').filter(Boolean) : [];
    } catch (error) {
      console.warn(`[docs:check] advisory: cannot diff ${doc.slug} from ${rev.slice(0, 7)}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const hits = matchGlobs(changed, globs);
    if (hits.length > 0) {
      stale += 1;
      const shown = hits.slice(0, 10);
      console.log(`[docs:check] advisory: "${doc.slug}" may be stale — ${hits.length} source file(s) changed since ${rev.slice(0, 7)}:`);
      for (const f of shown) console.log(`    ${f}`);
      if (hits.length > shown.length) console.log(`    …and ${hits.length - shown.length} more`);
    }
  }
  console.log(`[docs:check] advisory: ${stale}/${withDeps.length} doc(s) with deps look stale (advisory only; not failing the build).`);
}

// Same body-hash comparison the live server performs (docs without a record are 'unknown').
async function advisoryBodyHashDrift(docs: ManifestDocEntry[]): Promise<void> {
  let problems = 0;
  for (const doc of docs) {
    const raw = await readFile(join(DOCS_DIR, `${doc.slug}.md`), 'utf8');
    const result = computeFreshness(doc as unknown as ProductDocMeta, extractBody(raw));
    if (result.freshness === 'fresh') continue;
    problems += 1;
    console.log(`[docs:check] advisory: "${doc.slug}" is ${result.freshness} live (${result.stale_reasons.join('; ')}). Re-verify with "npm run docs:verify -- --slug=${doc.slug}".`);
  }
  console.log(`[docs:check] advisory: ${problems}/${docs.length} doc(s) have body-hash mismatches or no verification record (advisory only; not failing the build).`);
}

async function main(): Promise<void> {
  const rawManifest = await readFile(MANIFEST_PATH, 'utf8');
  const manifest = parseManifest(rawManifest);

  const generatedOk = await checkGeneratedDoc();
  advisoryDependsOnDrift(manifest.docs);
  await advisoryBodyHashDrift(manifest.docs);

  if (!generatedOk) process.exit(1);
  console.log('[docs:check] PASS.');
}

main().catch((error) => {
  console.error('[docs:check] FAILED:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
