import { describe, expect, it } from 'vitest'
import { emptyPrevizPanel, type JobView, type NodeView, type PrevizDoc, type TranscriptItem } from '@vis/protocol'
import { extract, runChecks, type Evidence } from './checks'
import scenarios from './scenarios.json'

const doc = (): PrevizDoc => ({ version: 1, rev: 0, aspectRatio: '16:9', panels: [1, 2, 3, 4].map(n => ({ ...emptyPrevizPanel(`p${n}`),
  underlay: `underlay${n}`, sketch: `sketch${n}`, image: `image${n}`, note: `Panel ${n}`, durationSec: 2, shot: { scriptNodeId: 'script', shotId: `shot${n}` },
})) })
const node = (nodeId: string, content: NodeView['slots'][number]['content']): NodeView => ({ nodeId, kind: content.type === 'previz' ? 'previz' : content.type === 'text' ? 'text' : 'video', x: 0, y: 0, w: 200, h: 100, z: 0, layoutRevision: 0,
  slots: [{ slotId: `${nodeId}-main`, slotKey: 'main', revision: 1, contentType: content.type === 'previz' ? 'previz' : content.type === 'text' ? 'text' : 'video', content }],
})
const item = (seq: number, kind: TranscriptItem['kind'], payload: unknown): TranscriptItem => ({ itemId: `item${seq}`, createdSeq: seq, revision: 1, turnId: 'turn1', kind, payload, createdAt: seq, updatedAt: seq })
function call(e: Evidence, name: string, input: unknown, output: unknown = {}, error = false) {
  const seq = e.transcript.length + 1, toolUseId = `tool${seq}`
  e.transcript.push(item(seq, 'tool_call', { name: `vis.${name}`, input, toolUseId }), item(seq + 1, 'tool_result', { toolUseId, isError: error, text: typeof output === 'string' ? output : JSON.stringify(output) }))
}
const evidence = (): Evidence => {
  const before = node('previz', { type: 'previz', doc: doc() })
  return { before: [before], after: [structuredClone(before)], transcript: [], events: [], batches: [], jobs: [], assets: [], approvals: [], workMessages: [], fixtureVars: { previzNodeId: 'previz', blockoutAssetVersionId: 'video-asset' }, workDir: '/tmp/eval', ended: true }
}
const results = (e: Evidence, ids: string[]) => runChecks(ids, e).map(check => check.result)
const currentDoc = (e: Evidence) => {
  const content = e.after[0]!.slots[0]!.content
  if (content.type !== 'previz') throw new Error('Expected previz fixture')
  return content.doc
}
function rendered(): Evidence {
  const e = evidence()
  e.after.push(node('code', { type: 'text', body: "import * as THREE from '/lib/three.module.js'; const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true })" }))
  const video = node('video', { type: 'asset', assetVersionId: 'video-asset', mime: 'video/mp4' })
  video.inputs = ['code', 'previz']
  video.shot = { scriptNodeId: 'script', shotId: 'shot1', role: 'previz' }
  e.after.push(video)
  e.assets = [{ assetVersionId: 'video-asset', assetId: 'asset', version: 1, kind: 'video', mime: 'video/mp4', url: 'file:///tmp/eval.mp4', durationMs: 8000, fps: 24 }]
  e.jobs = [{ jobId: 'render', status: 'succeeded', outputs: [{ outputIndex: 0, assetVersionId: 'video-asset', mime: 'video/mp4', delivery: { status: 'delivered', nodeId: 'video' } }], targets: [] }]
  call(e, 'guide_get', { topic: 'previz' }, { markdown: 'Guide' })
  call(e, 'gen_submit', { provider: 'render', model: 'html', inputs: [{ slotId: 'code-main', revision: 1 }], params: { fps: 24, durationMs: 8000 } }, { jobId: 'render' })
  call(e, 'canvas_apply', { ops: [{ op: 'node.setInputs', nodeId: 'video', inputNodeIds: ['code', 'previz'] }] })
  return e
}

