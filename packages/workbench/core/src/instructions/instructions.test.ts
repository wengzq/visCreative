import { describe, expect, it } from 'vitest'
import { GuideTopic } from '@vis/protocol'
import { agentInstructions, CORE_INSTRUCTIONS, getGuide, GUIDES, listGuides, turnPrompt } from './index'
import type { DispatchInput } from '../runtime-port'

const input: DispatchInput = {
  sessionId: 'session', turnId: 'turn', text: '  User text\nwith original spacing.  ', inputSnapshotId: 'snapshot',
  refs: [], resumeId: null, sessionTitle: 'Session', titleSource: 'default',
}

function hasEnglishGuideProse(guide: { topic: string; body: string }): boolean {
  const prose = guide.topic === 'generation' ? guide.body.replace(/`@?(?:视频|图片|音频)\d+`/g, '') : guide.body
  return !/\p{Script=Han}/u.test(prose)
}

it('keeps the core within the 1200-word budget and ends with the generated guide index', () => {
  expect(CORE_INSTRUCTIONS.split(/\s+/).length).toBeLessThanOrEqual(1200)
  expect(CORE_INSTRUCTIONS.endsWith(GUIDES.map(({ topic, when }) => `- ${topic}: ${when}`).join('\n'))).toBe(true)
  expect(CORE_INSTRUCTIONS).toContain('guide tool before the first write of that kind in a session')
  // Shared by Codex and DeepSeek, so nothing agent-specific belongs here.
  expect(CORE_INSTRUCTIONS).not.toMatch(/DeepSeek|dsh|Codex/)
})

it('serves all registered complete guides without loading specialist bodies into the core', () => {
  expect(GUIDES.map(guide => guide.topic)).toEqual(GuideTopic.options)
  for (const guide of GUIDES) {
    expect(guide.title.trim()).not.toBe('')
    expect(guide.when.trim()).not.toBe('')
    expect(guide.body.trim()).not.toBe('')
    expect(getGuide(guide.topic)).toEqual({ topics: listGuides(), guide: { topic: guide.topic, title: guide.title, body: guide.body } })
    expect(CORE_INSTRUCTIONS).not.toContain(guide.body)
  }
  expect(getGuide()).toEqual({ topics: listGuides() })
  expect(CORE_INSTRUCTIONS).not.toMatch(/\p{Script=Han}/u)
  expect(GUIDES.every(hasEnglishGuideProse)).toBe(true)
})

it('permits only literal vendor reference identifiers in the generation guide and rejects other Han prose', () => {
  const body = 'Use `视频1`, `图片12`, `音频2`, `@视频3`, `@图片1` and `@音频1` as literal identifiers.'
  expect(hasEnglishGuideProse({ topic: 'generation', body })).toBe(true)
  expect(hasEnglishGuideProse({ topic: 'generation', body: `${body} 其他文字` })).toBe(false)
  for (const token of ['`视频`', '`图片n`', '`@音频`', '`@@图片1`', '视频1']) expect(hasEnglishGuideProse({ topic: 'generation', body: token })).toBe(false)
  for (const guide of GUIDES.filter(guide => guide.topic !== 'generation')) expect(hasEnglishGuideProse({ topic: guide.topic, body })).toBe(false)
})

it('teaches labeling and setting proposals through the library guide', () => {
  const body = getGuide('library').guide!.body
  for (const fact of ['asset.label in batches of at most 50', 'skippedFields', 'never claim to have listened', 'entity.propose', 'castIds and one styleId', 'Only the user deletes a setting']) expect(body).toContain(fact)
})

it('teaches scene authoring, free local checks and proposals for protected content', () => {
  const body = getGuide('scene').guide!.body
  for (const fact of [
    'metres', 'Y is up', 'quaternions [x, y, z, w]', "type: 'group'", 'Human joint ids:', 'Human preset pose names:',
    'durationS', 'cameraKeys', 'strictly increasing', 'easeInOut', 'Visibility is stepped',
    "provider: 'render', model: 'scene'", "kind: 'image'", 'params.timeS', "kind: 'video'", 'first input',
    'Never suggest paid providers', 'call scene.propose', 'a proposal is waiting in the scene editor', 'Do not retry the write',
    'panel.blockout and sceneRef stay user-only',
  ]) expect(body).toContain(fact)
})

