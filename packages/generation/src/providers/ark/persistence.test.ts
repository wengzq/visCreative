import { describe, expect, it, vi } from 'vitest'
import { replaceRecord } from './persistence'

describe('Atomic replacement of Ark submission records', () => {
  it('temporary Windows EPERM retries only rename with the same source and destination files', async () => {
    const rename = vi.fn().mockRejectedValueOnce(Object.assign(new Error(), { code: 'EPERM' })).mockRejectedValueOnce(Object.assign(new Error(), { code: 'EPERM' })).mockResolvedValue(undefined)
    const wait = vi.fn().mockResolvedValue(undefined)
    await replaceRecord('result.tmp', 'submitting.json', { platform: 'win32', rename, wait })
    expect(rename.mock.calls).toEqual(Array.from({ length: 3 }, () => ['result.tmp', 'submitting.json']))
    expect(wait.mock.calls).toEqual([[10], [20]])
  })

  it('persistent Windows failures have a limit and do not delete idempotency placeholder records', async () => {
    const error = Object.assign(new Error(), { code: 'EPERM' })
    const rename = vi.fn().mockRejectedValue(error)
    const wait = vi.fn().mockResolvedValue(undefined)
    await expect(replaceRecord('result.tmp', 'submitting.json', { platform: 'win32', rename, wait })).rejects.toBe(error)
    expect(rename).toHaveBeenCalledTimes(8)
    expect(wait.mock.calls).toEqual([[10], [20], [40], [80], [160], [320], [640]])
  })

  it.each([{ platform: 'darwin' as const, code: 'EPERM' }, { platform: 'win32' as const, code: 'ENOENT' }, { platform: 'win32' as const, code: 'ENOSPC' }])('$platform / $code does not retry', async ({ platform, code }) => {
    const error = Object.assign(new Error(), { code })
    const rename = vi.fn().mockRejectedValue(error)
    const wait = vi.fn()
    await expect(replaceRecord('result.tmp', 'submitting.json', { platform, rename, wait })).rejects.toBe(error)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })
})
