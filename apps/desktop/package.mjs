import { fileURLToPath } from 'node:url'
import { root, distDir, stageDir } from './package-paths.mjs'
import { join } from 'node:path'
import { run, stage } from './stage.mjs'
import { buildIcons } from './icons.mjs'
import { packageManagerInvocation } from './packaging-helpers.mjs'

const arch = process.argv.includes('--x64') ? 'x64' : 'arm64'
if (process.platform !== 'darwin') throw new Error('dist:mac must run on macOS')
if (!process.env.npm_execpath) throw new Error('Run this script through pnpm --filter @vis/desktop dist:mac')
const packageManager = packageManagerInvocation(process.env.npm_execpath, ['--dir', root, 'build'])
await run(packageManager.command, packageManager.args)
await run(process.execPath, [fileURLToPath(new URL('build.mjs', import.meta.url))], { cwd: fileURLToPath(new URL('.', import.meta.url)) })
await run(process.execPath, [fileURLToPath(new URL('../../scripts/fetch-fonts.mjs', import.meta.url))])
await stage(arch)
await buildIcons()
// Import after cache environment variables and the resource tree are ready.
const { build, Arch, Platform } = await import('electron-builder')
const { default: config } = await import('./electron-builder.config.mjs')
await build({ projectDir: join(stageDir, 'app'), config, targets: Platform.MAC.createTarget('dmg', arch === 'arm64' ? Arch.arm64 : Arch.x64) })
console.log(`Desktop ${arch} package: ${distDir}`)
