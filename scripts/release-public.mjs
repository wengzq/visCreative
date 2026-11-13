#!/usr/bin/env node
// Publish a verified commit of the archive as the next snapshot on the public mirror (RFC 0042 §2).
// The snapshot has the source tree, one parent (the mirror's current tip) and a noreply identity, so the mirror
// is a linear series of snapshots that shares no history with the archive.
//
//   node scripts/release-public.mjs --message <file>            dry run: build and check the snapshot, print it
//   node scripts/release-public.mjs --message <file> --push     also push after typing the confirmation
//
// Options: --source <ref> (default main), --remote <name> (default public, or VIS_PUBLIC_REMOTE).
// Identity: ~/.config/vis-creative/release.json, {"name": "...", "email": "...@users.noreply.github.com"}.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { identityFindings } from './privacy-rules.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const git = (cmd, env) => execFileSync('git', cmd, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const fail = message => { console.error(`release-public: ${message}`); process.exit(1) }

const source = value('--source') ?? 'main'
const remote = value('--remote') ?? process.env.VIS_PUBLIC_REMOTE ?? 'public'
const messageFile = value('--message')
if (!messageFile || !existsSync(messageFile)) fail('--message <file> is required: a release summary written for the public')

// The snapshot must be exactly what was verified: a clean checkout of the source ref.
if (git(['status', '--porcelain'])) fail('the working tree has uncommitted changes')
const sourceCommit = git(['rev-parse', '--verify', `${source}^{commit}`])
if (git(['rev-parse', 'HEAD']) !== sourceCommit) fail(`check out ${source} first; the privacy check scans the working tree`)

const identityPath = join(homedir(), '.config', 'vis-creative', 'release.json')
if (!existsSync(identityPath)) fail(`no release identity; create ${identityPath} with a noreply name and email`)
const identity = JSON.parse(readFileSync(identityPath, 'utf8'))
if (!identity.name || identityFindings([{ role: 'release', email: String(identity.email ?? '') }]).length) fail('the release identity must have a name and a noreply email')

git(['fetch', '--quiet', remote])
const parent = git(['rev-parse', '--verify', `${remote}/main^{commit}`])
const tree = git(['rev-parse', `${sourceCommit}^{tree}`])
if (git(['rev-parse', `${parent}^{tree}`]) === tree) { console.log('The public mirror already has this tree; nothing to publish.'); process.exit(0) }

const env = { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email }
const snapshot = git(['commit-tree', tree, '-p', parent, '-F', messageFile], env)

// Whole tree with both layers, then the snapshot's changed files, message and identity as the mirror will see them.
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

if (!args.includes('--push')) { console.log('\nDry run: nothing was pushed. Add --push to publish.'); process.exit(0) }
if (!process.stdin.isTTY) fail('--push needs an interactive terminal to confirm')
const rl = createInterface({ input: process.stdin, output: process.stdout })
const answer = await rl.question(`\nType "publish" to push this snapshot to ${remote}/main: `)
rl.close()
if (answer.trim() !== 'publish') fail('not confirmed; nothing was pushed')
execFileSync('git', ['push', remote, `${snapshot}:refs/heads/main`], { cwd: root, stdio: 'inherit' })
console.log(`Published ${snapshot.slice(0, 12)} to ${remote}/main.`)
