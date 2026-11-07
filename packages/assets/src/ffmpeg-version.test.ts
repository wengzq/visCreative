import { afterEach, expect, it, vi } from 'vitest'
import { promisify } from 'node:util'

const run = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: Object.assign(() => {}, { [promisify.custom]: run }) }))
afterEach(() => { vi.resetModules(); run.mockReset() })

it.each(['6.1.2', '5.1.6', '4.4'])('rejects ffmpeg %s with its version and requirement', async version => {
  run.mockResolvedValue({ stdout: `ffmpeg version ${version}-vendor Copyright` })
  const { requireFfmpeg7 } = await import('./ffmpeg-version')
  await expect(requireFfmpeg7('old-ffmpeg')).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'media.ffmpeg_version_unsupported', params: { version, required: 7 } } })
})

it.each(['7.0', 'n7.1.1', '8.0.1', 'N-118000-gabcdef', 'git-2026-11-05-abcdef', 'vendor-build'])('allows ffmpeg %s', async version => {
  run.mockResolvedValue({ stdout: `ffmpeg version ${version} Copyright` })
  const { requireFfmpeg7 } = await import('./ffmpeg-version')
  await expect(requireFfmpeg7(version)).resolves.toBeUndefined()
})

it('caches concurrent and later checks per executable, keeping paths independent', async () => {
  run.mockResolvedValue({ stdout: 'ffmpeg version 7.1 Copyright' })
  const { requireFfmpeg7 } = await import('./ffmpeg-version')
  await Promise.all([requireFfmpeg7('./ffmpeg'), requireFfmpeg7('./ffmpeg')])
  await requireFfmpeg7('./ffmpeg')
  expect(run).toHaveBeenCalledTimes(1)
  await requireFfmpeg7('./another-ffmpeg')
  expect(run).toHaveBeenCalledTimes(2)
})

it('lets the render path report a missing executable rather than rejecting an unknown version', async () => {
  run.mockRejectedValue(new Error('missing'))
  const { requireFfmpeg7 } = await import('./ffmpeg-version')
  await expect(requireFfmpeg7('missing')).resolves.toBeUndefined()
})

it('checks the version before timeline source probing or export starts', async () => {
  run.mockResolvedValue({ stdout: 'ffmpeg version 6.1.2 Copyright' })
  const { renderTimeline } = await import('./timeline-render')
  await expect(renderTimeline({ version: 1, tracks: [] }, new Map(), { encoder: { name: 'libx264', hardware: false, args: [] }, ffmpegPath: 'old-export' }))
    .rejects.toMatchObject({ details: { reason: 'media.ffmpeg_version_unsupported' } })
  expect(run).toHaveBeenCalledTimes(1)
  expect(run.mock.calls[0]?.[1]).toEqual(['-version'])
})
