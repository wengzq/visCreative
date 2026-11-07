import { describe, expect, it } from 'vitest'
import { EMPTY_SCRIPT, ScriptOp, type NodeView, type ScriptAsset, type Shot } from '@vis/protocol'
import { assembleScriptTimeline, assetParts, assetSummary, assetText, bulkShots, conflictRows, continuousChains, deleteShot, EXPORT_FIELDS, insertShot, moveShot, scriptCsv, scriptMarkdown, shotOutputs, updateShot } from './script-table'

const shot = (id: string, transition: Shot['transition'] = 'cut', rev = 7): Shot => ({ id, rev, description: id, transition, characterIds: [], propIds: [] })
const asset: ScriptAsset = { id: 'hero', rev: 3, kind: 'character', name: 'Hero', description: '' }

describe('Script timeline assembly', () => {
  const output = (id: string, shotId: string, kind: 'video' | 'image', role: 'video' | 'first' | 'last' | 'previz' = kind === 'video' ? 'video' : 'first'): NodeView => ({
    nodeId: id, kind, x: 0, y: 0, w: 320, h: 180, z: 0, layoutRevision: 0,
    shot: { scriptNodeId: 'script', shotId, role },
    slots: [{ slotId: `${id}-main`, slotKey: 'main', contentType: kind, revision: 1, content: { type: 'asset', assetVersionId: `${id}-asset`, mime: kind === 'image' ? 'image/png' : 'video/mp4' } }],
  })
  it('ignores previz videos even when they are newer than finished videos or first frames', () => {
    const doc = { ...EMPTY_SCRIPT, shots: [shot('a'), { ...shot('b'), durationSec: 2 }, shot('c')] }
    const nodes = [output('finished', 'a', 'video'), output('first', 'b', 'image'), ...doc.shots.map(row => output(`previz-${row.id}`, row.id, 'video', 'previz'))]
    expect(assembleScriptTimeline('script', doc, nodes)).toEqual({
      items: ['finished', { nodeId: 'first', durationMs: 2000 }], skipped: [{ shotId: 'c', reason: 'missing' }],
    })
  })
  it('chooses the newest usable video before first frames and retains document order', () => {
    const doc = { ...EMPTY_SCRIPT, shots: [shot('a'), { ...shot('b'), durationSec: 4 }, shot('c'), shot('d')] }
    const empty = { ...output('empty', 'a', 'video'), slots: [] }
    const nodes = [output('old', 'a', 'video'), output('new', 'a', 'video'), empty, output('image', 'b', 'image'), output('last', 'c', 'image', 'last'), output('fourth', 'd', 'video')]
    expect(assembleScriptTimeline('script', doc, nodes)).toEqual({
      items: ['new', { nodeId: 'image', durationMs: 4000 }, 'fourth'],
      skipped: [{ shotId: 'c', reason: 'missing' }],
    })
    expect(assembleScriptTimeline('another-script', doc, nodes).items).toEqual([])
    expect(assembleScriptTimeline('script', doc, [nodes[0]!, nodes[3]!]).items).toEqual(['old', { nodeId: 'image', durationMs: 4000 }])
  })
  it('clamps image lengths, rounds milliseconds and leaves unspecified lengths to the server', () => {
    const doc = { ...EMPTY_SCRIPT, shots: [0.1, 60, 1.2345, null, undefined].map((durationSec, i) => ({ ...shot(String(i)), durationSec })) }
    const nodes = doc.shots.map(row => output(row.id, row.id, 'image'))
    expect(assembleScriptTimeline('script', doc, nodes).items).toEqual([
      { nodeId: '0', durationMs: 500 }, { nodeId: '1', durationMs: 30_000 }, { nodeId: '2', durationMs: 1235 }, '3', '4',
    ])
  })
  it('stops at 200 clips and marks all remaining shots as limited', () => {
    const doc = { ...EMPTY_SCRIPT, shots: Array.from({ length: 203 }, (_, i) => shot(String(i))) }
    const result = assembleScriptTimeline('script', doc, doc.shots.slice(0, 202).map(row => output(row.id, row.id, 'video')))
    expect(result.items).toHaveLength(200)
    expect(result.skipped).toEqual(doc.shots.slice(200).map(row => ({ shotId: row.id, reason: 'limit' })))
  })
  it('uses registered video durations when supplied and stops before exceeding 30 minutes', () => {
    const doc = { ...EMPTY_SCRIPT, shots: [shot('a'), shot('b'), shot('c'), shot('d')] }
    const nodes = doc.shots.map(row => output(row.id, row.id, 'video'))
    expect(assembleScriptTimeline('script', doc, nodes).items).toEqual(['a', 'b', 'c', 'd'])
    const durations = new Map([['a-asset', 900_000], ['b-asset', 900_000], ['c-asset', 1]])
    expect(assembleScriptTimeline('script', doc, nodes, durations)).toEqual({
      items: ['a', 'b'], skipped: [{ shotId: 'c', reason: 'limit' }, { shotId: 'd', reason: 'limit' }],
    })
    expect(assembleScriptTimeline('script', doc, nodes, new Map()).items).toHaveLength(4)
  })
  it('counts the server default image duration toward the 30-minute limit', () => {
    const doc = { ...EMPTY_SCRIPT, shots: Array.from({ length: 62 }, (_, i) => ({ ...shot(String(i)), durationSec: i < 60 ? 30 : null })) }
    const nodes = doc.shots.map(row => output(row.id, row.id, 'image'))
    const result = assembleScriptTimeline('script', doc, nodes)
    expect(result.items).toHaveLength(60)
    expect(result.skipped).toEqual([{ shotId: '60', reason: 'limit' }, { shotId: '61', reason: 'limit' }])
  })
})

