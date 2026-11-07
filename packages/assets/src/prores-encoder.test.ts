import { expect, it, vi } from 'vitest'
import { createFfmpegMedia } from './media'

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: async (tool: string) => ({ stdout: tool === 'ffprobe'
      ? JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 64, height: 64 }], format: { duration: '1', format_name: 'mov,mp4' } })
      : ' V..... libx264', stderr: '' }),
  }) }
})

it('fails with a localized reason when ProRes 4444 cannot be encoded', async () => {
  await expect(createFfmpegMedia().process('/source.mp4', 'video.exportMov', {})).rejects.toMatchObject({
    code: 'unavailable', details: { reason: 'media.prores_encoder_missing' },
    message: 'This ffmpeg lacks prores_ks; MOV ProRes 4444 export is unavailable',
  })
})
