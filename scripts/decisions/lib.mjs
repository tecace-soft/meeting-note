// Decision-record helpers: frontmatter parsing, schema validation, glob matching.
// Node built-ins only, no I/O in this module (pure functions, unit-testable).

export const STATUSES = ['active', 'superseded', 'retired', 'needs-review']
export const MAX_LIST_ITEMS = 50
export const MAX_FRONTMATTER_LINES = 200

const ID_PATTERN = /^DEC-\d{4}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const REQUIRED_STRINGS = ['id', 'date', 'status', 'question', 'chosen', 'reason', 'source']
const REQUIRED_LISTS = ['options', 'paths', 'supersedes']
const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g

function unquote(raw) {
  const v = raw.trim()
  const quoted = v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]
  return quoted ? v.slice(1, -1) : v
}

/**
 * Parses the YAML subset used by decision files: `key: scalar`, `key: []`,
 * and `key:` followed by `  - item` lines. Throws on anything else.
 */
export function parseFrontmatter(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0] !== '---') throw new Error('missing opening --- frontmatter fence')
  const end = lines.indexOf('---', 1)
  if (end === -1) throw new Error('missing closing --- frontmatter fence')
  if (end > MAX_FRONTMATTER_LINES) throw new Error('frontmatter too long')
  const data = {}
  let listKey = null
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item) {
      if (listKey === null) throw new Error(`list item without a key: ${line}`)
      data[listKey].push(unquote(item[1]))
      if (data[listKey].length > MAX_LIST_ITEMS) throw new Error(`too many items in ${listKey}`)
      continue
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!kv) throw new Error(`unparseable frontmatter line: ${line}`)
    const [, key, value] = kv
    if (key in data) throw new Error(`duplicate key: ${key}`)
    if (value === '' || value === '[]') {
      data[key] = []
      listKey = value === '' ? key : null
    } else {
      data[key] = unquote(value)
      listKey = null
    }
  }
  return data
}

/** Returns a list of schema problems (empty when valid). */
export function validateDecision(data, fileName) {
  const errors = []
  for (const key of REQUIRED_STRINGS) {
    if (typeof data[key] !== 'string' || data[key].trim() === '') errors.push(`${key} must be a non-empty string`)
  }
  for (const key of REQUIRED_LISTS) {
    if (!Array.isArray(data[key])) errors.push(`${key} must be a list`)
  }
  if (errors.length > 0) return errors
  if (!ID_PATTERN.test(data.id)) errors.push('id must look like DEC-0001')
  if (!DATE_PATTERN.test(data.date)) errors.push('date must be YYYY-MM-DD')
  if (!STATUSES.includes(data.status)) errors.push(`status must be one of ${STATUSES.join('|')}`)
  if (data.options.length < 2) errors.push('options needs at least 2 entries')
  if (data.status === 'active' && data.paths.length === 0) errors.push('active decision needs at least 1 path glob')
  for (const ref of data.supersedes) {
    if (!ID_PATTERN.test(ref)) errors.push(`supersedes entry is not a decision id: ${ref}`)
  }
  if (fileName && ID_PATTERN.test(data.id) && !fileName.startsWith(`${data.id.slice(4)}-`)) {
    errors.push(`file name must start with ${data.id.slice(4)}-`)
  }
  return errors
}

/** Converts a glob (`**`, `*`, `?`) to an anchored RegExp over `/` separated paths. */
export function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i += 1
      if (glob[i + 1] === '/') {
        i += 1
        out += '(?:.*/)?'
      } else {
        out += '.*'
      }
    } else if (c === '*') {
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(REGEX_SPECIAL, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

export function matchesGlob(glob, file) {
  return globToRegExp(glob).test(file.replace(/\\/g, '/'))
}

/** Active decisions whose path globs match at least one changed file. */
export function findMatches(decisions, changedFiles) {
  const matches = []
  for (const d of decisions) {
    if (d.status !== 'active') continue
    const files = changedFiles.filter((f) => d.paths.some((g) => matchesGlob(g, f)))
    if (files.length > 0) matches.push({ decision: d, files })
  }
  return matches
}

export function formatReport(matches) {
  if (matches.length === 0) return 'No active decision paths touched.'
  const lines = [`${matches.length} active decision(s) touch the changed files (advisory):`]
  for (const { decision: d, files } of matches) {
    lines.push('', `- ${d.id}: ${d.question}`, `  chosen: ${d.chosen}`, `  file: docs/decisions/${d.fileName}`)
    for (const f of files.slice(0, 5)) lines.push(`  touched: ${f}`)
    if (files.length > 5) lines.push(`  ... and ${files.length - 5} more`)
  }
  lines.push('', 'Do not contradict an active decision without recording a superseding decision.')
  return lines.join('\n')
}
