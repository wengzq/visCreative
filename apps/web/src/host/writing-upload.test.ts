import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createWebHost, type WebHost } from './server'
import { WRITING_LIMITS } from '@vis/protocol'

let host: WebHost | undefined
let server: Server | undefined
let dir: string | undefined
afterEach(async () => { await host?.close(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); if (dir) rmSync(dir, { recursive: true, force: true }) })
it('authenticates, bounds and cleans document uploads before returning a read-only preview', async () => {
  dir = mkdtempSync(join(tmpdir(), 'vis-writing-upload-'))
  mkdirSync(join(dir, 'static'))
  const tokenPath = join(dir, 'token')
  writeFileSync(tokenPath, 'test-token')
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\vis-writing-${crypto.randomUUID()}` : join(dir, 'studiod.sock')
  const calls: Array<{ method: string; path: string; body: string }> = []
  server = createServer(socket => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1)
        const result = message.method === 'writing.importPreview' ? { name: 'book.txt', body: '# 第一章', encoding: 'utf-8', words: 3, chapters: [{ title: '第一章', level: 1, from: 0, to: 5 }] } : {}
        if (message.method === 'writing.importPreview') calls.push({ method: message.method, path: message.params.path, body: readFileSync(message.params.path, 'utf8') })
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
      }
    })
  })
  await new Promise<void>(resolve => server!.listen(socketPath, resolve))
  host = await createWebHost({ socketPath, tokenPath, staticDir: join(dir, 'static') })
  const url = new URL(host.url)
  const target = `${url.origin}/upload?kind=writing&space=test&name=book.txt&t=${encodeURIComponent(host.token)}`
  expect((await fetch(target, { method: 'POST', body: '第一章' })).status).toBe(403)
  expect((await fetch(target.replace(host.token, 'wrong'), { method: 'POST', body: '第一章', headers: { Origin: url.origin } })).status).toBe(403)
  expect(calls).toEqual([])
  const oversized = await fetch(target, { method: 'POST', body: Buffer.alloc(WRITING_LIMITS.uploadBytes + 1), headers: { Origin: url.origin } })
  expect(oversized.status).toBe(413)
  expect(calls).toEqual([])
  const result = await fetch(target, { method: 'POST', body: '第一章', headers: { Origin: url.origin } })
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({ body: '# 第一章', encoding: 'utf-8' })
  expect(calls).toEqual([{ method: 'writing.importPreview', path: expect.stringContaining('book.txt'), body: '第一章' }])
  expect(existsSync(calls[0]!.path)).toBe(false)
})
