// Pure helpers for the AX-KH node: secret/PII scanner, body assembly, hashing, stale check.
// Node built-ins only, no I/O (unit-testable). The repo never reads or stores an AX-KH key.
import { createHash } from 'node:crypto'

export const META_HEADING = '## 출처와 기준'
export const MAX_BODY_CHARS = 60_000
export const MAX_FINDINGS = 200
const SNIPPET_WIDTH = 80

const RULES = [
  { category: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  { category: 'uuid', re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g },
  { category: 'internal-host', re: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:onrender\.com|supabase\.co)\b/gi },
  { category: 'url', re: /https?:\/\/[^\s)>\]"'`]+/g },
  { category: 'key', re: /\baxk_[A-Za-z0-9_-]{6,}/g },
  { category: 'key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { category: 'key', re: /\bAIza[0-9A-Za-z_-]{20,}/g },
  { category: 'key', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g },
  { category: 'key', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g },
  { category: 'env', re: /\b[A-Z][A-Z0-9_]{3,}=\S+/g },
]

/** Masks a matched value so reports never print it in full. */
export function maskValue(value) {
  if (value.length <= 6) return `***(len ${value.length})`
  return `${value.slice(0, 2)}***${value.slice(-1)}(len ${value.length})`
}

function isAllowedUrl(match, allowedPrefixes) {
  return allowedPrefixes.some((p) => match.startsWith(p))
}

function maskLine(line, values) {
  let out = line
  for (const v of values) out = out.split(v).join(maskValue(v))
  return out.length > SNIPPET_WIDTH ? `${out.slice(0, SNIPPET_WIDTH)}...` : out
}

function lineHits(line, allowedUrlPrefixes) {
  const hits = []
  for (const rule of RULES) {
    for (const m of line.matchAll(rule.re)) {
      if (rule.category === 'url' && isAllowedUrl(m[0], allowedUrlPrefixes)) continue
      hits.push({ category: rule.category, value: m[0] })
    }
  }
  return hits
}

/**
 * Scans text and returns findings `{ file, line, category, masked, snippet }`.
 * Fails closed by design: callers must treat any finding as a hard stop.
 */
export function scanText(text, { file = 'body', allowedUrlPrefixes = [] } = {}) {
  const findings = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const hits = lineHits(lines[i], allowedUrlPrefixes)
    const values = hits.map((h) => h.value)
    for (const h of hits) {
      if (findings.length >= MAX_FINDINGS) return findings
      findings.push({ file, line: i + 1, category: h.category, masked: maskValue(h.value), snippet: maskLine(lines[i], values) })
    }
  }
  return findings
}

export function formatFindings(findings) {
  return findings.map((f) => `${f.file}:${f.line} [${f.category}] ${f.masked} | ${f.snippet}`).join('\n')
}

/** Returns the part of the body that is hashed (everything before the metadata section). */
export function hashedPart(body) {
  const idx = body.indexOf(`\n${META_HEADING}\n`)
  return idx === -1 ? body : body.slice(0, idx + 1)
}

export function hashBody(body) {
  return createHash('sha256').update(hashedPart(body), 'utf8').digest('hex')
}

function stripFrontmatter(text) {
  const t = text.replace(/\r\n/g, '\n')
  if (!t.startsWith('---\n')) return t
  const end = t.indexOf('\n---\n', 4)
  return end === -1 ? t : t.slice(end + 5)
}

/** Text between the H1 and the first H2 of a product doc (frontmatter removed). */
export function extractIntro(docText) {
  const out = []
  let started = false
  for (const line of stripFrontmatter(docText).split('\n')) {
    if (line.startsWith('## ')) break
    if (started) out.push(line)
    else if (line.startsWith('# ')) started = true
  }
  return out.join('\n').trim()
}

// Same buckets and order the retired history.md generator used (DEC-0023 keeps the AX-KH
// selection identical): commits are grouped by conventional-commit type, newest first within a group.
export const TYPE_BUCKETS = ['feat', 'fix', 'perf', 'eval', 'docs', 'other']