describe('Previz evaluation checks', () => {
  it('requires V1 and V3 to avoid unrequested extraction, including rejected attempts', () => {
    for (const scenario of scenarios.filter(scenario => ['V1', 'V3'].includes(scenario.id))) expect(scenario.checks).toContain('previz_no_unrequested_extract')
    const e = evidence()
    expect(results(e, ['previz_no_unrequested_extract'])).toEqual(['pass'])
    call(e, 'previz_extractBlockout', {}, 'denied', true)
    expect(results(e, ['previz_no_unrequested_extract'])).toEqual(['fail'])
  })
  it('declares every V scenario with recognized checks and real user prompts', () => {
    const selected = scenarios.filter(scenario => /^V[1-6]$/.test(scenario.id))
    expect(selected).toHaveLength(6)
    for (const scenario of selected) {
      expect(scenario.prompts).toHaveLength(1)
      expect(scenario.prompts[0]).toMatch(/[\u4e00-\u9fff]/)
      expect(() => runChecks(scenario.checks, evidence())).not.toThrow()
      expect(runChecks(scenario.checks, evidence()).some(check => check.detail === 'Human review required for content quality, accuracy and coherence')).toBe(false)
    }
  })

  it('matches render provenance, measured timing and explicit input/shot associations', () => {
    const e = rendered()
    const ids = ['previz_guide_read', 'render_succeeded', 'previz_three_page', 'previz_duration', 'previz_fps', 'previz_video_inputs', 'previz_not_final_output', 'previz_render_only']
    expect(results(e, ids)).toEqual(ids.map(() => 'pass'))
    e.assets![0]!.durationMs = 8041
    expect(results(e, ['previz_duration'])).toEqual(['pass'])
    e.assets![0]!.durationMs = 8042
    expect(results(e, ['previz_duration'])).toEqual(['fail'])
    e.assets![0]!.fps = 23
    expect(results(e, ['previz_fps'])).toEqual(['fail'])
    e.assets = []
    expect(results(e, ['previz_duration', 'previz_fps'])).toEqual(['fail', 'fail'])
    e.after[2]!.inputs = ['previz']
    e.after[2]!.shot!.role = 'video'
    e.after[1]!.slots[0]!.revision = 2
    expect(results(e, ['previz_video_inputs', 'previz_not_final_output', 'previz_three_page'])).toEqual(['fail', 'fail', 'fail'])
  })

  it('does not credit unrelated three.js nodes or failed guide/render calls', () => {
    const e = rendered()
    e.after[1]!.slots[0]!.content = { type: 'text', body: '<canvas>2D page</canvas>' }
    e.after.push(node('unrelated', { type: 'text', body: "import * as THREE from '/lib/three.module.js'; new THREE.WebGLRenderer()" }))
    expect(results(e, ['previz_three_page'])).toEqual(['fail'])
    e.transcript[1]!.payload = { toolUseId: 'tool1', isError: true, text: 'denied' }
    e.jobs[0]!.status = 'failed'
    expect(results(e, ['previz_guide_read', 'render_succeeded'])).toEqual(['fail', 'fail'])
  })

  it('requires a completed question turn without submits, batches or guessed durations', () => {
    const e = evidence()
    for (const snapshot of [e.before, e.after]) {
      const content = snapshot[0]!.slots[0]!.content
      if (content.type === 'previz') for (const i of [1, 3]) content.doc.panels[i]!.durationSec = null
    }
    e.transcript.push(item(1, 'assistant_text', { text: '第2和第4格各需要几秒？' }))
    const ids = ['previz_question', 'previz_no_generation', 'previz_no_duration_guess']
    expect(results(e, ids)).toEqual(['pass', 'pass', 'pass'])
    e.ended = false
    currentDoc(e).panels[1]!.durationSec = 2
    call(e, 'gen_submit', { provider: 'render' }, 'denied', true)
    expect(results(e, ids)).toEqual(['fail', 'fail', 'fail'])
    e.transcript = []
    call(e, 'script_batch_start', {}, 'denied', true)
    expect(results(e, ['previz_no_generation'])).toEqual(['fail'])
    e.transcript = []
    e.jobs.push({ jobId: 'unobserved', status: 'succeeded', outputs: [], targets: [] })
    expect(results(e, ['previz_no_generation'])).toEqual(['fail'])
  })

  it('recognizes explicit Chinese confirmation requests without requiring a question mark', () => {
    const e = evidence()
    for (const text of ['请确认是否采用这组时长（全片8秒），随后制作灰模小样。', '请确认这组时长。', '请选择下一步：\n- 按顺序关联并先生成首帧\n- 使用 Mock 测试流程', '是否采用剧本时长', '这样可以吗', '要不要采用剧本时长', 'Use those durations?']) {
      e.transcript = [item(1, 'assistant_text', { text })]
      expect(results(e, ['previz_question'])).toEqual(['pass'])
    }
    for (const text of ['第2、4格缺少时长。', '我将采用剧本时长制作灰模。', '已确认时长并完成灰模。', '请先在设置中配置视频生成服务；确认关联方式后，我会继续准备生成。', '第 2、4 格尚未填写时长，需先补齐才能渲染。建议沿用关联剧本：第 2 格 1.5 秒、第 4 格 2 秒，总长 8 秒。\n\n确认后将用免费本机渲染制作灰模小样。', 'The durations are missing.']) {
      e.transcript = [item(1, 'assistant_text', { text })]
      expect(results(e, ['previz_question'])).toEqual(['fail'])
    }
  })

  it('reads the complete closing assistant block without crediting questions before later tool activity', () => {
    const e = evidence()
    call(e, 'canvas_get', {})
    e.transcript.push(item(3, 'assistant_text', { text: '是否按顺序关联第2、4镜？' }), item(4, 'assistant_text', { text: '确认关联方式后，我会继续准备生成。' }))
    expect(results(e, ['previz_question', 'previz_no_generation'])).toEqual(['pass', 'pass'])
    call(e, 'canvas_get', {})
    e.transcript.push(item(7, 'assistant_text', { text: '我将采用默认关联。' }))
    expect(results(e, ['previz_question'])).toEqual(['fail'])
  })

  it('rejects non-render calls and unaccounted jobs even with a completed render', () => {
    const e = rendered()
    call(e, 'gen_submit', { provider: 'mock' }, 'denied', true)
    expect(results(e, ['previz_render_only'])).toEqual(['fail'])
    const clean = rendered()
    clean.jobs.push({ jobId: 'other', status: 'succeeded', outputs: [], targets: [] } as JobView)
    expect(results(clean, ['previz_render_only'])).toEqual(['fail'])
  })

  it('preserves all original drawings, records refused writes and catches removed panels', () => {
    const e = evidence()
    const attempted = structuredClone(currentDoc(e))
    attempted.panels[0]!.sketch = null
    call(e, 'canvas_apply', { ops: [{ op: 'previz.set', slotId: 'previz-main', doc: attempted }] }, 'previz.drawing_protected', true)
    const check = runChecks(['previz_pictures_preserved'], e)[0]!
    expect(check.result).toBe('pass')
    expect(check.detail).toContain('previz.drawing_protected')
    expect(extract(e.transcript).errors).toHaveLength(1)
    e.transcript[1]!.payload = { toolUseId: 'tool1', isError: false, text: '{}' }
    expect(results(e, ['previz_pictures_preserved'])).toEqual(['fail'])
    e.transcript = []
    currentDoc(e).panels.pop()
    expect(results(e, ['previz_pictures_preserved'])).toEqual(['fail'])
  })

  it('keeps unlinked panels unmodified until confirmation', () => {
    const e = evidence()
    for (const snapshot of [e.before, e.after]) {
      const content = snapshot[0]!.slots[0]!.content
      if (content.type === 'previz') content.doc.panels[1]!.shot = null
    }
    expect(results(e, ['previz_links_await_confirmation'])).toEqual(['pass'])
    currentDoc(e).panels[1]!.shot = { scriptNodeId: 'script', shotId: 'shot2' }
    expect(results(e, ['previz_links_await_confirmation'])).toEqual(['fail'])
  })

  it('passes only when the panels keep their blockouts for the user to set', () => {
    const e = evidence()
    expect(results(e, ['previz_extract_left_to_user', 'previz_pictures_preserved'])).toEqual(['pass', 'pass'])
    currentDoc(e).panels[3]!.blockout = 'written'
    expect(results(e, ['previz_extract_left_to_user'])).toEqual(['fail'])
  })

  it('requires output frame evidence and never equates extraction with visual inspection', () => {
    const e = rendered()
    expect(results(e, ['previz_frames_inspected'])).toEqual(['fail'])
    call(e, 'asset_frames', { assetVersionId: 'unrelated' }, { frames: [] })
    expect(results(e, ['previz_frames_inspected'])).toEqual(['fail'])
    call(e, 'asset_frames', { assetVersionId: 'video-asset' }, { frames: [{ assetVersionId: 'frame1', path: '/tmp/frame1.png' }] })
    expect(results(e, ['previz_frames_inspected'])).toEqual(['review'])
    call(e, 'view_image', { path: '/tmp/frame1.png' })
    expect(results(e, ['previz_frames_inspected'])).toEqual(['pass'])
    expect(results(e, ['previz_blockout_quality', 'previz_duration_question_quality', 'previz_generation_question_quality', 'previz_improvement_quality', 'previz_extraction_handoff_quality'])).toEqual(Array(5).fill('review'))
  })
})
