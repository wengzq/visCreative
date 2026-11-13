#!/usr/bin/env node
// Publish a verified commit of the archive as the next snapshot on the public mirror (RFC 0042 §2).
// The snapshot has the source tree, one parent (the mirror's current tip) and a noreply identity, so the mirror
// is a linear series of snapshots that shares no history with the archive.
//
//   node scripts/release-public.mjs --message <file>            dry run: build and check the snapshot, print it
//   node scripts/release-public.mjs --message <file> --push     also push after typing the confirmation
//
// Options: --source <ref> (default main), --since <ref> (default local refs/vis/public-snapshot),
// --remote <name> (default public, or VIS_PUBLIC_REMOTE).
// Identity: ~/.config/vis-creative/release.json, {"name": "...", "email": "...@users.noreply.github.com"}.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { identityFindings, PUBLIC_AGENT_EMAILS } from './privacy-rules.mjs'

export const SNAPSHOT_SOURCE_REF = 'refs/vis/public-snapshot'

export function snapshotSince(git, sourceCommit, override) {
  let sinceCommit
  try { sinceCommit = git(['rev-parse', '--verify', '--end-of-options', `${override ?? SNAPSHOT_SOURCE_REF}^{commit}`]) }
  catch {
    throw new Error(override
      ? 'cannot resolve --since to an archive commit'
      : `no previous archive source at ${SNAPSHOT_SOURCE_REF}; seed it with git update-ref or pass --since <ref>`)
  }
  try { git(['merge-base', '--is-ancestor', sinceCommit, sourceCommit]) }
  catch { throw new Error('the previous archive source must be an ancestor of --source; pass --since <ref> to correct the range') }
  return sinceCommit
}

export function snapshotCoauthors(git, sinceCommit, sourceCommit) {
  // Keep bodies as well as Git's parsed trailers: malformed candidates still count, but body text is never copied.
  const records = git(['log', '--format=%B%x00%(trailers:only,unfold=false)%x00', `${sinceCommit}..${sourceCommit}`]).split('\0')
  const authors = new Map()
  let excluded = 0
  let duplicates = 0
  for (let i = 0; i + 1 < records.length; i += 2) {
    const candidates = records[i].split(/\r?\n/).filter(line => /^[ \t]*Co-Authored-By\b/i.test(line))
    excluded += candidates.length
    // Git normalizes separator spacing. Match from the end to retain the actual trailer, not a body example.
    const normalized = line => line.replace(/^([^:]+):[ \t]*/, '$1: ').trimEnd()
    const originals = new Map()
    for (const line of candidates) {
      const key = normalized(line)
      const lines = originals.get(key) ?? []
      lines.push(line)
      originals.set(key, lines)
    }
    for (const parsed of records[i + 1].split(/\r?\n(?![ \t])/).reverse()) {
      if (!/^Co-Authored-By:/i.test(parsed) || /[\r\n]/.test(parsed)) continue
      const line = originals.get(normalized(parsed))?.pop()
      if (line === undefined) continue
      const match = /^Co-Authored-By:[ \t]+([^<>\x00-\x1f\x7f]+?)[ \t]+<([^<>\s]+)>[ \t]*$/i.exec(line)
      const name = match?.[1].trim()
      const email = match?.[2].toLowerCase()
      if (!name || !PUBLIC_AGENT_EMAILS.has(email)) continue
      excluded--
      const key = `${email}\0${name.toLowerCase()}`
      // Choose the same original spelling even if equivalent trailers differ in case or spacing.
      const previous = authors.get(key)
      if (previous !== undefined) duplicates++
      if (previous === undefined || line < previous) authors.set(key, line)
    }
  }
  // Sort by normalized email, then name. Lexical comparison is independent of the machine's locale.
  const trailers = [...authors].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, line]) => line)
  return { trailers, excluded, duplicates }
}

