#!/usr/bin/env node
// Builds the AX-KH "Meeting Note 현황" node body from an explicit allowlist
// (scripts/axkh-node/sources.json), scans it, and writes a gitignored preview.
// It never calls AX-KH and never reads an AX-KH key; publishing is done by an agent
// session via add_knowledge (see docs/axkh-node/README.md).
//
//   node scripts/axkh-node/assemble.mjs                       build + scan + write preview
//   node scripts/axkh-node/assemble.mjs --check               print stale/current (exit 0)
//   node scripts/axkh-node/assemble.mjs --record-published --doc-key K --url U
//   add --as-of YYYY-MM-DD to pin the date (default: today, local)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDecisions } from '../decisions/check.mjs'
import {
  buildBody,
  checkStale,
  extractIntro,
  extractRecentCommits,
  formatFindings,
  hashBody,
  scanText,
  validatePublishRecord,
} from './lib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCES_PATH = 'scripts/axkh-node/sources.json'
const PUBLISHED_PATH = 'docs/axkh-node/published.json'
const OUT_DIR = '.axkh'
const OUT_BODY = `${OUT_DIR}/meeting-note-node.md`
const OUT_META = `${OUT_DIR}/meeting-note-node.json`
const MAX_DOCS = 20
const GIT_TIMEOUT_MS = 15_000
const MAX_SCAN_COMMITS = 500
const DEFAULT_SCAN_COMMITS = 200
const SLUG_PATTERN = /^[a-z0-9-]+$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MODES = ['intro', 'summary']

function isRelativeInside(p) {
  return typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.includes('..') && !/^[A-Za-z]:/.test(p)
}

/** Validates sources.json. Returns a list of problems. */
export function validateConfig(c) {
  const errors = []
  if (!c || typeof c !== 'object') return ['config must be an object']
  for (const k of ['title', 'productSlug', 'securityLevel']) {
    if (typeof c[k] !== 'string' || c[k].trim() === '') errors.push(`${k} must be a non-empty string`)
  }
  if (!Array.isArray(c.productDocs) || c.productDocs.length === 0 || c.productDocs.length > MAX_DOCS) {
    errors.push(`productDocs must have 1-${MAX_DOCS} entries`)
  } else {
    for (const d of c.productDocs) {
      if (!SLUG_PATTERN.test(d?.slug ?? '')) errors.push(`bad product doc slug: ${d?.slug}`)
      if (!MODES.includes(d?.mode)) errors.push(`bad mode for ${d?.slug}: ${d?.mode}`)
    }
  }
  if (c.history?.scanCommits !== undefined && (!Number.isInteger(c.history.scanCommits) || c.history.scanCommits < 1 || c.history.scanCommits > MAX_SCAN_COMMITS)) {
    errors.push(`history.scanCommits must be 1-${MAX_SCAN_COMMITS}`)
  }
  if (!Array.isArray(c.history?.excludeCommitPrefixes)) errors.push('history.excludeCommitPrefixes must be a list')
  if (!isRelativeInside(c.story?.file)) errors.push('story.file must be a repo-relative path')
  if (!Number.isInteger(c.history?.maxCommits) || c.history.maxCommits < 1 || c.history.maxCommits > 50) errors.push('history.maxCommits must be 1-50')
  if (!isRelativeInside(c.decisions?.dir)) errors.push('decisions.dir must be a repo-relative path')
  if (!Array.isArray(c.decisions?.statuses) || c.decisions.statuses.length === 0) errors.push('decisions.statuses must be a non-empty list')
  if (!isRelativeInside(c.currentWork?.file)) errors.push('currentWork.file must be a repo-relative path')
  if (!Array.isArray(c.allowedUrlPrefixes)) errors.push('allowedUrlPrefixes must be a list')
  return errors
}

function readText(root, rel) {
  return readFileSync(join(root, rel), 'utf8')
}

