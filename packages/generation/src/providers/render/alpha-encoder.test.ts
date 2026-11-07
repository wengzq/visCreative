import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createRenderProvider } from './index'

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: async () => ({ stdout: ' V..... libx264', stderr: '' }),
  }) }
})

it('fails before opening Chrome when libvpx-vp9 is absent and produces no opaque fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vis-no-alpha-'))
  try {
    const provider = createRenderProvider({ workDir: dir, chromePath: process.execPath })
    await provider.submit({ operation: 'generate', kind: 'video', model: 'html', prompt: '', params: { transparent: true }, inputs: [{ type: 'text', text: '<script>window.vis={duration:1,seek(){}}</script>' }] }, { idempotencyKey: 'missing' })
    await expect.poll(() => provider.getTask('missing')).toEqual({ state: 'failed', error: { code: 'generation.render_alpha_encoder_missing', message: 'This ffmpeg lacks libvpx-vp9; transparent WebM rendering is unavailable' } })
    expect(readdirSync(join(dir, 'missing'))).toEqual([])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
