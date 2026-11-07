import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
// Development client entry point. Requires studiod to be running with the same VIS_DATA_DIR (default ~/.vis-dev).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { SpaceEvent, TransientEvent } from '@vis/protocol'
import { connectUi } from './connection'
import { createDevConsole } from './console'

const dataDir = process.env.VIS_DATA_DIR ?? join(homedir(), '.vis-dev')
const run = join(dataDir, 'run')
let token: string
try {
  token = readFileSync(join(run, 'studiod.token'), 'utf8')
} catch {
  console.error(`Cannot find ${join(run, 'studiod.token')}: start studiod first (pnpm dev:studiod) and use the same VIS_DATA_DIR`)
  process.exit(2)
}

// Create readline only after connecting and subscribing: it starts reading immediately, so early lines would be lost
let rl: ReturnType<typeof createInterface> | undefined
let inputClosed = false
const prompt = (preserve = false) => { if (rl && !inputClosed) rl.prompt(preserve) }
// Do not interrupt typing when events arrive: clear the prompt line, print, then redraw
const print = (line: string) => {
  if (rl && !inputClosed) process.stdout.write('\r\x1b[2K')
  console.log(line)
  prompt(true)
}

// Streaming reply: refresh the prompt line in place, showing only the tail that fits; the next print clears it
const status = (prefix: string, body: string) => {
  if (!process.stdout.isTTY || !rl || inputClosed) return
  const room = Math.max(10, (process.stdout.columns || 80) - prefix.length - 2)
  process.stdout.write(`\r\x1b[2K${prefix}${body.length > room ? `…${body.slice(-(room - 1))}` : body}`)
}

const events: SpaceEvent[] = []
let onEvent: ((e: SpaceEvent) => void) | undefined
let devConsole: ReturnType<typeof createDevConsole> | undefined
const conn = await connectUi({
  socketPath: studiodEndpoint(dataDir),
  token,
  onNotification: n => {
    // Dropped streaming fragments are harmless; discard those arriving before subscription completes
    if (n.method === 'events.transient') { devConsole?.handleTransient(n.params as TransientEvent); return }
    if (n.method !== 'events.event') return
    const e = n.params as SpaceEvent
    if (onEvent) onEvent(e)
    else events.push(e)
  },
  onClose: () => { print('· 与 studiod 的连接已断开'); process.exit(1) },
})

const { spaces } = await conn.call('space.list')
const space = spaces.find((x: { spaceId: string }) => x.spaceId === process.env.VIS_SPACE_ID) ?? spaces[0]
if (!space) { console.error('No space'); process.exit(1) }
const sub = await conn.call('events.subscribe', { spaceId: space.spaceId })
const dev = createDevConsole({ call: conn.call, print, status, spaceId: space.spaceId, snapshot: sub.snapshot })
devConsole = dev
// Events arriving before the subscription acknowledgment are already included in the snapshot
events.length = 0
onEvent = e => dev.handleEvent(e)

console.log(`Connected to space "${space.name}": ${sub.snapshot.nodes.length} nodes, ${sub.snapshot.sessions.length} sessions. Enter /help for commands.`)
rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' })
prompt()
// Execute commands sequentially in input order
let chain = Promise.resolve()
rl.on('line', line => {
  chain = chain.then(() => dev.handleLine(line)).then(
    result => { if (result === 'quit') { conn.close(); process.exit(0) } prompt() },
    error => print(`✗ ${error instanceof Error ? error.message : String(error)}`),
  )
})
rl.on('close', () => { inputClosed = true; void chain.then(() => { conn.close(); process.exit(0) }) })