function collectProductDocs(root, config) {
  const manifest = JSON.parse(readText(root, 'workflow-server/content/product-docs/manifest.json'))
  const bySlug = new Map(manifest.docs.map((d) => [d.slug, d]))
  const docs = config.productDocs.map((entry) => {
    const meta = bySlug.get(entry.slug)
    if (!meta) throw new Error(`product doc not in manifest: ${entry.slug}`)
    return { entry, meta }
  })
  const overviewEntry = docs.find((d) => d.entry.mode === 'intro')
  if (!overviewEntry) throw new Error('productDocs needs one entry with mode "intro"')
  const overview = extractIntro(readText(root, `workflow-server/content/product-docs/${overviewEntry.entry.slug}.md`))
  const systemSummaries = docs.filter((d) => d.entry.mode === 'summary').map((d) => ({ title: d.meta.title, summary: d.meta.summary }))
  const revisions = docs.map((d) => ({ name: `제품 문서 ${d.meta.slug}`, revision: d.meta.revision }))
  return { overview, systemSummaries, revisions }
}

function collectDecisions(root, config) {
  const { decisions, problems } = loadDecisions(join(root, config.decisions.dir))
  if (problems.length > 0) throw new Error(`malformed decision files: ${problems.join('; ')}`)
  const picked = decisions.filter((d) => config.decisions.statuses.includes(d.status))
  return { picked, revision: `${picked.length}건 (${picked.at(0)?.id ?? '-'} ~ ${picked.at(-1)?.id ?? '-'})` }
}

/**
 * Newest-first non-merge commit subjects from git (HEAD of `root`), at most `count`.
 * Throws a clear error when git is unavailable or `root` is not a repository.
 */
