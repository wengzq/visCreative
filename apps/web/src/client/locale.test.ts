import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeError } from '@vis/ui-kit'
import { initialLocale } from './LocaleApp'
import { connectRpc, RpcError } from './rpc'

// Test initialization caching and transport separately; English e2e covers immediate page switching and persistence.
afterEach(() => vi.unstubAllGlobals())

describe('Web language initialization and error transport', () => {
  it('prefers valid cache; missing, invalid, or unreadable caches follow the browser', () => {
    vi.stubGlobal('navigator', { languages: ['en-US'] })
    vi.stubGlobal('localStorage', { getItem: () => 'zh-CN' })
    expect(initialLocale()).toBe('zh-CN')
    vi.stubGlobal('localStorage', { getItem: () => 'en' })
    expect(initialLocale()).toBe('en')
    for (const value of [null, 'fr', '']) {
      vi.stubGlobal('localStorage', { getItem: () => value })
      expect(initialLocale()).toBe('en')
    }
    vi.stubGlobal('navigator', { languages: ['zh-TW'] })
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') } })
    expect(initialLocale()).toBe('zh-CN')
  })

  it('RPC preserves reason/params unchanged; English errors fall back to structured codes', async () => {
    let socket!: FakeSocket
    class FakeSocket {
      static OPEN = 1
      readyState = 1
      onopen?: () => void
      onmessage?: (event: { data: string }) => void
      onclose?: () => void
      send = vi.fn()
      close() {}
      constructor() { socket = this }
    }
    vi.stubGlobal('WebSocket', FakeSocket)
    const rpc = connectRpc({ url: 'ws://localhost', onNotification() {}, onStatus() {}, onOpen() {}, getLocale: () => 'en' })
    const pending = rpc.call('skill.import', {})
    const data = { code: 'invalid_params', reason: 'test.unknown', params: { name: '用户名称', count: 2 } }
    // english-exempt: Chinese RPC diagnostic fixture verifies locale fallback and unchanged transport.
    socket.onmessage!({ data: JSON.stringify({ id: 1, error: { code: -32602, message: '导入失败', data } }) })
    const error = await pending.catch(error => error)
    expect(error).toBeInstanceOf(RpcError)
    expect(error.data).toEqual(data)
    expect(error.message).toBe('导入失败')
    expect(describeError(error, 'en')).toBe('Invalid request')
    expect(describeError(error, 'zh-CN')).toBe('导入失败')
    rpc.close()
  })
})

it('deduplicates global skill changes by sequence and rereads after reconnect', () => {
  let socket!: FakeSocket
  class FakeSocket {
    static OPEN = 1
    readyState = 1
    onopen?: () => void
    onmessage?: (event: { data: string }) => void
    send() {}
    close() {}
    constructor() { socket = this }
  }
  vi.stubGlobal('WebSocket', FakeSocket)
  const rpc = connectRpc({ url: 'ws://localhost', onNotification() {}, onStatus() {}, onOpen() {} })
  const changed = vi.fn()
  const unsubscribe = rpc.onSkillsChanged!(changed)
  const event = (seq: number) => socket.onmessage!({ data: JSON.stringify({ method: 'events.skillsChanged', params: { seq } }) })
  event(7); event(7); event(6); event(8)
  expect(changed).toHaveBeenCalledTimes(2)
  socket.onopen!()
  expect(changed).toHaveBeenCalledTimes(3)
  event(1)
  expect(changed).toHaveBeenCalledTimes(4)
  unsubscribe()
  event(2)
  expect(changed).toHaveBeenCalledTimes(4)
  rpc.close()
})
