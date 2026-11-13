import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JobView, MethodParams, SpaceSummary } from '@vis/protocol'
import { _electron, type ElectronApplication } from 'playwright-core'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { detectVideoEncoder, SOFTWARE_FIRST_H264_ENCODERS } from '../../../packages/assets/src/encoders'
import { prepareSandbox } from '../../../packages/workbench/core/src/sandbox'
import { agentPath } from '../../../packages/workbench/core/src/agent-path'
import { removeTempDir } from '../../web/e2e/platform'
import { openStudiodLink, type StudiodLink } from '../../web/src/host/studiod-link'
import { cleanupStudiod, selectStudiodPid } from './process-helpers'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = resolve(process.env.VIS_DESKTOP_OUTPUT_DIR || join(root, 'artifacts/desktop'))
const bundle = resolve(process.env.VIS_PACKAGED_APP || join(output, 'dist/mac-arm64/visCreative.app'))
const binary = join(bundle, 'Contents/MacOS/visCreative')
const resources = join(bundle, 'Contents/Resources')
const requireBundledMedia = process.env.VIS_PACKAGED_REQUIRE_BUNDLED_MEDIA === '1'
let scratch: string
let dataDir: string
let electronApp: ElectronApplication | undefined
let admin: StudiodLink | undefined
let daemonPid: number | undefined
const tokenPath = () => join(dataDir, 'run/studiod.token')
const link = () => openStudiodLink({ socketPath: studiodEndpoint(dataDir), tokenPath: tokenPath() })
const alive = () => {
  if (!daemonPid) return false
  try {
    process.kill(daemonPid, 0)
    return true
  } catch { return false }
}
function studiodPid() {
  let output: string
  try { output = execFileSync('lsof', ['-t', join(dataDir, 'run/studiod.lock')], { encoding: 'utf8' }) } catch { return undefined }
  return selectStudiodPid(output, pid => {
    try {
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
      const executable = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { encoding: 'utf8' })
      return command.includes(realpathSync(join(resources, 'studiod/dist/studiod.mjs'))) && executable.includes(realpathSync(binary))
    } catch { return false }
  })
}

beforeAll(() => {
  if (process.platform !== 'darwin' || !existsSync(binary)) throw new Error('Build a macOS app with dist:mac, or set VIS_PACKAGED_APP to a copied .app')
  scratch = mkdtempSync(join(tmpdir(), 'vis-packaged-'))
  dataDir = join(scratch, 'data')
})

