import type { SkillCopyState } from '@vis/protocol'
import { useMessages } from '@vis/ui-kit'
import { skillCopyMessages } from './messages'

export function SkillCopyBadges({ copy }: { copy?: SkillCopyState | undefined }) {
  const m = useMessages(skillCopyMessages)
  return copy ? <span className="vis-skill-copy-states">{copy.newer ? <small>{m.newer}</small> : null}{copy.edited ? <small>{m.edited}</small> : null}{copy.missing ? <small>{m.missing}</small> : null}</span> : null
}
