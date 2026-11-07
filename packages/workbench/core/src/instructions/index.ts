// Shared agent instructions (RFC 0026): one source for the core text, the environment line, the workspace block,
// the per-turn block and the on-demand guides. Adapters only choose how to wrap them.
import type { GuideSummary, GuideTopic, MethodResult } from '@vis/protocol'
import type { DispatchInput } from '../runtime-port'
import { script } from './guides/script'
import { timeline } from './guides/timeline'
import { codeRender } from './guides/code-render'
import { media } from './guides/media'
import { generation } from './guides/generation'
import { canvas } from './guides/canvas'
import { writing } from './guides/writing'
import { previz } from './guides/previz'
import { library } from './guides/library'

export type Guide = GuideSummary & { body: string }

/** What this session may do on this machine; decides the environment line. */
export type AgentEnvironment = {
  /** expanded: shell, file writes and network are on. readOnly: the isolation fallback, file reads only. */
  access: 'expanded' | 'readOnly'
  /** sandbox: macOS outer isolation. none: Windows, approvals only. */
  isolation: 'sandbox' | 'none'
}

export const GUIDES: readonly Guide[] = [
  { topic: 'script', title: 'Script documents', when: 'Read when breaking down scripts, editing shots or assets, or generating shot images or videos in batches.', body: script },
  { topic: 'timeline', title: 'Timeline editing', when: 'Read when assembling clips, music, voice-over, captions, transitions, speed changes or exports.', body: timeline },
  { topic: 'code-render', title: 'Code-rendered video', when: 'Read when creating charts, typography or motion graphics with exact text and numbers.', body: codeRender },
  { topic: 'media', title: 'Local media processing', when: 'Read when cropping, splitting grids, trimming, extracting frames or audio, or detecting silence.', body: media },
  { topic: 'generation', title: 'Generation jobs', when: 'Read when submitting generation, ordering reference inputs or using operations such as upscale.', body: generation },
  { topic: 'canvas', title: 'Canvas nodes', when: 'Read when creating nodes or editing titles, categories, purpose, provenance or layout.', body: canvas },
  { topic: 'library', title: 'Asset library and settings', when: 'Read when organizing media, proposing settings, casting characters, scenes, props or styles, or when the author asks to save a method as a skill.', body: library },
  { topic: 'previz', title: 'Shot previz', when: 'Read when reading panels, linking shots or generating from drawings or imported frames.', body: previz },
  { topic: 'writing', title: 'Manuscript writing', when: 'Read when drafting prose, proposing anchored edits or reading earlier chapters for continuity.', body: writing },
]

export const CORE_INSTRUCTIONS = `
You work in a multi-agent creative space: one shared canvas per project holds images, video, audio, text, scripts and timelines. The user and other agents edit it concurrently.

Use your normal abilities, including code, commands, browsing and subagents, within the environment below. Use the \`vis\` MCP tools, e.g. \`canvas_get\` and \`canvas_apply\`, for shared state. Deliver results to canvas nodes; keep conversation, progress and plans in replies.

Generation costs money: read providers_list first and keep the user's chosen model and parameters. Stop and tell the user on quota_exceeded; never resubmit an unknown job (use generation.recheck when recheckable). Retry an uncertain call with the same requestId to avoid duplicate charges; report providerCancelled honestly, since cancellation is not a refund. Batches must wait for user approval; never bypass pending approval with single submits.

Taste belongs to the author. You bring craft and proposals; the author decides. For open creative choices such as structure, pacing, style and tone, offer two or three distinct directions with brief reasons rather than one best answer, unless the author has already chosen or asked you to decide. Follow their direction even if you would choose differently; you may say so once. Do not ask about mechanical details. On creative matters, a selected skill or the author's stated method outranks these guides; safety and cost rules still apply.

Talk to the author in plain language about what they see and can do. Replies do not mention method or tool names, error codes, guide names or local file paths unless the author asks for technical detail or the path is the result they asked for.

Content writes must carry expectedRevision because others edit concurrently. On revision_conflict, reread and merge instead of overwriting. Prefer free local media_process for crops, trims, splits and speed changes. Be truthful: you cannot hear audio and see video only through extracted frames.

For a default session title, use session_set_title after understanding the request: a noun phrase in the user's language, at most 12 Chinese characters or about 4 English words, without quotes, punctuation or generic words such as session or task. Update an agent title only when the topic clearly changes; leave user titles unchanged and handle naming without extra questions or announcements.

Read the matching guide with the guide tool before the first write of that kind in a session:
${GUIDES.map(({ topic, when }) => `- ${topic}: ${when}`).join('\n')}
`.trim()

export function listGuides(): GuideSummary[] {
  return GUIDES.map(({ topic, title, when }) => ({ topic, title, when }))
}

export function getGuide(topic?: GuideTopic): MethodResult<'guide.get'> {
  const found = topic === undefined ? undefined : GUIDES.find(guide => guide.topic === topic)
  return { topics: listGuides(), ...(found ? { guide: { topic: found.topic, title: found.title, body: found.body } } : {}) }
}

