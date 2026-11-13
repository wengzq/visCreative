import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertFreeProviders, assertMockConfiguration, parseOptions } from './safety'
import { extract, runChecks, type Evidence } from './checks'
import type { MethodResult, NodeView, ScriptDoc, TimelineDoc, TranscriptItem, WorkMessageView } from '@vis/protocol'

const temporary: string[] = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'vis-eval-test-'))
  temporary.push(dir)
  return dir
}
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { force: true, recursive: true }) })
const options = (dir: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}) => parseOptions(['--data-dir', join(dir, 'data'), '--out', join(dir, 'out'), ...extra], ['G1', 'S2'], env)

describe('Evaluation safety', () => {
  it('rejects any configured provider, non-Mock default or loosened limit in the on-disk configuration', () => {
    const config = { providers: [], defaults: Object.fromEntries(['image', 'video', 'audio'].map(kind => [kind, { provider: 'mock' }])), limits: { maxConcurrent: 1, dailyImage: 1, dailyVideo: 1, dailyAudio: 1 } }
    expect(() => assertMockConfiguration(config)).not.toThrow()
    expect(() => assertMockConfiguration({ ...config, providers: [{ id: 'mock', type: 'mock' }] })).toThrow('Unsafe providers.json')
    expect(() => assertMockConfiguration({ ...config, defaults: { ...config.defaults, video: { provider: 'render' } } })).toThrow('Unsafe providers.json')
    expect(() => assertMockConfiguration({ ...config, limits: { ...config.limits, dailyVideo: 0 } })).toThrow('Unsafe providers.json')
  })
  it('keeps project roots outside the data directory so agents keep their normal sandbox', () => {
    const dir = temp()
    const parsed = options(dir)
    expect(parsed.projectsDir).toBe(`${parsed.dataDir}-projects`)
    expect(parsed.projectsDir.startsWith(`${parsed.dataDir}/`)).toBe(false)
    mkdirSync(join(dir, 'data-projects'))
    writeFileSync(join(dir, 'data-projects', 'left-over'), '')
    expect(() => options(dir)).toThrow('must not exist or must be empty')
  })

  it('requires an explicit empty data directory and rejects unsupported agents', () => {
    expect(() => parseOptions([], ['G1'], {})).toThrow('--data-dir is required')
    const dir = temp()
    mkdirSync(join(dir, 'data'))
    writeFileSync(join(dir, 'data', 'providers.json'), '{}')
    expect(() => options(dir)).toThrow('empty')
    expect(() => options(temp(), ['--agents', 'claude'])).toThrow('deferred')
    expect(() => options(temp(), ['--dry-run'])).toThrow('--agents codex')
    expect(() => options(temp(), ['--agents', 'pi'])).toThrow('Agents must be')
    expect(options(temp(), ['--agents', 'minimax-code,codebuddy']).agents).toEqual(['minimax-code', 'codebuddy'])
  })

  it('rejects real data, nested paths, ancestors and symlink aliases before writing', () => {
    expect(() => parseOptions(['--data-dir', join(homedir(), '.vis-dev', 'evaluation')], ['G1'], {})).toThrow('real application data')
    const dir = temp()
    mkdirSync(join(dir, 'real'))
    symlinkSync(join(dir, 'real'), join(dir, 'alias'), 'dir')
    expect(() => options(dir, ['--data-dir', 'duplicate'])).toThrow('Duplicate')
    expect(() => parseOptions(['--data-dir', join(dir, 'alias', 'child')], ['G1'], { VIS_DATA_DIR: join(dir, 'real') })).toThrow('real application data')
    expect(() => parseOptions(['--data-dir', dir], ['G1'], { VIS_DATA_DIR: join(dir, 'real') })).toThrow('real application data')
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(() => parseOptions(['--data-dir', join(dir, 'casealias', 'evaluation')], ['G1'], { VIS_DATA_DIR: join(dir, 'CaseAlias') })).toThrow('real application data')
    }
  })

  it('uses explicit dry-run Codex, all scenarios and a twenty-minute default', () => {
    const parsed = options(temp(), ['--agents', 'codex', '--dry-run'])
    expect(parsed.agents).toEqual(['codex'])
    expect(parsed.scenarios).toEqual(['G1', 'S2'])
    expect(parsed.timeoutMs).toBe(20 * 60_000)
    expect(() => options(temp(), ['--timeout-ms', '0'])).toThrow('positive integer')
    expect(() => options(temp(), ['--scenarios', 'BAD'])).toThrow('Unknown scenario')
  })

  it('refuses non-Mock providers before any session is created, allowing built-in local render', () => {
    const catalog = { providers: [{ id: 'mock', type: 'mock' }, { id: 'render', type: 'render' }], defaults: {} } as MethodResult<'providers.list'>
    expect(() => assertFreeProviders(catalog)).not.toThrow()
    const unsafe = { ...catalog, providers: [...catalog.providers, { id: 'paid', type: 'volcengine-ark', hasKey: false }] } as MethodResult<'providers.list'>
    expect(() => assertFreeProviders(unsafe)).toThrow('Unsafe provider catalog')
    expect(() => assertFreeProviders({ ...catalog, providers: [] })).toThrow('Unsafe provider catalog')
    expect(() => assertFreeProviders({ ...catalog, providers: catalog.providers.map(provider => ({ ...provider, hasKey: true })) })).toThrow('Unsafe provider catalog')
  })
})

