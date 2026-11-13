import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
// studiod entry point. Launched detached by the Electron main process (RFC 0004 "Local communication"); can also run directly during development.
//   VIS_DATA_DIR     Application data directory (required)
//   VIS_CLI_BIN_DIR  Directory containing the vis executable, injected into Agent PATH (required)
//   VIS_CODEX_PATH   Optional codex executable; defaults to searching PATH
//   VIS_CODEX_MODEL  Optional override for the default Codex model
//   VIS_DSH_PATH     Optional dsh executable; searches PATH then the npx cache by default; users configure DEEPSEEK_API_KEY in their own environment, studiod does not read it
//   VIS_DSH_MODEL    Optional override for the default DeepSeek model
//   VIS_CODEBUDDY_PATH Optional CodeBuddy executable; searches codebuddy then cbc on PATH
//   VIS_MCODE_PATH   Optional MiniMax Code executable; searches PATH then ~/.minimax-code/bin/mcode
//   VIS_CLAUDE_MODEL Optional override for the default Claude model
//   VIS_CHROME_PATH Optional Chrome for code rendering; defaults to the system Google Chrome installation
//   VIS_FFMPEG_PATH  Optional ffmpeg (RFC 0046: the desktop app's bundled build); defaults to ffmpeg on PATH
//   VIS_FFPROBE_PATH Optional ffprobe; defaults to the one beside VIS_FFMPEG_PATH, else ffprobe on PATH
//   VIS_FONTS_DIR    Optional built-in caption fonts directory; defaults to the repository copy
//   VIS_STUDIOD_LOG  Optional log file that receives console output (RFC 0046: the desktop app starts studiod without a terminal)
import { dirname, join } from 'node:path'
import { codexDescriptor, codexAvailability } from '@vis/agent-codex'
import { deepseekDescriptor, resolveDsh } from '@vis/agent-deepseek'
import { codebuddyDescriptor, codebuddyAvailability } from '@vis/agent-codebuddy'
import { minimaxDescriptor, resolveMcode } from '@vis/agent-minimax'
import { claudeDescriptor } from '@vis/agent-claude'
import { registerAgents } from './agents'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createMockProvider, createRenderProvider } from '@vis/generation'
import { createFfmpegMedia } from '@vis/assets'
import { mediaBinaries } from './media-binaries'
import { claudeRuntime } from './claude'
import { codexRuntime } from './codex'
import { deepseekRuntime } from './deepseek'
import { minimaxRuntime } from './minimax'
import { codebuddyRuntime } from './codebuddy'
import { startStudiod, StudiodRunningError } from './studiod'
import { prepareAgentCli } from './agent-cli'
import { logToFile } from './log-file'

const STUDIOD_VERSION = '0.0.0'

// RFC 0046: the desktop app starts studiod through its own binary with this set. Children that need it get it from
// nodeChildEnv; anything else started from here (Agents, ffmpeg, Chrome) must not inherit it.
delete process.env.ELECTRON_RUN_AS_NODE

if (process.env.VIS_STUDIOD_LOG) {
  const write = logToFile(process.env.VIS_STUDIOD_LOG)
  // Without a terminal the default crash report on stderr goes nowhere.
  process.on('uncaughtException', error => { write('fatal', error); process.exit(1) })
  process.on('unhandledRejection', error => { write('fatal', error); process.exit(1) })
}

const dataDir = process.env.VIS_DATA_DIR
const cliBinDir = process.env.VIS_CLI_BIN_DIR
if (!dataDir || !cliBinDir) {
  console.error('VIS_DATA_DIR and VIS_CLI_BIN_DIR environment variables are required')
  process.exit(2)
}

