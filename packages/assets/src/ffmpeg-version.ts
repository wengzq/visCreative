import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { VisError } from '@vis/domain'

const exec = promisify(execFile)
const versions = new Map<string, Promise<string | undefined>>()

/** Share in-flight checks and results across exports using the same executable. */
export function detectFfmpegVersion(path: string): Promise<string | undefined> {
  const executable = /[/\\]/.test(path) ? resolve(path) : path
  let pending = versions.get(executable)
  if (!pending) {
    pending = exec(executable, ['-version'], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 })
      .then(({ stdout }) => /^ffmpeg version (?:n)?(\d+\.\d+(?:\.\d+)?)(?=[\s-]|$)/m.exec(stdout)?.[1], () => undefined)
    versions.set(executable, pending)
  }
  return pending
}

export async function requireFfmpeg7(path: string): Promise<void> {
  const version = await detectFfmpegVersion(path)
  // Git snapshots and vendor version schemes must get a chance to run.
  if (version && Number(version.split('.')[0]) < 7) {
    throw VisError.of('unavailable', 'media.ffmpeg_version_unsupported', { version, required: 7 }, `Found ffmpeg ${version}. Timeline export requires ffmpeg 7 or newer. Update ffmpeg and restart visCreative to export.`)
  }
}
