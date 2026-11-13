import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, toNamespacedPath } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canAutoApprove } from './auto-approval'
import type { ApprovalRequest } from './runtime-port'

let dir: string
let workDir: string
let rootPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-auto-approval-'))
  workDir = join(dir, 'workspace')
  rootPath = join(dir, 'project')
  for (const path of [workDir, rootPath, join(dir, 'outside'), join(workDir, 'nested')]) mkdirSync(path)
  writeFileSync(join(workDir, 'existing.txt'), 'test')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function approve(evidence: Partial<ApprovalRequest>): boolean {
  return canAutoApprove({ sessionId: 'session', turnId: 'turn', kind: 'file_write', summary: '', detail: '', ...evidence }, { workDir, rootPath })
}

describe('Automatic approval path boundaries', () => {
  it.runIf(process.platform === 'win32')('Windows: 8.3 directory aliases still resolve real paths and junction boundaries', () => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      input: '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:VIS_TEST_SHORT_PATH).ShortPath\n',
      env: { ...process.env, VIS_TEST_SHORT_PATH: workDir }, encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    const short = result.stdout.trim()
    expect(short).not.toBe('')
    expect(approve({ kind: 'command', cwd: short })).toBe(true)
    expect(approve({ paths: [`${short}\\new.txt`] })).toBe(true)
    symlinkSync(join(dir, 'outside'), join(workDir, 'escape'), 'junction')
    expect(approve({ paths: [`${short}\\escape\\new.txt`] })).toBe(false)
    expect(approve({ paths: [`${short}\\escape\\..\\new.txt`] })).toBe(false)
  })
  it.runIf(process.platform === 'win32')('Windows: case, long-path prefixes, and mixed separators do not change boundaries', () => {
    for (const path of [workDir.toUpperCase(), toNamespacedPath(workDir), workDir.replaceAll('\\', '/')]) {
      expect(approve({ kind: 'command', cwd: path })).toBe(true)
      expect(approve({ paths: [`${path}/nested\\new.txt`] })).toBe(true)
      expect(approve({ paths: [`${path}/../outside/new.txt`] })).toBe(false)
    }
    symlinkSync(join(dir, 'outside'), join(workDir, 'escape'), 'junction')
    expect(approve({ paths: [`${toNamespacedPath(workDir)}\\escape\\..\\new.txt`] })).toBe(false)
    expect(approve({ paths: [`${workDir.toUpperCase()}/escape\\new.txt`] })).toBe(false)
    expect(approve({ paths: [`${workDir}/existing.txt/../new.txt`] })).toBe(false)
  })
  it('Commands accept only an existing absolute cwd within the directory', () => {
    for (const cwd of [workDir, rootPath, join(workDir, 'nested')]) expect(approve({ kind: 'command', cwd })).toBe(true)
    for (const cwd of ['', 'workspace', join(dir, 'outside'), join(workDir, 'missing'), join(workDir, 'existing.txt')]) expect(approve({ kind: 'command', cwd })).toBe(false)
    expect(approve({ kind: 'command' })).toBe(false)
    expect(approve({ kind: 'command', cwd: workDir, autoApprovalBlocked: true })).toBe(false)
  })

  it('File writes require every target inside the work or project directory, allowing files and parents not yet created', () => {
    expect(approve({ paths: [join(workDir, 'existing.txt'), join(workDir, 'new/deep/file.txt'), join(rootPath, 'asset.txt')] })).toBe(true)
    for (const paths of [[], [''], ['relative.txt'], [join(workDir, 'existing.txt'), join(dir, 'outside/file.txt')], [`${workDir}-other/file.txt`], [`${workDir}/bad\0path`]]) expect(approve({ paths })).toBe(false)
    expect(approve({ cwd: workDir })).toBe(false)
  })

  it('Normalize dot paths, but still ask for .. paths that cross boundaries', () => {
    expect(approve({ paths: [`${workDir}/nested/../new.txt`] })).toBe(true)
    expect(approve({ paths: [`${workDir}/../outside/new.txt`] })).toBe(false)
    expect(approve({ paths: [`${workDir}/nested/../../outside/new.txt`] })).toBe(false)
  })

  it('Allow internal symlinks; reject existing and new files through links pointing outside', () => {
    symlinkSync(join(workDir, 'nested'), join(workDir, 'safe'), process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(rootPath, join(workDir, 'project'), process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(join(dir, 'outside'), join(workDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(dir, 'outside/existing.txt'), 'test')
    expect(approve({ paths: [join(workDir, 'safe/new/deep.txt')] })).toBe(true)
    expect(approve({ paths: [join(workDir, 'project/new.txt')] })).toBe(true)
    for (const path of ['escape/existing.txt', 'escape/new.txt', 'escape/new/deep.txt']) expect(approve({ paths: [join(workDir, path)] })).toBe(false)
    expect(approve({ kind: 'command', cwd: join(workDir, 'safe') })).toBe(true)
    expect(approve({ kind: 'command', cwd: join(workDir, 'escape') })).toBe(false)
  })

  it('Do not remove .. before resolving symlinks; neither existing nor new targets can escape this way', () => {
    symlinkSync(join(dir, 'outside'), join(workDir, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(dir, 'escaped.txt'), 'test')
    expect(approve({ paths: [`${workDir}/link/../escaped.txt`] })).toBe(false)
    expect(approve({ paths: [`${workDir}/link/../new.txt`] })).toBe(false)
  })

  it('Dangling links, link cycles, and non-directory parents still require prompting', () => {
    symlinkSync(join(dir, 'missing'), join(workDir, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(join(workDir, 'loop'), join(workDir, 'loop'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const path of ['dangling', 'dangling/new.txt', 'loop', 'loop/new.txt', 'existing.txt/new.txt']) expect(approve({ paths: [join(workDir, path)] })).toBe(false)
  })

  it('Trusted roots also resolve symlinks; invalid roots do not allow access', () => {
    const alias = join(dir, 'alias')
    symlinkSync(workDir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const request: ApprovalRequest = { sessionId: 'session', turnId: 'turn', kind: 'file_write', summary: '', detail: '', paths: [join(alias, 'new.txt')] }
    expect(canAutoApprove(request, { workDir: alias })).toBe(true)
    // Both spellings of the same directory (on macOS, /tmp and /private/tmp) are accepted: alias root with real target, and vice versa
    expect(canAutoApprove({ ...request, paths: [join(workDir, 'new.txt')] }, { workDir: alias })).toBe(true)
    expect(canAutoApprove({ sessionId: 'session', turnId: 'turn', kind: 'command', summary: '', detail: '', cwd: workDir }, { workDir: alias })).toBe(true)
    expect(canAutoApprove({ sessionId: 'session', turnId: 'turn', kind: 'command', summary: '', detail: '', cwd: alias }, { workDir })).toBe(true)
    expect(canAutoApprove(request, { workDir: join(dir, 'missing') })).toBe(false)
    expect(canAutoApprove(request, { workDir: 'relative' })).toBe(false)
  })

  it.each(['network', 'other'] as const)('%s always prompts even with a path inside the directory', kind => {
    expect(approve({ kind, cwd: workDir, paths: [join(workDir, 'new.txt')] })).toBe(false)
  })

  it('Native read-only web search and fetch pass; other network requests and blocked ones still prompt (RFC 0048)', () => {
    expect(approve({ kind: 'network', webRead: true })).toBe(true)
    expect(approve({ kind: 'network', webRead: true, autoApprovalBlocked: true })).toBe(false)
    expect(approve({ kind: 'network' })).toBe(false)
    expect(approve({ kind: 'other', webRead: true })).toBe(false)
    expect(approve({ kind: 'command', webRead: true, cwd: join(dir, 'outside') })).toBe(false)
  })
})
