import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { assemble, parseArgs, validateConfig, verifyPreviewHash } from './assemble.mjs'
import {
  buildBody,
  checkStale,
  extractIntro,
  extractRecentCommits,
  hashBody,
  hashedPart,
  maskValue,
  scanText,
  validatePublishRecord,
} from './lib.mjs'

const CONFIG = {
  title: 'Meeting Note 현황',
  productSlug: 'meeting-note',
  securityLevel: 'S2',
  productDocs: [
    { slug: 'product-overview', mode: 'intro' },
    { slug: 'architecture', mode: 'summary' },
  ],
  history: { file: 'docs/ai-native/history.md', maxCommits: 2, excludeCommitPrefixes: ['fix(security)', 'fix(auth)'] },
  story: { file: 'docs/axkh-node/story.md' },
  decisions: { dir: 'docs/decisions', statuses: ['active'] },
  currentWork: { file: 'docs/axkh-node/current-work.md' },
  allowedUrlPrefixes: [],
}

const HISTORY = `# H

## The story so far

Narrative line.

<!-- ai-native:auto:START section=history -->

### Recent changes

**Features**

- feat: one
- Merge pull request #1
- feat: one
- fix(security): hidden one
- fix: two
- fix(auth): hidden two
- fix: three

### Recent merges

- feat: merged-only
<!-- ai-native:auto:END -->
`

function decision(n, status) {
  return `---
id: DEC-000${n}
date: 2026-10-19
status: ${status}
question: Q${n}
options:
  - a
  - b
chosen: C${n}
reason: R${n}
paths:
  - src/**
supersedes: []
source: x
---
body
`
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'axkh-node-'))
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  const pd = 'workflow-server/content/product-docs'
  put(`${pd}/manifest.json`, JSON.stringify({ docs: [
    { slug: 'product-overview', title: '제품 개요', summary: 's1', revision: 'r1' },
    { slug: 'architecture', title: '아키텍처', summary: 'arch summary', revision: 'r2' },
  ] }))
  put(`${pd}/product-overview.md`, '---\ntitle: x\n---\n\n# T\n\nIntro text.\n\n## Secret section\n\nuser@example.com\n')
  put(`${pd}/architecture.md`, '# A\n\nSECRET_BODY_SHOULD_NOT_APPEAR\n')
  put('docs/ai-native/history.md', HISTORY)
  put('docs/decisions/0001-a.md', decision(1, 'active'))
  put('docs/decisions/0002-b.md', decision(2, 'superseded'))
  put('docs/axkh-node/story.md', '한국어 서사.\n')
  put('docs/axkh-node/current-work.md', '- item one\n')
  put('docs/reviews/incident.md', 'token sk-abcdefghijklmnopqrstuvwx\n')
  return root
}

const RUN = { asOf: '2026-10-19', commit: 'abc1234' }

test('assemble uses only allowlisted sources', () => {
  const { body, sources } = assemble(makeRepo(), CONFIG, RUN)
  assert.match(body, /Intro text\./)
  assert.match(body, /arch summary/)
  assert.match(body, /DEC-0001: Q1/)
  assert.doesNotMatch(body, /DEC-0002/)
  assert.doesNotMatch(body, /Secret section|user@example\.com|SECRET_BODY_SHOULD_NOT_APPEAR|sk-abc/)
  assert.match(body, /- item one/)
  assert.match(body, /한국어 서사/)
  assert.doesNotMatch(body, /hidden|Narrative line/)
  assert.match(body, /기준일\(asOf\): 2026-10-19/)
  assert.match(body, /저장소 커밋: abc1234/)
  assert.ok(sources.some((s) => s.name.includes('architecture') && s.revision === 'r2'))
})

test('assemble rejects invalid config and bad asOf', () => {
  assert.throws(() => assemble(makeRepo(), { ...CONFIG, productDocs: [{ slug: '../x', mode: 'intro' }] }, RUN), /invalid/)
  assert.throws(() => assemble(makeRepo(), CONFIG, { ...RUN, asOf: 'today' }), /asOf/)
  assert.deepEqual(validateConfig(CONFIG), [])
  assert.ok(validateConfig({ ...CONFIG, currentWork: { file: '../../etc/passwd' } }).length > 0)
})

test('history extraction: narrative, commits skip merges/dupes and honor max', () => {
  assert.deepEqual(extractRecentCommits(HISTORY, 10), ['feat: one', 'fix(security): hidden one', 'fix: two', 'fix(auth): hidden two', 'fix: three'])
  assert.deepEqual(extractRecentCommits(HISTORY, 2), ['feat: one', 'fix(security): hidden one'])
  assert.deepEqual(extractRecentCommits(HISTORY, 10, ['fix(security)', 'fix(auth)']), ['feat: one', 'fix: two', 'fix: three'])
  assert.deepEqual(extractRecentCommits(HISTORY, 10, ['fix:']), ['feat: one', 'fix(security): hidden one', 'fix(auth): hidden two'])
})

