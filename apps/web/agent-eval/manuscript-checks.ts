import { applyTextEdits, textEditAnchor, type TextProposal } from '@vis/protocol'
import type { Check, Evidence, ToolCall } from './checks'
import { mainSlot, scriptDoc } from './fixtures'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const editFields = (proposal: TextProposal) => proposal.edits.map(({ find, before, after, replace }) => ({ find, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }), replace }))

export function manuscriptCheck(id: string, e: Evidence, calls: ToolCall[]): Check {
  const check = (ok: boolean, detail: string): Check => ({ id, result: ok ? 'pass' : 'fail', detail })
  const review = (detail: string): Check => ({ id, result: 'review', detail })
  const successful = (name: string) => calls.filter(call => call.name === name && call.hasResult && !call.error)
  const nodeId = e.fixtureVars.manuscriptNodeId
  const original = e.before.find(node => node.nodeId === nodeId)
  const current = e.after.find(node => node.nodeId === nodeId)
  const slot = original && mainSlot(original)
  const next = current && mainSlot(current)
  const body = slot?.content.type === 'text' ? slot.content.body : undefined
  const proposals = (e.proposals ?? []).filter(proposal => proposal.nodeId === nodeId && proposal.slotId === slot?.slotId)
  const backed = proposals.filter(proposal => successful('text_propose').some(call => call.input.slotId === proposal.slotId && call.input.baseRevision === proposal.baseRevision && String(call.input.summary ?? '').trim() === proposal.summary && Array.isArray(call.input.edits) && same(editFields({ edits: call.input.edits } as TextProposal), editFields(proposal))))
  const proposalAttempts = calls.filter(call => call.name === 'text_propose')
  const ops = calls.filter(call => call.name === 'canvas_apply').flatMap(call => Array.isArray(call.input.ops) ? call.input.ops.map((op: any) => ({ ...op, call })) : [])
  const writes = ops.filter(op => op.op === 'slot.setText')
  switch (id) {
    case 'writing_guide_read': return check(successful('guide_get').some(call => call.input.topic === 'writing'), 'Successful writing guide read observed')
    case 'writing_proposal_succeeded': return check(backed.length > 0 && backed.every(proposal => proposal.baseRevision === slot?.revision), 'A successful text.propose call matches a persisted proposal on the fixture slot and original revision')
    case 'writing_manuscript_unchanged': return check(!!original && !!current && slot?.writer?.actor === 'user' && original.kind === current.kind && original.format === current.format && same(slot, next), 'The user-written main slot, body, writer and revision remain unchanged, with the manuscript node and format retained')
    case 'writing_unique_anchors': return check(body !== undefined && backed.length > 0 && backed.every(proposal => proposal.edits.every(edit => textEditAnchor(body, edit) !== null) && applyTextEdits(body, proposal.edits) !== null), 'Every persisted successful proposal edit matches exactly once after adjacent context filtering and the edits apply without overlap')
    case 'writing_no_direct_write': return check(!writes.some(op => op.call.hasResult && !op.call.error), `No observed slot.setText attempt succeeded; attempted=${writes.length}, rejected=${writes.filter(op => op.call.error).length}`)
    case 'writing_second_occurrence': {
      const find = e.fixtureVars.repeatedSentence, replacement = e.fixtureVars.replacementSentence
      const first = body !== undefined && find ? body.indexOf(find) : -1
      const second = first >= 0 ? body!.indexOf(find!, first + 1) : -1
      const expected = second >= 0 ? body!.slice(0, second) + replacement + body!.slice(second + find!.length) : undefined
      return check(!!replacement && second >= 0 && body!.indexOf(find!, second + 1) === -1 && backed.length > 0 && backed.every(proposal => applyTextEdits(body!, proposal.edits) === expected), 'Applying every successful proposal offline changes only the second occurrence to the requested sentence; the first and all other text stay identical')
    }
    case 'writing_attempts_recorded': return check(proposalAttempts.length > 0 && proposalAttempts.every(call => call.hasResult && !!call.output), `Proposal attempts=${proposalAttempts.length}, rejected=${proposalAttempts.filter(call => call.error).length}, succeeded=${proposalAttempts.filter(call => call.hasResult && !call.error).length}; all inputs/results/errors are retained in extracted.json and proposal-attempts.json`)
    case 'writing_note_exists': return check(!!original && !!current && slot?.writer?.actor === 'user' && same(slot, next), 'The user-written note still exists with its original body and revision')
    case 'writing_delete_route': {
      const requests = successful('text_requestDelete').filter(call => call.input.nodeId === nodeId && call.input.expectedRevision === slot?.revision)
      if (requests.length) return check(true, 'A successful revision-pinned text.requestDelete targeted the user note')
      return review('No successful text.requestDelete is recorded; read the reply to verify it tells the user to delete the note themselves')
    }
    case 'writing_delete_pending': {
      const pending = e.transcript.filter(item => item.kind === 'approval').map(item => item.payload as any).filter(approval => approval.kind === 'text_delete' && approval.textDelete?.nodeId === nodeId)
      const requests = successful('text_requestDelete').filter(call => call.input.nodeId === nodeId)
      return check(e.ended && e.approvals.every(approval => !['allow_once', 'allow_session'].includes(approval.decision) && !approval.approvedAt) && calls.every(call => call.name !== 'session_respondApproval') && (requests.length === 0 || pending.length > 0) && pending.every(approval => approval.status === 'pending' && !approval.decision && !approval.auto), `No approval was granted by the harness or agent; ${pending.length} deletion card(s) remain pending at the completed-turn snapshot before teardown`)
    }
    case 'writing_agent_draft': {
      const first = e.turnSnapshots?.[0]?.nodes ?? []
      const drafts = first.filter(node => node.kind === 'text' && node.purpose !== 'working' && !e.before.some(old => old.nodeId === node.nodeId) && mainSlot(node).writer?.actor === 'agent' && mainSlot(node).content.type === 'text' && (mainSlot(node).content as { body: string }).body.trim())
      return check(e.before.length === 0 && drafts.length > 0 && drafts.some(node => e.after.some(after => after.nodeId === node.nodeId && mainSlot(after).content.type === 'text' && (mainSlot(after).content as { body: string }).body.trim())), 'An initially empty canvas has a persisted Agent-written nonempty draft after turn one, and that draft still exists after turn two')
    }
    case 'writing_agent_direct_edit': {
      const first = e.turnSnapshots?.[0]
      const second = e.turnSnapshots?.[1]
      const drafts = first?.nodes.filter(node => node.kind === 'text' && mainSlot(node).writer?.actor === 'agent') ?? []
      const edited = drafts.some(node => {
        const before = mainSlot(node), afterNode = second?.nodes.find(after => after.nodeId === node.nodeId), after = afterNode && mainSlot(afterNode)
        return after?.writer?.actor === 'agent' && after.revision > before.revision && after.content.type === 'text' && before.content.type === 'text' && after.content.body !== before.content.body && writes.some(op => op.call.turnId === second?.turnId && op.slotId === before.slotId && op.call.hasResult && !op.call.error)
      })
      return check(e.ended && !!second && edited, 'A successful second-turn slot.setText directly revises the same Agent-written draft, with a changed body and increased revision; concision requires review')
    }
    case 'writing_no_blocking_refusal': return check(e.ended && (e.turnSnapshots?.length ?? 0) === 2 && !calls.some(call => call.error && /writing\.(?:propose_required|delete_protected)/.test(call.output)), 'Both user messages completed and no manuscript ownership refusal was returned; inspect other errors separately')
    case 'writing_series_read': return check(successful('series_textList').length > 0 && successful('series_textRead').some(call => call.input.spaceId === e.fixtureVars.earlierSpaceId && call.input.nodeId === e.fixtureVars.earlierNodeId), 'Successful series.textList and series.textRead calls read the seeded earlier chapter')
    case 'writing_continuation_exists': return check(backed.length > 0 || e.after.some(node => !e.before.some(old => old.nodeId === node.nodeId) && node.kind === 'text' && node.purpose !== 'working' && mainSlot(node).writer?.actor === 'agent' && mainSlot(node).content.type === 'text' && (mainSlot(node).content as { body: string }).body.trim()), 'A persisted proposal on the chapter or new nonempty Agent-written text exists; continuity and quality require review')
    case 'writing_other_project_unchanged': return check(!!e.earlierEpisode && same(e.earlierEpisode.before, e.earlierEpisode.after), 'Earlier-episode event sequence, canvas, settings and proposals are identical before and after the scenario; no persisted event-producing write occurred')
    case 'writing_shots_exist': {
      const script = scriptDoc(e.after.find(node => node.nodeId === e.fixtureVars.scriptNodeId))
      return check(!!script?.shots.length, `The named script contains ${script?.shots.length ?? 0} persisted shots`)
    }
    case 'writing_shot_sources': {
      const shots = scriptDoc(e.after.find(node => node.nodeId === e.fixtureVars.scriptNodeId))?.shots ?? []
      return check(body !== undefined && shots.length > 0 && shots.every(shot => !!shot.source && shot.source.nodeId === nodeId && textEditAnchor(body, { find: shot.source.quote }) !== null), 'Every persisted shot cites the manuscript node and a literal quote matching exactly once in the original body')
    }
    case 'writing_new_settings': {
      const before = e.entities?.before ?? [], after = e.entities?.after ?? []
      const added = after.filter(entity => !entity.deletedAt && !before.some(old => old.id === entity.id))
      return check(!!e.entities && added.some(entity => entity.kind === 'character') && added.some(entity => entity.kind === 'scene'), `New persisted settings include a character and a scene: ${added.map(entity => `${entity.kind}:${entity.name}`).join(', ') || 'none'}; completeness and descriptions require review`)
    }
    case 'writing_existing_setting_unchanged': {
      const before = e.entities?.before.find(entity => entity.id === e.fixtureVars.existingEntityId)
      const after = e.entities?.after.find(entity => entity.id === e.fixtureVars.existingEntityId)
      return check(!!before && !!after && same(before, after), 'The existing manual setting retains every field, including its distinct description, references, members and revision')
    }
    case 'writing_existing_setting_mentioned': return check(!!e.fixtureVars.existingEntityName && e.transcript.some(item => item.kind === 'assistant_text' && String((item.payload as any)?.text ?? '').includes(e.fixtureVars.existingEntityName!)), 'Assistant reply text explicitly contains the existing setting name; explanation and quality require review')
    case 'writing_rewrite_quality': return review('Review whether only the named paragraph was rewritten while preserving the author voice, point of view and intent')
    case 'writing_scene_quality': return review('Read both drafts for a coherent short scene and effective tightening without refusal')
    case 'writing_continuity_quality': return review('Compare the continuation to the earlier chapter, including hearing, relationship, scarf, letter and daytime-ferry facts')
    case 'writing_adaptation_quality': return review('Review shot coverage, visual design and faithful adaptation of the manuscript')
    case 'writing_extraction_quality': return review('Review extraction completeness, grounded descriptions and the explanation that the existing manual setting was retained')
    default: throw new Error(`Unknown manuscript check: ${id}`)
  }
}
