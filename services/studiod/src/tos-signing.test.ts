import { describe, expect, it } from 'vitest'
import { presignTosGet, signTosRequest } from './tos-signing'

const config = { region: 'cn-beijing', bucket: 'examplebucket', accessKeyId: 'testAK' }
const date = new Date('2022-01-01T00:00:00Z')

describe('TOS v4 signatures', () => {
  it('matches the published header signature vector', () => {
    const signed = signTosRequest({ config, secret: 'testSK', method: 'GET', key: 'exampleobject', date })
    expect(signed.url).toBe('https://examplebucket.tos-cn-beijing.volces.com/exampleobject')
    expect(signed.headers.authorization).toBe(`TOS4-HMAC-SHA256 Credential=${config.accessKeyId}/20220101/${config.region}/tos/request,SignedHeaders=host;x-tos-content-sha256;x-tos-date, Signature=d40b66cf0054d1642843670d10fa095e1609c7896f25df217770b0abe717693b`)
  })

  it('matches the published query signature vector and uses an unsigned payload', () => {
    const url = new URL(presignTosGet({ config, secret: 'testSK', key: 'exampleobject', ttlSeconds: 86400, date }))
    expect(url.searchParams.get('X-Tos-Signature')).toBe('353aa55583eceb222aad4bdcb70d4045a202a4af9a3096f25a656b82c8ec2f56')
    expect(url.searchParams.get('X-Tos-SignedHeaders')).toBe('host')
  })

  it('rejects lifetimes outside one second to seven days without echoing inputs', () => {
    expect(new URL(presignTosGet({ config, secret: 'testSK', key: 'clip', ttlSeconds: 604800, date })).searchParams.get('X-Tos-Expires')).toBe('604800')
    for (const ttlSeconds of [0, -1, NaN, Infinity, 0.5, 604801]) expect(() => presignTosGet({ config, secret: 'testSK', key: 'clip', ttlSeconds, date })).toThrow()
  })

  it('encodes object segments and query values using RFC 3986 and sorts by encoded bytes', () => {
    const signed = signTosRequest({ config, secret: 'testSK', method: 'GET', key: 'refs/a b!\'()*+.mp4', date, query: { prefix: 'refs/a b/', 'continuation-token': 'a+/=' } })
    expect(new URL(signed.url).pathname).toBe('/refs/a%20b%21%27%28%29%2A%2B.mp4')
    expect(new URL(signed.url).search).toBe('?continuation-token=' + 'a%2B%2F%3D&prefix=refs%2Fa%20b%2F')
  })
})
