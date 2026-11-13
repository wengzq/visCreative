import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'

// Selected response payloads from the sanitized, no-prompt Seatbelt probe on 2026-11-09 (mcode 0.7.6).
const fixture = JSON.parse(readFileSync(new URL('./handshake.json', import.meta.url), 'utf8'))
export const recorded = (method: string): any => structuredClone(fixture[method])
export const NATIVE_SESSION = recorded('session/new').sessionId as string
export const HANG = Symbol('pending response')
export type Handler = (params: any, id?: number) => unknown

/** A bidirectional ACP peer that never starts an operating-system process. */
export class ScriptedMcode extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly received: { method: string; params: any; id?: number }[] = []
  readonly answers = new Map<number, any>()
  readonly signals: NodeJS.Signals[] = []
  exited = false
  private nextId = 1000

  constructor(readonly handlers: Record<string, Handler>) {
    super()
    let buffer = ''
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      buffer += chunk
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        if (!message.method) {
          this.answers.set(message.id, message.result ?? message.error)
          continue
        }
        this.received.push(message)
        const result = this.handlers[message.method]?.(message.params, message.id) ?? {}
        if (message.id === undefined || result === HANG) continue
        this.send({ id: message.id, ...(result && typeof result === 'object' && 'error' in result ? result : { result }) })
      }
    })
    this.stdin.on('end', () => this.exit())
  }

  requests(method: string) { return this.received.filter(message => message.method === method) }
  send(message: object) { if (!this.exited) this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
  update(update: object) { this.send({ method: 'session/update', params: { sessionId: NATIVE_SESSION, update } }) }
  settlePrompt(stopReason = 'end_turn') { this.send({ id: this.requests('session/prompt').at(-1)!.id, result: { stopReason } }) }
  permission(toolCall: object) {
    const id = ++this.nextId
    this.send({ id, method: 'session/request_permission', params: { sessionId: NATIVE_SESSION, toolCall, options: [
      { optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'allow-always', kind: 'allow_always' }, { optionId: 'deny', kind: 'reject_once' },
    ] } })
    return id
  }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.signals.push(signal)
    this.exit()
    return true
  }
  exit() {
    if (this.exited) return
    this.exited = true
    this.stdout.end()
    setImmediate(() => this.emit('exit'))
  }
}

export function recordedHandlers(): Record<string, Handler> {
  let options = recorded('session/new').configOptions
  return {
    initialize: () => recorded('initialize'),
    'session/new': () => ({ ...recorded('session/new'), configOptions: structuredClone(options) }),
    'session/resume': () => recorded('session/resume'),
    'session/set_config_option': ({ configId, value }) => {
      options = options.map((option: any) => option.id === configId ? { ...option, currentValue: value } : option)
      return { ...recorded('session/set_config_option'), configOptions: structuredClone(options) }
    },
    'session/prompt': () => HANG,
    'session/close': () => recorded('session/close'),
  }
}