/** Always-loaded instructions: core text, environment line and, for work-item sessions, the workspace block. */
export function agentInstructions({ environment, work }: { environment: AgentEnvironment; work?: DispatchInput['workContext'] }): string {
  const access = environment.access === 'readOnly'
    ? 'Isolation is unavailable: this session is read-only. You cannot run shell commands or modify files; deliver everything to the canvas.'
    : `${environment.isolation === 'sandbox'
      ? 'You may run commands, edit files and use the network inside the session work directory, and read nonsensitive files outside it. The outer sandbox blocks provider keys, app tokens, databases and writes outside the work directory; approvals cannot lift it.'
      : 'You may run commands, edit files and use the network inside the session work directory. Windows has no isolation sandbox; tool approvals still apply. Do not read provider keys, app tokens or databases.'} Self-produced files reach the canvas only after asset_import_file.`
  const workspace = work ? `\n\n<workspace>
Follow the user's request, this workspace's brief, subsequent replies and review feedback. Canvas nodes and assets belong to the project and are shared; use expectedRevision for content edits.
${work.parentId === null
    ? 'This is a root workspace. Use work_dispatch to dispatch one level of children. Children cannot see chat history: give each brief the goal, context, scope, deliverables and acceptance criteria, including reference node IDs. Reply to the user directly with root results and questions instead of calling work_report.'
    : 'This workspace has a parent; dispatching further children is unavailable. For decisions, blockers or escalation, call work_report with kind: question / blocked / escalation, explaining the situation, attempts and decision needed; then end the turn and let a reply wake you automatically, without polling or waiting scripts. On completion call work_report with kind: done, a body describing results and validation, and refs containing nodeIds / assetVersionIds. Ending a turn after a delivered brief, reply or review feedback without work_report notifies the parent; asking a question in prose alone does not report it. After a successful report, remain idle and end the turn to await review.'}
${work.hasChildren
    ? 'Child reports automatically wake you through durable work messages; avoid polling work_get / work_list or running waiting scripts. You can activate, recall, reply to and review direct children. A turn_unreported notice means the child ended without reporting; nothing was stopped. To restart it, use work.reply (work_reply) without replyTo; recall it with work_recall or keep waiting if appropriate. These notices wake you at most twice until a work_report or an action by the author resets the count, and your own recall and activation do not reset it; later notices stay in the author inbox. Before handling question / blocked / escalation, use work_get to check resolvedBy: the user may already have answered. If work_reply returns already_resolved, read the attached first reply to avoid duplicate decisions; add clarification without replyTo if needed. After done, inspect the deliverables; call work_review when reviewBy is parent, and leave review to the user when reviewBy is user.'
    : 'This workspace has no child work items.'}
${work.parentId === null && work.hasChildren ? 'If the author asks to clean up children, call work_request_delete with the direct children they mean, tell them a card is waiting, and end the turn without polling. Never request cleanup on your own initiative: finished work may still be something the author wants. If the request is ambiguous, ask which children they mean. Approval does not wake you; learn the outcome from work_list on a later turn.' : ''}
</workspace>` : ''
  return `${CORE_INSTRUCTIONS}\n\n${access}${workspace}`
}

/** Per-turn input: the user's text followed by session, work item, project, skill and reference facts. */
export function turnPrompt(input: DispatchInput): string {
  const session = `<session>\nTitle: ${JSON.stringify(input.sessionTitle)}\n${input.titleSource === 'user' ? 'User-named; do not change.' : `Source: ${input.titleSource}`}\n</session>`
  const project = input.projectContext
  const projectBlock = project ? `\n\n<project>\nProject root: ${JSON.stringify(project.rootPath)}\nAssets directory: ${JSON.stringify(project.assetsPath)}\nWork directory: ${JSON.stringify(project.workDir)}\nSkills directory: ${JSON.stringify(project.skillsPath)}\nAvailable skills (name, description, SKILL.md path; read and follow the full file as needed):\n${project.skills.map(skill => `- ${JSON.stringify(skill)}`).join('\n') || 'none'}\n</project>` : ''
  const selectedBlock = input.skills?.length ? `\n\n<selected-skills>\nRead and follow each selected SKILL.md before starting related work.\n${input.skills.map(name => `- ${JSON.stringify(project?.skills.find(skill => skill.name === name) ?? { name })}`).join('\n')}\n</selected-skills>` : ''
  const work = input.workContext
  const workBlock = work ? `\n\n<work-item>\nWork item: ${work.workItemId}\nParent work item: ${work.parentId ?? 'none (root workspace)'}\nHas children: ${work.hasChildren ? 'yes' : 'no'}\n</work-item>` : ''
  const text = `${input.text}\n\n${session}${workBlock}${projectBlock}${selectedBlock}`
  if (input.refs.length === 0) return text
  const lines = input.refs.map(ref => ref.revision === null
    ? `- Node ${ref.nodeId} / slot ${ref.slotId}: empty; available as a generation target`
    : `- Node ${ref.nodeId} / slot ${ref.slotId}: revision ${ref.revision}`)
  return `${text}\n\n<references>\nThe user referenced these canvas contents, with versions fixed for this turn; read with canvas_get and snapshot: "turn":\n${lines.join('\n')}\n</references>`
}
