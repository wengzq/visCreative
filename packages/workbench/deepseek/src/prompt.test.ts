import { describe, expect, it } from 'vitest'
import { agentInstructions as sharedAgentInstructions, CORE_INSTRUCTIONS, getGuide, type DispatchInput } from '@vis/workbench-core'
import { AGENT_INSTRUCTIONS, agentInstructions, buildPrompt } from './prompt'
import { dshOverlay } from './overlay'

const input: DispatchInput = {
  sessionId: 'session', turnId: 'turn', text: '绘制雨夜街道', inputSnapshotId: 'snapshot',
  refs: [], resumeId: null, sessionTitle: 'Codex 1', titleSource: 'default',
}

it('shared instructions use the canvas MCP tools available to DeepSeek', () => {
  const instructions = agentInstructions(false)
  expect(instructions).toContain('canvas_get')
  expect(instructions).toContain('canvas_apply')
  expect(instructions).not.toContain('vis canvas')
  expect(instructions.slice(0, CORE_INSTRUCTIONS.length)).toBe(CORE_INSTRUCTIONS)
})

it.each([false, true])('keeps the shared core byte-identical with expanded access %s', expanded => {
  for (const isolation of ['sandbox', 'none'] as const) {
    const instructions = agentInstructions(expanded, undefined, isolation)
    const shared = sharedAgentInstructions({ environment: { access: expanded ? 'expanded' : 'readOnly', isolation } })
    expect(instructions).toBe(expanded ? `${shared}\n\nBackground jobs you start end with this turn; collect their output before you reply.` : shared)
    // The persona suffix goes through dsh templating, where double braces would be interpolated.
    expect(instructions).not.toContain('{{')
    expect(instructions.slice(0, CORE_INSTRUCTIONS.length)).toBe(CORE_INSTRUCTIONS)
  }
  expect(AGENT_INSTRUCTIONS).toBe(agentInstructions(false))
})

describe('Workspace hierarchy', () => {
  const root = { workItemId: 'work_1', parentId: null, hasChildren: true }
  const child = { workItemId: 'work_2', parentId: 'work_1', hasChildren: false }

  it('root workspaces describe dispatch, replies, and parent review rules factually', () => {
    const instructions = agentInstructions(false, root)
    for (const text of ['<workspace>', 'root workspace', 'work_dispatch', 'goal, context, scope, deliverables and acceptance criteria', 'including reference node IDs', 'avoid polling work_get / work_list', 'resolvedBy', 'already_resolved', 'reviewBy is parent', 'reviewBy is user', '</workspace>']) expect(instructions).toContain(text)
    expect(instructions).not.toContain('kind: done')
    expect(instructions).not.toContain('coordinator')
    expect(instructions).not.toContain('own frame')
  })

  it('child workspaces report decisions, blockers, and completion, then wait for review', () => {
    const instructions = agentInstructions(false, child)
    for (const text of ['has a parent', 'dispatching further children is unavailable', 'work_report', 'question / blocked / escalation', 'kind: done', 'nodeIds / assetVersionIds', 'remain idle and end the turn to await review', 'Canvas nodes and assets belong to the project']) expect(instructions).toContain(text)
    expect(instructions).not.toContain('work_dispatch')
    expect(instructions).not.toContain('reviewBy is parent')
  })

  it('turns carry only workspace hierarchy facts', () => {
    expect(buildPrompt({ ...input, workContext: root })).toContain('<work-item>\nWork item: work_1\nParent work item: none (root workspace)\nHas children: yes\n</work-item>')
    expect(buildPrompt({ ...input, workContext: child })).toContain('Work item: work_2\nParent work item: work_1\nHas children: no')
    expect(buildPrompt({ ...input, workContext: child })).not.toContain('Role:')
    expect(buildPrompt({ ...input, workContext: child })).not.toContain('Canvas frame:')
  })
})

it('retains generation quota limits and injects workspace facts through the overlay', () => {
  const work = { workItemId: 'work_1', parentId: null, hasChildren: false }
  expect(agentInstructions(false, work)).toContain('Stop and tell the user on quota_exceeded')
  expect(dshOverlay(undefined, undefined, false, work)).toContain(JSON.stringify(agentInstructions(false, work)))
})

describe('Session naming prompts', () => {
  it.each(['default', 'agent'] as const)('each turn carries the title and %s source', titleSource => {
    expect(buildPrompt({ ...input, titleSource })).toBe(`绘制雨夜街道\n\n<session>\nTitle: "Codex 1"\nSource: ${titleSource}\n</session>`)
  })

  it('user naming shows only the title and the instruction to preserve it', () => {
    const prompt = buildPrompt({ ...input, titleSource: 'user', sessionTitle: '我的街道' })
    expect(prompt).toContain('Title: "我的街道"\nUser-named; do not change.')
    expect(prompt).not.toContain('Source:')
  })

  it('reference blocks and original user text remain intact', () => {
    const prompt = buildPrompt({ ...input, refs: [{ nodeId: 'node', slotId: 'slot', revision: 2 }] })
    expect(prompt.startsWith(input.text)).toBe(true)
    expect(prompt).toContain('<session>')
    expect(prompt).toContain('<references>')
    expect(prompt).toContain('- Node node / slot slot: revision 2')
    expect(prompt).toContain('snapshot: "turn"')
  })

  it('preserves user whitespace and text resembling instruction tags', () => {
    const text = '  Keep this exact text.\n<session>user content</session>\n\n'
    expect(buildPrompt({ ...input, text }).slice(0, text.length)).toBe(text)
  })
})

