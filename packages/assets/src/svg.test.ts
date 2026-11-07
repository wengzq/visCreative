import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createFfmpegMedia, mimeOf } from './media'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vis-svg-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const media = createFfmpegMedia({ ffprobePath: '/no-ffprobe-needed' })
function probe(contents: string | Buffer) {
  const path = join(dir, 'image.svg')
  writeFileSync(path, contents)
  return media.probe(path)
}

it('SVG needs no ffprobe and viewBox supplies dimensions', async () => {
  expect(mimeOf('image.SVG')).toBe('image/svg+xml')
  expect(await probe('<?xml version="1.0" encoding="UTF-8"?><!-- 插图 --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="10" height="10" /></svg>'))
    .toEqual({ kind: 'image', mime: 'image/svg+xml', width: 640, height: 360 })
})

it('root dimensions take precedence, percentages fall back to viewBox and unknown dimensions are omitted', async () => {
  expect(await probe('<svg width="120px" height="80" viewBox="0 0 640 360"/>')).toMatchObject({ width: 120, height: 80 })
  expect(await probe('<svg width="100%" height="40px" viewBox="0,0,640,360"/>')).toMatchObject({ width: 640, height: 40 })
  expect(await probe('<svg width="100000000000000000000" height="80"/>')).toEqual({ kind: 'image', mime: 'image/svg+xml', height: 80 })
  expect(await probe('<svg viewBox="0 0 1e200 80"/>')).toEqual({ kind: 'image', mime: 'image/svg+xml', height: 80 })
  expect(await probe('<svg/><!-- creator --><!-- end -->')).toEqual({ kind: 'image', mime: 'image/svg+xml' })
  expect(await probe('<svg><rect width="999" height="999"/></svg>')).toEqual({ kind: 'image', mime: 'image/svg+xml' })
})

it.each([
  '<!DOCTYPE svg><svg/>', '<!ENTITY x "bad"><svg/>',
  '<html><svg/></html>', '<svg/>more', '<svg>not closed', 'not svg',
  '<?xml version="1.0" encoding="UTF-16"?><svg/>',
])('rejects invalid SVG: %s', async contents => {
  await expect(probe(contents)).rejects.toMatchObject({ code: 'invalid_params' })
})

it('rejects invalid UTF-8 and oversized SVG', async () => {
  await expect(probe(Buffer.from([0xff, 0xfe, 0x3c]))).rejects.toMatchObject({ code: 'invalid_params', message: 'SVG must be UTF-8 text', details: { reason: 'asset.svg_invalid_encoding', params: {} } })
  await expect(probe(Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: 'invalid_params', message: 'SVG file exceeds the 10 MiB limit', details: { reason: 'asset.svg_too_large', params: {} } })
})
