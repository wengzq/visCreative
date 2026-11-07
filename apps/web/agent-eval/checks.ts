import { ScriptDoc, ScriptDocInput, TimelineDoc, clipDurationMs, clipEndMs, toolNameOf, type AssetVersionView, type EntityView, type NodeView, type SpaceEvent, type TextProposal, type TranscriptItem, type WorkMessageView, type BatchView, type JobView, type WorkItemView, type MethodResult } from '@vis/protocol'
import { mainSlot, previzDoc, scriptDoc, timelineDoc, type EpisodeSnapshot } from './fixtures'
import { manuscriptCheck } from './manuscript-checks'
import { authorCheck } from './author-checks'
import { scanFinalReplies } from './reply-checks'

export type Check = { id: string; result: 'pass' | 'fail' | 'review'; detail: string }
export type ToolCall = { name: string; input: any; seq: number; turnId: string | null; toolUseId: string; hasResult: boolean; error: boolean; output: string; expectedRefusal?: string }
export type Evidence = {
  before: NodeView[]
  after: NodeView[]
  transcript: TranscriptItem[]
  events: SpaceEvent[]
  batches: BatchView[]
  jobs: JobView[]
  assets?: AssetVersionView[]
  approvals: any[]
  workMessages: WorkMessageView[]
  fixtureVars: Record<string, string>
  workDir: string
  prompts?: string[]
  ended: boolean
  proposals?: TextProposal[]
  entities?: { before: EntityView[]; after: EntityView[] }
  turnSnapshots?: { turnId: string; nodes: NodeView[] }[]
  parentTranscript?: TranscriptItem[]
  workInbox?: MethodResult<'work.inbox'>
  workItems?: { before: WorkItemView[]; after: WorkItemView[] }
  skills?: { before: MethodResult<'skill.libraryList'>; after: MethodResult<'skill.libraryList'> }
  earlierEpisode?: { before: EpisodeSnapshot; after: EpisodeSnapshot }
}

const aliases: Record<string, string> = {
  generation_submit: 'gen_submit', guide: 'guide_get',
  [toolNameOf('series.textList')]: 'series_textList',
  [toolNameOf('series.textRead')]: 'series_textRead',
  [toolNameOf('text.requestDelete')]: 'text_requestDelete',
  [toolNameOf('work.requestDelete')]: 'work_requestDelete',
  [toolNameOf('skill.proposeDraft')]: 'skill_proposeDraft',
}

export function toolName(name: string): string {
  const normalized = name.replace(/^mcp__vis__|^vis\./, '').replace(/\./g, '_')
  return aliases[normalized] ?? normalized
}

export function extract(transcript: TranscriptItem[]) {
  const ordered = [...transcript].sort((a, b) => a.createdSeq - b.createdSeq)
  const calls: ToolCall[] = ordered.filter(item => item.kind === 'tool_call').map(item => {
    const payload = item.payload as any
    const result = ordered.find(other => other.kind === 'tool_result' && other.turnId === item.turnId && (other.payload as any)?.toolUseId === payload?.toolUseId)?.payload as any
    return { name: toolName(String(payload?.name ?? 'unknown')), input: payload?.input ?? {}, seq: item.createdSeq, turnId: item.turnId, toolUseId: payload?.toolUseId, hasResult: !!result, error: result?.isError === true, output: String(result?.text ?? '') }
  })
  const finalReply = (ordered.filter(item => item.kind === 'assistant_text').at(-1)?.payload as any)?.text ?? ''
  for (const call of calls) {
    if (call.name === 'skill_proposeDraft' && call.error && call.output.includes('skill.draft_frontmatter') && /^\uFEFF?---\r?\n/.test(call.input.body ?? '') && calls.some(retry => retry.seq > call.seq && retry.turnId === call.turnId && retry.name === call.name && retry.hasResult && !retry.error && retry.input.name === call.input.name && retry.input.description === call.input.description && typeof retry.input.body === 'string' && retry.input.body.trim() && !/^\uFEFF?---\r?\n/.test(retry.input.body))) call.expectedRefusal = 'skill.draft_frontmatter'
  }
  return {
    calls, errors: calls.filter(call => call.error && !call.expectedRefusal), expectedRefusals: calls.filter(call => call.expectedRefusal), guideCalls: calls.filter(call => call.name === 'guide_get'),
    toolCounts: Object.fromEntries([...new Set(calls.map(call => call.name))].map(name => [name, calls.filter(call => call.name === name).length])),
    invalidOps: calls.filter(call => call.name === 'canvas_apply' && call.error && call.output.includes('invalid_params')),
    turns: new Set(ordered.map(item => item.turnId).filter(Boolean)).size, finalReply,
    inputTokens: null,
    limitations: ['The product transcript truncates tool results at 4000 characters and does not expose token usage. Some native web/subagent/file tools may not be translated by the current adapter; absence in the transcript needs review.'],
  }
}