it('teaches deterministic anime.js and plain JavaScript without installing author libraries', () => {
  const body = getGuide('code-render').guide!.body
  for (const fact of [
    'Plain JavaScript', 'equal option', '/lib/anime.js', 'useDefaultMainLoop = false',
    'autoplay: false', 'x: [0, 260]', "timeUnit = 'ms'", 'timeline.seek(t * 1000, true)',
    'only when the author explicitly says it is available', 'Never fetch, install or copy',
    'never write into render-libs', 'render.lib_missing',
  ]) expect(body).toContain(fact)
})

describe('author-facing wording', () => {
  it('keeps plain replies in the shared instructions, not only the writing guide', () => {
    expect(CORE_INSTRUCTIONS).toContain('Replies do not mention method or tool names, error codes, guide names or local file paths')
  })
})

describe('environment facts', () => {
  it('enables general abilities within the outer sandbox and explains import and approval boundaries', () => {
    const text = agentInstructions({ environment: { access: 'expanded', isolation: 'sandbox' } }).slice(CORE_INSTRUCTIONS.length)
    for (const fact of ['run commands, edit files and use the network', 'read nonsensitive files outside it', 'blocks provider keys, app tokens, databases and writes outside the work directory', 'approvals cannot lift it', 'only after asset_import_file']) expect(text).toContain(fact)
  })

  it('describes Windows capabilities and the absence of isolation without removing approvals', () => {
    const text = agentInstructions({ environment: { access: 'expanded', isolation: 'none' } }).slice(CORE_INSTRUCTIONS.length)
    for (const fact of ['run commands, edit files and use the network', 'Windows has no isolation sandbox', 'tool approvals still apply', 'Do not read provider keys, app tokens or databases', 'only after asset_import_file']) expect(text).toContain(fact)
    expect(text).not.toContain('outer sandbox blocks')
  })

  it.each(['sandbox', 'none'] as const)('makes read-only fallback unambiguous with %s isolation state', isolation => {
    const text = agentInstructions({ environment: { access: 'readOnly', isolation } }).slice(CORE_INSTRUCTIONS.length)
    expect(text).toContain('cannot run shell commands or modify files; deliver everything to the canvas')
    expect(text).not.toContain('You may run commands')
    expect(text).not.toContain('only after asset_import_file')
  })
})

describe('workspace and turn facts', () => {
  it('teaches children to report and parents to answer an unreported notice without replyTo', () => {
    const environment = { access: 'expanded', isolation: 'none' } as const
    const child = agentInstructions({ environment, work: { workItemId: 'child', parentId: 'parent', hasChildren: false } })
    expect(child).toContain('without work_report notifies the parent')
    expect(child).toContain('asking a question in prose alone does not report it')
    const parent = agentInstructions({ environment, work: { workItemId: 'parent', parentId: null, hasChildren: true } })
    expect(parent).toContain('work.reply (work_reply) without replyTo')
    expect(parent).toContain('recall it with work_recall or keep waiting')
    expect(parent).toContain('your own recall and activation do not reset it')
  })

  it('only teaches cleanup in a root workspace with children and keeps the author in control', () => {
    for (const parentId of [null, 'parent']) for (const hasChildren of [false, true]) {
      const text = agentInstructions({ environment: { access: 'expanded', isolation: 'sandbox' }, work: { workItemId: 'root', parentId, hasChildren } })
      if (parentId === null && hasChildren) {
        for (const fact of ['If the author asks', 'work_request_delete', 'direct children they mean', 'a card is waiting', 'end the turn without polling', 'Never request cleanup on your own initiative', 'ask which children', 'Approval does not wake you', 'work_list on a later turn']) expect(text).toContain(fact)
      } else expect(text).not.toContain('work_request_delete')
    }
  })
  it('omits workspace instructions when no work item is linked', () => {
    expect(agentInstructions({ environment: { access: 'expanded', isolation: 'sandbox' } })).not.toContain('<workspace>')
    expect(turnPrompt(input)).not.toContain('<work-item>')
  })

  it('preserves user text byte-for-byte before any generated facts', () => {
    expect(turnPrompt(input)).toBe(`${input.text}\n\n<session>\nTitle: "Session"\nSource: default\n</session>`)
  })

  it('retains explicitly selected unknown skills when project context is absent', () => {
    expect(turnPrompt({ ...input, skills: ['custom'] })).toContain('- {"name":"custom"}')
  })
})
