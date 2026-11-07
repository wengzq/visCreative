import type { LibraryTask } from '@vis/library-ui'

export function libraryTaskText(task: LibraryTask): string {
  const scope = task.relabel ? 'Read every non-archived media asset, including assets already labeled.' : 'Read unlabeled media assets using asset.list { labeled: false }.'
  if (task.kind === 'merge') return [
    'Library task: merge',
    `runId: ${task.runId}`,
    'Read the library guide first: the guide tool with topic library, or vis guide library.',
    'Read the project media library and existing settings with asset.list and entity.list, paging through nextCursor.',
    'Propose groups representing the same character, scene, prop or style through entity.propose. Include this runId in every call.',
    'Use human-readable names, explain the evidence in reason, and choose up to four image reference versions from the group.',
    'The user reviews proposals. Do not create or update settings directly. Do not call a generation provider.',
  ].join('\n')
  return [
    'Library task: label',
    `runId: ${task.runId}`,
    `relabel: ${task.relabel}`,
    'Read the library guide first: the guide tool with topic library, or vis guide library.',
    scope,
    'Page through nextCursor. Use context node titles and prompts first; only open asset.get path when the context is insufficient.',
    'Give each asset a short human-readable name, category and useful tags with asset.label in batches of at most 50.',
    'Include this runId in every asset.label call and use a fresh requestId for each distinct batch.',
    'Preserve userFields: skippedFields are corrections, never retry or work around them.',
    // i18n-exempt: Agent-facing recommended category values from the protocol, not UI copy.
    'Recommended image categories: 角色 / 场景 / 物品 / 风格 / 其他. Video: 视频片段 / 成片.',
    'Organize metadata only. Do not generate media or call a generation provider.',
  ].join('\n')
}
