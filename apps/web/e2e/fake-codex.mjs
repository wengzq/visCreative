#!/usr/bin/env node
// Fake `codex app-server` for end-to-end tests: no model calls. Each turn echoes the first user-message line as a streaming reply;
// Messages containing the slow marker (Unicode U+6162) produce long replies; other probe prefixes run deterministic MCP / CLI scenarios without model calls.
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

let buffer = ''
const send = msg => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
const notify = (method, params) => send({ method, params })
let thread = 'thr_e2e'
let turnSeq = 0
let ignoreInterrupt = false
let agentEnv = {}
let agentMcp
const timers = new Set()
const approvals = new Map()
const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn() }, ms); timers.add(t) }

function replyNow(turnId, text) {
  const item = { id: 'm0', type: 'agentMessage', text }
  notify('item/started', { threadId: thread, turnId, item: { ...item, text: '' } })
  notify('item/completed', { threadId: thread, turnId, item })
  notify('turn/completed', { threadId: thread, turn: { id: turnId, status: 'completed' } })
}

function workTool(tool, args = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(agentMcp.command, agentMcp.args, { env: { ...process.env, ...agentEnv } }, (error, stdout) => {
      try {
        if (error) throw error
        const response = stdout.trim().split('\n').map(line => JSON.parse(line)).find(message => message.id === 1)
        const result = response?.result
        const output = JSON.parse(result?.content?.find(item => item.type === 'text')?.text ?? '{}')
        appendFileSync(join(process.cwd(), '.vis-e2e-agent.jsonl'), `${JSON.stringify({ method: 'work-tool', tool, output })}\n`)
        if (!result || result.isError) throw new Error(JSON.stringify(output.error ?? response?.error))
        resolve(output)
      } catch (error) { reject(error) }
    })
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } })}\n`)
  })
}

async function workScenario(turnId, text, script) {
  if (script.scenario === 'generation-provenance') {
    const { nodes } = await workTool('canvas_get')
    const reference = nodes.find(node => node.nodeId === script.referenceId)
    const input = reference?.slots.find(slot => slot.slotKey === 'main')
    if (!input) throw new Error('The provenance scenario needs a reference node')
    const result = await workTool('gen_submit', {
      kind: 'image', provider: 'mock', model: 'mock-image-1',
      prompt: script.prompt, params: { width: 128, height: 128 },
      inputs: [{ slotId: input.slotId, revision: input.revision }],
      targets: [{ outputIndex: 0, kind: 'new_node', nearNodeId: reference.nodeId }],
    })
    let job = await workTool('gen_get', { jobId: result.jobId, waitMs: 30000 })
    while (['queued', 'running', 'finalizing'].includes(job.status)) job = await workTool('gen_get', { jobId: result.jobId, waitMs: 30000 })
    if (job.status !== 'succeeded') throw new Error(`Provenance generation failed: ${job.status}`)
    return replyNow(turnId, 'The provenance image is ready.')
  }
  if (script.scenario === 'unreported') return replyNow(turnId, 'Should I use option A or option B?')
  if (script.scenario === 'reply-unreported') {
    await workTool('work_reply', { workItemId: script.workItemId, body: `工作代理检查：${JSON.stringify({ scenario: 'hold' })}` })
    return replyNow(turnId, 'The child has been asked to continue.')
  }
  if (script.scenario === 'request-delete') {
    const approval = await workTool('work_request_delete', { workItemIds: script.workItemIds })
    return replyNow(turnId, `Cleanup card waiting: ${approval.approvalId}`)
  }
  if (script.scenario === 'cleanup-hold') {
    await workTool('canvas_apply', { ops: [{ op: 'node.create', tempId: 'kept', kind: 'text', x: 40, y: 80, content: { text: 'Child result stays on the shared canvas' } }] })
    await workTool('gen_submit', { kind: 'image', prompt: 'Mock cleanup consequence' })
    return
  }
  if (script.scenario === 'guide') {
    await workTool('guide')
    await workTool('guide', { topic: script.topic })
    return replyNow(turnId, 'Guide loaded')
  }
  if (['script-breakdown', 'script-prompts', 'script-batch'].includes(script.scenario)) return scriptScenario(turnId, script.scenario, script.nodeId, text.includes('script-hold'))
  if (['timeline-roughcut', 'timeline-edit'].includes(script.scenario)) return timelineScenario(turnId, script.scenario)
  if (script.scenario === 'dispatch') {
    for (const [index, child] of script.children.entries()) {
      if (script.confirm) {
        const id = `dispatch-${turnId}-${index}`
        const action = await new Promise(resolve => {
          approvals.set(id, resolve)
          send({ id, method: 'mcpServer/elicitation/request', params: {
            threadId: thread, turnId, serverName: 'vis', toolName: 'work_dispatch',
            // english-exempt: Seeded agent approval message is visible Chinese UI fixture data.
            mode: 'form', requestedSchema: {}, message: `派发子工作项：${child.title}`,
          } })
        })
        if (action !== 'accept') return replyNow(turnId, '已取消派发')
      }
      await workTool('work_dispatch', { title: child.title, brief: `工作代理检查：${JSON.stringify(child.script)}`, agentKind: 'codex' })
    }
    if (!script.hold) replyNow(turnId, `已派发 ${script.children.length} 个 Agent`)
    return
  }
  if (script.scenario === 'question') {
    const { nodes } = await workTool('canvas_get')
    const created = await workTool('canvas_apply', { ops: [{ op: 'node.create', tempId: 'inside', kind: 'text', x: 40, y: 80, w: 160, h: 80, content: { text: '工作草稿' } }] })
    if (script.outsideNodeId) {
      const outside = nodes.find(node => node.nodeId === script.outsideNodeId).slots[0]
      await workTool('text_propose', { slotId: outside.slotId, baseRevision: outside.revision, summary: 'Update the shared manuscript', edits: [{ find: outside.content.body, replace: '共享画布修改' }] })
    }
    await workTool('work_report', { kind: 'question', body: '请选择版本 A 或 B', refs: { nodeIds: [created.idMap.inside] } })
    replyNow(turnId, '已提问，等待回复')
    return
  }
  if (script.scenario === 'canvas') {
    await workTool('canvas_apply', { ops: script.ops })
    replyNow(turnId, '已修改画布')
    return
  }
  if (script.scenario === 'done') {
    await workTool('work_report', { kind: 'done', body: script.body ?? '已完成工作项' })
    replyNow(turnId, '已提交审阅')
    return
  }
  if (script.scenario === 'hold') return
  if (script.scenario === 'restart') {
    if (text.includes('重新投递')) replyNow(turnId, '重新投递已处理')
    return
  }
  throw new Error(`Unknown work scenario: ${script.scenario}`)
}

async function scriptScenario(turnId, scenario, nodeId, hold = false) {
  const { nodes } = await workTool('canvas_get')
  const node = nodes.find(node => node.kind === 'script' && (!nodeId || node.nodeId === nodeId))
  if (!node) throw new Error('The script scenario needs a script node')
  if (hold) await new Promise(resolve => later(1500, resolve))
  const slot = node.slots.find(slot => slot.slotKey === 'main')
  if (scenario === 'script-batch') {
    let batch = await workTool('script_batch_start', { scriptNodeId: node.nodeId, media: 'frames' })
    while (batch.status === 'pending_approval') batch = await workTool('script_batch_get', { batchId: batch.batchId, waitMs: 30000 })
    return replyNow(turnId, `Batch status: ${batch.status}`)
  }
  if (scenario === 'script-breakdown') {
    await workTool('canvas_apply', { ops: [{ op: 'script.replace', slotId: slot.slotId, expectedRevision: slot.revision, doc: {
      style: 'Cinematic natural light',
      assets: [
        { tempId: 'hero', kind: 'character', name: 'Lin', description: 'A traveler in a blue coat' },
        { tempId: 'station', kind: 'scene', name: 'Station', description: 'A quiet station at dawn' },
      ],
      shots: [
        { tempId: 'shot1', durationSec: 4, description: '{{asset:hero}} stands at the platform', endState: 'Lin reaches the train door', sceneId: 'station', characterIds: ['hero'], transition: 'cut', shotSize: 'Wide' },
        { tempId: 'shot2', durationSec: 3, description: 'Lin stands beside the open train door', sceneId: 'station', characterIds: ['hero'], transition: 'continuous', shotSize: 'Medium' },
        { tempId: 'shot3', durationSec: 5, description: 'The train disappears into the dawn', sceneId: 'station', transition: 'cut', shotSize: 'Wide' },
      ],
    } }] })
  } else {
    const doc = slot.content.doc
    const ops = doc.shots.filter(shot => shot.promptState !== 'edited').map(shot => {
      const refs = doc.assets.filter(asset => asset.imageNodeId && (shot.sceneId === asset.id || shot.characterIds.includes(asset.id) || shot.propIds.includes(asset.id)))
        .map(asset => `{{ref:${asset.imageNodeId}}}`).join(' ')
      return { kind: 'shot.update', shotId: shot.id, rev: shot.rev, fields: {
        framePrompt: `${shot.transition === 'continuous' ? 'Continue the previous ending. ' : ''}Still frame: ${shot.description}. ${refs}`,
        endFramePrompt: shot.endState ? `Ending still: ${shot.endState}. ${refs}` : null,
        videoPrompt: `Cinematic movement for ${shot.durationSec ?? 4} seconds. ${shot.camera ?? 'Steady camera'}. ${refs}`,
      } }
    })
    if (ops.length) await workTool('canvas_apply', { ops: [{ op: 'script.patch', slotId: slot.slotId, ops }] })
  }
  replyNow(turnId, `Completed ${scenario}`)
}

// Probe text containing timeline-roughcut or timeline-edit, or work JSON with that scenario, runs these stable fixtures.
async function timelineScenario(turnId, scenario) {
  const { nodes } = await workTool('canvas_get')
  let timeline
  if (scenario === 'timeline-roughcut') {
    const hasAsset = node => node.slots.some(slot => slot.slotKey === 'main' && slot.content.type === 'asset')
    const videos = nodes.filter(node => node.kind === 'video' && hasAsset(node)).sort((a, b) => a.y - b.y || a.x - b.x)
    const audio = nodes.find(node => node.kind === 'audio' && hasAsset(node))
    if (!videos.length) throw new Error('The rough cut scenario needs video nodes with assets')
    const created = await workTool('canvas_apply', { ops: [{
      op: 'node.create', tempId: 'cut', kind: 'timeline',
      content: { timelineFrom: [...videos.map(node => node.nodeId), ...(audio ? [audio.nodeId] : [])] },
    }] })
    timeline = (await workTool('canvas_get', { nodeIds: [created.idMap.cut] })).nodes[0]
  } else {
    timeline = nodes.find(node => node.kind === 'timeline')
    if (!timeline) throw new Error('The edit scenario needs a timeline node')
  }
  const slot = timeline.slots.find(slot => slot.slotKey === 'main')
  const doc = slot.content.doc
  const video = doc.tracks.find(track => track.kind === 'video')
  if (scenario === 'timeline-edit') {
    if (video) video.clips.pop()
    await workTool('canvas_apply', { ops: [{ op: 'timeline.set', slotId: slot.slotId, expectedRevision: slot.revision, doc }] })
    return replyNow(turnId, `Completed timeline-edit ${timeline.nodeId}`)
  }
  const length = video.clips.reduce((total, clip) => total + clip.outMs - clip.inMs, 0)
  const music = doc.tracks.find(track => track.kind === 'audio')
  if (music?.clips.length) {
    music.name = '配乐'
    const clip = music.clips[0]
    clip.outMs = Math.min(clip.outMs, clip.inMs + length)
    clip.fadeOutMs = Math.min(1000, clip.outMs - clip.inMs)
  }
  const edited = await workTool('canvas_apply', { ops: [{ op: 'timeline.set', slotId: slot.slotId, expectedRevision: slot.revision, doc }] })
  let task = await workTool('media_process', {
    operation: 'timeline.export', params: {}, nodeId: timeline.nodeId, slotId: slot.slotId,
    expectedRevision: edited.slotRevisions[slot.slotId],
  })
  while (task.status === 'queued' || task.status === 'running') task = await workTool('media_get', { taskId: task.taskId, waitMs: 30000 })
  if (task.status !== 'succeeded') throw new Error(`Timeline export failed: ${task.error?.code ?? task.status}`)
  replyNow(turnId, `Completed timeline-roughcut ${timeline.nodeId} ${task.nodeIds.join(' ')}`)
}

// README capture fixtures live only in isolated harness work directories. Existing e2e turns never enter this block.
async function readmeShotTurn(turnId, text) {
  const fixturePath = join(process.cwd(), '.vis-readme-shots.json')
  if (!existsSync(fixturePath)) return false
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  const tool = async (name, args = {}) => {
    const item = { id: `shots-${name}-${crypto.randomUUID()}`, type: 'mcpToolCall', server: 'vis', tool: name, arguments: args, status: 'inProgress' }
    notify('item/started', { threadId: thread, turnId, item })
    const result = await workTool(name, args)
    notify('item/completed', { threadId: thread, turnId, item: { ...item, status: 'completed', result: { content: [{ type: 'text', text: name === 'skill_proposeDraft' ? JSON.stringify(result) : fixture.toolResult }] } } })
    return result
  }
  if (fixture.request && text.includes(fixture.request)) {
    const reasoning = { id: 'shots-thought', type: 'reasoning', summary: [fixture.reasoning], content: [] }
    notify('item/started', { threadId: thread, turnId, item: { ...reasoning, summary: [] } })
    notify('item/reasoning/summaryTextDelta', { threadId: thread, turnId, itemId: reasoning.id, summaryIndex: 0, delta: fixture.reasoning })
    notify('item/completed', { threadId: thread, turnId, item: reasoning })
    notify('turn/plan/updated', { threadId: thread, turnId, plan: fixture.plan.map(step => ({ step, status: 'completed' })) })
    await tool('canvas_get')
    await tool('entity_list')
    for (const call of fixture.calls ?? []) {
      const result = await tool(call.name, call.args)
      if (call.waitForGeneration) {
        let job = await tool('gen_get', { jobId: result.jobId, waitMs: 30000 })
        while (['queued', 'running', 'finalizing'].includes(job.status)) job = await tool('gen_get', { jobId: result.jobId, waitMs: 30000 })
        if (job.status !== 'succeeded') throw new Error(`README generation failed: ${job.status}`)
      }
    }
    if (fixture.hold) return true
    replyNow(turnId, fixture.answer)
  } else if (fixture.report && text.includes(fixture.trigger)) {
    if (fixture.ops?.length) await tool('canvas_apply', { ops: fixture.ops })
    await tool('work_report', fixture.report)
    replyNow(turnId, fixture.answer)
  } else replyNow(turnId, fixture.ack)
  return true
}
// End README capture fixtures.

async function runTurn(turnId, text) {
  if (await readmeShotTurn(turnId, text)) return
  const skillDraft = text.match(/^author-skill-draft (.+)$/m)
  if (skillDraft) {
    await workTool('guide', { topic: 'library' })
    const args = { requestId: `author-skill-${turnId}`, name: skillDraft[1], description: 'My quiet story method', body: '# My method\n\nKeep the pauses I asked for. Let each image breathe because I want time to notice the small details.\n' }
    if (text.includes('author-frontmatter-retry')) {
      const invalid = { ...args, requestId: `${args.requestId}-frontmatter`, body: `---\nname: ${args.name}\ndescription: ${args.description}\n---\n${args.body}` }
      const item = { id: 'skill-frontmatter', type: 'mcpToolCall', server: 'vis', tool: 'skill_proposeDraft', arguments: invalid, status: 'inProgress' }
      notify('item/started', { threadId: thread, turnId, item })
      try {
        await workTool('skill_proposeDraft', invalid)
        throw new Error('Expected a frontmatter refusal')
      } catch (error) {
        if (!String(error).includes('skill.draft_frontmatter')) throw error
        notify('item/completed', { threadId: thread, turnId, item: { ...item, status: 'failed', result: { isError: true, content: [{ type: 'text', text: String(error) }] } } })
      }
    }
    const item = { id: 'skill-draft', type: 'mcpToolCall', server: 'vis', tool: 'skill_proposeDraft', arguments: args, status: 'inProgress' }
    notify('item/started', { threadId: thread, turnId, item })
    const result = await workTool('skill_proposeDraft', args)
    notify('item/completed', { threadId: thread, turnId, item: { ...item, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } })
    return replyNow(turnId, `Draft “${result.draft.name}” is in ${result.location}. Review and save it there.`)
  }
  const skillRead = text.match(/^author-skill-read (.+)$/m)
  if (skillRead) {
    const marker = text.match(/"path":"([^"]+SKILL\.md)"/)
    if (!marker) throw new Error('The skill probe needs a selected project skill path')
    const path = JSON.parse(`"${marker[1]}"`)
    const body = readFileSync(path, 'utf8')
    appendFileSync(join(process.cwd(), '.vis-e2e-agent.jsonl'), `${JSON.stringify({ method: 'author-skill-read', path, body })}\n`)
    return replyNow(turnId, `Read project skill: ${skillRead[1]}`)
  }
  const production = text.match(/^Writing task: (shots|extract)\nnodeId: ([^\n]+)\nslotId: ([^\n]+)\nChapter: ([^\n]+)\nSelection: ([^\n]+)\nInstruction: ([^\n]+)/m)
  if (production) {
    await workTool('guide', { topic: 'writing' })
    const nodeId = production[2]
    const selection = JSON.parse(production[5])
    const instruction = JSON.parse(production[6])
    const { nodes } = await workTool('canvas_get')
    const source = nodes.find(node => node.nodeId === nodeId)
    if (!source || source.slots.find(slot => slot.slotKey === 'main')?.content.type !== 'text') throw new Error('Production needs a manuscript')
    if (production[1] === 'shots') {
      await workTool('guide', { topic: 'script' })
      const name = instruction.trim() || 'Manuscript storyboard'
      let script = nodes.find(node => node.kind === 'script' && node.title === name)
      if (!script) {
        const created = await workTool('canvas_apply', { ops: [{ op: 'node.create', tempId: 'script', kind: 'script', title: name, inputNodeIds: [nodeId] }] })
        script = (await workTool('canvas_get', { nodeIds: [created.idMap.script] })).nodes[0]
      }
      const slot = script.slots.find(slot => slot.slotKey === 'main')
      await workTool('canvas_apply', { ops: [{ op: 'script.patch', slotId: slot.slotId, ops: [{ kind: 'shot.insert', tempId: 'adapted', afterShotId: slot.content.doc.shots.at(-1)?.id ?? null, shot: { description: 'A traveler walks beside the quiet river.', durationSec: 4, source: { nodeId, quote: selection } } }] }] })
      return replyNow(turnId, `Completed writing shots: ${name}`)
    }
    await workTool('guide', { topic: 'library' })
    const { items } = await workTool('entity_list')
    const existing = []
    for (const setting of [{ kind: 'character', name: 'Lin Zhou', description: 'A traveler returning home through the morning fog.' }, { kind: 'scene', name: 'River', description: 'A quiet river covered in morning fog.' }]) {
      if (items.some(item => item.kind === setting.kind && item.name.trim().toLowerCase() === setting.name.toLowerCase())) existing.push(setting.name)
      else await workTool('entity_create', setting)
    }
    return replyNow(turnId, `Extracted settings; existing settings preserved: ${existing.join(', ')}`)
  }
  const protectedWrite = text.match(/^scene-protected-write (.+)$/m)
  if (protectedWrite) {
    const payload = JSON.parse(protectedWrite[1])
    const { nodes } = await workTool('canvas_get', { nodeIds: [payload.nodeId] })
    const slot = nodes[0]?.slots.find(slot => slot.slotKey === 'main')
    if (slot?.content.type !== 'scene') throw new Error('The protected write scenario needs a scene')
    const doc = slot.content.doc
    const bench = doc.objects.find(object => object.id === 'bench')
    const view = doc.views.find(view => view.id === 'wide')
    if (!bench || !view) throw new Error('The protected write scenario needs a bench and a view')
    const attempt = async (id, ops) => {
      const args = { ops }
      const item = { id: `scene-protected-${id}`, type: 'mcpToolCall', server: 'vis', tool: 'canvas_apply', arguments: args, status: 'inProgress' }
      notify('item/started', { threadId: thread, turnId, item })
      let failure
      try { await workTool('canvas_apply', args) } catch (error) { failure = error }
      if (!failure) throw new Error(`Protected scene write succeeded: ${id}`)
      notify('item/completed', { threadId: thread, turnId, item: { ...item, status: 'failed', result: { isError: true, content: [{ type: 'text', text: failure.message }] } } })
    }
    const set = next => ({ op: 'scene.set', slotId: slot.slotId, expectedRevision: slot.revision, doc: next })
    if (payload.mode === 'object') {
      await attempt('object', [set({ ...doc, objects: doc.objects.map(object => object.id === bench.id
        ? { ...object, transform: { ...object.transform, position: [object.transform.position[0] + 1, ...object.transform.position.slice(1)] } } : object) })])
    } else if (payload.mode === 'view') {
      await attempt('view', [set({ ...doc, views: doc.views.map(item => item.id === view.id
        ? { ...item, camera: { ...item.camera, focalLengthMm: item.camera.focalLengthMm + 10 } } : item) })])
    } else if (payload.mode === 'delete') {
      await attempt('delete-object', [set({ ...doc, objects: doc.objects.filter(object => object.id !== bench.id) })])
      await attempt('delete-node', [{ op: 'node.delete', nodeId: payload.nodeId }])
    } else throw new Error(`Unknown protected scene write mode: ${payload.mode}`)
    return replyNow(turnId, `Completed scene-protected-write ${payload.mode}`)
  }
  const sceneProposal = text.match(/^scene-proposal (.+)$/m)
  if (sceneProposal) {
    const payload = JSON.parse(sceneProposal[1])
    const { nodes } = await workTool('canvas_get', { nodeIds: [payload.nodeId] })
    const slot = nodes[0]?.slots.find(slot => slot.slotKey === 'main')
    if (slot?.content.type !== 'scene') throw new Error('The proposal scenario needs a scene')
    const bench = slot.content.doc.objects.find(object => object.id === 'bench')
    if (!bench) throw new Error('The proposal scenario needs a bench')
    const { createdBy, userTouched, ...content } = bench
    const args = { slotId: slot.slotId, baseRevision: slot.revision, summary: payload.summary,
      changes: [{ target: 'object', id: bench.id, action: 'update', item: { ...content, transform: { ...content.transform, position: [payload.x, 0, 0] } } }] }
    const item = { id: 'scene-proposal', type: 'mcpToolCall', server: 'vis', tool: 'scene_propose', arguments: args, status: 'inProgress' }
    notify('item/started', { threadId: thread, turnId, item })
    const result = await workTool('scene_propose', args)
    notify('item/completed', { threadId: thread, turnId, item: { ...item, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } })
    return replyNow(turnId, `Completed ${payload.summary}`)
  }
  const writingAction = text.match(/^Writing task: (rewrite|continue|expand|ask)\nnodeId: ([^\n]+)\nslotId: ([^\n]+)\nChapter: ([^\n]+)\nSelection: ([^\n]+)\nInstruction: ([^\n]+)/m)
  const writingProbe = text.match(/^writing-(propose|nonunique|refuse|own|series|delete)\s+(.+)$/m)
  if (writingAction || writingProbe) {
    await workTool('guide', { topic: 'writing' })
    const payload = writingProbe ? JSON.parse(writingProbe[2]) : { nodeId: writingAction[2] }
    const scenario = writingProbe?.[1] ?? 'selection'
    if (scenario === 'own') {
      const created = await workTool('canvas_apply', { ops: [{ op: 'node.create', tempId: 'own', kind: 'text', title: 'Agent draft', content: { text: 'First Agent draft' } }] })
      const { nodes } = await workTool('canvas_get', { nodeIds: [created.idMap.own] })
      await workTool('canvas_apply', { ops: [{ op: 'slot.setText', slotId: nodes[0].slots[0].slotId, expectedRevision: 1, body: 'Second Agent draft' }] })
    } else if (scenario === 'series') {
      const result = await workTool('series_text_list')
      const episode = result.episodes.find(episode => episode.spaceId === payload.earlier)
      if (!episode || result.episodes.some(item => item.spaceId === payload.outside)) throw new Error('Series listing escaped the current series')
      const chapter = await workTool('series_text_read', { spaceId: episode.spaceId, nodeId: episode.nodes[0].nodeId })
      if (chapter.body !== payload.body) throw new Error('Earlier chapter content differs')
      let refused = false
      try { await workTool('series_text_read', { spaceId: payload.outside, nodeId: episode.nodes[0].nodeId }) } catch (error) { if (!error.message.includes('writing.same_series_required')) throw error; refused = true }
      if (!refused) throw new Error('A project outside the series was readable')
    } else {
      const { nodes } = await workTool('canvas_get', { nodeIds: [payload.nodeId] })
      const slot = nodes[0]?.slots.find(slot => slot.slotKey === 'main')
      if (!slot) throw new Error('The writing scenario needs a manuscript')
      if (scenario === 'delete') {
        let refused = false
        try { await workTool('canvas_apply', { ops: [{ op: 'node.delete', nodeId: payload.nodeId }] }) } catch (error) { if (!error.message.includes('writing.delete_protected')) throw error; refused = true }
        if (!refused) throw new Error('Protected prose was deleted without approval')
        const approval = await workTool('text_request_delete', { nodeId: payload.nodeId, expectedRevision: slot.revision })
        if (approval.status !== 'pending') throw new Error('Deletion approval must require a user click')
      } else if (scenario === 'refuse') {
        let refused = false
        try { await workTool('canvas_apply', { ops: [{ op: 'slot.setText', slotId: slot.slotId, expectedRevision: slot.revision, body: 'Overwritten by Agent' }] }) } catch (error) { if (!error.message.includes('writing.propose_required')) throw error; refused = true }
        if (!refused) throw new Error('User text was overwritten')
      } else if (scenario === 'nonunique') {
        let refused = false
        try { await workTool('text_propose', { slotId: slot.slotId, baseRevision: slot.revision, summary: 'Ambiguous edit', edits: [{ find: payload.find, replace: 'Ambiguous' }] }) } catch (error) { if (!error.message.includes('writing.anchor_not_unique')) throw error; refused = true }
        if (!refused) throw new Error('Ambiguous anchor was accepted')
      } else {
        const selection = writingAction ? JSON.parse(writingAction[5]) : payload.selection
        const sentences = selection.match(/[^。]+。/gu) ?? [selection]
        const replacements = ['晨雾贴着河面流动。', '林舟沿着石阶走向旧书店。']
        await new Promise(resolve => later(600, resolve))
        await workTool('text_propose', { slotId: slot.slotId, baseRevision: slot.revision, summary: 'Preserve the voice and clarify the scene', edits: sentences.slice(0, 2).map((find, index) => ({ find, replace: replacements[index] })) })
      }
    }
    return replyNow(turnId, writingAction ? `Completed writing ${writingAction[1]}` : `Completed ${text.split('\n')[0]}`)
  }
  // RFC 0027 C1: series discovery and linking exercise the real agent gateway.
  const seriesLink = text.match(/^library-series-link\s+(.+)$/m)
  if (seriesLink) {
    const { items } = await workTool('series_list')
    const setting = items.find(item => item.latest.name === seriesLink[1].trim())
    if (!setting) throw new Error('The requested series setting does not exist')
    const entity = await workTool('entity_link', { requestId: `series-link-${turnId}`, seriesEntityId: setting.seriesEntityId })
    return replyNow(turnId, `Linked series setting ${entity.name}`)
  }
  // A2: deterministic library labeling exercises real agent permissions and run-id protection.
  const libraryRun = text.match(/Library task: label\nrunId: ([^\n]+)\nrelabel: (true|false)/)
  if (libraryRun) {
    const runId = libraryRun[1]
    const relabel = libraryRun[2] === 'true'
    let cursor
    do {
      const page = await workTool('asset_list', { ...(relabel ? {} : { labeled: false }), ...(cursor ? { cursor } : {}), limit: 50 })
      if (page.items.length) await workTool('asset_label', {
        requestId: `labels-${runId}-${cursor ?? 'first'}`, runId,
        items: page.items.map(asset => ({ assetId: asset.assetId, displayName: `${asset.kind === 'image' ? 'Dawn portrait' : asset.kind === 'audio' ? 'Station ambience' : 'Arrival clip'}${relabel ? ' revised' : ''}`,
          category: asset.kind === 'image' ? 'Portrait' : asset.kind === 'audio' ? 'Ambience' : 'Clips',
          tags: ['dawn', asset.kind] })),
      })
      cursor = page.nextCursor
    } while (cursor)
    return replyNow(turnId, 'Library labeling complete')
  }
  const first = text.split('\n')[0]
  if (first.startsWith('turn-block')) {
    for (let index = 0; index < 3; index++) {
      const reasoning = { id: `work-thought-${index}`, type: 'reasoning', summary: [`Inspecting references and preparing option ${index + 1}.`], content: [] }
      notify('item/started', { threadId: thread, turnId, item: { ...reasoning, summary: [] } })
      notify('item/completed', { threadId: thread, turnId, item: reasoning })
      notify('turn/plan/updated', { threadId: thread, turnId, plan: [{ step: 'Read project references', status: 'completed' }, { step: 'Prepare visual options', status: 'inProgress' }] })
      await new Promise(resolve => later(600, resolve))
      for (let toolIndex = 0; toolIndex < 4; toolIndex++) {
        const tool = { id: `work-tool-${index}-${toolIndex}`, type: 'mcpToolCall', server: 'vis', tool: 'canvas_get', arguments: {}, status: 'inProgress' }
        notify('item/started', { threadId: thread, turnId, item: tool })
        notify('item/completed', { threadId: thread, turnId, item: { ...tool, status: index === 1 && toolIndex === 2 ? 'failed' : 'completed', result: { content: [{ type: 'text', text: index === 1 && toolIndex === 2 ? 'Mock tool failure' : 'References read' }] } } })
      }
    }
    if (first === 'turn-block-running') return
    const tool = { id: 'work-generation', type: 'mcpToolCall', server: 'vis', tool: 'gen_submit', arguments: { kind: 'image' }, status: 'inProgress' }
    notify('item/started', { threadId: thread, turnId, item: tool })
    const submitted = await workTool('gen_submit', { kind: 'image', prompt: 'RFC 0032 result' })
    notify('item/completed', { threadId: thread, turnId, item: { ...tool, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(submitted) }] } } })
    const after = { id: 'after-result', type: 'reasoning', summary: ['Checking the generated result before replying.'], content: [] }
    notify('item/completed', { threadId: thread, turnId, item: after })
    later(5000, () => replyNow(turnId, 'Options are ready for your review.'))
    return
  }
  if (text.includes('watchdog-hold') || text.includes('watchdog-recover') || text.includes('watchdog-hung')) {
    ignoreInterrupt = text.includes('watchdog-hung')
    if (ignoreInterrupt) process.on('SIGTERM', () => {})
    notify('item/completed', { threadId: thread, turnId, item: { id: 'watchdog-thought', type: 'reasoning', summary: ['Preparing visual options.'], content: [] } })
    const pulse = setInterval(() => {
      if (text.includes('watchdog-recover') && existsSync(join(process.cwd(), '.vis-watchdog-resume'))) {
        notify('item/agentMessage/delta', { turnId, itemId: 'watchdog-recovered', delta: 'Working. ' })
      }
    }, 100)
    process.once('exit', () => clearInterval(pulse))
    return
  }
  if (first === 'turn-hold' || first === 'turn-standalone' || first.startsWith('turn-batch ')) {
    const reasoning = { id: 'held-thought', type: 'reasoning', summary: ['Preparing the next option.'], content: [] }
    notify('item/completed', { threadId: thread, turnId, item: reasoning })
    if (first === 'turn-standalone' || first.startsWith('turn-batch ')) {
      const name = first === 'turn-standalone' ? 'gen_submit' : 'script_batch_start'
      const args = first === 'turn-standalone' ? { kind: 'image', prompt: 'RFC 0032 held generation' } : { scriptNodeId: first.split(' ')[1], media: 'frames' }
      const tool = { id: 'held-generation', type: 'mcpToolCall', server: 'vis', tool: name, arguments: args, status: 'inProgress' }
      notify('item/started', { threadId: thread, turnId, item: tool })
      const result = await workTool(name, args)
      notify('item/completed', { threadId: thread, turnId, item: { ...tool, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } })
    }
    return
  }
  if (text.includes('child-working-report')) {
    const created = await workTool('canvas_apply', { ops: [
      { op: 'node.create', tempId: 'review', kind: 'text', title: 'Child review notes', content: { text: 'These notes are ready for the parent to review.' }, purpose: 'artifact' },
      { op: 'node.create', tempId: 'code', kind: 'text', format: 'code', title: 'Child animation', content: { text: '<!doctype html><body style="margin:0;background:teal"><script>window.vis={duration:1,seek(){}}</script>' }, generation: { provider: 'render', model: 'html', params: { width: 64, height: 64, fps: 1, durationMs: 1000 } } },
    ] })
    await workTool('work_report', { kind: 'done', body: 'Review notes and animation source are ready.' })
    return replyNow(turnId, `Reported working documents ${created.idMap.review} ${created.idMap.code}`)
  }
  if (first === 'session-results' || first === 'session-audio') {
    let toolIndex = 0
    const tool = async (name, args) => {
      const item = { id: `result-${++toolIndex}`, type: 'mcpToolCall', server: 'vis', tool: name, arguments: args, status: 'inProgress' }
      notify('item/started', { threadId: thread, turnId, item })
      const result = await workTool(name, args)
      notify('item/completed', { threadId: thread, turnId, item: { ...item, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } })
      return result
    }
    for (const [index, kind] of (first === 'session-audio' ? ['audio'] : ['image', 'video', 'image']).entries()) {
      const submitted = await tool('gen_submit', { kind, prompt: index === 2 ? 'session-results-fail' : `Session ${kind} result` })
      let job = await tool('gen_get', { jobId: submitted.jobId, waitMs: 30000 })
      while (['queued', 'running', 'finalizing'].includes(job.status)) job = await tool('gen_get', { jobId: submitted.jobId, waitMs: 30000 })
    }
    return replyNow(turnId, 'Results ready. ![Remote reference](https://session-results.invalid/tracker.png) ![](https://session-results.invalid/no-alt.png) ![Local file](file:///private/reference.png)')
  }
  // RFC 0027 B2: deterministic merge proposals, pinned to the caller's merge run.
  const libraryMerge = text.match(/library-settings-(merge|gallery)\s+(\S+)/)
  if (libraryMerge) {
    const { items } = await workTool('asset_list', { limit: 200 })
    const images = items.filter(item => item.kind === 'image').slice(0, 3)
    const audio = items.find(item => item.kind === 'audio')
    if (images.length !== 3 || !audio) throw new Error('The settings merge fixture needs three images and one audio asset')
    if (libraryMerge[1] === 'gallery') {
      const { items: settings } = await workTool('entity_list')
      const target = settings.find(item => item.name === 'Mira')
      if (!target) throw new Error('The settings gallery fixture needs Mira')
      await workTool('entity_propose', { runId: libraryMerge[2], proposals: [{
        entityId: target.id, kind: 'character', name: 'Mira', reason: 'These portraits show the same silver scarf and matching face.',
        members: images.slice(0, 2).map(item => ({ assetId: item.assetId, role: 'image' })), refs: [images[0].latest.assetVersionId],
      }, {
        kind: 'prop', name: 'Travel kit', description: 'The bag and its recorded signature sound',
        reason: 'The travel bag reference and recorded clasp belong together.',
        members: [{ assetId: images[2].assetId, role: 'image' }, { assetId: audio.assetId, role: 'voice' }], refs: [images[2].latest.assetVersionId],
      }] })
      return replyNow(turnId, 'Completed settings gallery proposals')
    }
    await workTool('entity_propose', { runId: libraryMerge[2], proposals: [{
      kind: 'character', name: 'Library Hero', description: 'A traveler in a blue coat', reason: 'Matching costume and voice',
      members: [...images.map(item => ({ assetId: item.assetId, role: 'image' })), { assetId: audio.assetId, role: 'voice' }],
      refs: [images[0].latest.assetVersionId],
    }] })
    return replyNow(turnId, 'Completed settings merge proposal')
  }
  const work = text.match(/^工作代理检查：(.*)$/m)
  if (work) return workScenario(turnId, text, JSON.parse(work[1]))
  const script = text.match(/\b(script-breakdown|script-prompts|script-batch)\b(?:\s+(node_[A-Za-z0-9]+))?/)
  if (script) return scriptScenario(turnId, script[1], script[2], text.includes('script-hold'))
  if (text.includes('transparent-overlay')) {
    let index = 0
    const tool = async (name, args = {}) => {
      const item = { id: `overlay-${++index}`, type: 'mcpToolCall', server: 'vis', tool: name, arguments: args, status: 'inProgress' }
      notify('item/started', { threadId: thread, turnId, item })
      const result = await workTool(name, args)
      notify('item/completed', { threadId: thread, turnId, item: { ...item, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } })
      return result
    }
    const { nodes } = await tool('canvas_get')
    const video = nodes.find(node => node.kind === 'video' && node.slots.some(slot => slot.content.mime === 'video/webm'))
    const timeline = nodes.find(node => node.kind === 'timeline')
    const source = video.slots.find(slot => slot.slotKey === 'main')
    const slot = timeline.slots.find(slot => slot.slotKey === 'main')
    const doc = slot.content.doc
    doc.tracks.splice(1, 0, { id: 'alpha-overlay', kind: 'overlay', name: 'Data card', muted: true, volume: 1, clips: [{ id: 'alpha-card', source: { nodeId: video.nodeId, assetVersionId: source.content.assetVersionId }, startMs: 0, inMs: 0, outMs: 3000, volume: 0, fadeInMs: 0, fadeOutMs: 0, overlay: { x: 0.5, y: 0.5, width: 1, opacity: 1 } }] })
    const edited = await tool('canvas_apply', { ops: [{ op: 'timeline.set', slotId: slot.slotId, expectedRevision: slot.revision, doc }] })
    let task = await tool('media_process', { operation: 'timeline.export', params: {}, nodeId: timeline.nodeId, slotId: slot.slotId, expectedRevision: edited.slotRevisions[slot.slotId] })
    while (['queued', 'running'].includes(task.status)) task = await tool('media_get', { taskId: task.taskId, waitMs: 30000 })
    if (task.status !== 'succeeded') throw new Error(`Transparent overlay export failed: ${task.error?.code ?? task.status}`)
    return replyNow(turnId, 'The transparent data card is over the blue video and the export is ready.')
  }
  if (text.includes('transparent-render')) {
    let toolIndex = 0
    const tool = async (name, args = {}) => {
      const item = { id: `alpha-${++toolIndex}`, type: 'mcpToolCall', server: 'vis', tool: name, arguments: args, status: 'inProgress' }
      notify('item/started', { threadId: thread, turnId, item })
      const result = await workTool(name, args)
      notify('item/completed', { threadId: thread, turnId, item: { ...item, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } })
      return result
    }
    await tool('guide', { topic: 'code-render' })
    const html = '<body style="margin:0"><div style="position:absolute;left:80px;top:40px;width:160px;height:100px;background:tomato"></div><script>window.vis={duration:1,seek(){}}</script>'
    const created = await tool('canvas_apply', { ops: [{ op: 'node.create', tempId: 'code', kind: 'text', format: 'code', title: 'Transparent source', x: -600, y: 0, content: { text: html } }] })
    const source = (await tool('canvas_get', { nodeIds: [created.idMap.code] })).nodes[0].slots.find(slot => slot.slotKey === 'main')
    const submitted = await tool('gen_submit', { kind: 'video', provider: 'render', model: 'html', prompt: 'Transparent data card', inputs: [{ slotId: source.slotId, revision: source.revision }], params: { width: 320, height: 180, fps: 4, transparent: true } })
    let job = await tool('gen_get', { jobId: submitted.jobId, waitMs: 30000 })
    while (['queued', 'running', 'finalizing'].includes(job.status)) job = await tool('gen_get', { jobId: submitted.jobId, waitMs: 30000 })
    if (job.status !== 'succeeded') throw new Error(`Transparent render failed: ${JSON.stringify(job.error)}`)
    await tool('canvas_apply', { ops: [{ op: 'node.setMeta', nodeId: job.outputs[0].delivery.nodeId, title: 'Transparent card' }] })
    return replyNow(turnId, 'Completed transparent-render')
  }
  const blockout = text.match(/\bpreviz-blockout\b/)
  if (blockout) {
    await workTool('guide', { topic: 'previz' })
    const { nodes } = await workTool('canvas_get')
    const node = nodes.find(node => node.kind === 'previz')
    if (!node) throw new Error('The blockout scenario needs a previz node')
    const slot = node.slots.find(slot => slot.slotKey === 'main')
    const panels = slot.content.doc.panels
    if (panels.some(panel => panel.durationSec === null)) throw new Error('The blockout scenario needs every panel duration')
    const duration = panels.reduce((sum, panel) => sum + panel.durationSec, 0)
    const html = readFileSync(new URL('../../../packages/generation/src/providers/render/fixtures/blockout.html', import.meta.url), 'utf8').replace('duration: 1,', `duration: ${duration},`)
    const created = await workTool('canvas_apply', { ops: [{ op: 'node.create', tempId: 'code', kind: 'text', format: 'code', title: 'Blockout source', content: { text: html } }] })
    const codeId = created.idMap.code
    const source = (await workTool('canvas_get', { nodeIds: [codeId] })).nodes[0].slots.find(slot => slot.slotKey === 'main')
    const submitted = await workTool('gen_submit', { kind: 'video', provider: 'render', model: 'html', prompt: 'Free shot blockout',
      inputs: [{ slotId: source.slotId, revision: source.revision }, ...panels.map(panel => ({ assetVersionId: panel.image }))],
      params: { width: 320, height: 180, fps: 24, durationMs: Math.round(duration * 1000) }, targets: [{ outputIndex: 0, kind: 'new_node', nearNodeId: node.nodeId }] })
    let job = await workTool('gen_get', { jobId: submitted.jobId, waitMs: 30000 })
    while (['queued', 'running', 'finalizing'].includes(job.status)) job = await workTool('gen_get', { jobId: submitted.jobId, waitMs: 30000 })
    if (job.status !== 'succeeded') throw new Error(`Blockout render failed: ${JSON.stringify(job.error)}`)
    const output = job.outputs[0]
    const ops = [{ op: 'node.setInputs', nodeId: output.delivery.nodeId, inputNodeIds: [codeId, node.nodeId] }]
    await workTool('canvas_apply', { ops })
    return replyNow(turnId, `Completed ${blockout[0]}`)
  }
  const previz = text.match(/\b(previz-edit|previz-refuse)\b/)
  if (previz) {
    const { nodes } = await workTool('canvas_get')
    const node = nodes.find(node => node.kind === 'previz')
    if (!node) throw new Error('The previz scenario needs a previz node')
    const slot = node.slots.find(slot => slot.slotKey === 'main')
    const doc = structuredClone(slot.content.doc)
    if (previz[1] === 'previz-edit') {
      doc.rev++
      doc.panels[0].note = 'Agent camera note'
      doc.panels[0].rev++
      await workTool('canvas_apply', { ops: [{ op: 'previz.set', slotId: slot.slotId, expectedRevision: slot.revision, doc }] })
    } else {
      doc.panels[0].image = null
      try {
        await workTool('canvas_apply', { ops: [{ op: 'previz.set', slotId: slot.slotId, expectedRevision: slot.revision, doc }] })
        throw new Error('The gateway allowed a protected drawing write')
      } catch (error) {
        if (!error.message.includes('previz.drawing_protected')) throw error
      }
    }
    return replyNow(turnId, `Completed ${previz[1]}`)
  }
  const timeline = text.match(/\b(timeline-roughcut|timeline-edit)\b/)
  if (timeline) return timelineScenario(turnId, timeline[1])
  if (first.startsWith('活动检查')) {
    const reasoning = { id: 'thought', type: 'reasoning', summary: [], content: [] }
    notify('item/started', { threadId: thread, turnId, item: reasoning })
    notify('item/reasoning/summaryTextDelta', { threadId: thread, turnId, itemId: 'thought', summaryIndex: 0, delta: '先检查画布。\n' })
    later(700, () => notify('item/reasoning/summaryTextDelta', { threadId: thread, turnId, itemId: 'thought', summaryIndex: 0, delta: '再整理分镜。\n最后核对素材。' }))
    later(3500, () => {
      notify('item/completed', { threadId: thread, turnId, item: { ...reasoning, summary: ['先检查画布。\n再整理分镜。\n最后核对素材。'] } })
      notify('turn/plan/updated', { threadId: thread, turnId, explanation: '按顺序检查并整理', plan: [{ step: '读取画布', status: 'inProgress' }, { step: '整理分镜', status: 'pending' }] })
    })
    const tool = { id: 'activity-tool', type: 'mcpToolCall', server: 'vis', tool: 'canvas_get', arguments: {}, status: 'inProgress' }
    later(6000, () => {
      notify('turn/plan/updated', { threadId: thread, turnId, plan: [{ step: '读取画布', status: 'completed' }, { step: '整理分镜', status: 'inProgress' }] })
      notify('item/started', { threadId: thread, turnId, item: tool })
    })
    later(8500, () => {
      notify('item/completed', { threadId: thread, turnId, item: { ...tool, status: 'completed', result: { content: [{ type: 'text', text: '画布已读取' }] } } })
      notify('turn/plan/updated', { threadId: thread, turnId, plan: [{ step: '读取画布', status: 'completed' }, { step: '整理分镜', status: 'completed' }] })
      replyNow(turnId, '活动检查完成')
    })
    return
  }
  if (first.startsWith('审批检查')) {
    const id = `approval-${turnId}`
    const decision = await new Promise(resolve => {
      approvals.set(id, resolve)
      send({ id, method: 'item/commandExecution/requestApproval', params: {
        threadId: thread, turnId, itemId: `command-${turnId}`,
        command: 'mkdir -p exports && touch exports/storyboard.txt', cwd: process.cwd(),
        reason: '为分镜稿创建导出目录和文件',
      } })
    })
    replyNow(turnId, ['accept', 'acceptForSession'].includes(decision) ? '已获准' : '已拒绝')
    return
  }
  const gen = first.match(/^生成 (.+)$/)
  if (gen) {
    // For arrays, submit each item sequentially in the same turn
    const list = [JSON.parse(gen[1])].flat()
    const cli = agentMcp.args[0]
    const ids = []
    const next = () => {
      if (ids.length === list.length) return replyNow(turnId, `已提交 ${ids.join(' ')}`)
      execFile(agentMcp.command, [cli, 'gen', 'submit', '--params', JSON.stringify(list[ids.length])], { env: { ...process.env, ...agentEnv } }, (error, stdout) => {
        if (error) return replyNow(turnId, `提交失败：${stdout || error.message}`)
        ids.push(JSON.parse(stdout).jobId)
        next()
      })
    }
    next()
    return
  }
  if (first.startsWith('命名检查：')) {
    const item = { id: 'title', type: 'mcpToolCall', server: 'vis', tool: 'session_set_title', arguments: { title: first.slice('命名检查：'.length) }, status: 'inProgress' }
    notify('item/started', { threadId: thread, turnId, item })
    try {
      const result = await new Promise((resolve, reject) => {
        const child = execFile(agentMcp.command, agentMcp.args, { env: { ...process.env, ...agentEnv } }, (error, stdout) => {
          if (error) return reject(error)
          try {
            const response = stdout.trim().split('\n').map(line => JSON.parse(line)).find(message => message.id === 1)
            if (!response?.result) throw new Error(response?.error?.message ?? 'MCP did not return a tool result')
            resolve(response.result)
          } catch (error) { reject(error) }
        })
        child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: item.tool, arguments: item.arguments } })}\n`)
      })
      notify('item/completed', { threadId: thread, turnId, item: { ...item, status: result.isError ? 'failed' : 'completed', result } })
    } catch (error) {
      notify('item/completed', { threadId: thread, turnId, item: { ...item, status: 'failed', error: { message: error.message } } })
    }
  }
  if (first.startsWith('工具检查')) {
    for (const [i, tool] of ['canvas_get', 'slot_history'].entries()) {
      const item = { id: `tool${i}`, type: 'mcpToolCall', server: 'vis', tool, arguments: i ? { slotId: 'reference-main' } : { snapshot: 'turn' }, status: 'inProgress' }
      notify('item/started', { threadId: thread, turnId, item })
      notify('item/completed', { threadId: thread, turnId, item: { ...item, status: 'completed', result: { content: [{ type: 'text', text: i ? '参考版本已读取' : '参考素材已就绪' }] } } })
    }
  }
  const refs = (text.match(/- Node /g) ?? []).length
  const reply = first.includes('慢') ? '慢慢想'.repeat(200) : `收到：${first}${refs ? `（引用 ${refs} 个节点）` : ''}`
  const item = { id: 'm0', type: 'agentMessage', text: '' }
  notify('item/started', { threadId: thread, turnId, item })
  const chunks = reply.match(/.{1,3}/gsu) ?? []
  chunks.forEach((delta, i) => later(40 * (i + 1), () => notify('item/agentMessage/delta', { threadId: thread, turnId, itemId: 'm0', delta })))
  // Allow time to render streaming drafts so parallel tests do not combine fragments and the terminal state in one render
  later(40 * (chunks.length + 2) + 600, () => {
    notify('item/completed', { threadId: thread, turnId, item: { ...item, text: reply } })
    notify('turn/completed', { threadId: thread, turn: { id: turnId, status: 'completed' } })
  })
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
    const msg = JSON.parse(buffer.slice(0, nl))
    buffer = buffer.slice(nl + 1)
    if (!msg.method && approvals.has(msg.id)) {
      approvals.get(msg.id)(msg.result?.decision ?? msg.result?.action)
      approvals.delete(msg.id)
      continue
    }
    if (msg.id === undefined || !msg.method) continue
    if (['thread/start', 'thread/resume', 'turn/start'].includes(msg.method)) {
      appendFileSync(join(process.cwd(), '.vis-e2e-agent.jsonl'), `${JSON.stringify({ method: msg.method, cwd: process.cwd(), threadCwd: msg.params.cwd, prompt: msg.params.input?.[0]?.text, developerInstructions: msg.params.developerInstructions, model: msg.params.model, effort: msg.params.effort, serviceTierForTurn: msg.params.serviceTierForTurn })}\n`)
    }
    switch (msg.method) {
      case 'initialize': send({ id: msg.id, result: { userAgent: 'fake-codex/0' } }); break
      case 'model/list':
        send({ id: msg.id, result: { data: [
          { id: 'gpt-test', displayName: 'GPT Test', description: '完整思考强度', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '快速' }, { reasoningEffort: 'high', description: '深入' }], defaultReasoningEffort: 'high', isDefault: true, hidden: false, serviceTiers: [{ id: 'fast', name: 'Fast', description: '更快，消耗更多额度' }] },
          { id: 'gpt-fast', displayName: 'GPT Fast', description: '快速模型', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '快速' }], defaultReasoningEffort: 'low', isDefault: false, hidden: false },
          { id: 'gpt-hidden', displayName: 'Hidden', description: '不可选', supportedReasoningEfforts: [], defaultReasoningEffort: 'low', isDefault: false, hidden: true },
        ], nextCursor: null } }); break
      case 'thread/start':
      case 'thread/resume':
        agentMcp = Object.values(msg.params.config?.mcp_servers ?? {})[0]
        agentEnv = agentMcp?.env ?? {}
        if (msg.method === 'thread/resume') thread = msg.params.threadId
        send({ id: msg.id, result: { thread: { id: thread } } }); break
      case 'turn/start': {
        // Each turn may use a new process: include the process ID in turnId to avoid entry ID collisions with the previous turn
        const turnId = `t${process.pid}-${++turnSeq}`
        send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } })
        runTurn(turnId, msg.params.input?.[0]?.text ?? '').catch(error => replyNow(turnId, `工作代理失败：${error.message}`))
        break
      }
      case 'turn/interrupt':
        if (ignoreInterrupt) break
        for (const t of timers) clearTimeout(t)
        timers.clear()
        send({ id: msg.id, result: {} })
        notify('turn/completed', { threadId: thread, turn: { id: msg.params.turnId, status: 'interrupted' } })
        break
      default: send({ id: msg.id, result: {} })
    }
  }
})
process.stdin.on('end', () => { if (!ignoreInterrupt) process.exit(0) })
