import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { outputDir, root } from './package-paths.mjs'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
export const iconDir = join(outputDir, 'icons')

export async function buildIcons() {
  if (process.platform !== 'darwin') throw new Error('The macOS icon build requires iconutil')
  const profile = await mkdtemp(join(tmpdir(), 'vis-icon-'))
  await rm(iconDir, { recursive: true, force: true })
  await mkdir(iconDir, { recursive: true })
  try {
    const env = { ...process.env, VIS_ICON_PROFILE: profile, VIS_ICON_OUTPUT: iconDir, VIS_ICON_SOURCE: join(root, 'apps/web/src/client/public/favicon.svg') }
    delete env.ELECTRON_RUN_AS_NODE
    await exec(require('electron'), [fileURLToPath(new URL('render-icons.cjs', import.meta.url))], { env, timeout: 60_000 })
    await exec('/usr/bin/iconutil', ['-c', 'icns', join(iconDir, 'app.iconset'), '-o', join(iconDir, 'app.icns')])
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
}
