import { describe, expect, it } from 'vitest'
import { VisError } from '@vis/domain'
import { fingerprint, runIdempotent } from './idempotency'
import { openSpaceDb } from './open'
import { blobs } from './schema/space'

describe('runIdempotent', () => {
  it('fingerprints are independent of field order', () => {
    expect(fingerprint('m', { a: 1, b: [{ x: 1, y: 2 }] })).toBe(fingerprint('m', { b: [{ y: 2, x: 1 }], a: 1 }))
    expect(fingerprint('m', { a: 1 })).not.toBe(fingerprint('n', { a: 1 }))
  })

  it('the same requestId and content execute once and return the first result; different content conflicts', () => {
    const db = openSpaceDb(':memory:')
    let calls = 0
    const run = (params: unknown) =>
      runIdempotent(db, { requestId: 'req_1', method: 'test', params }, tx => {
        calls++
        tx.insert(blobs).values({ hash: `h${calls}`, byteSize: 1, createdAt: 0 }).run()
        return { n: calls }
      })
    expect(run({ a: 1 })).toEqual({ n: 1 })
    expect(run({ a: 1 })).toEqual({ n: 1 })
    expect(calls).toBe(1)
    expect(() => run({ a: 2 })).toThrow(VisError)
    expect(db.select().from(blobs).all()).toHaveLength(1)
  })

  it('failed execution rolls back without registering requestId, allowing retries', () => {
    const db = openSpaceDb(':memory:')
    expect(() =>
      runIdempotent(db, { requestId: 'req_2', method: 'test', params: {} }, tx => {
        tx.insert(blobs).values({ hash: 'h', byteSize: 1, createdAt: 0 }).run()
        throw new Error('Failed')
      }),
    ).toThrow('Failed')
    expect(db.select().from(blobs).all()).toHaveLength(0)
    expect(runIdempotent(db, { requestId: 'req_2', method: 'test', params: {} }, () => 'ok')).toBe('ok')
  })
})
