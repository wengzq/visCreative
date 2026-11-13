// Privacy rules for scripts/check-privacy.mjs (RFC 0042 §1). Pure functions, so tests can drive them without git.
// A finding names the rule and where it matched, never the matched value: the check's own output must not leak it.

/** Hosts that only ever appear as placeholders (RFC 2606, RFC 6761) or are published on purpose. */
const PLACEHOLDER_EMAIL_DOMAINS = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost|users\.noreply\.github\.com)$/i
/** The only agent addresses copied from archive co-author trailers into public snapshots. */
export const PUBLIC_AGENT_EMAILS = new Set(['noreply@anthropic.com', 'noreply@openai.com'])
/** Addresses published on purpose: attribution trailers and the SSH user every GitHub remote uses. */
const PUBLIC_EMAILS = new Set([...PUBLIC_AGENT_EMAILS, 'noreply@github.com', 'git@github.com'])
/** Home-directory names tests and docs use as placeholders. */
const PLACEHOLDER_USERS = new Set(['creative', 'me', 'you', 'user', 'username', 'name', 'example', 'alice', 'bob', 'test', 'runner', 'someone', 'shared', 'public', 'guest', 'default'])

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)/g
// Only a path that starts at the root: `<root>/home/...` in a test is a fake home inside a temporary directory.
const HOME = /(?<![\w>.~-])(?:\/Users\/|\/home\/|[A-Za-z]:\\{1,2}Users\\{1,2})([^/\\\s'"`<>$*{}()[\],:;]+)/g
const SECRETS = [
  ['openai-style key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['private key block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
]
/** A line carrying this marker (or following a line that does) is exempt; the marker must give a reason. */
export const ALLOW_MARKER = /privacy-allow:\s*\S/

/** Code file extensions: `bad@name.js` is a file name in a test, not an address. */
const FILE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'md', 'css', 'html', 'png', 'jpg', 'svg', 'mp4', 'wav', 'yml', 'yaml', 'txt', 'sh', 'py'])

export function isPublicEmail(address) {
  const lower = address.toLowerCase()
  const [local = '', domain = ''] = lower.split('@')
  const labels = domain.split('.')
  // Throwaway test values such as a@b.com have one-letter parts.
  if (local.length <= 1 || (labels.at(-2) ?? '').length <= 1) return true
  return PUBLIC_EMAILS.has(lower) || PLACEHOLDER_EMAIL_DOMAINS.test(domain) || FILE_EXTENSIONS.has(labels.at(-1) ?? '')
}

function isPrivateIpv4(parts) {
  const [a, b, c, d] = parts.map(Number)
  if ([a, b, c, d].some(n => n > 255)) return false
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
}

/**
 * Parse private-words.txt: one term per line, `#` comments, and `!term` lines that take a term back
 * (an automatic term that is also an ordinary word). Terms shorter than three characters are ignored.
 */
export function parseWords(text) {
  const add = new Set()
  const remove = new Set()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('!')) remove.add(line.slice(1).trim().toLowerCase())
    else if (line.length >= 3) add.add(line.toLowerCase())
  }
  return { add, remove }
}

/**
 * Build the personal term list. Each term keeps its source so a finding can say where it came from.
 * `automatic` holds machine values the check adds on its own (git identity, home directory name).
 */
export function personalTerms({ wordsText = '', automatic = [] } = {}) {
  const { add, remove } = parseWords(wordsText)
  const terms = new Map()
  for (const [term, source] of automatic) {
    const lower = term?.trim().toLowerCase()
    if (lower && lower.length >= 3 && !PLACEHOLDER_USERS.has(lower) && !remove.has(lower)) terms.set(lower, source)
  }
  for (const term of add) if (!remove.has(term)) terms.set(term, 'private-words.txt')
  return terms
}

/** Generic and personal findings for one line of text; `public` adds nothing here (identities are checked separately). */
export function scanLine(line, terms = new Map()) {
  const findings = []
  for (const match of line.matchAll(EMAIL)) {
    // `scheme://user@host` is URL userinfo (tests of endpoints that must refuse credentials), not an address.
    if (line.slice(Math.max(0, match.index - 3), match.index) === '://') continue
    if (!isPublicEmail(match[0])) findings.push({ rule: 'email address', source: 'generic rule' })
  }
  for (const match of line.matchAll(IPV4)) if (isPrivateIpv4(match.slice(1, 5))) findings.push({ rule: 'private IPv4 address', source: 'generic rule' })
  for (const match of line.matchAll(HOME)) {
    const name = match[1]
    // Dot directories (/home/.ssh) are policy paths, and one- or two-letter names (/home/u) are placeholders.
    if (name.startsWith('.') || name.length <= 2 || PLACEHOLDER_USERS.has(name.toLowerCase())) continue
    findings.push({ rule: 'home directory path', source: 'generic rule' })
  }
  for (const [rule, pattern] of SECRETS) if (pattern.test(line)) findings.push({ rule, source: 'generic rule' })
  if (terms.size) {
    const lower = line.toLowerCase()
    for (const [term, source] of terms) if (lower.includes(term)) findings.push({ rule: 'personal term', source })
  }
  return findings
}

/** Scan a text (file, message or path list); returns findings with 1-based line numbers. */
export function scanText(text, terms = new Map()) {
  const lines = text.split(/\r?\n/)
  const findings = []
  lines.forEach((line, index) => {
    if (ALLOW_MARKER.test(line) || ALLOW_MARKER.test(lines[index - 1] ?? '')) return
    for (const finding of scanLine(line, terms)) findings.push({ ...finding, line: index + 1 })
  })
  return findings
}

/** A commit identity reaching the public repository must be a noreply address (RFC 0042 §2). */
export function identityFindings(identities) {
  return identities.filter(({ email }) => !/@(users\.)?noreply\.github\.com$/i.test(email) && !PUBLIC_EMAILS.has(email.toLowerCase()))
    .map(({ role }) => ({ rule: `${role} identity is not a noreply address`, source: 'public rule' }))
}

/** Render findings without values: `where  [rule] (source)`. */
export function formatFinding(where, { rule, source, line }) {
  return `${where}${line ? `:${line}` : ''}  [${rule}] (${source})`
}
