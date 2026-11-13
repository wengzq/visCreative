import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { assertNoPackagedFFmpegSources, ffmpegSourceOffer, includeFFmpegResource } from '../apps/desktop/ffmpeg-source-offer.mjs'

const sources = [
  { id: 'ffmpeg', version: '9.0.2', license: 'LGPL-2.1-or-later', archive: 'ffmpeg-9.0.2.tar.xz', sha256: 'a'.repeat(64) },
  { id: 'openh264', version: '2.7.0', license: 'BSD-2-Clause', archive: 'openh264-2.7.0.tar.gz', sha256: 'b'.repeat(64) },
]

it('offers every exact component archive and its build recipes at the configured source URL', () => {
  const offer = ffmpegSourceOffer({ sources }, 'https://example.com/media/sources/')
  expect(offer).toContain('https://example.com/media/sources/')
  expect(offer).toContain('exact build recipes')
  for (const source of sources) for (const value of Object.values(source)) expect(offer).toContain(value)
  expect(offer).not.toContain('available on request')
})

it('uses available-on-request wording for a local preview without a selected host', () => {
  expect(ffmpegSourceOffer({ sources })).toContain('available on request from the distributor of this local preview')
})

it('rejects incomplete archive identities and invalid source URLs', () => {
  expect(() => ffmpegSourceOffer({ sources: [] })).toThrow('exact source archives')
  expect(() => ffmpegSourceOffer({ sources: [{ ...sources[0], sha256: 'missing' }] })).toThrow('SHA-256')
  expect(() => ffmpegSourceOffer({ sources: [{ ...sources[0], archive: '../source.tar.xz' }] })).toThrow('archive name')
  expect(() => ffmpegSourceOffer({ sources }, 'file:///tmp/sources')).toThrow('public HTTP or HTTPS URL')
})

it('omits source archives from the copy, retains licences and metadata, and guards against reintroduction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vis-source-offer-'))
  try {
    const input = join(dir, 'input')
    const output = join(dir, 'output')
    await mkdir(join(input, 'source'), { recursive: true })
    await mkdir(join(input, 'LICENSES'))
    await writeFile(join(input, 'source', sources[0].archive), 'exact source archive')
    await writeFile(join(input, 'LICENSES', 'LGPL.txt'), 'licence text')
    await writeFile(join(input, 'BUILDINFO.json'), JSON.stringify({ sources }))
    for (const name of ['ffmpeg', 'ffprobe', 'libavcodec.dylib']) await writeFile(join(input, name), name)
    await cp(input, output, { recursive: true, filter: path => includeFFmpegResource(input, path) })
    expect((await readdir(output)).sort()).toEqual(['BUILDINFO.json', 'LICENSES', 'ffmpeg', 'ffprobe', 'libavcodec.dylib'])
    expect(await readFile(join(input, 'source', sources[0].archive), 'utf8')).toBe('exact source archive')
    expect(() => assertNoPackagedFFmpegSources(output)).not.toThrow()
    await mkdir(join(output, 'source'))
    expect(() => assertNoPackagedFFmpegSources(output)).toThrow('must be hosted separately')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
