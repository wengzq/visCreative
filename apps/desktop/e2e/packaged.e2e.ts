import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JobView, MethodParams, NodeView, SpaceSummary } from '@vis/protocol'
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
const windows = process.platform === 'win32'
const bundle = resolve(process.env.VIS_PACKAGED_APP || join(output, windows ? 'dist/win-unpacked' : 'dist/mac-arm64/visCreative.app'))
const binary = resolve(process.env.VIS_DESKTOP_EXECUTABLE || join(bundle, windows ? 'visCreative.exe' : 'Contents/MacOS/visCreative'))
const resources = windows ? join(dirname(binary), 'resources') : resolve(binary, '../../Resources')
const mediaName = (name: string) => windows ? `${name}.exe` : name
const requireBundledMedia = process.env.VIS_PACKAGED_REQUIRE_BUNDLED_MEDIA === '1'
const systemPath = windows ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32'), join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0')].join(';') : undefined
let scratch: string
let dataDir: string
let electronApp: ElectronApplication | undefined
let admin: StudiodLink | undefined
let daemonPid: number | undefined
let daemonIdentity: string | undefined
const tokenPath = () => join(dataDir, 'run/studiod.token')
const link = () => openStudiodLink({ socketPath: studiodEndpoint(dataDir), tokenPath: tokenPath() })
const alive = () => {
  if (!daemonPid) return false
  try {
    process.kill(daemonPid, 0)
    return true
  } catch { return false }
}
const powershell = (script: string) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${script}`, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim()
const psString = (value: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString('base64')}'))`
function cmd(command: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { ...options, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 30_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Test command failed (${result.status}): ${result.stderr}`)
  return result.stdout
}
function windowsProcess(pid: number) {
  const info = JSON.parse(powershell(`$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { $p | Select-Object ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress } else { 'null' }`))
  if (!info || info.ExecutablePath?.toLowerCase() !== realpathSync(binary).toLowerCase() || !info.CommandLine?.toLowerCase().includes(join(resources, 'studiod/dist/studiod.mjs').toLowerCase())) return undefined
  return JSON.stringify(info)
}
function studiodPid() {
  if (windows) {
    try {
      // The isolated named pipe identifies our daemon, even when other packaged apps are running.
      const pipe = studiodEndpoint(dataDir).replace(/^\\\\\.\\pipe\\/, '')
      const pid = Number(powershell(`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles; public static class VisSmokePipe { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(SafePipeHandle handle, out uint pid); }'
$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', (${psString(pipe)}), [IO.Pipes.PipeDirection]::InOut)
try { $pipe.Connect(2000); [uint32]$serverPid = 0; if (![VisSmokePipe]::GetNamedPipeServerProcessId($pipe.SafePipeHandle, [ref]$serverPid)) { throw 'Cannot identify test pipe server' }; $serverPid } finally { $pipe.Dispose() }`))
      if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
      const identity = windowsProcess(pid)
      if (!identity || daemonIdentity && identity !== daemonIdentity) return undefined
      daemonIdentity = identity
      return pid
    } catch { return undefined }
  }
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
  if (!['darwin', 'win32'].includes(process.platform) || !existsSync(binary)) throw new Error('Build an app with dist:mac or dist:win, or set VIS_PACKAGED_APP / VIS_DESKTOP_EXECUTABLE')
  scratch = mkdtempSync(join(tmpdir(), 'vis-packaged-'))
  dataDir = join(scratch, 'data')
})

async function closeApp() {
  if (!electronApp) return
  if (!windows) return electronApp.close()
  const child = electronApp.process()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([electronApp.close(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Test app did not close')), 10_000)
    })])
  } finally {
    clearTimeout(timer)
    // A startup error dialog can block app.quit; stop only the child Playwright launched.
    if (child.exitCode === null && child.pid) execFileSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
  }
}

afterAll(async () => {
  admin?.close()
  await closeApp().catch(() => {})
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
      if (windows ? windowsProcess(daemonPid!) !== daemonIdentity : studiodPid() !== daemonPid) throw new Error('Refusing to stop a process that no longer matches the isolated test daemon')
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
    if (windows) {
      for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]
      env.PATH = systemPath
    } else env.SHELL = '/usr/bin/false'
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
  if (windows) {
    expect(windowsProcess(daemonPid!)).toBe(daemonIdentity)
  } else {
    const executable = execFileSync('lsof', ['-a', '-p', String(daemonPid), '-d', 'txt', '-Fn'], { encoding: 'utf8' })
    expect(executable).toContain(binary)
    expect(execFileSync('ps', ['-p', String(daemonPid), '-o', 'command='], { encoding: 'utf8' })).toContain(join(resources, 'studiod/dist/studiod.mjs'))
  }
  console.info('studiod executable verified: the packaged app binary is running its .mjs entry in Node mode')
  if (windows) {
    const shim = join(dataDir, 'run/cli/vis.cmd')
    expect(readFileSync(shim, 'utf8')).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(readFileSync(shim, 'utf8')).toContain(binary)
    expect(cmd(`""${shim}" --help"`)).toContain('vis')
    expect(existsSync(join(resources, 'cli/vis'))).toBe(false)
  } else {
    expect(execFileSync(join(resources, 'cli/vis'), ['--help'], { encoding: 'utf8' })).toContain('vis')
    const bin = join(scratch, 'bin')
    mkdirSync(bin)
    symlinkSync(join(resources, 'cli/vis'), join(bin, 'vis'))
    expect(execFileSync(join(bin, 'vis'), ['--help'], { encoding: 'utf8' })).toContain('vis')
  }
  expect((await admin!.call('font.list')).fonts.length).toBeGreaterThan(0)

  const image = await generate({ requestId: randomUUID(), kind: 'image', provider: 'mock', model: 'mock-image-1', prompt: 'Packaged smoke image', params: { width: 128, height: 128 } })
  expect(image.outputs[0]!.mime).toBe('image/png')
  const ffmpeg = existsSync(join(resources, 'ffmpeg', mediaName('ffmpeg'))) ? join(resources, 'ffmpeg', mediaName('ffmpeg')) : 'ffmpeg'
  const systemMediaEnv = windows && requireBundledMedia ? { ...process.env, PATH: systemPath } : process.env
  if (windows && requireBundledMedia) for (const key of Object.keys(systemMediaEnv)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete systemMediaEnv[key]
  if (requireBundledMedia) {
    expect(ffmpeg).toBe(join(resources, 'ffmpeg', mediaName('ffmpeg')))
    for (const name of [mediaName('ffprobe'), 'LICENSES', 'BUILDINFO.json', 'SOURCE-OFFER.txt']) expect(existsSync(join(resources, 'ffmpeg', name))).toBe(true)
    expect(existsSync(join(resources, 'ffmpeg/source'))).toBe(false)
    expect(readFileSync(join(resources, 'ffmpeg/SOURCE-OFFER.txt'), 'utf8')).toContain('The exact build recipes')
    expect(spawnSync('ffmpeg', ['-version'], { env: systemMediaEnv }).error).toMatchObject({ code: 'ENOENT' })
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
    const { nodes } = await admin!.call('canvas.get') as { nodes: NodeView[] }
    const node = nodes.find(node => node.slots.some(slot => slot.slotId === video.outputs[0]!.delivery.slotId))!
    const slot = node.slots.find(slot => slot.slotId === video.outputs[0]!.delivery.slotId)!
    let trimmed = await admin!.call('media.process', { requestId: randomUUID(), operation: 'video.trim', nodeId: node.nodeId, slotId: slot.slotId, expectedRevision: slot.revision, params: { startMs: 0, endMs: 500 }, waitMs: 30_000 })
    await expect.poll(async () => {
      trimmed = await admin!.call('media.get', { taskId: trimmed.taskId, waitMs: 1000 })
      return trimmed.status
    }, { timeout: 45_000 }).toBe('succeeded')
    expect(trimmed.assetVersionIds).toHaveLength(1)
    console.info(`Mock video and encoded operation passed (${encoder.name})`)
  } else console.info('SKIP mock video: bundled/PATH ffmpeg has no usable H.264 encoder')

  const chrome = process.env.VIS_CHROME_PATH || (windows
    ? [join(process.env.ProgramFiles || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'), join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')].find(path => existsSync(path)) || ''
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  if (existsSync(chrome)) {
    const { idMap } = await admin!.call('canvas.apply', { requestId: randomUUID(), ops: [{ op: 'node.create', tempId: 'code', kind: 'text', format: 'code', x: 0, y: 0, w: 300, h: 200, content: { text: '<!doctype html><body style="margin:0;background:teal"><script>window.vis={duration:1,seek(){}}</script>' } }] })
    const { nodes } = await admin!.call('canvas.get', { nodeIds: [idMap.code] })
    const slot = nodes[0].slots.find((slot: { slotKey: string }) => slot.slotKey === 'main')
    const rendered = await generate({ requestId: randomUUID(), kind: encoder ? 'video' : 'image', provider: 'render', model: 'html', prompt: 'Packaged local render', inputs: [{ slotId: slot.slotId, revision: slot.revision }], params: { width: 64, height: 64, fps: 2, durationMs: 1000, transparent: false } })
    expect(rendered.outputs[0]!.mime).toBe(encoder ? 'video/mp4' : 'image/png')
    console.info('Local Chrome render passed')
  } else console.info('SKIP local render: Google Chrome is not installed (set VIS_CHROME_PATH to override)')

  const cwd = join(scratch, 'sandbox-work')
  mkdirSync(cwd)
  const sandbox = prepareSandbox({ cwd, dataDir, env: { HOME: join(scratch, 'home'), PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', ELECTRON: '1', ELECTRON_ENABLE_LOGGING: '1' }, agent: { runtimeDirectory: '.smoke-agent', envPassthrough: [] } })
  expect(sandbox.isolation).toBe(windows ? 'none' : 'sandbox')
  expect(sandbox.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  expect(sandbox.env).not.toHaveProperty('ELECTRON')
  expect(Object.keys(sandbox.env).some(key => key.startsWith('ELECTRON'))).toBe(false)
  sandbox.env.PATH = agentPath({ cliBinDir: windows ? join(dataDir, 'run/cli') : join(resources, 'cli'), base: windows && requireBundledMedia ? systemMediaEnv.PATH : sandbox.env.PATH, fallbackDirs: ffmpeg !== 'ffmpeg' ? [dirname(ffmpeg)] : [] })
  const policy = join(scratch, 'sandbox.sb')
  if (!windows) writeFileSync(policy, sandbox.policy!)
  const nodeArgs = ['-e', 'console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node,abi:process.versions.modules,execPath:process.execPath}))']
  const info = JSON.parse(execFileSync(windows ? binary : '/usr/bin/sandbox-exec', windows ? nodeArgs : ['-f', policy, binary, ...nodeArgs], { env: { ...sandbox.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true }))
  expect(realpathSync(info.execPath)).toBe(realpathSync(binary))
  expect(info.electron).toMatch(/^45\./)
  console.info(`${windows ? 'Agent child' : 'Agent sandbox'} can execute the packaged app binary in Node mode; Electron variables stay outside its allowlist`)
  if (requireBundledMedia) {
    const shell = (command: string, args: string[] = []) => windows
      ? cmd(command.replace(/^exec /, '').replace('"$@"', args.map(arg => `"${arg}"`).join(' ')), { cwd, env: sandbox.env })
      : execFileSync('/usr/bin/sandbox-exec', ['-f', policy, '/bin/sh', '-c', command, 'agent-media-smoke', ...args], { cwd, env: sandbox.env, encoding: 'utf8' })
    expect(realpathSync(shell(windows ? 'where ffmpeg' : 'command -v ffmpeg').trim())).toBe(realpathSync(ffmpeg))
    expect(realpathSync(shell(windows ? 'where ffprobe' : 'command -v ffprobe').trim())).toBe(realpathSync(join(dirname(ffmpeg), mediaName('ffprobe'))))
    expect(shell('exec ffmpeg -version')).toContain(windows ? 'ffmpeg version' : 'ffmpeg version 9.0.2')
    shell('exec ffmpeg "$@"', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=teal:s=128x128:r=5:d=1', '-frames:v', '5', '-c:v', encoder!.name, ...encoder!.args, '-y', 'agent-media.mp4'])
    const video = JSON.parse(shell('exec ffprobe -v error -show_entries stream=codec_name,width,height -of json agent-media.mp4'))
    expect(video.streams).toEqual([{ codec_name: 'h264', width: 128, height: 128 }])
    console.info(`Agent sandbox shell resolved bundled ffmpeg/ffprobe and encoded lavfi H.264 (${encoder!.name})`)
  }

  // Exercise macOS's activate handler without changing status or stopping the daemon.
  if (!windows) {
    await page.close()
    expect(await electronApp!.evaluate(({ app, BrowserWindow }) => ({ dock: app.dock!.isVisible(), windows: BrowserWindow.getAllWindows().length }))).toEqual({ dock: true, windows: 0 })
    await electronApp!.evaluate(({ app }) => { app.emit('activate') })
    await electronApp!.firstWindow()
    console.info('macOS stays in the Dock without windows and activate recreates the window')
  }

  const token = readFileSync(tokenPath(), 'utf8')
  expect(readFileSync(join(dataDir, 'logs/studiod.log'), 'utf8').includes(token.trim())).toBe(false)
  admin!.close()
  await closeApp()
  await launch()
  expect(readFileSync(tokenPath(), 'utf8')).toBe(token)
  expect(studiodPid()).toBe(daemonPid)
  console.info('Quit/relaunch reused the same studiod PID and token')
  if (process.env.VIS_PACKAGED_REPORT) writeFileSync(process.env.VIS_PACKAGED_REPORT, JSON.stringify({
    bundle, binary, ui: true, mockImage: true, mockVideo: !!encoder, mockVideoOperation: !!encoder, trim: !!encoder,
    encoder: encoder?.name ?? null, renderEncoder: renderEncoder?.name ?? null,
    bundledFfmpeg: ffmpeg !== 'ffmpeg', ffmpegPath: ffmpeg,
    systemFfmpegUnavailable: !!spawnSync('ffmpeg', ['-version'], { env: systemMediaEnv }).error,
    render: existsSync(chrome), studiodUsesAppBinary: true,
    sandbox: info, isolation: sandbox.isolation, agentEnvironmentExcludesElectron: true, dockActivation: !windows, reusedStudiod: true,
    agentBundledFfmpeg: requireBundledMedia, agentEncoder: requireBundledMedia ? encoder!.name : null,
    skips: [...(!encoder ? ['Mock video: no usable H.264 encoder'] : []), ...(!existsSync(chrome) ? ['Local render: Chrome is not installed'] : [])],
  }, null, 2) + '\n')
})
