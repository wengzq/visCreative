import type { Check, Evidence, ToolCall } from './checks'

const parsed = (call?: ToolCall): any => { try { return JSON.parse(call?.output ?? '') } catch { return undefined } }
const result = (id: string, ok: boolean, detail: string): Check => ({ id, result: ok ? 'pass' : 'fail', detail })
const review = (id: string, detail: string): Check => ({ id, result: 'review', detail })
const sameIds = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && [...a].sort().join(',') === [...b].sort().join(',')

export function authorCheck(id: string, e: Evidence, calls: ToolCall[]): Check {
  const called = (name: string) => calls.filter(call => call.name === name)
  const successful = (name: string) => called(name).filter(call => call.hasResult && !call.error)
  const childIds = (e.fixtureVars.childWorkItemIds ?? '').split(',').filter(Boolean)
  const requests = successful('work_requestDelete')
  const latestCards = e.transcript.filter(item => item.kind === 'approval').map(item => item.payload as any).filter(card => card.kind === 'work_delete')
  const drafts = e.skills?.after.drafts.filter(draft => !e.skills!.before.drafts.some(old => old.draftId === draft.draftId)) ?? []
  switch (id) {
    case 'directions_no_paid_generation': return result(id, [...called('gen_submit'), ...called('script_batch_start')].every(call => !call.input.provider || ['mock', 'render'].includes(call.input.provider)) && e.batches.every(batch => ['mock', 'render'].includes(batch.estimate.provider) && batch.estimate.billedJobs === 0), 'No paid-provider submission attempted and no billed batch; the runner separately verifies only keyless Mock/render providers exist')
    case 'directions_quality': return review(id, 'Read the reply for two or three distinct creative directions with reasons, meaningful choices and author control; a numbered list alone is not evidence of quality')
    case 'child_text_working': {
      const nodes = e.after.filter(node => node.kind === 'text' && !e.before.some(old => old.nodeId === node.nodeId))
      return result(id, nodes.length > 0 && nodes.every(node => node.purpose === 'working' && node.slots.some(slot => slot.content.type === 'text' && slot.content.body.trim() && slot.writer?.actor === 'agent')), `Gateway canvas contains ${nodes.length} new nonempty Agent text node(s), all with purpose working`)
    }
    case 'child_report_links': {
      const nodes = e.after.filter(node => node.kind === 'text' && !e.before.some(old => old.nodeId === node.nodeId))
      const reports = e.workMessages.filter(message => message.kind === 'done' && message.to === 'parent' && message.workItemId === e.fixtureVars.childWorkItemId)
      const received = reports.some(report => nodes.length > 0 && nodes.every(node => report.refs.nodeIds?.includes(node.nodeId)) && e.workInbox?.groups.some(group => group.items.some(item => item.workItemId === e.fixtureVars.childWorkItemId && !!item.parentTitle && item.messages.some(message => message.messageId === report.messageId && nodes.every(node => message.refs.nodeIds?.includes(node.nodeId) && item.nodeLabels[node.nodeId])))))
      return result(id, !!received, 'A persisted parent-directed child done report links all new text notes and appears with named node links in the parent workspace inbox; the paused parent does not consume it')
    }
    case 'child_no_parent_turn': return result(id, !!e.parentTranscript && !e.parentTranscript.some(item => item.turnId), 'The paused parent starts no extra real Agent turn')
    case 'cleanup_direct_children': {
      const direct = e.workItems?.before.filter(item => item.parentId === e.fixtureVars.parentWorkItemId && item.archivedAt === null).map(item => item.workItemId) ?? []
      return result(id, childIds.length === 2 && sameIds(direct, childIds) && called('work_requestDelete').length === 1 && requests.length === 1 && sameIds(requests[0]!.input.workItemIds ?? [], childIds), 'Exactly one successful work.requestDelete names exactly the two seeded live direct children')
    }
    case 'cleanup_pending': {
      const approvalId = parsed(requests[0]!)?.approvalId
      const cards = latestCards.filter(card => card.approvalId === approvalId)
      const observed = e.approvals.filter(card => card.approvalId === approvalId)
      return result(id, !!approvalId && parsed(requests[0]!)?.status === 'pending' && cards.length === 1 && cards.every(card => card.status === 'pending' && sameIds(card.workDelete?.items?.map((item: any) => item.workItemId) ?? [], childIds)) && observed.length === 1 && observed.every(card => card.pendingObserved && card.harnessAction === 'left_pending' && !card.decision) && !called('session_respondApproval').length, 'The request result, completed-turn approval and harness observation agree on one pending work_delete card; nobody approves or denies it')
    }
    case 'cleanup_no_poll': {
      const seq = requests[0]?.seq
      const later = seq === undefined ? [] : calls.filter(call => call.seq > seq)
      return result(id, e.ended && seq !== undefined && later.length === 0, `The turn ended with ${later.length} tool call(s) after its successful deletion request; inspect native transcript omissions separately`)
    }
    case 'cleanup_nothing_deleted': return result(id, childIds.length === 2 && childIds.every(workItemId => {
      const before = e.workItems?.before.find(item => item.workItemId === workItemId)
      const after = e.workItems?.after.find(item => item.workItemId === workItemId)
      return before?.status === 'done' && after?.status === 'done' && after.archivedAt === null && after.parentId === before.parentId && after.revision === before.revision && after.sessions.every(session => before.sessions.some(old => old.sessionId === session.sessionId && old.archived === session.archived))
    }) && e.before.every(node => e.after.some(after => JSON.stringify(after) === JSON.stringify(node))) && !e.events.some(event => event.type === 'node.deleted' || event.type === 'work.itemChanged' && !!(event.payload as any)?.archivedAt), 'Both finished children retain status, revision, parent and sessions before teardown; existing canvas content stays unchanged')
    case 'cleanup_not_requested': return result(id, called('work_requestDelete').length === 0 && latestCards.length === 0, 'No work.requestDelete attempt or work_delete card for a status-only request')
    case 'skill_one_draft': {
      const proposals = successful('skill_proposeDraft')
      return result(id, called('skill_proposeDraft').every(call => !call.error || call.expectedRefusal === 'skill.draft_frontmatter') && proposals.length === 1 && drafts.length === 1 && drafts[0]!.name === proposals[0]!.input.name && drafts[0]!.description === proposals[0]!.input.description && drafts[0]!.body === proposals[0]!.input.body, 'Exactly one successful skill.proposeDraft matches one persisted new draft, including its complete body; recovered frontmatter refusals are recorded separately')
    }
    case 'skill_no_frontmatter': return result(id, drafts.length === 1 && !/^\uFEFF?---\r?\n/.test(drafts[0]!.body), 'The complete persisted draft body has no leading frontmatter block')
    case 'skill_frontmatter_retry': {
      const refusals = called('skill_proposeDraft').filter(call => call.error && call.output.includes('skill.draft_frontmatter'))
      return result(id, refusals.every(call => call.expectedRefusal === 'skill.draft_frontmatter'), refusals.length ? `Frontmatter refusals and same-turn corrected retries: ${JSON.stringify(refusals.map(call => ({ seq: call.seq, output: call.output, recovered: !!call.expectedRefusal })))}` : 'No frontmatter refusal occurred; retry recovery was not exercised in this scenario')
    }
    case 'skill_library_unchanged': return result(id, !!e.skills && JSON.stringify(e.skills.before.skills) === JSON.stringify(e.skills.after.skills) && !called('skill_librarySave').length && !called('skill_use').length, 'The saved skill library is unchanged; no library-save or project-use call was attempted')
    case 'skill_no_project_paths': return result(id, drafts.length === 1 && !/(?:\/(?:Users|tmp|private|home)\/|[A-Z]:\\|file:\/\/|skills\/|\.vis-)/i.test(drafts[0]!.body) && !drafts[0]!.body.includes(e.workDir), 'The complete persisted draft body contains no project work directory or local path pattern; fidelity and unwanted names require review')
    case 'skill_fidelity': return review(id, 'Compare the full persisted draft body to the author prompt: motivation before action, two framing/movement choices with viewer-distance reasons, and author selection before detail; preserve those reasons without adding taste')
    case 'skill_not_requested': return result(id, called('skill_proposeDraft').length === 0 && drafts.length === 0, 'No skill.proposeDraft attempt or new draft when the author only requested help with a shot')
    default: throw new Error(`Unknown author check: ${id}`)
  }
}