describe('Script table operations', () => {
  it('captures row revisions, skips unchanged fields and keeps multi-edit in one patch', () => {
    const shots = [shot('a'), shot('b', 'cut', 11), shot('c')]
    expect(updateShot(shots[0]!, { description: 'a', sound: null })).toEqual([])
    expect(bulkShots(shots, new Set(['a', 'b', 'missing']), { durationSec: 4 })).toEqual([
      { kind: 'shot.update', shotId: 'a', rev: 7, fields: { durationSec: 4 } },
      { kind: 'shot.update', shotId: 'b', rev: 11, fields: { durationSec: 4 } },
    ])
    for (const op of [...insertShot(shots, 0, 'new'), ...insertShot(shots, 2, 'second')]) expect(ScriptOp.safeParse(op).success).toBe(true)
    expect(insertShot(shots, 2, 'new')[0]).toMatchObject({ afterShotId: 'b' })
  })

  it('repairs a new first row before a delete or move and addresses stable ids', () => {
    const shots = [shot('a'), shot('b', 'continuous'), shot('c', 'continuous')]
    expect(deleteShot(shots, 'a')).toEqual([
      { kind: 'shot.update', shotId: 'b', rev: 7, fields: { transition: 'cut' } },
      { kind: 'shot.delete', shotId: 'a', rev: 7 },
    ])
    expect(moveShot(shots, 'c', 0)).toEqual([
      { kind: 'shot.update', shotId: 'c', rev: 7, fields: { transition: 'cut' } },
      { kind: 'shot.move', shotId: 'c', afterShotId: null },
    ])
    expect(moveShot(shots, 'a', 2)).toEqual([
      { kind: 'shot.update', shotId: 'b', rev: 7, fields: { transition: 'cut' } },
      { kind: 'shot.move', shotId: 'a', afterShotId: 'c' },
    ])
    expect(moveShot(shots, 'a', 0)).toEqual([])
    expect(moveShot(shots, 'missing', 0)).toEqual([])
    expect(deleteShot(shots, 'missing')).toEqual([])
    expect(moveShot(shots, 'b', 2)).toEqual([{ kind: 'shot.move', shotId: 'b', afterShotId: 'c' }])
  })

  it('groups only connected chains across cuts and after reorder', () => {
    const shots = [shot('a'), shot('b', 'continuous'), shot('c', 'continuous'), shot('d'), shot('e'), shot('f', 'continuous')]
    expect(continuousChains(shots)).toEqual([['a', 'b', 'c'], ['e', 'f']])
    expect(continuousChains([])).toEqual([])
    expect(continuousChains([shot('a')])).toEqual([])
  })

  it('decodes row conflicts without retrying or accepting malformed row data', () => {
    expect(conflictRows({ code: 'revision_conflict', data: { params: { currentRows: JSON.stringify([shot('latest'), { id: 'asset' }]) } } })).toEqual([shot('latest')])
    expect(conflictRows({ code: 'revision_conflict', data: { params: { currentRows: JSON.stringify([{ kind: 'shot', id: 'latest', current: shot('latest') }]) } } })).toEqual([shot('latest')])
    expect(conflictRows({ code: 'revision_conflict', params: { currentRows: 'broken' } })).toEqual([])
    expect(conflictRows({ code: 'unavailable' })).toBeNull()
  })

  it('groups linked outputs newest first without accepting links to another script', () => {
    const output = (nodeId: string, scriptNodeId: string, shotId: string): NodeView => ({
      nodeId, kind: 'image', x: 0, y: 0, w: 320, h: 320, z: 0, layoutRevision: 0, slots: [],
      shot: { scriptNodeId, shotId, role: 'first' },
    })
    const outputs = shotOutputs([output('old', 'script', 'a'), output('other', 'another', 'a'), output('b', 'script', 'b'), output('new', 'script', 'a')], 'script')
    expect(outputs.get('a')?.map(node => node.nodeId)).toEqual(['new', 'old'])
    expect(outputs.get('b')?.map(node => node.nodeId)).toEqual(['b'])
    expect(outputs.size).toBe(2)
    const earlier = `node_${'1'.padStart(10, '0')}${'0'.repeat(16)}`
    const later = `node_${'2'.padStart(10, '0')}${'0'.repeat(16)}`
    expect(shotOutputs([output(later, 'script', 'a'), output(earlier, 'script', 'a')], 'script').get('a')?.map(node => node.nodeId)).toEqual([later, earlier])
  })
})

