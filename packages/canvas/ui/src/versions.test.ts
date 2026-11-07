import { describe, expect, it } from 'vitest'
import type { SlotVersionView } from '@vis/protocol'
import { assetVersions, versionDescription, versionIndex } from './versions'

const version = (revision: number, id?: string): SlotVersionView => ({ revision, content: id ? { type: 'asset', assetVersionId: id, mime: 'image/png' } : { type: 'empty' }, createdAt: 0, actor: 'user', isCurrent: false })

describe('Version numbering', () => {
  it('Number assets by first appearance from oldest to newest; restoration and clearing add no versions', () => {
    const history = [version(6, 'a'), version(5), version(4, 'c'), version(3, 'b'), version(2, 'a'), version(1)]
    const versions = assetVersions(history)
    expect(versions.map(v => v.revision)).toEqual([2, 3, 4])
    expect(versionIndex(versions, history[0]!.content)).toBe(0)
    expect(versionIndex(versions, { type: 'empty' })).toBe(-1)
    expect(history.map(v => v.revision)).toEqual([6, 5, 4, 3, 2, 1])
  })
  it('Hover descriptions include actual provenance and at most 60 prompt characters', () => {
    const v = { ...version(2, 'a'), source: { jobId: 'job', provider: 'mock', model: 'Seedream', params: {}, inputNodeIds: [], prompt: '图'.repeat(70) } }
    expect(versionDescription(v, 2, 7200000)).toBe(`v3 · 2 小时前 · Seedream / mock\n${'图'.repeat(60)}`)
    expect(versionDescription(version(1, 'a'), 0, 0)).toContain('手动替换 / 上传')
    expect(versionDescription(v, 2, 7200000, 'en')).toBe(`v3 · 2 hours ago · Seedream / mock\n${'图'.repeat(60)}`)
    expect(versionDescription(version(1, 'a'), 0, 0, 'en')).toBe('v1 · now · Manual replacement / upload')
  })
  it('Chinese relative time preserves existing rounding boundaries and the just-now copy', () => {
    const v = version(1, 'a')
    expect(versionDescription(v, 0, 59999)).toBe('v1 · 刚刚 · 手动替换 / 上传')
    expect(versionDescription(v, 0, 119999)).toBe('v1 · 1 分钟前 · 手动替换 / 上传')
    expect(versionDescription(v, 0, 7199999)).toBe('v1 · 1 小时前 · 手动替换 / 上传')
    expect(versionDescription(v, 0, 172799999)).toBe('v1 · 1 天前 · 手动替换 / 上传')
  })
})