const item = (seq: number, kind: TranscriptItem['kind'], payload: unknown, turnId = 'turn1'): TranscriptItem => ({ itemId: `item${seq}`, createdSeq: seq, revision: 1, turnId, kind, payload, createdAt: seq, updatedAt: seq })
const evidence = (transcript: TranscriptItem[] = []): Evidence => ({ before: [], after: [], transcript, events: [], batches: [], jobs: [], approvals: [], workMessages: [], fixtureVars: {}, workDir: '/tmp/eval', ended: true })

describe('Evaluation evidence and scoring', () => {
  it('normalizes tool names, scopes repeated tool IDs by turn and records errors and guide reads', () => {
    const entries = [item(1, 'tool_call', { name: 'vis.canvas_apply', toolUseId: 't', input: {} }), item(2, 'tool_result', { toolUseId: 't', isError: true, text: 'invalid_params' }), item(3, 'tool_call', { name: 'mcp__vis__guide', toolUseId: 'g', input: { topic: 'script' } }), item(4, 'tool_call', { name: 'vis.canvas_apply', toolUseId: 't' }, 'turn2'), item(5, 'tool_result', { toolUseId: 't', isError: false, text: '{}' }, 'turn2'), item(6, 'assistant_text', { text: 'Done' }, 'turn2')]
    const result = extract(entries)
    expect(result.calls.map(call => call.name)).toEqual(['canvas_apply', 'guide_get', 'canvas_apply'])
    expect(result.errors).toHaveLength(1)
    expect(result.guideCalls).toHaveLength(1)
    expect(result.turns).toBe(2)
    expect(result.finalReply).toBe('Done')
    expect(result.inputTokens).toBeNull()
  })

  it('never treats missing output, a guide read or an untestable quota as an automatic pass', () => {
    const results = runChecks(['one_text', 'script_valid', 'first_script_replace', 'quota_stop', 'own_web_tool'], evidence())
    expect(results.map(check => check.result)).toEqual(['fail', 'fail', 'fail', 'review', 'review'])
    expect(() => runChecks(['row_revisions'], evidence([item(1, 'tool_call', { name: 'vis.canvas_apply', input: { ops: 'invalid' } })]))).not.toThrow()
  })

  it('fails a batch that had a standalone submit or an observed job before approval', () => {
    const e = evidence([item(1, 'tool_call', { name: 'vis.gen_submit', toolUseId: 'g' })])
    e.approvals = [{ kind: 'generation_batch', pendingObserved: true, noSingleSubmits: false, jobsBeforeApproval: 1, statusAtApproval: 'pending_approval' }]
    expect(runChecks(['no_single_submits', 'batch_wait'], e).map(check => check.result)).toEqual(['fail', 'fail'])
  })

  it('requires ordered fixture videos and links the export to the scored timeline', () => {
    const e = evidence()
    e.fixtureVars.videoNodeIds = 'video1, video2, video3'
    e.after = [timelineNode(timeline()), { ...timelineNode(timeline()), nodeId: 'export', kind: 'video', exportOf: { timelineNodeId: 'unrelated', timelineRevision: 1 }, slots: [{ slotId: 'export-main', slotKey: 'main', contentType: 'video', revision: 1, content: { type: 'asset', assetVersionId: 'asset', mime: 'video/mp4' } }] }]
    expect(runChecks(['timeline_valid', 'export_succeeded'], e).map(check => check.result)).toEqual(['pass', 'fail'])
    const repeated = timeline()
    repeated.tracks[0]!.clips[1]!.source.nodeId = 'video1'
    e.after[0] = timelineNode(repeated)
    expect(runChecks(['timeline_valid'], e)[0]?.result).toBe('fail')
  })

  it('accepts correct half-speed retiming and rejects hidden captions or changed track settings', () => {
    const e = evidence()
    e.fixtureVars.timelineNodeId = 'timeline'
    const old = timeline()
    const next = structuredClone(old)
    next.tracks[0]!.clips[1]!.speed = 0.5
    next.tracks[0]!.clips[2]!.startMs = 3000
    next.textTracks![0]!.clips[1]!.durationMs = 2000
    next.textTracks![0]!.clips[2]!.startMs = 3000
    e.before = [timelineNode(old)]
    e.after = [timelineNode(next)]
    const ids = ['half_speed', 'caption_follow', 'other_clips_preserved']
    expect(runChecks(ids, e).map(check => check.result)).toEqual(['pass', 'pass', 'pass'])
    next.textTracks![0]!.hidden = true
    expect(runChecks(ids, e).at(-1)?.result).toBe('fail')
    next.textTracks![0]!.hidden = false
    next.tracks[0]!.muted = true
    expect(runChecks(ids, e).at(-1)?.result).toBe('fail')
  })

  it('rejects captions packed into the first shot and references without actual delivery', () => {
    const e = evidence()
    const doc = timeline()
    doc.tracks[0]!.clips[1]!.transitionIn = { kind: 'crossfade', durationMs: 200 }
    doc.tracks[0]!.clips[1]!.startMs = 800
    doc.tracks[0]!.clips[2]!.transitionIn = { kind: 'crossfade', durationMs: 200 }
    doc.tracks[0]!.clips[2]!.startMs = 1600
    doc.textTracks![0]!.clips.forEach((clip, i) => {
      clip.startMs = i * 200
      clip.durationMs = 200
    })
    e.after = [timelineNode(doc)]
    expect(runChecks(['captions_transitions'], e)[0]?.result).toBe('fail')
    e.workMessages = [{ messageId: 'report', kind: 'done', refs: { nodeIds: ['missing'] } } as WorkMessageView]
    expect(runChecks(['done_report_refs'], e)[0]?.result).toBe('fail')
    e.after.push({ ...timelineNode(doc), nodeId: 'slogan', kind: 'text', slots: [{ slotId: 'slogan-main', slotKey: 'main', contentType: 'text', revision: 1, content: { type: 'text', body: 'Three lines\nof slogan\nfor delivery' } }] })
    e.workMessages[0]!.refs.nodeIds = ['slogan']
    expect(runChecks(['done_report_refs'], e)[0]?.result).toBe('pass')
    e.events = [{ seq: 1, type: 'work.messageAdded', entityType: 'workMessage', entityId: 'report', payload: e.workMessages[0] }]
    expect(runChecks(['idle_after_done'], e)[0]?.result).toBe('pass')
    e.events.push({ seq: 2, type: 'node.created', entityType: 'node', entityId: 'extra', payload: {} })
    expect(runChecks(['idle_after_done'], e)[0]?.result).toBe('fail')
  })

  it('requires both target frame prompts to change and does not credit failed row patches', () => {
    const e = evidence()
    const old: ScriptDoc = { version: 1, rev: 0, assets: [], shots: Array.from({ length: 6 }, (_, i) => ({ id: `shot${i + 1}`, rev: 0, transition: 'cut', description: `Shot ${i + 1}`, framePrompt: `Original ${i + 1}`, characterIds: [], propIds: [] })) }
    const next = structuredClone(old)
    for (const i of [1, 3]) {
      next.shots[i]!.description = 'Updated'
      next.shots[i]!.rev++
    }
    const node = (doc: ScriptDoc): NodeView => ({ ...timelineNode(timeline()), nodeId: 'script', kind: 'script', slots: [{ slotId: 'script-main', slotKey: 'main', contentType: 'script', revision: 1, content: { type: 'script', doc } }] })
    e.fixtureVars.scriptNodeId = 'script'
    e.before = [node(old)]
    e.after = [node(next)]
    expect(runChecks(['only_rows_2_4'], e)[0]?.result).toBe('fail')
    for (const i of [1, 3]) next.shots[i]!.framePrompt = 'Updated frame'
    e.after = [node(next)]
    expect(runChecks(['only_rows_2_4'], e)[0]?.result).toBe('pass')
    e.transcript = [item(1, 'tool_call', { name: 'vis.canvas_apply', toolUseId: 'patch', input: { ops: [{ op: 'script.patch', ops: [1, 3].map(i => ({ kind: 'shot.update', shotId: old.shots[i]!.id, rev: 0, fields: { description: 'Updated' } })) }] } }), item(2, 'tool_result', { toolUseId: 'patch', isError: true, text: 'revision_conflict' })]
    expect(runChecks(['row_revisions'], e)[0]?.result).toBe('fail')
    e.transcript[1]!.payload = { toolUseId: 'patch', isError: false, text: '{}' }
    expect(runChecks(['row_revisions'], e)[0]?.result).toBe('pass')
  })
})

function timeline(): TimelineDoc {
  return {
    version: 1,
    tracks: [{ id: 'video-track', kind: 'video', muted: false, volume: 1, clips: [0, 1, 2].map(i => ({ id: `clip${i + 1}`, source: { nodeId: `video${i + 1}`, assetVersionId: `asset${i + 1}` }, startMs: i * 1000, inMs: 0, outMs: 1000, volume: 1, fadeInMs: 0, fadeOutMs: 0 })) }],
    textTracks: [{ id: 'text-track', hidden: false, clips: [0, 1, 2].map(i => ({ id: `text${i + 1}`, text: `Caption ${i + 1}`, startMs: i * 1000, durationMs: 1000, fadeInMs: 0, fadeOutMs: 0, style: { preset: 'subtitle' } })) }],
  }
}

function timelineNode(doc: TimelineDoc): NodeView {
  return { nodeId: 'timeline', kind: 'timeline', x: 0, y: 0, w: 200, h: 100, z: 0, layoutRevision: 0, slots: [{ slotId: 'timeline-main', slotKey: 'main', contentType: 'timeline', revision: 1, content: { type: 'timeline', doc } }] }
}