describe('Script asset markers and export', () => {
  it('round-trips repeated, deleted and incomplete markers with whitespace and Unicode exactly', () => {
    const text = '  \u7b2c\u4e00\u955c\n{{asset:hero}} + {{asset:gone}} + {{asset:hero}}\t{{asset:unfinished'
    const parts = assetParts(text, [asset])
    expect(assetText(parts)).toBe(text)
    expect(parts.filter(part => part.type === 'asset').map(part => [part.id, part.asset?.name])).toEqual([['hero', 'Hero'], ['gone', undefined], ['hero', 'Hero']])
    expect(assetSummary(text, [asset], 'Deleted')).toContain('Hero + Deleted + Hero')
    expect(assetText(assetParts('', []))).toBe('')
    expect(assetText(assetParts('{{asset:}}', []))).toBe('{{asset:}}')
  })

  it('quotes CSV and escapes Markdown while including every shot and prompt', () => {
    const doc = { ...EMPTY_SCRIPT, assets: [asset], shots: [
      { ...shot('a'), description: 'A "quote",\n{{asset:hero}} | B', characterIds: ['hero'], videoPrompt: 'Move left' },
      { ...shot('b'), sceneId: 'gone', durationSec: 2.5 },
    ] }
    const csv = scriptCsv(doc, EXPORT_FIELDS, 'Deleted')
    expect(csv).toContain('"A ""quote"",\nHero | B"')
    expect(csv).toContain('"Move left"')
    expect(csv).toContain('"2","2.5"')
    expect(csv).toContain('"Deleted"')
    const markdown = scriptMarkdown(doc, EXPORT_FIELDS, 'Deleted')
    expect(markdown).toContain('A "quote",<br>Hero \\| B')
    expect(markdown.split('\n').filter(Boolean)).toHaveLength(4)
    expect(doc.shots[0]!.description).toContain('{{asset:hero}}')
  })
})
