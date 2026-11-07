import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '@vis/protocol'
import { extract, runChecks, type Evidence } from './checks'
import { scanFinalReplies } from './reply-checks'
import scenarios from './scenarios.json'

const item = (seq: number, kind: TranscriptItem['kind'], payload: unknown, turnId = 'turn1'): TranscriptItem => ({ itemId: `item${seq}`, createdSeq: seq, revision: 1, turnId, kind, payload, createdAt: seq, updatedAt: seq })
const evidence = (): Evidence => ({ before: [], after: [], transcript: [], events: [], batches: [], jobs: [], assets: [], approvals: [], workMessages: [], fixtureVars: {}, workDir: '/tmp/eval-project', ended: true })
function call(e: Evidence, name: string, input: unknown, output: unknown = {}, error = false) {
  const seq = e.transcript.length + 1, toolUseId = `tool${seq}`
  e.transcript.push(item(seq, 'tool_call', { name, input, toolUseId }), item(seq + 1, 'tool_result', { toolUseId, text: JSON.stringify(output), isError: error }))
}
const score = (e: Evidence, id: string) => runChecks([id], e)[0]!
function alphaRender() {
  const e = evidence()
  e.after = [{ nodeId: 'card', kind: 'video', slots: [{ content: { type: 'asset', assetVersionId: 'alpha' } }] }] as any
  e.assets = [{ assetVersionId: 'alpha', mime: 'video/webm', hasAlpha: true }] as any
  e.jobs = [{ jobId: 'render', status: 'succeeded', outputs: [{ assetVersionId: 'alpha', delivery: { status: 'delivered', nodeId: 'card' } }] }] as any
  call(e, 'mcp__vis__gen_submit', { provider: 'render', model: 'html', params: { transparent: true } }, { jobId: 'render' })
  return e
}

describe('Transparency and reply evaluation', () => {
  it('declares Chinese transparency scenarios, preserves old timeline cases and scans every scenario', () => {
    for (const scenario of scenarios) expect(scenario.checks).toContain('final_reply_internals')
    for (const id of ['T1', 'T2']) {
      const scenario = scenarios.find(scenario => scenario.id === id)!
      expect(scenario.prompts[0]).toMatch(/[\u4e00-\u9fff]/)
      expect(runChecks(scenario.checks, evidence()).some(check => check.detail === 'Human review required for content quality, accuracy and coherence')).toBe(false)
    }
    expect(scenarios.find(scenario => scenario.id === 'T3')?.checks).toContain('captions_transitions')
    expect(scenarios.find(scenario => scenario.id === 'T4')?.checks).toContain('half_speed')
  })
  it('requires delivered measured alpha WebM, not just a transparent request or unrelated asset', () => {
    const e = alphaRender()
    expect(score(e, 'transparent_render').result).toBe('pass')
    for (const change of [
      (e: Evidence) => { e.assets![0]!.hasAlpha = false },
      (e: Evidence) => { e.assets![0]!.mime = 'video/mp4' },
      (e: Evidence) => { e.jobs[0]!.status = 'failed' },
      (e: Evidence) => { e.jobs[0]!.outputs[0]!.delivery.status = 'undelivered' as any },
      (e: Evidence) => { (e.transcript[0]!.payload as any).input.params.transparent = false },
    ]) {
      const bad = structuredClone(e)
      change(bad)
      expect(score(bad, 'transparent_render').result).toBe('fail')
    }
  })
  it('records Chrome shell attempts even if refused, while allowing ordinary extraction commands', () => {
    const e = evidence()
    call(e, 'exec_command', { cmd: 'ffmpeg -i card.webm frame.png' })
    expect(score(e, 'no_shell_chrome').result).toBe('pass')
    call(e, 'exec_command', { cmd: '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless' }, {}, true)
    expect(score(e, 'no_shell_chrome').result).toBe('fail')
    expect(extract(e.transcript).errors).toHaveLength(1)
  })
  it('rejects placing the alpha source on the main track or exporting an obsolete revision', () => {
    const e = alphaRender()
    e.fixtureVars = { transparentAssetVersionId: 'alpha', transparentVideoNodeId: 'card', timelineNodeId: 'edit' }
    const clip = { id: 'card', source: { nodeId: 'card', assetVersionId: 'alpha' }, startMs: 0, inMs: 0, outMs: 1000, volume: 0, fadeInMs: 0, fadeOutMs: 0, overlay: { x: 0.5, y: 0.5, width: 1, opacity: 1 } }
    const timeline = { nodeId: 'edit', kind: 'timeline', slots: [{ slotKey: 'main', revision: 2, content: { type: 'timeline', doc: { version: 1, output: { width: 320, height: 180, fps: 30 }, tracks: [{ id: 'overlay', kind: 'overlay', muted: true, volume: 1, clips: [clip] }], textTracks: [] } } }] }
    e.after.push(timeline as any)
    e.after.push({ nodeId: 'export', exportOf: { timelineNodeId: 'edit', timelineRevision: 2 }, slots: [{ content: { type: 'asset', assetVersionId: 'export-asset' } }] } as any)
    e.assets!.push({ assetVersionId: 'export-asset', mime: 'video/mp4', durationMs: 1000 } as any)
    expect(score(e, 'transparent_overlay').result).toBe('pass')
    expect(score(e, 'transparent_export').result).toBe('pass')
    timeline.slots[0]!.content.doc.tracks[0]!.kind = 'video'
    expect(score(e, 'transparent_overlay').result).toBe('fail')
    timeline.slots[0]!.revision = 3
    expect(score(e, 'transparent_export').result).toBe('fail')
  })
  it('scans each closing reply and reports literal matches without flagging requested paths or tool evidence', () => {
    const e = evidence()
    e.prompts = ['Please write /tmp/requested/card.webm']
    e.transcript = [
      item(1, 'assistant_text', { text: 'Reading /tmp/internal/guide.md' }),
      item(2, 'tool_call', { name: 'canvas_get', toolUseId: 'read' }),
      item(3, 'tool_result', { toolUseId: 'read', text: 'revision_conflict' }),
      item(4, 'assistant_text', { text: 'Use text.requestDelete after writing.delete_protected. Read writing guide at /tmp/internal/SKILL.md.' }),
      item(5, 'assistant_text', { text: 'Created /tmp/requested/card.webm' }, 'turn2'),
    ]
    const matches = scanFinalReplies(e.transcript, e.prompts)
    expect(matches.some(match => match.text === 'text.requestDelete' && match.kind === 'method')).toBe(true)
    expect(matches.some(match => match.text === 'writing.delete_protected' && match.kind === 'error')).toBe(true)
    expect(matches.some(match => match.text === 'writing guide' && match.kind === 'guide')).toBe(true)
    expect(matches.some(match => match.text === '/tmp/internal/SKILL.md' && match.kind === 'path')).toBe(true)
    expect(matches.some(match => match.text.includes('requested') || match.text === 'revision_conflict')).toBe(false)
    expect(score(e, 'final_reply_internals').result).toBe('review')
    e.transcript = [item(1, 'assistant_text', { text: 'Created /tmp/requested/card.webm' })]
    expect(score(e, 'final_reply_internals').result).toBe('pass')
  })
})
