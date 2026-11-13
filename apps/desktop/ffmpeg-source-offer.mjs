import { existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export function ffmpegSourceOffer(buildInfo, sourceUrl = '') {
  let download = ''
  if (sourceUrl.trim()) {
    try {
      const url = new URL(sourceUrl.trim())
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error()
      download = url.href
    } catch { throw new Error('VIS_FFMPEG_SOURCE_URL must be a public HTTP or HTTPS URL') }
  }
  const sources = buildInfo?.sources
  if (!Array.isArray(sources) || !sources.length) throw new Error('BUILDINFO.json must list exact source archives')
  const rows = sources.map(source => {
    const text = ['id', 'version', 'license', 'archive'].every(key => typeof source[key] === 'string' && source[key].trim() && !/[\r\n]/.test(source[key]))
    if (!text || /[/\\]/.test(source.archive) || !/^[a-f\d]{64}$/i.test(source.sha256 ?? '')) {
      throw new Error('BUILDINFO.json must include each component, version, licence, archive name and SHA-256')
    }
    return [`Component: ${source.id}`, `Version: ${source.version}`, `Licence: ${source.license}`, `Archive: ${source.archive}`, `SHA-256: ${source.sha256.toLowerCase()}`].join('\n')
  })
  return [
    'visCreative bundled media: written source offer',
    '',
    download ? `Obtain the exact sources and build recipes at: ${download}`
      : 'The exact sources and build recipes are available on request from the distributor of this local preview.',
    'The exact build recipes used for these binaries are included in the source download.',
    'BUILDINFO.json beside this offer also records the build commands and configuration.',
    'The following SHA-256 values identify each exact source archive used to build the bundled components.',
    '', ...rows.flatMap(row => [row, '']),
  ].join('\n')
}

export function includeFFmpegResource(bundleRoot, path) {
  return relative(bundleRoot, path).split(sep)[0] !== 'source'
}

export function assertNoPackagedFFmpegSources(directory) {
  if (existsSync(join(directory, 'source'))) throw new Error('FFmpeg source archives must be hosted separately, not packaged in the app')
}