afterAll(async () => {
  admin?.close()
  await electronApp?.close().catch(() => {})
  if (!dataDir) return
  daemonPid ??= studiodPid()
  await cleanupStudiod({
    shutdown: async () => {
      const shutdown = await link().catch(() => undefined)
      if (!shutdown) {
        if (alive()) throw new Error('Cannot connect to the test studiod for shutdown')
        return
      }
      try { await shutdown.call('runtime.shutdown', { reason: 'user_quit' }) } finally { shutdown.close() }
    },
    waitForExit: () => vi.waitFor(() => expect(alive()).toBe(false), { timeout: 5000 }),
    alive,
    terminate: signal => {
      if (!alive()) return
      if (studiodPid() !== daemonPid) throw new Error('Refusing to stop a process that no longer owns the isolated test lock')
      try { process.kill(daemonPid!, signal) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    },
    remove: () => removeTempDir(scratch),
  })
})

async function launch() {
  const env: NodeJS.ProcessEnv = { ...process.env, VIS_DATA_DIR: dataDir, VIS_PROJECTS_DIR: join(scratch, 'projects') }
  delete env.ELECTRON_RUN_AS_NODE
  if (requireBundledMedia) {
    // The GUI must not reintroduce a system ffmpeg through the login shell's PATH.
    env.SHELL = '/usr/bin/false'
    delete env.VIS_FFMPEG_PATH
    delete env.VIS_FFPROBE_PATH
  }
  electronApp = await _electron.launch({ executablePath: binary, env: env as Record<string, string> })
  const page = await electronApp.firstWindow()
  admin = await link()
  const projects = (await admin.call('space.list')).spaces as SpaceSummary[]
  expect(projects.length).toBeGreaterThan(0)
  await page.getByText(projects[0]!.name).first().waitFor({ timeout: 20_000 })
  await admin.call('events.subscribe', { spaceId: projects[0]!.spaceId })
  await expect.poll(() => electronApp!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true)
  expect(await electronApp.evaluate(({ app }) => app.isPackaged)).toBe(true)
  return page
}

async function generate(params: MethodParams<'generation.submit'>) {
  const { jobId } = await admin!.call('generation.submit', params)
  let job: JobView
  await expect.poll(async () => {
    job = await admin!.call('generation.get', { jobId, waitMs: 1000 })
    return ['succeeded', 'failed', 'cancelled', 'unknown'].includes(job.status) ? job.status : 'pending'
  }, { timeout: 45_000 }).toBe('succeeded')
  expect(job!.outputs[0]!.delivery.status).toBe('delivered')
  return job!
}

it('runs a relocated app, generates and renders locally, and reuses its Electron studiod after quit', async () => {
  const page = await launch()
  daemonPid = studiodPid()
  expect(daemonPid).toBeGreaterThan(0)
  const executable = execFileSync('lsof', ['-a', '-p', String(daemonPid), '-d', 'txt', '-Fn'], { encoding: 'utf8' })
  expect(executable).toContain(binary)
  expect(execFileSync('ps', ['-p', String(daemonPid), '-o', 'command='], { encoding: 'utf8' })).toContain(join(resources, 'studiod/dist/studiod.mjs'))
  console.info('studiod executable verified: the packaged app binary is running its .mjs entry in Node mode')
  expect(execFileSync(join(resources, 'cli/vis'), ['--help'], { encoding: 'utf8' })).toContain('vis')
  const bin = join(scratch, 'bin')
  mkdirSync(bin)
  symlinkSync(join(resources, 'cli/vis'), join(bin, 'vis'))
  expect(execFileSync(join(bin, 'vis'), ['--help'], { encoding: 'utf8' })).toContain('vis')
  expect((await admin!.call('font.list')).fonts.length).toBeGreaterThan(0)

  const image = await generate({ requestId: randomUUID(), kind: 'image', provider: 'mock', model: 'mock-image-1', prompt: 'Packaged smoke image', params: { width: 128, height: 128 } })
  expect(image.outputs[0]!.mime).toBe('image/png')
  const ffmpeg = existsSync(join(resources, 'ffmpeg/ffmpeg')) ? join(resources, 'ffmpeg/ffmpeg') : 'ffmpeg'
  if (requireBundledMedia) {
    expect(ffmpeg).toBe(join(resources, 'ffmpeg/ffmpeg'))
    for (const name of ['ffprobe', 'LICENSES', 'BUILDINFO.json', 'SOURCE-OFFER.txt']) expect(existsSync(join(resources, 'ffmpeg', name))).toBe(true)
    expect(existsSync(join(resources, 'ffmpeg/source'))).toBe(false)
    expect(readFileSync(join(resources, 'ffmpeg/SOURCE-OFFER.txt'), 'utf8')).toContain('The exact build recipes')
    expect(spawnSync('ffmpeg', ['-version']).error).toMatchObject({ code: 'ENOENT' })
    expect(execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' })).not.toMatch(/\blibx264\b/)
  }
  const encoder = await detectVideoEncoder({ ffmpegPath: ffmpeg, priority: SOFTWARE_FIRST_H264_ENCODERS }).catch(() => undefined)
  const renderEncoder = encoder
  if (requireBundledMedia) {
    expect(['h264_videotoolbox', 'libopenh264']).toContain(encoder?.name)
    expect(['h264_videotoolbox', 'libopenh264']).toContain(renderEncoder?.name)
  }
  if (encoder) {
    const video = await generate({ requestId: randomUUID(), kind: 'video', provider: 'mock', model: 'mock-video-1', prompt: 'Packaged smoke video' })
    expect(video.outputs[0]!.mime).toBe('video/mp4')
    // The operation path actually encodes a clip instead of returning the static mock fixture.
    await generate({ requestId: randomUUID(), kind: 'video', provider: 'mock', model: 'mock-video-1', operation: 'video.removeSubtitles', prompt: '', inputs: [{ slotId: video.outputs[0]!.delivery.slotId! }] })
    console.info(`Mock video and encoded operation passed (${encoder.name})`)
  } else console.info('SKIP mock video: bundled/PATH ffmpeg has no usable H.264 encoder')

  const chrome = process.env.VIS_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (existsSync(chrome)) {
    const { idMap } = await admin!.call('canvas.apply', { requestId: randomUUID(), ops: [{ op: 'node.create', tempId: 'code', kind: 'text', format: 'code', x: 0, y: 0, w: 300, h: 200, content: { text: '<!doctype html><body style="margin:0;background:teal"><script>window.vis={duration:1,seek(){}}</script>' } }] })
    const { nodes } = await admin!.call('canvas.get', { nodeIds: [idMap.code] })
    const slot = nodes[0].slots.find((slot: { slotKey: string }) => slot.slotKey === 'main')
    const rendered = await generate({ requestId: randomUUID(), kind: encoder ? 'video' : 'image', provider: 'render', model: 'html', prompt: 'Packaged local render', inputs: [{ slotId: slot.slotId, revision: slot.revision }], params: { width: 64, height: 64, fps: 2, durationMs: 1000 } })
    expect(rendered.outputs[0]!.mime).toBe(encoder ? 'video/mp4' : 'image/png')
    console.info('Local Chrome render passed')
  } else console.info('SKIP local render: Google Chrome is not installed (set VIS_CHROME_PATH to override)')

  const cwd = join(scratch, 'sandbox-work')
  mkdirSync(cwd)
  const sandbox = prepareSandbox({ cwd, dataDir, env: { HOME: join(scratch, 'home'), PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', ELECTRON: '1', ELECTRON_ENABLE_LOGGING: '1' }, agent: { runtimeDirectory: '.smoke-agent', envPassthrough: [] } })
  expect(sandbox.isolation).toBe('sandbox')
  expect(sandbox.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  expect(sandbox.env).not.toHaveProperty('ELECTRON')
  expect(Object.keys(sandbox.env).some(key => key.startsWith('ELECTRON'))).toBe(false)
  sandbox.env.PATH = agentPath({ cliBinDir: join(resources, 'cli'), base: sandbox.env.PATH, fallbackDirs: ffmpeg !== 'ffmpeg' ? [dirname(ffmpeg)] : [] })
  const policy = join(scratch, 'sandbox.sb')
  writeFileSync(policy, sandbox.policy!)
  const info = JSON.parse(execFileSync('/usr/bin/sandbox-exec', ['-f', policy, binary, '-e', 'console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node,abi:process.versions.modules,execPath:process.execPath}))'], { env: { ...sandbox.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }))
  expect(realpathSync(info.execPath)).toBe(realpathSync(binary))
  expect(info.electron).toMatch(/^45\./)
  console.info('Agent sandbox can execute the packaged app binary in Node mode; Electron variables stay outside its allowlist')
  if (requireBundledMedia) {
    const shell = (command: string, args: string[] = []) => execFileSync('/usr/bin/sandbox-exec', ['-f', policy, '/bin/sh', '-c', command, 'agent-media-smoke', ...args], { cwd, env: sandbox.env, encoding: 'utf8' })
    expect(realpathSync(shell('command -v ffmpeg').trim())).toBe(realpathSync(ffmpeg))
    expect(realpathSync(shell('command -v ffprobe').trim())).toBe(realpathSync(join(dirname(ffmpeg), 'ffprobe')))
    expect(shell('exec ffmpeg -version')).toContain('ffmpeg version 9.0.2')
    shell('exec ffmpeg "$@"', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=teal:s=128x128:r=5:d=1', '-frames:v', '5', '-c:v', encoder!.name, ...encoder!.args, '-y', 'agent-media.mp4'])
    const video = JSON.parse(shell('exec ffprobe -v error -show_entries stream=codec_name,width,height -of json agent-media.mp4'))
    expect(video.streams).toEqual([{ codec_name: 'h264', width: 128, height: 128 }])
    console.info(`Agent sandbox shell resolved bundled ffmpeg/ffprobe and encoded lavfi H.264 (${encoder!.name})`)
  }

  // Exercise macOS's activate handler without changing status or stopping the daemon.
  await page.close()
  expect(await electronApp!.evaluate(({ app, BrowserWindow }) => ({ dock: app.dock!.isVisible(), windows: BrowserWindow.getAllWindows().length }))).toEqual({ dock: true, windows: 0 })
  await electronApp!.evaluate(({ app }) => { app.emit('activate') })
  await electronApp!.firstWindow()
  console.info('macOS stays in the Dock without windows and activate recreates the window')

  const token = readFileSync(tokenPath(), 'utf8')
  expect(readFileSync(join(dataDir, 'logs/studiod.log'), 'utf8').includes(token.trim())).toBe(false)
  admin!.close()
  await electronApp!.close()
  await launch()
  expect(readFileSync(tokenPath(), 'utf8')).toBe(token)
  expect(studiodPid()).toBe(daemonPid)
  console.info('Quit/relaunch reused the same studiod PID and token')
  if (process.env.VIS_PACKAGED_REPORT) writeFileSync(process.env.VIS_PACKAGED_REPORT, JSON.stringify({
    bundle, ui: true, mockImage: true, mockVideo: !!encoder, mockVideoOperation: !!encoder,
    encoder: encoder?.name ?? null, renderEncoder: renderEncoder?.name ?? null,
    bundledFfmpeg: ffmpeg !== 'ffmpeg', ffmpegPath: ffmpeg,
    systemFfmpegUnavailable: !!spawnSync('ffmpeg', ['-version']).error,
    render: existsSync(chrome), studiodUsesAppBinary: true,
    sandbox: info, agentEnvironmentExcludesElectron: true, dockActivation: true, reusedStudiod: true,
    agentBundledFfmpeg: requireBundledMedia, agentEncoder: requireBundledMedia ? encoder!.name : null,
    skips: [...(!encoder ? ['Mock video: no usable H.264 encoder'] : []), ...(!existsSync(chrome) ? ['Local render: Chrome is not installed'] : [])],
  }, null, 2) + '\n')
})
