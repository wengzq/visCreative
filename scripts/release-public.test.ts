import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PUBLIC_AGENT_EMAILS, scanText } from './privacy-rules.mjs'
import { SNAPSHOT_SOURCE_REF, snapshotCoauthors, snapshotMessage, snapshotSince } from './release-public.mjs'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const codex = 'Co-Authored-By: Codex <noreply@openai.com>'
const claude = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
const human = 'Co-Authored-By: Example Author <me@example.com>'
const unknown = `Co-Authored-By: Unknown Agent <noreply${'@'}unknown-agent.com>`

function archive() {
  const dir = mkdtempSync(join(tmpdir(), 'vis-release-'))
  dirs.push(dir)
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'me@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'me@example.com' }
  const git = (args: string[], input?: string) => execFileSync('git', args, { cwd: dir, env, input, encoding: 'utf8', stdio: 'pipe' }).trim()
  git(['init', '--quiet', '--initial-branch=main'])
  git(['config', 'core.hooksPath', ''])
  const commit = (message: string) => {
    git(['add', '.'])
    git(['commit', '--quiet', '--allow-empty', '--cleanup=verbatim', '-F', '-'], message)
    return git(['rev-parse', 'HEAD'])
  }
  const base = commit('Previous release')
  return { dir, git, commit, base }
}

describe('snapshot coauthors', () => {
  it('selects every commit in since-exclusive to source-inclusive, including merged branches', () => {
    const { git, commit, base } = archive()
    const old = commit(`Already published\n\n${claude}`)
    git(['checkout', '-qb', 'feature'])
    commit(`Branch change\n\n${codex}`)
    git(['checkout', '-q', 'main'])
    commit('Main change')
    git(['merge', '--quiet', '--no-ff', 'feature', '-m', 'Merge feature'])
    const source = git(['rev-parse', 'HEAD'])
    commit('After source\n\nCo-Authored-By: Later Agent <noreply@openai.com>')
    expect(snapshotCoauthors(git, old, source)).toEqual({ trailers: [codex], excluded: 0, duplicates: 0 })
    expect(snapshotCoauthors(git, base, source).trailers).toEqual([claude, codex])
    expect(snapshotCoauthors(git, source, source).trailers).toEqual([])
  })

  it('copies only the shared agent allowlist and counts unapproved or malformed candidates without their values', () => {
    const { git, commit, base } = archive()
    commit(`Attribution\n\n${human}\n${unknown}\nCo-Authored-By: Broken <noreply@openai.com> extra\nCo-Authored-By: <noreply@anthropic.com>\n${codex}\n${claude}`)
    expect(snapshotCoauthors(git, base, 'HEAD')).toEqual({ trailers: [claude, codex], excluded: 4, duplicates: 0 })
    expect([...PUBLIC_AGENT_EMAILS].sort()).toEqual(['noreply@anthropic.com', 'noreply@openai.com'])
  })

  it('does not copy body examples, malformed tokens or folded trailer values', () => {
    const { git, commit, base } = archive()
    commit(`A body example\n\n${codex}\n\nThis is ordinary prose after the example.`)
    commit('Malformed token\n\nCo-Authored-By Missing Colon <noreply@openai.com>')
    commit(`Folded trailer\n\n${claude}\n continued value`)
    expect(snapshotCoauthors(git, base, 'HEAD')).toEqual({ trailers: [], excluded: 3, duplicates: 0 })
  })

  it('deduplicates normalized email and name, preserves original text, and orders by email then name', () => {
    const { git, commit, base } = archive()
    const alternate = 'co-authored-by: codex <NOREPLY@OPENAI.COM>'
    const variant = 'Co-Authored-By: Codex Review <noreply@openai.com>'
    commit(`First\n\n${codex}\n${variant}\n${claude}`)
    commit(`Repeated\n\n${alternate}\n${claude}\n${codex}`)
    expect(snapshotCoauthors(git, base, 'HEAD')).toEqual({ trailers: [claude, codex, variant], excluded: 0, duplicates: 3 })
    // Collection order does not decide which exact spelling survives.
    const reverse = (args: string[]) => git([args[0]!, '--reverse', ...args.slice(1)])
    expect(snapshotCoauthors(reverse, base, 'HEAD')).toEqual(snapshotCoauthors(git, base, 'HEAD'))
  })

  it('preserves separator spacing and counts a matching body example as excluded', () => {
    const { git, commit, base } = archive()
    const original = 'co-authored-by:\tCodex  <NOREPLY@OPENAI.COM>  '
    commit(`Body example\n\n${original}\n\nFurther details.\n\n${original}\n`)
    expect(snapshotCoauthors(git, base, 'HEAD')).toEqual({ trailers: [original], excluded: 1, duplicates: 0 })
  })

  it('leaves a message byte-for-byte unchanged when there are no copied trailers', () => {
    const message = 'Public summary\n\nDetails.\n\n'
    expect(snapshotMessage(message, [])).toBe(message)
    expect(snapshotMessage(message, [claude, codex])).toBe(`Public summary\n\nDetails.\n\n${claude}\n${codex}\n`)
    expect(scanText(snapshotMessage(message, [claude, codex]))).toEqual([])
  })
})

