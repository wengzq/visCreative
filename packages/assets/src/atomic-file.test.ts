import { expect, it, vi } from 'vitest'
import { replaceFileSync } from './atomic-file'

it('rechecks approval before every Windows retry and stops after eight atomic rename attempts', () => {
  const locked = Object.assign(new Error('Locked'), { code: 'EPERM' })
  const rename = vi.fn().mockImplementation(() => { throw locked })
  const wait = vi.fn()
  const beforeAttempt = vi.fn()
  expect(() => replaceFileSync('pending', 'SKILL.md', { platform: 'win32', rename, wait, beforeAttempt })).toThrow(locked)
  expect(rename.mock.calls).toEqual(Array.from({ length: 8 }, () => ['pending', 'SKILL.md']))
  expect(beforeAttempt).toHaveBeenCalledTimes(8)
  expect(wait.mock.calls).toEqual([[10], [20], [40], [80], [160], [320], [640]])
})

it('retries transient locks but never overwrites an edit made during the wait', () => {
  const rename = vi.fn().mockImplementationOnce(() => { throw Object.assign(new Error('Locked'), { code: 'EPERM' }) })
  const beforeAttempt = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('Author edited the file') })
  expect(() => replaceFileSync('pending', 'SKILL.md', { platform: 'win32', rename, wait: () => {}, beforeAttempt })).toThrow('Author edited')
  expect(rename).toHaveBeenCalledTimes(1)
  const success = vi.fn().mockImplementationOnce(() => { throw Object.assign(new Error('Locked'), { code: 'EPERM' }) }).mockReturnValue(undefined)
  replaceFileSync('pending', 'SKILL.md', { platform: 'win32', rename: success, wait: () => {} })
  expect(success).toHaveBeenCalledTimes(2)
})