export function snapshotMessage(message, trailers) {
  return trailers.length ? `${message.trimEnd()}\n\n${trailers.join('\n')}\n` : message
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const args = process.argv.slice(2)
  const value = name => {
    const i = args.indexOf(name)
    if (i < 0) return undefined
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} needs a value`)
    return args[i + 1]
  }
  const git = (cmd, env, input) => execFileSync('git', cmd, { cwd: root, encoding: 'utf8', input, env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const fail = message => { throw new Error(message) }

  const source = value('--source') ?? 'main'
  const remote = value('--remote') ?? process.env.VIS_PUBLIC_REMOTE ?? 'public'
  const messageFile = value('--message')
  if (!messageFile || !existsSync(messageFile)) fail('--message <file> is required: a release summary written for the public')

  // The snapshot must be exactly what was verified: a clean checkout of the source ref.
  if (git(['status', '--porcelain'])) fail('the working tree has uncommitted changes')
  const sourceCommit = git(['rev-parse', '--verify', '--end-of-options', `${source}^{commit}`])
  if (git(['rev-parse', 'HEAD']) !== sourceCommit) fail(`check out ${source} first; the privacy check scans the working tree`)
  const sinceCommit = snapshotSince(git, sourceCommit, value('--since'))
  const coauthors = snapshotCoauthors(git, sinceCommit, sourceCommit)
  const message = snapshotMessage(readFileSync(messageFile, 'utf8'), coauthors.trailers)

  const identityPath = join(homedir(), '.config', 'vis-creative', 'release.json')
  if (!existsSync(identityPath)) fail(`no release identity; create ${identityPath} with a noreply name and email`)
  const identity = JSON.parse(readFileSync(identityPath, 'utf8'))
  if (!identity.name || identityFindings([{ role: 'release', email: String(identity.email ?? '') }]).length) fail('the release identity must have a name and a noreply email')

  git(['fetch', '--quiet', remote])
  const parent = git(['rev-parse', '--verify', `${remote}/main^{commit}`])
  const tree = git(['rev-parse', `${sourceCommit}^{tree}`])
  if (git(['rev-parse', `${parent}^{tree}`]) === tree) {
    console.log('The public mirror already has this tree; nothing to publish.')
    return
  }

  const env = { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email }
  const snapshot = git(['commit-tree', tree, '-p', parent, '-F', '-'], env, message)

  // Whole tree with both layers, then the snapshot's changed files, final message and identity as the mirror will see them.
  const check = extra => {
    try { execFileSync(process.execPath, [join(root, 'scripts/check-privacy.mjs'), ...extra], { cwd: root, stdio: 'inherit', env: { ...process.env, CI: '' } }) }
    catch { fail('privacy check failed; nothing was pushed') }
  }
  check([])
  check(['--range', `${parent}..${snapshot}`, '--public'])

  const stat = git(['diff', '--shortstat', parent, snapshot])
  console.log(`\nSnapshot ${snapshot.slice(0, 12)} of ${source} (${sourceCommit.slice(0, 12)})`)
  console.log(`  parent  ${remote}/main ${parent.slice(0, 12)}`)
  console.log(`  author  ${identity.name} (noreply)`)
  console.log(`  change  ${stat}`)
  console.log(`  coauthors  ${coauthors.trailers.length} added; ${coauthors.excluded} excluded (unapproved or malformed); ${coauthors.duplicates} duplicates omitted`)
  for (const trailer of coauthors.trailers) console.log(`    ${trailer}`)

  if (!args.includes('--push')) {
    console.log('\nDry run: nothing was pushed. Add --push to publish.')
    return
  }
  if (!process.stdin.isTTY) fail('--push needs an interactive terminal to confirm')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`\nType "publish" to push this snapshot to ${remote}/main: `)
  rl.close()
  if (answer.trim() !== 'publish') fail('not confirmed; nothing was pushed')
  execFileSync('git', ['push', remote, `${snapshot}:refs/heads/main`], { cwd: root, stdio: 'inherit' })
  try { git(['update-ref', SNAPSHOT_SOURCE_REF, sourceCommit]) }
  catch { fail(`snapshot published, but the local archive source was not recorded; run git update-ref ${SNAPSHOT_SOURCE_REF} ${sourceCommit} before the next release`) }
  console.log(`Published ${snapshot.slice(0, 12)} to ${remote}/main; recorded the archive source locally.`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main() }
  catch (error) {
    console.error(`release-public: ${error.message}`)
    process.exitCode = 1
  }
}