export function runChecks(ids: string[], e: Evidence): Check[] {
  const extracted = extract(e.transcript)
  const calls = extracted.calls
  const called = (name: string) => calls.filter(call => call.name === name)
  const successful = (name: string) => called(name).filter(call => !call.error && call.output)
  const newNodes = e.after.filter(node => !e.before.some(old => old.nodeId === node.nodeId))
  const ops = calls.filter(call => call.name === 'canvas_apply').flatMap(call => (Array.isArray(call.input?.ops) ? call.input.ops : []).filter((op: unknown) => op && typeof op === 'object').map((op: any) => ({ ...op, call })))
  const script = scriptDoc(e.after.find(node => node.nodeId === e.fixtureVars.scriptNodeId) ?? newNodes.find(node => node.kind === 'script'))
  const oldScript = scriptDoc(e.before.find(node => node.nodeId === e.fixtureVars.scriptNodeId))
  const timeline = timelineDoc(e.after.find(node => node.nodeId === e.fixtureVars.timelineNodeId) ?? newNodes.find(node => node.kind === 'timeline'))
  const timelineNode = e.after.find(node => node.nodeId === e.fixtureVars.timelineNodeId) ?? newNodes.find(node => node.kind === 'timeline')
  const oldTimeline = timelineDoc(e.before.find(node => node.nodeId === e.fixtureVars.timelineNodeId))
  const fixtureVideos = (e.fixtureVars.videoNodeIds ?? '').split(', ').filter(Boolean)
  const fixtureVideoOrder = timeline?.tracks.find(track => track.kind === 'video')?.clips.map(clip => clip.source.nodeId)
  const text = newNodes.filter(node => node.kind === 'text').flatMap(node => node.slots.filter(slot => slot.content.type === 'text').map(slot => slot.content.type === 'text' ? slot.content.body : '')).join('\n')
  const check = (id: string, ok: boolean, detail: string): Check => ({ id, result: ok ? 'pass' : 'fail', detail })
  const review = (id: string, detail: string): Check => ({ id, result: 'review', detail })
  const parsed = (call: ToolCall): any => { try { return JSON.parse(call.output) } catch { return undefined } }
  const previzNode = e.after.find(node => node.nodeId === e.fixtureVars.previzNodeId)
  const oldPrevizNode = e.before.find(node => node.nodeId === e.fixtureVars.previzNodeId)
  const previz = previzDoc(previzNode), oldPreviz = previzDoc(oldPrevizNode)
  const renderCalls = successful('gen_submit').filter(call => call.input.provider === 'render' && call.input.model === 'html')
  const renders = renderCalls.flatMap(call => e.jobs.filter(job => job.jobId === parsed(call)?.jobId && job.status === 'succeeded').map(job => ({ call, job })))
  const renderOutputs = renders.flatMap(({ call, job }) => job.outputs.map(output => ({ call, output,
    node: e.after.find(node => node.nodeId === output.delivery.nodeId),
    asset: e.assets?.find(asset => asset.assetVersionId === output.assetVersionId),
  })))
  const source = (call: ToolCall) => {
    const input = call.input.inputs?.[0]
    return e.after.flatMap(node => node.slots.map(slot => ({ node, slot }))).find(({ slot }) => slot.slotId === input?.slotId && slot.revision === input.revision && slot.content.type === 'text')
  }
  const noGeneration = () => called('gen_submit').length === 0 && called('script_batch_start').length === 0 && e.jobs.length === 0 && e.batches.length === 0
  const previzWrites = ops.filter(op => op.op === 'previz.set' && op.slotId === oldPrevizNode?.slots.find(slot => slot.slotKey === 'main')?.slotId)
  const successfulWrites = previzWrites.filter(op => !op.call.error && op.call.output)
  const lastToolSeq = Math.max(0, ...e.transcript.filter(item => item.kind === 'tool_call' || item.kind === 'tool_result').map(item => item.createdSeq))
  const closingText = e.transcript.filter(item => item.kind === 'assistant_text' && item.createdSeq > lastToolSeq).map(item => (item.payload as any)?.text ?? '').join('\n')
  return ids.map(id => {
    if (/^(directions_|child_|cleanup_|skill_)/.test(id)) return authorCheck(id, e, calls)
    if (id.startsWith('writing_')) return manuscriptCheck(id, e, calls)
    switch (id) {
      case 'final_reply_internals': {
        const matches = scanFinalReplies(e.transcript, e.prompts ?? [])
        return matches.length ? review(id, JSON.stringify(matches)) : check(id, true, 'No method names, error codes, internal guide names or unrequested local paths found in the closing replies of any turn')
      }
      case 'transparent_render': return check(id, renders.length > 0 && renders.every(({ call }) => call.input.params?.transparent === true) && renderOutputs.length > 0 && renderOutputs.every(({ output, node, asset }) => output.delivery.status === 'delivered' && node?.kind === 'video' && asset?.hasAlpha === true && asset.mime === 'video/webm' && node.slots.some(slot => slot.content.type === 'asset' && slot.content.assetVersionId === asset.assetVersionId)), 'Completed render submissions use transparent: true and deliver canvas video assets measured as hasAlpha: true and video/webm')
      case 'no_shell_chrome': {
        const launches = calls.filter(call => /shell|bash|exec|command/i.test(call.name) && /(?:chrome|chromium)[\s\S]*(?:--headless|--remote-debugging|--no-sandbox)|(?:spawn|execFile|Popen|launch|open\s+-a)[\s\S]*(?:chrome|chromium)|(?:^|[\s"';&|/])(?:google-chrome|chromium|chrome)(?:[\s"']|$)|Chrome\.app\/Contents\/MacOS\/Google Chrome/i.test(JSON.stringify(call.input)))
        return check(id, launches.length === 0, `Observed shell Chrome launch attempts: ${JSON.stringify(launches.map(call => ({ seq: call.seq, input: call.input })))}; native tool omissions still require review`)
      }
      case 'transparent_overlay': {
        const asset = e.assets?.find(asset => asset.assetVersionId === e.fixtureVars.transparentAssetVersionId)
        const placements = timeline?.tracks.flatMap(track => track.clips.filter(clip => clip.source.nodeId === e.fixtureVars.transparentVideoNodeId || clip.source.assetVersionId === e.fixtureVars.transparentAssetVersionId).map(clip => ({ track, clip }))) ?? []
        return check(id, TimelineDoc.safeParse(timeline).success && asset?.hasAlpha === true && asset.mime === 'video/webm' && placements.length === 1 && placements.every(({ track, clip }) => track.kind === 'overlay' && !track.hidden && !!clip.overlay && (clip.overlay.opacity ?? 1) > 0 && clipDurationMs(clip) > 0), 'The measured transparent WebM occurs exactly once on a visible overlay track, with visible nonempty placement, never on the main track')
      }
      case 'transparent_timeline_preserved': return check(id, !!oldTimeline && !!timeline && JSON.stringify(timeline.tracks.filter(track => track.kind !== 'overlay')) === JSON.stringify(oldTimeline.tracks.filter(track => track.kind !== 'overlay')) && JSON.stringify(timeline.textTracks) === JSON.stringify(oldTimeline.textTracks), 'Original main media tracks and text tracks remain unchanged')
      case 'transparent_export': {
        const exports = newNodes.filter(node => !!timelineNode && node.exportOf?.timelineNodeId === timelineNode.nodeId && node.exportOf?.timelineRevision === mainSlot(timelineNode).revision)
        return check(id, exports.length > 0 && exports.every(node => node.slots.some(slot => {
          const content = slot.content
          return content.type === 'asset' && e.assets?.some(asset => asset.assetVersionId === content.assetVersionId && asset.mime.startsWith('video/') && (asset.durationMs ?? 0) > 0)
        })), 'The current timeline revision has a delivered, probed video export with nonzero duration; alpha compositing and taste require visual review')
      }
      case 'transparent_quality': return review(id, 'Review rendered motion, data accuracy and readability; composite decoded libvpx-vp9 frames over a checkerboard to inspect actual transparency')
      case 'transparent_timeline_quality': return review(id, 'Review the timeline export for retained transparent corners and visible underlay, composition and timing; taste stays with the author')
      case 'previz_no_unrequested_extract': return check(id, called('previz_extractBlockout').length === 0, 'No previz.extractBlockout call was attempted without an explicit request to write panel blockouts')
      case 'previz_guide_read': return check(id, successful('guide_get').some(call => call.input.topic === 'previz'), 'Successful previz guide read observed')
      case 'previz_three_page': return check(id, renders.length > 0 && renders.every(({ call }) => {
        const content = source(call)?.slot.content
        return content?.type === 'text' && /(?:from\s*|import\s*\(?\s*)['"]\/lib\/three\.module\.js['"]/.test(content.body) && /new\s+(?:\w+\.)?WebGLRenderer\s*\(/.test(content.body)
      }), 'Every completed render used a retained source revision importing local three.js and constructing a WebGL renderer; scene quality requires review')
      case 'previz_duration': {
        const total = oldPreviz?.panels.reduce((sum, panel) => sum + (panel.durationSec ?? NaN), 0)
        return check(id, !!total && renderOutputs.length > 0 && renderOutputs.every(({ asset }) => !!asset?.durationMs && !!asset.fps && Math.abs(asset.durationMs - total * 1000) <= 1000 / asset.fps), `Measured video duration matches the original panel sum (${total ?? 'missing'}s) within one measured frame`)
      }
      case 'previz_fps': return check(id, renderOutputs.length > 0 && renderOutputs.every(({ asset }) => (asset?.fps ?? 0) >= 24), `Measured output frame rates: ${renderOutputs.map(({ asset }) => asset?.fps ?? 'missing').join(', ') || 'no output'}`)
      case 'previz_video_inputs': return check(id, !!previzNode && renderOutputs.length > 0 && renderOutputs.every(({ call, node }) => {
        const codeNode = source(call)?.node
        return !!node && !!codeNode && node.inputs?.includes(previzNode.nodeId) === true && node.inputs.includes(codeNode.nodeId) && ops.some(op => op.op === 'node.setInputs' && op.nodeId === node.nodeId && !op.call.error && op.call.output && op.inputNodeIds?.includes(previzNode.nodeId) && op.inputNodeIds.includes(codeNode.nodeId))
      }), 'Observed successful node.setInputs and persisted video inputs retain both previz and rendered code nodes')
      case 'previz_not_final_output': return check(id, renderOutputs.length > 0 && renderOutputs.every(({ node }) => !!node && (!node.shot || node.shot.role === 'previz')), 'Every completed blockout stays out of first, last and video shot outputs')
      case 'previz_frames_inspected': {
        const frames = [...successful('asset_frames'), ...successful('asset_extractFrames')].filter(call => renderOutputs.some(({ output }) => call.input.assetVersionId === output.assetVersionId))
        if (!frames.length) return check(id, false, 'No successful frame extraction from a completed blockout is exposed in the transcript; native activity may require review')
        const paths = frames.flatMap(call => parsed(call)?.frames ?? []).flatMap((frame: any) => [frame.path, frame.url, frame.assetVersionId].filter(Boolean))
        const viewed = calls.some(call => /view_image|image_view|open_image/.test(call.name) && !call.error && paths.some((path: string) => JSON.stringify(call.input).includes(path)))
        return viewed ? check(id, true, 'Extracted blockout frames were passed to an observed image-view tool; visual quality requires review') : review(id, 'Blockout frame extraction succeeded, but the Codex adapter omits native image-view items; verify inspection in the agent reply/native evidence')
      }
      case 'previz_question': return check(id, e.ended && /[?？]|请确认|请选择|是否|可以吗|要不要/.test(closingText), 'The single user turn ended with a question or explicit confirmation request after its last tool activity; wording and completeness require review')
      case 'previz_no_generation': return check(id, noGeneration(), 'No generation submit, batch start, generation job or batch exists before a second user message')
      case 'previz_no_duration_guess': {
        const missing = oldPreviz?.panels.filter(panel => panel.durationSec === null) ?? []
        const docs = [previz, ...successfulWrites.map(op => op.doc)]
        return check(id, missing.length === 2 && docs.every(doc => !!doc && missing.every(panel => doc.panels?.find((next: any) => next.id === panel.id)?.durationSec === null)), 'Both originally missing durations remain null in persisted and observed successful writes')
      }
      case 'previz_render_only': {
        const renderIds = new Set(renderCalls.map(call => parsed(call)?.jobId).filter(Boolean))
        return check(id, called('gen_submit').every(call => call.input.provider === 'render') && called('script_batch_start').length === 0 && e.batches.length === 0 && e.jobs.every(job => renderIds.has(job.jobId)), 'Every generation call uses render; all jobs map to render calls, with no Mock/paid job or batch')
      }
      case 'previz_links_await_confirmation': {
        const unlinked = oldPreviz?.panels.filter(panel => panel.shot === null) ?? []
        return check(id, unlinked.length > 0 && [previz, ...successfulWrites.map(op => op.doc)].every(doc => !!doc && unlinked.every(panel => doc.panels?.find((next: any) => next.id === panel.id)?.shot === null)), 'Unlinked panels remain unlinked before the user confirms; the order-based proposal requires review')
      }
      case 'previz_pictures_preserved': {
        const preserved = oldPreviz && oldPreviz.panels.length > 0 && [previz, ...successfulWrites.map(op => op.doc)].every(doc => !!doc && oldPreviz.panels.every(panel => {
          const next = doc.panels?.find((candidate: any) => candidate.id === panel.id)
          return next && ['underlay', 'sketch', 'image'].every(field => next[field] === panel[field as 'image'])
        }))
        const refused = previzWrites.filter(op => op.call.error).map(op => ({ seq: op.call.seq, error: op.call.output }))
        return check(id, !!preserved, `Every original panel and underlay/sketch/image is retained in final state and observed successful writes; refused writes: ${JSON.stringify(refused)}`)
      }
      case 'previz_extract_left_to_user': return check(id, !!oldPreviz?.panels.length && successful('previz_extractBlockout').length === 0 && oldPreviz.panels.every(panel => previz?.panels.find(candidate => candidate.id === panel.id)?.blockout === panel.blockout), 'No panel blockout changed; the frames are left to the user')
      case 'previz_blockout_quality': return review(id, 'Watch the MP4 and inspect frames for grey geometry, composition, blocking, continuity and camera movement against all four panel images and notes')
      case 'previz_duration_question_quality': return review(id, 'Verify one clarification message covers panels 2 and 4 together and does not silently infer their durations')
      case 'previz_generation_question_quality': return review(id, 'Verify one message asks before acting, gives defaults for missing choices and proposes linking panels 2 and 4 to shots 2 and 4 in reading order')
      case 'previz_improvement_quality': return review(id, 'Review whether the response helps improve the pictures while respecting protected drawings; inspect refused writes in extracted.json')
      case 'previz_extraction_handoff_quality': return review(id, 'Verify the reply tells the user, in plain words, to click Use blockout frames')
      case 'one_text': return check(id, newNodes.filter(node => node.kind === 'text' && node.purpose !== 'working').length === 1, 'Exactly one new artifact text node')
      case 'no_report_node': return review(id, 'Read new node content and final reply: the canvas should hold the requested ad, not a completion report')
      case 'own_web_tool': return calls.some(call => /web|browse|search/i.test(call.name) && !call.name.startsWith('vis_')) ? check(id, true, 'Native web/search activity observed; verify source use') : review(id, 'No native web tool exposed in transcript; inspect agent evidence before scoring')
      case 'sources': return check(id, new Set(text.match(/https?:\/\/[^\s)\]>]+/g) ?? []).size >= 2, 'At least two distinct source URLs in canvas text')
      case 'render_succeeded': {
        const render = called('gen_submit').filter(call => call.input.provider === 'render' && !call.error)
        const jobs = render.map(call => { try { return JSON.parse(call.output).jobId } catch { return undefined } }).filter(Boolean)
        return check(id, jobs.some(jobId => e.jobs.some(job => job.jobId === jobId && job.status === 'succeeded')), 'Successful render submission matched to a completed generation job')
      }
      case 'frames_checked': return check(id, successful('asset_frames').length + successful('asset_extractFrames').length > 0, 'Agent extracted output frames; visual correctness requires review')
      case 'local_command': return check(id, calls.some(call => /shell|bash|exec|command/i.test(call.name) && !call.error), 'A local command ran; inspect command and result')
      case 'asset_import': return check(id, successful('asset_import_file').length > 0, 'Local result imported via asset_import_file')
      case 'image_delivered': return check(id, newNodes.some(node => node.kind === 'image' && node.slots.some(slot => slot.content.type === 'asset')), 'A new image node contains an asset')
      case 'local_workdir': return review(id, `Verify commands and file writes stay inside ${e.workDir}; shell transcript omits cwd on some versions`)
      case 'subagents': return calls.some(call => /subagent|spawn_agent|task|workflow/i.test(call.name)) ? check(id, true, 'Delegation tool activity observed') : review(id, 'Delegation availability and activity need adapter/native log review')
      case 'character_delivery': return check(id, newNodes.some(node => node.kind === 'text' && node.purpose !== 'working'), 'Text delivery exists; five complete character sheets need review')
      case 'first_script_replace': {
        const first = ops.find(op => op.op === 'script.replace')
        return check(id, !!first && !first.call.error && !!first.call.output && ScriptDocInput.safeParse(first.doc).success && first.doc.shots.length >= 6, 'First script.replace succeeds with at least six shots')
      }
      case 'script_valid': return check(id, ScriptDoc.safeParse(script).success && (script?.shots.length ?? 0) >= 6, 'Persisted script doc is valid and holds at least six shots')
      case 'only_rows_2_4': {
        const unchanged = oldScript && script && oldScript.shots.length === script.shots.length && oldScript.shots.every((row, i) => [1, 3].includes(i)
          ? row.id === script.shots[i]?.id && row.rev < script.shots[i]!.rev && row.description !== script.shots[i]!.description && !!script.shots[i]!.framePrompt && row.framePrompt !== script.shots[i]!.framePrompt
          : JSON.stringify(row) === JSON.stringify(script.shots[i])) && JSON.stringify(oldScript.assets) === JSON.stringify(script.assets) && oldScript.rev === script.rev
        return check(id, !!unchanged, 'Only shots 2 and 4 changed (stable IDs, descriptions, frame prompts and revs); other rows, assets and doc rev unchanged')
      }
      case 'row_revisions': {
        const updates = ops.filter(op => op.op === 'script.patch' && !op.call.error && op.call.output && Array.isArray(op.ops)).flatMap(op => op.ops)
        return check(id, updates.length >= 2 && updates.every(op => op.kind === 'shot.update' && oldScript?.shots.some(row => row.id === op.shotId && row.rev === op.rev && [oldScript.shots[1]?.id, oldScript.shots[3]?.id].includes(row.id))), 'Shot updates carry original row revisions, only for shots 2 and 4')
      }
      case 'batch_plan_start': return check(id, successful('script_batch_plan').some(plan => successful('script_batch_start').some(start => {
        let output: any
        try { output = JSON.parse(start.output) } catch { return false }
        return start.seq > plan.seq && plan.input.scriptNodeId === e.fixtureVars.scriptNodeId && start.input.scriptNodeId === plan.input.scriptNodeId && plan.input.media === start.input.media && e.batches.some(batch => batch.batchId === output.batchId && batch.origin === 'agent' && batch.scriptNodeId === start.input.scriptNodeId)
      })), 'Successful plan precedes a matching start and persisted agent batch on the fixture script')
      case 'batch_wait': return check(id, e.approvals.some(approval => approval.kind === 'generation_batch' && approval.pendingObserved && approval.noSingleSubmits && approval.jobsBeforeApproval === 0 && approval.statusAtApproval === 'pending_approval'), 'Pending batch with no generation before approval was observed, then approved')
      case 'no_single_submits': {
        const batchJobs = new Set(e.batches.flatMap(batch => batch.shots.flatMap(shot => shot.steps.map(step => step.jobId).filter(Boolean))))
        return check(id, called('gen_submit').length === 0 && e.jobs.every(job => batchJobs.has(job.jobId)), 'No standalone generation calls or jobs outside the recorded batches')
      }
      case 'batch_completed': return check(id, e.batches.some(batch => batch.origin === 'agent' && batch.status === 'succeeded'), 'Agent batch completed successfully')
      case 'timeline_valid': return check(id, TimelineDoc.safeParse(timeline).success && fixtureVideos.length === 3 && JSON.stringify(fixtureVideoOrder) === JSON.stringify(fixtureVideos), 'Valid timeline contains exactly the three fixture videos in order')
      case 'captions_transitions': {
        const captions = timeline?.textTracks?.filter(track => !track.hidden).flatMap(track => track.clips) ?? []
        const video = timeline?.tracks.find(track => track.kind === 'video')
        const covered = video?.clips.every(clip => captions.some(caption => caption.text.trim() && caption.startMs >= clip.startMs && caption.startMs < clipEndMs(clip) && caption.startMs + caption.durationMs <= clipEndMs(clip)))
        return check(id, !!covered && video?.clips.length === 3 && video.clips.slice(1).every(clip => clip.transitionIn?.kind === 'crossfade' && clip.transitionIn.durationMs === 200), 'Each shot has a visible caption within its interval, with 200ms crossfades on every cut')
      }
      case 'export_succeeded': return check(id, !!timelineNode && newNodes.some(node => node.exportOf?.timelineNodeId === timelineNode.nodeId && node.exportOf?.timelineRevision === timelineNode.slots.find(slot => slot.slotKey === 'main')?.revision && node.slots.some(slot => slot.content.type === 'asset')), 'Export delivers an asset from the scored timeline and revision')
      case 'half_speed': return check(id, TimelineDoc.safeParse(timeline).success && timeline?.tracks.find(track => track.kind === 'video')?.clips[1]?.speed === 0.5, 'Valid timeline with second video clip at half speed')
      case 'caption_follow': {
        const oldClips = oldTimeline?.tracks.find(track => track.kind === 'video')?.clips
        const clips = timeline?.tracks.find(track => track.kind === 'video')?.clips
        const oldTexts = oldTimeline?.textTracks?.flatMap(track => track.clips)
        const texts = timeline?.textTracks?.flatMap(track => track.clips)
        const ok = oldClips && clips && oldTexts?.length === 3 && texts?.length === 3 && oldTexts.every((caption, i) => {
          const updated = texts.find(text => text.id === caption.id)
          return updated && updated.text === caption.text && clips[i]?.id === oldClips[i]?.id && updated.startMs === clips[i]!.startMs && updated.durationMs === clipDurationMs(clips[i]!)
        })
        return check(id, !!ok, 'All caption IDs/text retained and each caption spans its original shot after retiming')
      }
      case 'other_clips_preserved': {
        const oldClips = oldTimeline?.tracks.find(track => track.kind === 'video')?.clips
        const clips = timeline?.tracks.find(track => track.kind === 'video')?.clips
        const stableFields = (doc: TimelineDoc) => ({
          ...doc,
          tracks: doc.tracks.map(track => track.kind === 'video' ? { ...track, clips: track.clips.map((clip, i) => ({ ...clip, startMs: 0, speed: i === 1 ? 1 : (clip.speed ?? 1) })) } : track),
          textTracks: doc.textTracks?.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, startMs: 0, durationMs: 0 })) })),
        })
        return check(id, TimelineDoc.safeParse(timeline).success && !!oldClips && clips?.length === 3 && oldClips.every((clip, i) => {
          const current = clips[i]
          if (!current) return false
          const { startMs: _beforeStart, speed: beforeSpeed, ...before } = clip
          const { startMs: _afterStart, speed: afterSpeed, ...after } = current
          return JSON.stringify(before) === JSON.stringify(after) && (i === 1 || (beforeSpeed ?? 1) === (afterSpeed ?? 1))
        }) && JSON.stringify(stableFields(oldTimeline!)) === JSON.stringify(stableFields(timeline!)), 'All non-retiming document, track, source, clip, caption and style fields preserved')
      }
      // 0024e overlays: the main video track and captions must be untouched
      case 'media_and_captions_preserved': {
        const strip = (doc?: TimelineDoc) => doc && JSON.stringify({ media: doc.tracks.filter(track => track.kind !== 'overlay'), text: doc.textTracks ?? [], output: doc.output ?? null })
        return check(id, TimelineDoc.safeParse(timeline).success && !!oldTimeline && strip(oldTimeline) === strip(timeline), 'Valid timeline; video, audio and text tracks unchanged')
      }
      case 'logo_overlay': {
        const videoEnd = Math.max(0, ...(timeline?.tracks.find(track => track.kind === 'video')?.clips.map(clipEndMs) ?? []))
        const logos = timeline?.tracks.filter(track => track.kind === 'overlay' && !track.hidden).flatMap(track => track.clips).filter(clip => clip.source.nodeId === e.fixtureVars.logoNodeId) ?? []
        const ok = logos.length === 1 && logos.every(clip => clip.overlay && clip.startMs === 0 && clipEndMs(clip) >= videoEnd && clip.overlay.x > 0.5 && clip.overlay.y < 0.5 && clip.overlay.width >= 0.08 && clip.overlay.width <= 0.2 && clip.overlay.opacity > 0.5)
        return check(id, ok, 'One visible logo overlay from 0 to the end of the video, in the top-right quadrant, 8–20% wide')
      }
      case 'sticker_shot2': {
        const shot = timeline?.tracks.find(track => track.kind === 'video')?.clips[1]
        const stickers = timeline?.tracks.filter(track => track.kind === 'overlay' && !track.hidden).flatMap(track => track.clips).filter(clip => clip.source.nodeId === e.fixtureVars.stickerNodeId) ?? []
        const ok = !!shot && stickers.length === 1 && stickers.every(clip => clip.overlay && Math.abs(clip.startMs - shot.startMs) <= 50 && Math.abs(clipEndMs(clip) - clipEndMs(shot)) <= 50 && clip.fadeInMs === 500 && clip.overlay.y > 0.5 && Math.abs(clip.overlay.x - 0.5) <= 0.15)
        return check(id, ok, 'One sticker spanning shot 2 (±50 ms), centred horizontally and below the middle, with a 500 ms fade-in')
      }
      case 'pip_shot3': {
        const shot = timeline?.tracks.find(track => track.kind === 'video')?.clips[0]
        const pips = timeline?.tracks.filter(track => track.kind === 'overlay' && !track.hidden).flatMap(track => track.clips.map(clip => ({ clip, track }))).filter(({ clip }) => clip.source.nodeId === e.fixtureVars.shot3NodeId) ?? []
        const ok = !!shot && pips.length === 1 && pips.every(({ clip, track }) => clip.overlay && Math.abs(clip.startMs - shot.startMs) <= 50 && clipEndMs(clip) <= clipEndMs(shot) + 50 && clipEndMs(clip) - clip.startMs >= 500
          && clip.overlay.x > 0.5 && clip.overlay.y > 0.5 && clip.overlay.width >= 0.2 && clip.overlay.width <= 0.45 && (track.muted || clip.volume === 0))
        return check(id, ok, 'Shot 3 once as a visible, silent overlay video during shot 1 (±50 ms), in the bottom-right quadrant, 20–45% wide')
      }
      case 'logo_half_opacity': {
        const before = oldTimeline?.tracks.filter(track => track.kind === 'overlay').flatMap(track => track.clips)
        const after = timeline?.tracks.filter(track => track.kind === 'overlay').flatMap(track => track.clips)
        const ok = before?.length === 1 && after?.length === 1 && after[0]!.overlay?.opacity === 0.5
          && JSON.stringify({ ...before[0], overlay: { ...before[0]!.overlay, opacity: 0 } }) === JSON.stringify({ ...after[0], overlay: { ...after[0]!.overlay, opacity: 0 } })
        return check(id, ok, 'The single logo clip has opacity 0.5 and every other field unchanged')
      }
      case 'quota_stop': return review(id, `Unexercisable with Mock-only configuration: packages/generation/src/quota.ts isPaidProvider exempts mock/render; 0 is unlimited. Limits are set to 1, but no quota failure is fabricated. Observed ${calls.filter(call => call.error && call.output.includes('quota_exceeded')).length} quota tool errors and ${called('gen_submit').length} submits. Requires a separate approved quota-injection seam.`)
      case 'done_report_refs': return check(id, e.workMessages.some(message => message.kind === 'done' && newNodes.some(node => node.kind === 'text' && node.purpose !== 'working' && message.refs.nodeIds?.includes(node.nodeId) && node.slots.some(slot => slot.content.type === 'text' && slot.content.body.trim()))), 'Persisted done report references a new nonempty text deliverable in this project')
      case 'idle_after_done': {
        const done = e.workMessages.find(message => message.kind === 'done')
        const report = e.events.find(event => event.type === 'work.messageAdded' && (event.payload as any)?.messageId === done?.messageId)
        const editsAfter = report && e.events.some(event => event.seq > report.seq && ['node.created', 'node.updated', 'node.deleted', 'slot.revised'].includes(event.type))
        return check(id, e.ended && !!done && !!report && !editsAfter, 'Child turn ended after reporting done, with no subsequent canvas edits in the observed run')
      }
      default: return review(id, 'Human review required for content quality, accuracy and coherence')
    }
  })
}
