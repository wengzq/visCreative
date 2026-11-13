import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeChildEnv, resolveExecutable } from './resolve-executable'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vis-executable-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe.runIf(process.platform === 'win32')('Windows executable resolution', () => {
  it.each(['%~dp0', '%dp0%'])('unwraps npm %s shims without interpreting shell metacharacters', prefix => {
    const entry = join(dir, 'entry with spaces.mjs')
    writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    const shim = join(dir, 'codex.cmd')
    writeFileSync(join(dir, 'codex'), '#!/bin/sh\nexit 99\n')
    writeFileSync(shim, `@echo off\r\nSET dp0=%~dp0\r\n"%_prog%" "${prefix}\\entry with spaces.mjs" %*\r\n`)
    const executable = resolveExecutable('codex', undefined, { Path: dir, PATHEXT: '.EXE;.CMD' })
    expect(executable).toEqual({ command: process.execPath, args: [entry] })
    const args = ['a & b | c', '%PATH%', '"quoted"', 'spaces and 中文']
    const child = spawnSync(executable.command, [...executable.args, ...args], { encoding: 'utf8' })
    expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual(args)
  })

  it('honors explicit paths, PATH order and PATHEXT order, and launches JavaScript with Node', () => {
    const first = join(dir, 'first')
    const second = join(dir, 'second')
    mkdirSync(first)
    mkdirSync(second)
    for (const path of [join(first, 'agent.exe'), join(second, 'agent.exe'), join(first, 'agent.com')]) writeFileSync(path, '')
    expect(resolveExecutable('agent', undefined, { PATH: [first, second].join(delimiter), PATHEXT: '.COM;.EXE' })).toEqual({ command: join(first, 'agent.com'), args: [] })
    expect(resolveExecutable('agent', join(second, 'agent.exe'), { PATH: first })).toEqual({ command: join(second, 'agent.exe'), args: [] })
    for (const extension of ['.js', '.mjs']) {
      const entry = join(dir, `fake${extension}`)
      writeFileSync(entry, '')
      expect(resolveExecutable('agent', entry)).toEqual({ command: process.execPath, args: [entry] })
    }
  })

  it('rejects arbitrary batch scripts and broken npm shims instead of using a shell', () => {
    const shim = join(dir, 'agent.cmd')
    writeFileSync(shim, '@echo off\r\necho not a node shim\r\n')
    expect(() => resolveExecutable('agent', shim)).toThrow('Unsupported')
    writeFileSync(shim, '@echo off\r\nnode "%~dp0missing.js" %*\r\n')
    expect(() => resolveExecutable('agent', shim)).toThrow('Missing')
  })
})

it.runIf(process.platform !== 'win32')('POSIX: leaves executable and PATH lookup unchanged', () => {
  expect(resolveExecutable('codex')).toEqual({ command: 'codex', args: [] })
  expect(resolveExecutable('codex', '/custom/codex')).toEqual({ command: '/custom/codex', args: [] })
})

describe('nodeChildEnv (RFC 0046)', () => {
  const app = { electron: '39.0.0', execPath: '/Applications/visCreative.app/Contents/MacOS/visCreative' }
  it('marks only children launched through the Electron binary as Node', () => {
    expect(nodeChildEnv(app.execPath, app)).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(nodeChildEnv('/usr/local/bin/codex', app)).toEqual({})
    expect(nodeChildEnv('/usr/bin/sandbox-exec', app)).toEqual({})
  })
  it('adds nothing outside Electron', () => {
    expect(nodeChildEnv(process.execPath)).toEqual(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {})
    expect(nodeChildEnv('/usr/local/bin/node', { execPath: '/usr/local/bin/node' })).toEqual({})
  })
})
