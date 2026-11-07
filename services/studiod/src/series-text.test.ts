import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createCanvasService } from '@vis/canvas-core'
import { openSpaceDb, openSpaceDbReadOnly } from '@vis/storage'
import { readSeriesTexts } from './series-text'

it('reads a closed episode without migrating, writing or starting its runtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vis-series-text-'))
  const file = join(dir, 'space.db')
  try {
    const db = openSpaceDb(file)
    const canvas = createCanvasService({ db })
    const result = canvas.apply({ kind: 'user' }, { requestId: 'seed', ops: [{ op: 'node.create', tempId: 'chapter', kind: 'text', content: { text: '林舟回家。' } }] })
    db.$client.close()
    const before = statSync(file)
    expect(readSeriesTexts(file)).toEqual([{ nodeId: result.idMap.chapter, slotId: expect.any(String), title: null, revision: 1, body: '林舟回家。', format: 'plain', words: 4 }])
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs)
    const readonly = openSpaceDbReadOnly(file)
    try { expect(() => readonly.$client.exec('DELETE FROM nodes')).toThrow(/readonly/) } finally { readonly.$client.close() }
    expect(readSeriesTexts(join(dir, 'missing.db'))).toEqual([])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