// em dash and en dash (git %s collapses whitespace to single spaces, so plain spaces suffice)
const DASH_PATTERN = new RegExp(' *[' + String.fromCharCode(0x2014, 0x2013) + '] *', 'g')

/** Classify "type(scope): subject" into a bucket key. */
export function bucketOf(subject) {
  const m = /^([a-z]+)(\([^)]*\))?!?:/.exec(subject)
  const type = m ? m[1] : 'other'
  return TYPE_BUCKETS.includes(type) ? type : 'other'
}

/**
 * Recent commit subjects from a window of newest-first non-merge git subjects.
 * Dashes are normalized, the window is grouped by type (TYPE_BUCKETS order), then merge-looking
 * subjects, duplicates and excluded prefixes are skipped and at most `max` are kept.
 * The window comes from `git log --no-merges` (see readGitSubjects in assemble.mjs).
 */
export function extractRecentCommits(subjects, max, excludePrefixes = []) {
  const cleaned = subjects.map((raw) => raw.replace(DASH_PATTERN, ', ').trim()).filter(Boolean)
  const grouped = TYPE_BUCKETS.flatMap((key) => cleaned.filter((s) => bucketOf(s) === key))
  const seen = new Set()
  const commits = []
  for (const subject of grouped) {
    if (subject.startsWith('Merge') || seen.has(subject)) continue
    if (excludePrefixes.some((p) => subject.startsWith(p))) continue
    seen.add(subject)
    commits.push(subject)
    if (commits.length >= max) break
  }
  return commits
}

function oneLine(s) {
  return s.replace(/\s+/g, ' ').trim()
}

export function formatDecisions(decisions) {
  return decisions
    .map((d) => `- ${d.id}: ${oneLine(d.question)}\n  - 선택: ${oneLine(d.chosen)}\n  - 이유: ${oneLine(d.reason)}`)
    .join('\n')
}

/**
 * Builds the node body from already-selected allowlisted content (no file reads).
 * parts: { title, overview, systemSummaries[{title,summary}], narrative, commits[],
 *          decisions[], currentWork, sourceRevisions[{name,revision}] }
 */
export function buildBody(parts, { asOf, commit }) {
  const sections = [
    `# ${parts.title}`,
    '## 제품 개요',
    parts.overview,
    '## 시스템 구성',
    parts.systemSummaries.map((s) => `- ${s.title}: ${oneLine(s.summary)}`).join('\n'),
    '## 변천',
    parts.narrative,
    '최근 커밋:',
    parts.commits.map((c) => `- ${c}`).join('\n'),
    '## 현재 유효한 결정',
    formatDecisions(parts.decisions),
    '## 현재 진행 중',
    parts.currentWork.trim(),
  ]
  const meta = [
    META_HEADING,
    '',
    `- 기준일(asOf): ${asOf}`,
    `- 저장소 커밋: ${commit}`,
    ...parts.sourceRevisions.map((r) => `- ${r.name}: ${r.revision}`),
    '',
  ].join('\n')
  const body = `${sections.join('\n\n')}\n\n${meta}`
  if (body.length > MAX_BODY_CHARS) throw new Error(`body too large: ${body.length} > ${MAX_BODY_CHARS}`)
  return body
}

/** Stale check against the last published state. */
export function checkStale(currentHash, published) {
  if (!published || !published.bodyHash) return { stale: true, reason: 'never published' }
  if (published.bodyHash !== currentHash) return { stale: true, reason: 'content changed since last publish' }
  return { stale: false, reason: 'up to date' }
}

/** Validates inputs for --record-published. Returns a list of problems. */
export function validatePublishRecord({ docKey, url }) {
  const problems = []
  if (!docKey || !/^\S{1,200}$/.test(docKey)) problems.push('doc-key must be 1-200 non-space characters')
  if (!url || !/^https:\/\/\S+$/.test(url)) problems.push('url must be an https URL')
  const secretish = [...scanText(docKey ?? ''), ...scanText(url ?? '')].filter((f) => ['key', 'env', 'email'].includes(f.category))
  if (secretish.length > 0) problems.push('doc-key/url look like a secret or email; refusing to record')
  return problems
}
