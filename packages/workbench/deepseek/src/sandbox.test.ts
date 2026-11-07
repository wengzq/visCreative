import { deepseekSandbox } from './descriptor'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createRpcPeer, prepareSandbox } from '@vis/workbench-core'
import { dshOverlay } from './overlay'
import { resolveDsh } from './resolve-dsh'

const dsh = resolveDsh()

// Handshake only: no model requests or access to real login files; full isolation probes are in core's dual-runtime regression tests.
it.skipIf(process.platform !== 'darwin' || !dsh)('installed dsh starts from its cache in the outer sandbox without npm writes', async () => {
  const root = mkdtempSync('/tmp/vis-dsh-sb-')
  const cwd = join(root, 'workspace')
  const home = join(root, 'home')
  mkdirSync(cwd)
  mkdirSync(home)
  const sandbox = prepareSandbox({ cwd, dataDir: join(root, 'data'), agent: deepseekSandbox, env: { HOME: home, PATH: process.env.PATH } })
  expect(sandbox.policy).toBeDefined()
  const overlay = join(root, 'overlay.yml')
  writeFileSync(overlay, dshOverlay(undefined, undefined, true))
  const child = spawn('/usr/bin/sandbox-exec', ['-p', sandbox.policy!, dsh!.path, '--profile', 'acp', '--patch', overlay], { cwd, env: sandbox.env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  const peer = createRpcPeer({ input: child.stdout, output: child.stdin }, { onNotification() {}, onRequest() { throw new Error('Unexpected request') }, onClose() {} })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      peer.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'vis-sandbox-test', version: '1' } }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('dsh initialize timeout')), 20_000) }),
    ])
    expect(result).toMatchObject({ protocolVersion: 1 })
  } finally {
    clearTimeout(timer)
    child.kill('SIGTERM')
    await exited
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