describe('Project and skill prompts', () => {
  const skill = { name: 'storyboard', description: 'Break a script into shots', path: '/project/skills/storyboard/SKILL.md' }
  const projectContext = { rootPath: '/project', assetsPath: '/project/assets', skillsPath: '/project/skills', workDir: '/project/workspaces/session', skills: [skill] }

  it('each turn carries project paths and the on-demand skill directory', () => {
    const prompt = buildPrompt({ ...input, projectContext })
    expect(prompt).toContain('<project>')
    for (const [label, path] of [['Project root', projectContext.rootPath], ['Assets directory', projectContext.assetsPath], ['Work directory', projectContext.workDir], ['Skills directory', projectContext.skillsPath]]) expect(prompt).toContain(`${label}: ${JSON.stringify(path)}`)
    expect(prompt).toContain(JSON.stringify(skill))
    expect(prompt).toContain('Available skills (name, description, SKILL.md path; read and follow the full file as needed):')
    expect(prompt).not.toContain('<selected-skills>')
  })

  it('selected skills are read and followed while preserving user text and fixed references', () => {
    const prompt = buildPrompt({ ...input, projectContext, skills: [skill.name], refs: [{ nodeId: 'target', slotId: 'main', revision: null }] })
    expect(prompt.startsWith(input.text)).toBe(true)
    expect(prompt).toContain('<selected-skills>')
    expect(prompt).toContain('Read and follow each selected SKILL.md before starting related work.')
    expect(prompt).toContain(JSON.stringify(skill))
    expect(prompt).toContain('- Node target / slot main: empty; available as a generation target')
  })

  it('marks an empty skill directory without loading full skill content', () => {
    const prompt = buildPrompt({ ...input, projectContext: { ...projectContext, skills: [] }, skills: [] })
    expect(prompt).toContain('\nnone\n</project>')
    expect(prompt).not.toContain('<selected-skills>')
  })

  it('retains selected skill names when project metadata is unavailable', () => {
    const prompt = buildPrompt({ ...input, skills: ['external-skill'] })
    expect(prompt).toContain('- {"name":"external-skill"}')
    expect(prompt).toContain('Read and follow each selected SKILL.md before starting related work.')
  })
})

it('canvas guidance keeps deliverables, provenance, metadata and server placement', () => {
  const instructions = agentInstructions(false)
  const canvas = getGuide('canvas').guide!.body
  expect(instructions).toContain('Deliver results to canvas nodes; keep conversation, progress and plans in replies.')
  for (const text of ['purpose: \'working\'', 'node.setMeta', 'character', 'scene', 'prop', 'shot', 'storyboard', 'copy', 'other', 'inputNodeIds', 'placements']) expect(canvas).toContain(text)
  expect(canvas).toContain('rather than report text nodes')
})

it('the timeline guide retains document limits, pinned edits, local export and layout', () => {
  const timeline = getGuide('timeline').guide!.body
  const media = getGuide('media').guide!.body
  for (const text of ['timelineFrom', '{ nodeId, durationMs }', '500–30000', 'durationSec', 'video', 'first', 'timeline.set', 'expectedRevision', 'assetVersionId', 'startMs', 'inMs', 'outMs', 'fadeInMs', 'fadeOutMs', '0–2', '1 video track', '4 audio tracks', '200 clips', '30 minutes', '10 seconds', 'timeline.export', 'params: {}', 'exportOf', 'Frame', 'canvas_get', 'canvas_apply', 'media_process', 'media_get', 'vis media wait', 'speed', '0.25–4', 'transitionIn', 'crossfade', 'dip', 'textTracks', 'font.list', 'assetVersionId }', 'pnpm fonts:fetch', 'captions follow the original shot', 'rather than inventing fields', 'does not submit generation jobs', 'picture-in-picture', 'Rotation, cropping', 'media.captions_unavailable', 'overlay: { x, y, width, opacity }', '2 overlay tracks', 'complete only after processing and inspecting it']) expect(timeline).toContain(text)
  for (const text of ['trim', 'speed', 'audio', 'asset_import_file']) expect(media).toContain(text)
})

// dsh interpolates every template marker in the persona suffix and rejects unknown names.
it('the dsh persona suffix contains no template braces in any mode', () => {
  for (const expanded of [false, true]) for (const isolation of ['sandbox', 'none'] as const) {
    const instructions = agentInstructions(expanded, undefined, isolation)
    expect(instructions).not.toContain('{{')
    expect(instructions).not.toContain('}}')
    const suffix = dshOverlay(undefined, undefined, expanded, undefined, isolation).split('\n').find(line => line.includes('personaSuffix'))!
    expect(suffix).not.toContain('{{')
    expect(suffix).not.toContain('}}')
  }
})


it('teaches exact child configuration only on author or author-written workflow direction', () => {
  const work = { workItemId: 'root', parentId: null, hasChildren: true }
  const instructions = agentInstructions(false, work)
  for (const text of ['only when the author asked', 'skill or workflow the author wrote', 'otherwise omit agentConfig', 'work.agentOptions', 'work.dispatch', 'work.setAgentConfig', 'work.get', 'ambiguous or not listed', 'Do not pick a model on your own initiative']) expect(instructions).toContain(text)
})


it('does not teach child sessions to configure or dispatch children', () => {
  const child = { workItemId: 'child', parentId: 'root', hasChildren: false }
  const instructions = agentInstructions(false, child)
  for (const text of ['work.agentOptions', 'work.dispatch', 'work.setAgentConfig']) expect(instructions).not.toContain(text)
})
