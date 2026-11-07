import { describe, expect, it } from 'vitest'
import { METHODS } from './methods'
import { NodeView, SlotContent } from './canvas'
import { EMPTY_SCRIPT, PROMPT_FIELDS, PROMPT_SOURCE_FIELDS, SCRIPT_LIMITS, ScriptDoc, ScriptOp, assetRef, assetRefs } from './script'

const apply = (op: unknown) => METHODS['canvas.apply'].params.safeParse({ requestId: 'r', ops: [op] }).success
const patch = (...ops: unknown[]) => apply({ op: 'script.patch', slotId: 's', ops })

describe('0023 script contract', () => {
  it('stores a script document in the main slot and links generated nodes to shots', () => {
    expect(SlotContent.safeParse({ type: 'script', doc: EMPTY_SCRIPT }).success).toBe(true)
    const doc = {
      ...EMPTY_SCRIPT,
      shots: [{ id: 'shot_1', rev: 1, transition: 'cut', description: '雨夜街口', characterIds: ['asset_1'], propIds: [], promptState: 'agent' }],
      assets: [{ id: 'asset_1', rev: 1, kind: 'character', name: '林桐', description: '27 岁记忆编辑师' }],
    }
    expect(ScriptDoc.parse(doc).shots[0]!.transition).toBe('cut')
    const node = { nodeId: 'n', kind: 'script', x: 0, y: 0, w: 480, h: 320, z: 1, layoutRevision: 1, slots: [{ slotId: 's', slotKey: 'main', contentType: 'script', revision: 1, content: { type: 'script', doc } }] }
    expect(NodeView.safeParse(node).success).toBe(true)
    expect(NodeView.safeParse({ ...node, kind: 'image', slots: [], shot: { scriptNodeId: 'n', shotId: 'shot_1', role: 'first' } }).success).toBe(true)
    expect(NodeView.safeParse({ ...node, kind: 'image', slots: [], shot: { scriptNodeId: 'n', shotId: 'shot_1', role: 'cover' } }).success).toBe(false)
    expect(apply({ op: 'node.create', tempId: 't', kind: 'script' })).toBe(true)
    expect(apply({ op: 'node.setMeta', nodeId: 'n', shot: { scriptNodeId: 'n', shotId: 'shot_1', role: 'video' } })).toBe(true)
    expect(apply({ op: 'node.setMeta', nodeId: 'n', shot: null })).toBe(true)
  })

  it('patches rows with their own revisions', () => {
    expect(patch({ kind: 'shot.insert', tempId: 't1', afterShotId: null, shot: { description: '开场' } })).toBe(true)
    expect(patch({ kind: 'shot.update', shotId: 'shot_1', rev: 3, fields: { durationSec: 4, camera: '缓慢推近', sceneId: null } })).toBe(true)
    expect(patch({ kind: 'shot.move', shotId: 'shot_1', afterShotId: 'shot_2' })).toBe(true)
    expect(patch({ kind: 'asset.insert', tempId: 'a1', asset: { kind: 'prop', name: '旧相机', description: '' } })).toBe(true)
    expect(patch({ kind: 'doc.set', rev: 0, fields: { style: '冷暖对比', sessionId: 'session_1' } })).toBe(true)
    // update and delete must carry the row revision
    expect(patch({ kind: 'shot.update', shotId: 'shot_1', fields: { durationSec: 4 } })).toBe(false)
    expect(patch({ kind: 'asset.delete', assetId: 'asset_1' })).toBe(false)
    // prompt state is set by the server only; unknown fields are rejected
    expect(patch({ kind: 'shot.update', shotId: 'shot_1', rev: 1, fields: { promptState: 'agent' } })).toBe(false)
    expect(patch({ kind: 'shot.update', shotId: 'shot_1', rev: 1, fields: { durationSec: 0.1 } })).toBe(false)
    expect(patch({ kind: 'shot.insert', tempId: 't1', afterShotId: null, shot: { description: 'x'.repeat(SCRIPT_LIMITS.cell + 1) } })).toBe(false)
    expect(patch({ kind: 'asset.insert', tempId: 'a1', asset: { kind: 'prop', name: '  ', description: '' } })).toBe(false)
    expect(apply({ op: 'script.patch', slotId: 's', ops: [] })).toBe(false)
    expect(ScriptOp.safeParse({ kind: 'shot.copy', shotId: 'x' }).success).toBe(false)
  })

  it('replaces the whole document with tempIds only', () => {
    const doc = {
      style: null,
      shots: [{ tempId: 's1', description: '开场', transition: 'cut', characterIds: ['a1'] }, { tempId: 's2', description: '接上', transition: 'continuous' }],
      assets: [{ tempId: 'a1', kind: 'character', name: '林桐', description: '' }],
    }
    expect(apply({ op: 'script.replace', slotId: 's', expectedRevision: 0, doc })).toBe(true)
    expect(apply({ op: 'script.replace', slotId: 's', doc })).toBe(false)
    expect(apply({ op: 'script.replace', slotId: 's', expectedRevision: 0, doc: { ...doc, shots: [{ id: 'shot_1', rev: 1, description: 'x' }] } })).toBe(false)
  })

  it('asset markers and prompt staleness fields', () => {
    expect(assetRefs(`${assetRef('asset_1')} 看向 ${assetRef('asset_2')}，${assetRef('asset_1')} 转身`)).toEqual(['asset_1', 'asset_2'])
    expect(assetRefs('{{asset:}} {{ref:asset_1}}')).toEqual([])
    expect(PROMPT_SOURCE_FIELDS).not.toContain('framePrompt')
    expect(PROMPT_FIELDS.every(field => !(PROMPT_SOURCE_FIELDS as readonly string[]).includes(field))).toBe(true)
  })

  it('canvas.apply stays a top-level object schema for MCP', () => {
    const schema = METHODS['canvas.apply'].params
    expect(schema.safeParse({ requestId: 'r', ops: [{ op: 'script.patch', slotId: 's', ops: [{ kind: 'shot.move', shotId: 'a', afterShotId: null }] }] }).success).toBe(true)
  })
})