const socketPath = studiodEndpoint(dataDir)
const binaries = mediaBinaries(process.env)
const agentCli = prepareAgentCli(dataDir, cliBinDir)
const agentPaths = { cliBinDir: agentCli.cliBinDir, fallbackDirs: binaries.ffmpegPath ? [dirname(binaries.ffmpegPath)] : [] }
// Run the bundled vis with the current Node, without relying on node in PATH.
const visMcp = { command: process.execPath, args: [join(cliBinDir, 'vis.mjs'), 'mcp'] }
const studiod = await startStudiod({
  dataDir,
  studiodVersion: STUDIOD_VERSION,
  media: createFfmpegMedia(binaries),
  runtimes: registerAgents([
    { descriptor: codexDescriptor, availability: () => codexAvailability(process.env.VIS_CODEX_PATH, agentCli.env), runtime: codexRuntime({
      socketPath,
      dataDir,
      env: agentCli.env,
      ...agentPaths,
      visMcp,
      ...(process.env.VIS_CODEX_PATH ? { codexPath: process.env.VIS_CODEX_PATH } : {}),
      ...(process.env.VIS_CODEX_MODEL ? { model: process.env.VIS_CODEX_MODEL } : {}),
    }) },
    { descriptor: deepseekDescriptor, availability: () => resolveDsh({ env: agentCli.env }) ? { available: true } : { available: false, reason: 'executable_missing' }, runtime: deepseekRuntime({
      socketPath,
      dataDir,
      env: agentCli.env,
      ...agentPaths,
      visMcp,
      ...(process.env.VIS_DSH_PATH ? { dshPath: process.env.VIS_DSH_PATH } : {}),
      ...(process.env.VIS_DSH_MODEL ? { model: process.env.VIS_DSH_MODEL } : {}),
    }) },
    { descriptor: minimaxDescriptor, availability: () => resolveMcode({ env: agentCli.env }) ? { available: true } : { available: false, reason: 'executable_missing' }, runtime: minimaxRuntime({
      socketPath,
      dataDir,
      env: agentCli.env,
      ...agentPaths,
      visMcp,
      ...(process.env.VIS_MCODE_PATH ? { mcodePath: process.env.VIS_MCODE_PATH } : {}),
    }) },
    { descriptor: codebuddyDescriptor, availability: () => codebuddyAvailability({ env: agentCli.env }), runtime: codebuddyRuntime({
      socketPath,
      dataDir,
      env: agentCli.env,
      ...agentPaths,
      visMcp,
      ...(process.env.VIS_CODEBUDDY_PATH ? { codebuddyPath: process.env.VIS_CODEBUDDY_PATH } : {}),
    }) },
    { descriptor: claudeDescriptor, runtime: claudeRuntime({
      query,
      socketPath,
      env: agentCli.env,
      ...agentPaths,
      ...(process.env.VIS_CLAUDE_MODEL ? { model: process.env.VIS_CLAUDE_MODEL } : {}),
    }) },
  ]),
  // Built-in providers are always available; Ark providers and default models load from providers.json and can be updated at runtime.
  providers: [
    createMockProvider(binaries.ffmpegPath ? { ffmpegPath: binaries.ffmpegPath } : {}),
    createRenderProvider({
      workDir: join(dataDir, 'render'),
      userLibDir: join(dataDir, 'render-libs'),
      // Library files are copied to dist/lib during packaging.
      libs: Object.fromEntries(['anime.js', 'rough.js', 'three.module.js', 'three.core.js', 'vis-scene.js'].map(name => [name, fileURLToPath(new URL(`./lib/${name}`, import.meta.url))])),
      ...(process.env.VIS_CHROME_PATH ? { chromePath: process.env.VIS_CHROME_PATH } : {}),
      ...(binaries.ffmpegPath ? { ffmpegPath: binaries.ffmpegPath } : {}),
    }),
  ],
  defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
}).catch(error => {
  // An existing instance serves this data directory: not a failure; the caller can connect to it.
  if (error instanceof StudiodRunningError) {
    console.log(`[studiod] ${error.message}; skipping duplicate startup`)
    process.exit(0)
  }
  throw error
})

// Create the default project on first run; existing projects keep their names.
if (studiod.spaces.list().length === 0) studiod.spaces.create('我的项目')
console.log(`[studiod] Started ${studiod.socketPath}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void studiod.stop('user_quit') })
const reason = await studiod.stopped
console.log(`[studiod] Exited (${reason})`)
process.exit(0)
