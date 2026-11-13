#!/usr/bin/env node
// Nothing private reaches the repository or the public mirror (RFC 0042 §1). Generic rules live in
// scripts/privacy-rules.mjs; personal terms live only on this machine, in ~/.config/vis-creative/private-words.txt.
//
//   node scripts/check-privacy.mjs                         tracked files, content and paths
//   node scripts/check-privacy.mjs --staged                what `git commit` is about to record
//   node scripts/check-privacy.mjs --message <file>        a commit message or release text (commit-msg hook)
//   node scripts/check-privacy.mjs --range <a>..<b>        files those commits touch, plus their messages
//   ... --public                                           also require noreply commit identities (pushes to public)
//
// Findings name the rule, the place and the source of the term, never the matched value.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatFinding, identityFindings, personalTerms, scanText } from './privacy-rules.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
// The rules file and its tests hold the patterns and synthetic samples themselves.
const SKIP = new Set(['scripts/privacy-rules.mjs', 'scripts/privacy-rules.test.ts'])
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
const gitBuffer = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
const quiet = fn => { try { return fn() } catch { return '' } }

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

function terms() {
  const wordsPath = process.env.VIS_PRIVACY_WORDS ?? join(homedir(), '.config', 'vis-creative', 'private-words.txt')
  const wordsText = existsSync(wordsPath) ? readFileSync(wordsPath, 'utf8') : ''
  // CI has neither words nor a personal identity; the generic rules still run there.
  if (process.env.CI && !process.env.VIS_PRIVACY_WORDS) return personalTerms()
  return personalTerms({
    wordsText,
    automatic: [
      [quiet(() => git('config', 'user.email')).trim(), 'git user.email'],
      [quiet(() => git('config', 'user.name')).trim(), 'git user.name'],
      [basename(homedir()), 'home directory name'],
    ],
  })
}

const textOf = buffer => buffer.subarray(0, 8000).includes(0) ? null : buffer.toString('utf8')
const findings = []
const report = (where, list) => { for (const finding of list) findings.push(formatFinding(where, finding)) }
const personal = terms()

function scanFile(path, read) {
  if (SKIP.has(path)) return
  report(`${path} (path)`, scanText(path, personal).map(({ line, ...rest }) => rest))
  const text = textOf(read())
  if (text !== null) report(path, scanText(text, personal))
}

if (flag('--staged')) {
  const paths = git('diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR').split('\0').filter(Boolean)
  for (const path of paths) scanFile(path, () => gitBuffer('show', `:${path}`))
} else if (value('--range')) {
  const range = value('--range')
  const [, head = 'HEAD'] = range.split('..')
  const paths = git('diff', '--name-only', '-z', '--diff-filter=ACMR', range).split('\0').filter(Boolean)
  for (const path of paths) scanFile(path, () => gitBuffer('show', `${head}:${path}`))
  for (const record of git('log', '--format=%H%x00%ae%x00%ce%x00%B%x1e', range).split('\x1e').map(r => r.trim()).filter(Boolean)) {
    const [hash, author, committer, message] = record.split('\0')
    const where = `commit ${hash.slice(0, 12)}`
    report(`${where} (message)`, scanText(message ?? '', personal))
    if (flag('--public')) report(where, identityFindings([{ role: 'author', email: author }, { role: 'committer', email: committer }]))
  }
} else if (!value('--message')) {
  for (const path of git('ls-files', '-z').split('\0').filter(Boolean)) {
    const file = join(root, path)
    if (existsSync(file)) scanFile(path, () => readFileSync(file))
  }
}
if (value('--message')) report(`message ${basename(value('--message'))}`, scanText(readFileSync(value('--message'), 'utf8'), personal))

if (findings.length) {
  console.error(`Privacy check failed (${findings.length}). Values are not printed; open each place to see what matched.`)
  console.error('Remove the value, use a placeholder (me@example.com, <project dir>), or add `privacy-allow: <reason>` on the line for a public value.')
  for (const line of findings) console.error(`  ${line}`)
  process.exit(1)
}
console.log(`Privacy check passed${personal.size ? ` (${personal.size} personal terms)` : ' (generic rules only)'}`)
