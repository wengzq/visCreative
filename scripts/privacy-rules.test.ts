import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { formatFinding, identityFindings, parseWords, personalTerms, scanText } from './privacy-rules.mjs'

// Samples are assembled at runtime so this file never holds a literal that looks private.
const at = '@'
const rules = (text: string, terms?: Map<string, string>) => scanText(text, terms).map(finding => finding.rule)

describe('generic rules', () => {
  it('flags real-looking addresses, private networks, home paths and key shapes', () => {
    expect(rules(`contact jane.doe${at}corp-mail.com`)).toEqual(['email address'])
    expect(rules(`host ${[10, 2, 3, 4].join('.')} and ${[192, 168, 1, 20].join('.')}:8080 and ${[172, 20, 0, 1].join('.')}`)).toEqual(['private IPv4 address', 'private IPv4 address', 'private IPv4 address'])
    expect(rules(`tailnet ${[100, 101, 2, 3].join('.')}`)).toEqual(['private IPv4 address'])
    expect(rules(`open '${'/Users/'}jdoe/Projects/vis'`)).toEqual(['home directory path'])
    expect(rules(`cwd ${'/home/'}jdoe/work`)).toEqual(['home directory path'])
    expect(rules(`dir C:${'\\Users\\'}jdoe\\AppData`)).toEqual(['home directory path'])
    expect(rules(`key ${'sk-'}${'a'.repeat(24)}`)).toEqual(['openai-style key'])
    expect(rules(`id ${'AKIA'}${'ABCDEFGHIJKLMNOP'}`)).toEqual(['AWS access key'])
    expect(rules(`token ${'ghp_'}${'x'.repeat(36)}`)).toEqual(['GitHub token'])
    expect(rules(`-----BEGIN ${'OPENSSH '}PRIVATE KEY-----`)).toEqual(['private key block'])
  })

  it('passes placeholders, public addresses and the shapes tests use on purpose', () => {
    for (const text of [
      `me${at}example.com`, `bot${at}users.noreply.github.com`, `Co-Authored-By: Codex <noreply${at}openai.com>`,
      `git${at}github.com:owner/repo.git`, `https://key${at}api.vendor.cn/v1`, `bad${at}name.js`, `a${at}b.com`,
      `pnpm${at}10.34.9`, `${'/Users/'}creative/project`, `HOME: '${'/home/'}u'`, `(subpath "<root>${'/home/'}Library")`,
      `${'/home/'}.ssh`, 'localhost 127.0.0.1 and 0.0.0.0', 'version 1.10.0.1 of the 8.8.8.8 resolver', 'docs 192.0.2.10',
    ]) expect(rules(text), text).toEqual([])
  })

  it('honors a privacy-allow marker with a reason on the line or the line before', () => {
    const value = `jane${at}corp-mail.com`
    expect(rules(`${value} // privacy-allow: published vendor contact`)).toEqual([])
    expect(rules(`<!-- privacy-allow: published vendor contact -->\n${value}`)).toEqual([])
    expect(rules(`${value} // privacy-allow:`)).toEqual(['email address'])
  })
})

describe('personal terms', () => {
  it('reads words, takes terms back with !, ignores short terms and placeholder names', () => {
    expect(parseWords('# internal\nProjectFalcon\n!falcon\nab\n')).toEqual({ add: new Set(['projectfalcon']), remove: new Set(['falcon']) })
    const terms = personalTerms({ wordsText: 'ProjectFalcon\n!jdoe\n', automatic: [['jdoe', 'home directory name'], ['me', 'git user.name'], ['corp-host', 'git user.email']] })
    expect([...terms]).toEqual([['corp-host', 'git user.email'], ['projectfalcon', 'private-words.txt']])
  })

  it('matches case-insensitively and reports only the source of the term', () => {
    const terms = personalTerms({ wordsText: 'ProjectFalcon\n' })
    const findings = scanText('Notes about PROJECTFALCON rollout', terms)
    expect(findings).toEqual([{ rule: 'personal term', source: 'private-words.txt', line: 1 }])
    expect(formatFinding('docs/a.md', findings[0]!)).toBe('docs/a.md:1  [personal term] (private-words.txt)')
  })
})

it('requires noreply identities for commits that reach the public repository', () => {
  expect(identityFindings([{ role: 'author', email: `123+me${at}users.noreply.github.com` }, { role: 'committer', email: `noreply${at}github.com` }])).toEqual([])
  expect(identityFindings([{ role: 'author', email: `jane${at}corp-mail.com` }])).toEqual([{ rule: 'author identity is not a noreply address', source: 'public rule' }])
})

describe('check-privacy command', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
  const script = fileURLToPath(new URL('./check-privacy.mjs', import.meta.url))

  it('fails on a message with a private term without printing the term', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vis-privacy-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'words.txt'), 'ProjectFalcon\n')
    writeFileSync(join(dir, 'message.txt'), `Ship ProjectFalcon to jane${at}corp-mail.com\n`)
    let output = ''
    let status = 0
    try {
      execFileSync(process.execPath, [script, '--message', join(dir, 'message.txt')], { env: { ...process.env, CI: '', VIS_PRIVACY_WORDS: join(dir, 'words.txt') }, encoding: 'utf8', stdio: 'pipe' })
    } catch (error: any) {
      status = error.status
      output = `${error.stdout}${error.stderr}`
    }
    expect(status).toBe(1)
    expect(output).toContain('[personal term] (private-words.txt)')
    expect(output).toContain('[email address] (generic rule)')
    expect(output.toLowerCase()).not.toContain('projectfalcon')
    expect(output).not.toContain('corp-mail')
  })
})
