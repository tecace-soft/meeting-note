// Advisory decision checker. Exit 0 even when decisions match; exit 1 only when a
// decision file is malformed. Usage:
//   node scripts/decisions/check.mjs                  # working tree vs HEAD (+ untracked)
//   node scripts/decisions/check.mjs --base origin/main...HEAD
//   node scripts/decisions/check.mjs --files a.ts b.ts
import { execFileSync } from 'node:child_process'
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findMatches, formatReport, parseFrontmatter, validateDecision } from './lib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DECISIONS_DIR = join(ROOT, 'docs', 'decisions')
const MAX_FILES = 5000
const GIT_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024

export function loadDecisions(dir = DECISIONS_DIR) {
  const decisions = []
  const problems = []
  const names = readdirSync(dir).filter((n) => /^\d{4}-.+\.md$/.test(n)).sort()
  for (const name of names) {
    try {
      const data = parseFrontmatter(readFileSync(join(dir, name), 'utf8'))
      const errors = validateDecision(data, name)
      if (errors.length > 0) problems.push(`${name}: ${errors.join('; ')}`)
      else decisions.push({ ...data, fileName: name })
    } catch (err) {
      problems.push(`${name}: ${err.message}`)
    }
  }
  const seen = new Set()
  for (const d of decisions) {
    if (seen.has(d.id)) problems.push(`${d.fileName}: duplicate id ${d.id}`)
    seen.add(d.id)
  }
  return { decisions, problems }
}

function git(args) {
  const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER })
  return out.split('\n').map((l) => l.trim()).filter(Boolean)
}

export function changedFilesFromGit(base) {
  const files = git(['diff', '--name-only', '--no-renames', base])
  if (base === 'HEAD') files.push(...git(['ls-files', '--others', '--exclude-standard']))
  return [...new Set(files)].slice(0, MAX_FILES)
}

export function parseArgs(argv) {
  const opts = { base: 'HEAD', files: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') {
      opts.base = argv[i + 1]
      i += 1
    } else if (argv[i] === '--files') {
      opts.files = argv.slice(i + 1)
      break
    } else {
      throw new Error(`unknown argument: ${argv[i]}`)
    }
  }
  if (!opts.base) throw new Error('--base needs a value')
  return opts
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const { decisions, problems } = loadDecisions()
  if (problems.length > 0) {
    console.error('Malformed decision files:')
    for (const p of problems) console.error(`- ${p}`)
    return 1
  }
  let changed
  try {
    changed = opts.files ?? changedFilesFromGit(opts.base)
  } catch (err) {
    // Advisory tool: an unresolvable base ref (e.g. force-push) must not fail CI, but say so loudly.
    console.warn(`Could not compute changed files for base "${opts.base}": ${err.message}`)
    return 0
  }
  const report = formatReport(findMatches(decisions, changed))
  console.log(`Checked ${changed.length} changed file(s) against ${decisions.length} decision(s).`)
  console.log(report)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Decision check (advisory)\n\n\`\`\`\n${report}\n\`\`\`\n`)
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main()
  } catch (err) {
    console.error(`decision check failed: ${err.message}`)
    process.exitCode = 1
  }
}