export function readGitSubjects(root, count) {
  try {
    const out = execFileSync('git', ['log', '-n', String(count), '--no-merges', '--pretty=format:%s'], { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS })
    return out.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch (err) {
    throw new Error(`cannot read recent commits from git (the AX-KH node needs a git checkout): ${err.message}`)
  }
}

/**
 * Assembles the body. Reads ONLY the files named by `config` (plus the manifest and git log).
 * `asOf`, `commit` and optionally `commitSubjects` are injected for determinism and tests;
 * when `commitSubjects` is omitted the subjects are read from git.
 */
export function assemble(root, config, { asOf, commit, commitSubjects }) {
  const problems = validateConfig(config)
  if (problems.length > 0) throw new Error(`invalid ${SOURCES_PATH}: ${problems.join('; ')}`)
  if (!DATE_PATTERN.test(asOf)) throw new Error('asOf must be YYYY-MM-DD')
  const docs = collectProductDocs(root, config)
  const subjects = commitSubjects ?? readGitSubjects(root, config.history.scanCommits ?? DEFAULT_SCAN_COMMITS)
  const story = readText(root, config.story.file)
  const dec = collectDecisions(root, config)
  const currentWork = readText(root, config.currentWork.file)
  const parts = {
    title: config.title,
    overview: docs.overview,
    systemSummaries: docs.systemSummaries,
    narrative: story.trim(),
    commits: extractRecentCommits(subjects, config.history.maxCommits, config.history.excludeCommitPrefixes),
    decisions: dec.picked,
    currentWork,
    sourceRevisions: [...docs.revisions, { name: '결정 기록', revision: dec.revision }, { name: '변천 파일', revision: config.story.file }, { name: '현재 진행 중 파일', revision: config.currentWork.file }],
  }
  const body = buildBody(parts, { asOf, commit })
  return { body, bodyHash: hashBody(body), sources: parts.sourceRevisions }
}

export function parseArgs(argv) {
  const opts = { mode: 'build', asOf: null, docKey: null, url: null }
  const valueFlags = { '--as-of': 'asOf', '--doc-key': 'docKey', '--url': 'url' }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--check') opts.mode = 'check'
    else if (a === '--record-published') opts.mode = 'record'
    else if (a in valueFlags) {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`)
      opts[valueFlags[a]] = argv[i + 1]
      i += 1
    } else throw new Error(`unknown argument: ${a}`)
  }
  return opts
}

function todayLocal() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function headCommit() {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim()
}

function readPublished() {
  const p = join(ROOT, PUBLISHED_PATH)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

/** Builds and scans; on findings removes stale outputs and returns null (fail closed). */
function buildAndScan(opts) {
  const config = JSON.parse(readText(ROOT, SOURCES_PATH))
  const result = assemble(ROOT, config, { asOf: opts.asOf ?? todayLocal(), commit: headCommit() })
  const findings = scanText(result.body, { file: OUT_BODY, allowedUrlPrefixes: config.allowedUrlPrefixes })
  if (findings.length > 0) {
    rmSync(join(ROOT, OUT_BODY), { force: true })
    rmSync(join(ROOT, OUT_META), { force: true })
    console.error(`Scanner blocked the body (${findings.length} finding(s)); nothing written. Fix the allowlist/sources:`)
    console.error(formatFindings(findings))
    return null
  }
  return { config, result }
}

function runBuild(opts) {
  const built = buildAndScan(opts)
  if (!built) return 1
  const { config, result } = built
  mkdirSync(join(ROOT, OUT_DIR), { recursive: true })
  writeFileSync(join(ROOT, OUT_BODY), result.body, 'utf8')
  const asOf = opts.asOf ?? todayLocal()
  const meta = { title: config.title, productSlug: config.productSlug, securityLevel: config.securityLevel, asOf, bodyHash: result.bodyHash, sources: result.sources }
  writeFileSync(join(ROOT, OUT_META), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  const stale = checkStale(result.bodyHash, readPublished())
  console.log(`Preview: ${OUT_BODY} (${Buffer.byteLength(result.body, 'utf8')} bytes), bodyHash ${result.bodyHash.slice(0, 12)}, ${stale.stale ? 'stale' : 'current'} (${stale.reason}).`)
  return 0
}

function runCheck(opts) {
  const built = buildAndScan(opts)
  if (!built) return 1
  const stale = checkStale(built.result.bodyHash, readPublished())
  console.log(stale.stale ? `stale (${stale.reason})` : `current (${stale.reason})`)
  return 0
}

/** Returns a problem string when the preview hash no longer matches the current sources, else null. */
export function verifyPreviewHash(previewHash, currentHash) {
  if (typeof previewHash !== 'string' || previewHash === '') return 'preview has no bodyHash; rebuild it with "npm run axkh:node"'
  if (previewHash !== currentHash) return 'sources changed since the preview was built (hash mismatch); rebuild and republish before recording'
  return null
}

function runRecord(opts) {
  const problems = validatePublishRecord({ docKey: opts.docKey, url: opts.url })
  const metaPath = join(ROOT, OUT_META)
  if (!existsSync(metaPath)) problems.push(`no scanned preview found; run "npm run axkh:node" first`)
  if (problems.length > 0) {
    console.error(`Not recorded: ${problems.join('; ')}`)
    return 1
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  const built = buildAndScan({ asOf: meta.asOf })
  if (!built) return 1
  const mismatch = verifyPreviewHash(meta.bodyHash, built.result.bodyHash)
  if (mismatch) {
    console.error(`Not recorded: ${mismatch}`)
    return 1
  }
  const record = { docKey: opts.docKey, url: opts.url, bodyHash: meta.bodyHash, asOf: meta.asOf, publishedAt: new Date().toISOString() }
  writeFileSync(join(ROOT, PUBLISHED_PATH), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  console.log(`Recorded publish: asOf ${record.asOf}, bodyHash ${record.bodyHash.slice(0, 12)}.`)
  return 0
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.asOf !== null && !DATE_PATTERN.test(opts.asOf)) throw new Error('--as-of must be YYYY-MM-DD')
  if (opts.mode === 'check') return runCheck(opts)
  if (opts.mode === 'record') return runRecord(opts)
  return runBuild(opts)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main()
  } catch (err) {
    console.error(`axkh-node failed: ${err.message}`)
    process.exitCode = 1
  }
}
