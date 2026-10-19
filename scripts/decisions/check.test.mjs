import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadDecisions, parseArgs } from './check.mjs'
import { findMatches, formatReport, matchesGlob, parseFrontmatter, validateDecision } from './lib.mjs'

const VALID = `---
id: DEC-0001
date: 2026-10-19
status: active
question: "Which key: tid or mail?"
options:
  - mail domain
  - tenant id
chosen: tenant id
reason: mail is spoofable
paths:
  - workflow-server/src/auth/**
supersedes: []
source: AGENTS.md
---
Body text.
`

test('parseFrontmatter reads scalars, quoted scalars, lists and empty lists', () => {
  const d = parseFrontmatter(VALID)
  assert.equal(d.id, 'DEC-0001')
  assert.equal(d.question, 'Which key: tid or mail?')
  assert.deepEqual(d.options, ['mail domain', 'tenant id'])
  assert.deepEqual(d.supersedes, [])
})

test('parseFrontmatter rejects missing fences, duplicate keys and stray list items', () => {
  assert.throws(() => parseFrontmatter('no fence'), /opening/)
  assert.throws(() => parseFrontmatter('---\nid: a\n'), /closing/)
  assert.throws(() => parseFrontmatter('---\nid: a\nid: b\n---\n'), /duplicate/)
  assert.throws(() => parseFrontmatter('---\n  - x\n---\n'), /without a key/)
  assert.throws(() => parseFrontmatter('---\n???\n---\n'), /unparseable/)
})

test('validateDecision accepts a valid record', () => {
  assert.deepEqual(validateDecision(parseFrontmatter(VALID), '0001-identity.md'), [])
})

test('validateDecision reports schema problems', () => {
  const base = parseFrontmatter(VALID)
  assert.match(validateDecision({ ...base, id: 'X1' }).join(), /id must/)
  assert.match(validateDecision({ ...base, date: '10/19/2026' }).join(), /date must/)
  assert.match(validateDecision({ ...base, status: 'maybe' }).join(), /status must/)
  assert.match(validateDecision({ ...base, options: ['one'] }).join(), /options/)
  assert.match(validateDecision({ ...base, paths: [] }).join(), /path glob/)
  assert.match(validateDecision({ ...base, supersedes: ['nope'] }).join(), /supersedes/)
  assert.match(validateDecision({ ...base, reason: '' }).join(), /reason/)
  assert.match(validateDecision(base, '0002-wrong.md').join(), /file name/)
})

test('matchesGlob handles **, *, ? and non-matches', () => {
  assert.ok(matchesGlob('workflow-server/src/auth/**', 'workflow-server/src/auth/a/b.ts'))
  assert.ok(matchesGlob('src/**/*.tsx', 'src/pages/A.tsx'))
  assert.ok(matchesGlob('src/**/*.tsx', 'src/A.tsx'))
  assert.ok(matchesGlob('src/*.ts', 'src/a.ts'))
  assert.ok(!matchesGlob('src/*.ts', 'src/x/a.ts'))
  assert.ok(matchesGlob('a/b?.md', 'a/bc.md'))
  assert.ok(!matchesGlob('a/b.md', 'a/bxmd'))
  assert.ok(matchesGlob('a/b.md', 'a\\b.md'))
})

test('findMatches reports only active decisions and handles deleted/renamed paths as plain strings', () => {
  const active = { ...parseFrontmatter(VALID), fileName: '0001-x.md' }
  const retired = { ...active, id: 'DEC-0002', status: 'retired' }
  const hits = findMatches([active, retired], ['workflow-server/src/auth/old-name.ts', 'README.md'])
  assert.equal(hits.length, 1)
  assert.deepEqual(hits[0].files, ['workflow-server/src/auth/old-name.ts'])
  assert.deepEqual(findMatches([active], ['README.md']), [])
})

test('formatReport prints id, question and chosen', () => {
  const active = { ...parseFrontmatter(VALID), fileName: '0001-x.md' }
  const out = formatReport(findMatches([active], ['workflow-server/src/auth/x.ts']))
  assert.match(out, /DEC-0001/)
  assert.match(out, /Which key/)
  assert.match(out, /chosen: tenant id/)
  assert.match(formatReport([]), /No active/)
})

test('loadDecisions flags malformed files and duplicate ids without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dec-'))
  writeFileSync(join(dir, '0001-a.md'), VALID)
  writeFileSync(join(dir, '0002-b.md'), VALID.replace('DEC-0001', 'DEC-0001'))
  writeFileSync(join(dir, '0003-bad.md'), '---\nid: DEC-0003\n---\n')
  const { decisions, problems } = loadDecisions(dir)
  assert.equal(decisions.length, 1)
  assert.ok(problems.some((p) => p.startsWith('0003-bad.md')))
  assert.ok(problems.some((p) => p.includes('0002-b.md')))
})

test('the committed decision files are all valid', () => {
  const { decisions, problems } = loadDecisions()
  assert.deepEqual(problems, [])
  assert.ok(decisions.length >= 10)
})

test('every non-glob path in a decision exists, and every glob matches a tracked file', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  }).split('\n')
  const { decisions } = loadDecisions()
  const missing = []
  for (const d of decisions) {
    for (const g of d.paths) {
      if (!tracked.some((f) => matchesGlob(g, f))) missing.push(`${d.id}: ${g}`)
    }
  }
  assert.deepEqual(missing, [])
})

test('parseArgs defaults to HEAD and rejects unknown flags', () => {
  assert.deepEqual(parseArgs([]), { base: 'HEAD', files: null })
  assert.deepEqual(parseArgs(['--files', 'a', 'b']).files, ['a', 'b'])
  assert.throws(() => parseArgs(['--nope']), /unknown/)
})
