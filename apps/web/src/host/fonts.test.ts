import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWebHost, type WebHost } from './server'

let dir: string
let host: WebHost
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vis-font-route-'))
  vi.stubEnv('VIS_FONTS_DIR', dir)
  writeFileSync(join(dir, 'noto-sans-sc.otf'), 'Font route fixture')
  host = await createWebHost({ socketPath: join(dir, 'unused.socket'), tokenPath: join(dir, 'unused.token'), staticDir: dir })
})
afterEach(async () => { await host.close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })
const url = (id = 'noto-sans-sc') => `http://127.0.0.1:${host.port}/fonts/${id}?t=${encodeURIComponent(host.token)}`

it('serves built-in fonts with authentication, correct MIME and long private caching', async () => {
  const response = await fetch(url())
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('font/otf')
  expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
  expect(await response.text()).toBe('Font route fixture')
  const head = await fetch(url(), { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(await head.text()).toBe('')
})

it('rejects missing tokens, foreign origins, unsupported methods and unknown font IDs', async () => {
  expect((await fetch(`http://127.0.0.1:${host.port}/fonts/noto-sans-sc`)).status).toBe(403)
  expect((await fetch(url(), { headers: { Origin: 'http://other.invalid' } })).status).toBe(403)
  expect((await fetch(url(), { method: 'POST' })).status).toBe(405)
  expect((await fetch(url('unknown-font'))).status).toBe(404)
  const missing = await fetch(url('smiley-sans'))
  expect(missing.status).toBe(404)
  expect(await missing.json()).toMatchObject({ error: { data: { reason: 'media.font_missing' } } })
})

it('rejects a font upload above 50 MiB before staging it or contacting studiod', async () => {
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${host.port}/upload?t=${encodeURIComponent(host.token)}&space=project&name=caption.ttf`, {
      method: 'POST', headers: { Origin: `http://127.0.0.1:${host.port}`, 'Content-Length': String(50 * 1024 ** 2 + 1), Connection: 'close' },
    }, response => {
      let body = ''
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode!, body }))
    })
    req.on('error', reject)
    req.end()
  })
  expect(result.status).toBe(413)
  expect(JSON.parse(result.body)).toMatchObject({ error: { data: { reason: 'asset.font_too_large' } } })
})
