import type { CanvasOp, NodeView } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import { controlMessages } from './messages'

export function OrganizationPreview({ groups, ops, nodes }: {
  groups: { frameId: string; category: string; nodeIds: string[]; x: number; y: number; w: number; h: number }[]
  ops: CanvasOp[]
  nodes: NodeView[]
}) {
  const m = useMessages(controlMessages)
  const format = useFormat()
  if (!groups.length) return <p>{m.noOrganizationNodes}</p>
  const left = Math.min(...groups.map(group => group.x)) - 20
  const top = Math.min(...groups.map(group => group.y)) - 20
  const width = Math.max(...groups.map(group => group.x + group.w)) - left + 20
  const height = Math.max(...groups.map(group => group.y + group.h)) - top + 20
  const ids = new Set(groups.flatMap(group => group.nodeIds))
  const layouts = new Map(ops.filter(op => op.op === 'node.layout').map(op => [op.nodeId, op]))
  const arranged = nodes.filter(node => ids.has(node.nodeId)).map(node => {
    const layout = layouts.get(node.nodeId)
    return { ...node, x: layout?.x ?? node.x, y: layout?.y ?? node.y, w: layout?.w ?? node.w, h: layout?.h ?? node.h }
  })
  return <div className="vis-organization-preview" aria-label={m.organizationPreview}>
    <svg viewBox={`${left} ${top} ${width} ${height}`} role="img" aria-label={m.organizationPreviewImage}>
      {groups.map(group => <g key={group.frameId}><rect x={group.x} y={group.y} width={group.w} height={group.h} rx={12} className="vis-preview-frame" /><text x={group.x + 24} y={group.y + 35}>{nodes.find(node => node.nodeId === group.frameId)?.frame?.title ?? group.category}</text></g>)}
      {arranged.flatMap(node => [...new Set([...(node.inputs ?? []), ...node.slots.flatMap(slot => slot.source?.inputNodeIds ?? [])])].flatMap(id => {
        const source = arranged.find(node => node.nodeId === id)
        return source ? [<line key={`${id}-${node.nodeId}`} x1={source.x + source.w} y1={source.y + source.h / 2} x2={node.x} y2={node.y + node.h / 2} />] : []
      }))}
      {arranged.map(node => <rect key={node.nodeId} x={node.x} y={node.y} width={node.w} height={node.h} rx={8} className="vis-preview-node" />)}
    </svg>
    <p>{groups.map(group => m.organizationGroupCount(group.category, format.number(group.nodeIds.length))).join(' · ')}</p>
  </div>
}