test('extractIntro returns text between H1 and first H2', () => {
  assert.equal(extractIntro('---\na: b\n---\n# T\n\nHello.\n\n## Next\nno'), 'Hello.')
})

test('hash is stable for same inputs and ignores the metadata section', () => {
  const root = makeRepo()
  const a = assemble(root, CONFIG, RUN)
  const b = assemble(root, CONFIG, RUN)
  assert.equal(a.body, b.body)
  assert.equal(a.bodyHash, b.bodyHash)
  const later = assemble(root, CONFIG, { asOf: '2026-11-01', commit: 'fff0000' })
  assert.equal(later.bodyHash, a.bodyHash)
  assert.notEqual(later.body, a.body)
  assert.ok(!hashedPart(a.body).includes('기준일'))
})

test('hash changes when content changes', () => {
  const parts = { title: 'T', overview: 'o', systemSummaries: [], narrative: 'n', commits: [], decisions: [], currentWork: 'w', sourceRevisions: [] }
  assert.notEqual(hashBody(buildBody(parts, RUN)), hashBody(buildBody({ ...parts, currentWork: 'w2' }, RUN)))
})

test('stale check', () => {
  assert.deepEqual(checkStale('h1', null), { stale: true, reason: 'never published' })
  assert.equal(checkStale('h1', { bodyHash: '' }).stale, true)
  assert.equal(checkStale('h1', { bodyHash: 'h0' }).stale, true)
  assert.equal(checkStale('h1', { bodyHash: 'h1' }).stale, false)
})

const SAMPLES = {
  email: 'contact andrew@example.com now',
  uuid: 'tenant 123e4567-e89b-12d3-a456-426614174000 here',
  'internal-host': 'host my-app.onrender.com up',
  url: 'see https://internal.example.org/path now',
  key: 'key axk_abcdef123456 used',
  env: 'run SOME_SETTING=hunter2value now',
}

for (const [category, text] of Object.entries(SAMPLES)) {
  test(`scanner flags ${category} and masks the value`, () => {
    const findings = scanText(text)
    const hit = findings.find((f) => f.category === category)
    assert.ok(hit, `expected ${category} finding`)
    assert.equal(hit.line, 1)
    for (const f of findings) {
      assert.match(f.masked, /\*\*\*/)
      assert.doesNotMatch(f.snippet, /andrew@example\.com|123e4567-e89b|abcdef123456|hunter2value/)
    }
  })
}

test('scanner flags each key pattern', () => {
  for (const key of ['sk-abcdefghijklmnopqrstuvwx', 'AIzaSyA1234567890abcdefghij', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig', 'Bearer abcd1234efgh5678']) {
    assert.ok(scanText(`x ${key} y`).some((f) => f.category === 'key'), key)
  }
})

test('scanner allows only allowlisted URLs and reports line numbers', () => {
  const text = 'ok\nsee https://docs.example.com/a end'
  assert.equal(scanText(text, { allowedUrlPrefixes: ['https://docs.example.com/'] }).length, 0)
  const f = scanText(text)
  assert.equal(f[0].line, 2)
})

test('scanner passes clean prose', () => {
  assert.deepEqual(scanText('Meeting Note는 회의를 지식으로 바꾼다.\n- feat(auth): trust tenant id'), [])
})

test('maskValue never returns the full value', () => {
  assert.doesNotMatch(maskValue('supersecretvalue'), /supersecretvalue/)
  assert.equal(maskValue('abc'), '***(len 3)')
})

test('validatePublishRecord', () => {
  assert.deepEqual(validatePublishRecord({ docKey: 'meeting-note-status', url: 'https://hub.example/n/1' }), [])
  assert.ok(validatePublishRecord({ docKey: '', url: 'http://x' }).length >= 2)
  assert.ok(validatePublishRecord({ docKey: 'axk_abcdef123456', url: 'https://hub.example/n/1' }).length > 0)
})

test('parseArgs', () => {
  assert.equal(parseArgs(['--check']).mode, 'check')
  const r = parseArgs(['--record-published', '--doc-key', 'k', '--url', 'https://u'])
  assert.deepEqual([r.mode, r.docKey, r.url], ['record', 'k', 'https://u'])
  assert.throws(() => parseArgs(['--nope']), /unknown/)
  assert.throws(() => parseArgs(['--doc-key']), /needs a value/)
})

test('verifyPreviewHash refuses a stale or missing preview hash', () => {
  assert.equal(verifyPreviewHash('h1', 'h1'), null)
  assert.match(verifyPreviewHash('h1', 'h2'), /mismatch/)
  assert.match(verifyPreviewHash('', 'h2'), /no bodyHash/)
  assert.match(verifyPreviewHash(undefined, 'h2'), /no bodyHash/)
})

test('record hash check detects an edit made after the preview was built', () => {
  const root = makeRepo()
  const preview = assemble(root, CONFIG, RUN)
  writeFileSync(join(root, 'docs/axkh-node/current-work.md'), '- item changed\n')
  const current = assemble(root, CONFIG, RUN)
  assert.match(verifyPreviewHash(preview.bodyHash, current.bodyHash), /mismatch/)
})
