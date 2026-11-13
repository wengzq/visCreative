// Session area and project / task board. Communicate with the backend only through protocol.
export { type MentionNode, type RefChip, type RefPreview, SessionPanel, type SessionPanelProps } from './SessionPanel'
export type { WorkspaceInput, ProjectOption, SkillOption } from './WorkspaceDialog'
export { transcriptGenerationJobIds } from './toolGroups'
export { WorkCard, type WorkCardProps, type WorkCardAction, type WorkCardThumbnail } from './work/WorkCard'
export { WorkCardMenu, type WorkCardMenuProps, type WorkCardMenuHandle } from './work/WorkCardMenu'
export { WorkDialog } from './work/WorkDialog'
export { WorkTree, type WorkTreeProps } from './work/WorkTree'
export { WorkBoard, type WorkBoardProps } from './work/WorkBoard'
export { InboxPopover, type InboxPopoverProps, type InboxReplyResult } from './work/InboxPopover'
export { ReviewDrawer, type ReviewDrawerProps, type ReviewChangePreview } from './work/ReviewDrawer'
export { SlotsPopover, type SlotsPopoverProps } from './work/SlotsPopover'
export { NewTodoDialog, RejectDialog, AgentChoiceDialog, DeleteWorkDialog, type NewTodoInput, type NewTodoDialogProps, type RejectDialogProps, type AgentChoiceDialogProps, type DeleteWorkDialogProps } from './work/WorkDialogs'
export { getDropAction, getQuickActions, runningNotice, queuePosition, relativeTime, sortWorkItems, buildWorkTree, groupBoardItems, incompleteChildren, mergeInboxGroups, mergeWorkItems, statusLabels, actionLabels, sessionDoing, type DropResult, type WorkDropAction } from './work/model'

export { WorkStatusDropBar, type WorkTreeDrag } from './work/WorkStatusDropBar'
export { useAttachments } from './Attachments'

export { SkillManager, type SkillManagerActions } from './SkillManager'

export { ProjectSwitcher, type ProjectSwitcherProps } from './ProjectSwitcher'
export { AgentsContext, useAgents, agentLabel, EMPTY_AGENTS } from './agents'
export type { SeriesProjectHost, ProjectSeriesInput } from './series-model'

export { SkillCopyBadges } from './SkillCopyBadges'
export type { SkillDraftHost } from './SkillDraftCard'

export type { SceneProposalHost } from './SceneProposalCard'