describe('snapshot archive source', () => {
  it('requires a local range record instead of guessing', () => {
    const { git } = archive()
    expect(() => snapshotSince(git, 'HEAD')).toThrow(`no previous archive source at ${SNAPSHOT_SOURCE_REF}`)
  })

  it('uses the local ref and allows --since to override it without changing it', () => {
    const { git, commit, base } = archive()
    const previous = commit('Published source')
    const source = commit('Next source')
    git(['update-ref', SNAPSHOT_SOURCE_REF, previous])
    expect(snapshotSince(git, source)).toBe(previous)
    expect(snapshotSince(git, source, base)).toBe(base)
    expect(git(['rev-parse', SNAPSHOT_SOURCE_REF])).toBe(previous)
    expect(() => snapshotSince(git, source, 'missing')).toThrow('cannot resolve --since')
    expect(() => snapshotSince(git, base)).toThrow('must be an ancestor')
  })

  it('accepts --since without a local record', () => {
    const { git, commit, base } = archive()
    const source = commit('Next source')
    expect(snapshotSince(git, source, base)).toBe(base)
  })
})

function releaseFixture() {
  const repo = archive()
  const scripts = join(repo.dir, 'scripts')
  mkdirSync(scripts)
  for (const name of ['release-public.mjs', 'check-privacy.mjs', 'privacy-rules.mjs']) {
    copyFileSync(fileURLToPath(new URL(name, import.meta.url)), join(scripts, name))
  }
  repo.commit('Release scripts')
  const home = mkdtempSync(join(tmpdir(), 'vis-release-home-'))
  dirs.push(home)
  const config = join(home, '.config', 'vis-creative')
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'release.json'), JSON.stringify({ name: 'Test', email: 'test@users.noreply.github.com' }))
  const words = join(config, 'private-words.txt')
  writeFileSync(words, '')
  const message = join(home, 'summary.txt')
  writeFileSync(message, 'Public release summary\n')
  // A local branch acts as the public mirror, without pushing or contacting any external service.
  const tree = repo.git(['mktree'], '')
  const parent = repo.git(['commit-tree', tree, '-F', '-'], 'Previous public snapshot\n')
  repo.git(['update-ref', 'refs/heads/published', parent])
  repo.git(['config', 'remote.public.url', repo.dir])
  repo.git(['config', 'remote.public.fetch', '+refs/heads/published:refs/remotes/public/main'])
  const run = (...args: string[]) => spawnSync(process.execPath, [join(scripts, 'release-public.mjs'), '--message', message, ...args], {
    cwd: repo.dir,
    env: { ...process.env, HOME: home, USERPROFILE: home, VIS_PRIVACY_WORDS: words, VIS_PUBLIC_REMOTE: 'public' },
    encoding: 'utf8',
  })
  return { ...repo, run, message, words }
}

describe('release-public command', () => {
  it('fails clearly when the source range is missing, including an empty --since option', () => {
    const { run } = releaseFixture()
    const missing = run()
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain(`no previous archive source at ${SNAPSHOT_SOURCE_REF}`)
    const empty = run('--since')
    expect(empty.status).toBe(1)
    expect(empty.stderr).toContain('--since needs a value')
  })

  it('dry-runs --since with filtered, private-checked trailers and leaves the local record untouched', () => {
    const { git, commit, base, run, message } = releaseFixture()
    const previous = git(['rev-parse', 'HEAD'])
    const source = commit(`Next snapshot\n\n${codex}\n${claude}\n${human}\n${unknown}\n${codex}`)
    git(['update-ref', SNAPSHOT_SOURCE_REF, previous])
    const result = run('--since', base, '--source', source)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('2 added; 2 excluded (unapproved or malformed); 1 duplicates omitted')
    expect(result.stdout).toContain(`    ${claude}\n    ${codex}`)
    expect(result.stdout).not.toContain(human)
    expect(result.stdout).not.toContain(unknown)
    expect(result.stdout).toContain('Dry run: nothing was pushed.')
    const snapshot = /Snapshot ([a-f0-9]+)/.exec(result.stdout)![1]!
    expect(git(['show', '-s', '--format=%B', snapshot])).toBe(snapshotMessage(readFileSync(message, 'utf8'), [claude, codex]).trim())
    expect(git(['rev-parse', SNAPSHOT_SOURCE_REF])).toBe(previous)
    expect(git(['show', '-s', '--format=%B', snapshot])).not.toContain(source)
  })

  it('checks copied names in the final message before printing trailers', () => {
    const { commit, base, run, words } = releaseFixture()
    const source = commit('Next snapshot\n\nCo-Authored-By: PrivateDisplayName <noreply@openai.com>')
    writeFileSync(words, 'PrivateDisplayName\n')
    const result = run('--since', base, '--source', source)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('privacy check failed; nothing was pushed')
    expect(`${result.stdout}${result.stderr}`).not.toContain('PrivateDisplayName')
  })
})
