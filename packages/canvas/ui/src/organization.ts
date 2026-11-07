import type { CanvasOp, NodeView } from '@vis/protocol'
import { formatter, messagesFor, type Locale } from '@vis/ui-kit'
import { controlMessages } from './messages'
import { FRAME_MIN_SIZE, frameMembers, NODE_GAP } from './graph'
import { growFrames } from './frameBounds'

type Rect = { x: number, y: number, w: number, h: number }
export type OrganizationGroup = Rect & { category: string, frameId: string, nodeIds: string[] }

const PADDING = 24
const HEADER = 56
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w + NODE_GAP && b.x < a.x + a.w + NODE_GAP
  && a.y < b.y + b.h + NODE_GAP && b.y < a.y + a.h + NODE_GAP

/** Sort by name within strongly connected components, keeping upstream components first outside cycles. */
function categoryOrder(categories: string[], dependencies: Map<string, Set<string>>) {
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const active = new Set<string>()
  const ordered: string[] = []
  let index = 0
  const visit = (category: string) => {
    indices.set(category, index)
    low.set(category, index++)
    stack.push(category)
    active.add(category)
    for (const source of [...dependencies.get(category)!].sort(compare)) {
      if (!indices.has(source)) {
        visit(source)
        low.set(category, Math.min(low.get(category)!, low.get(source)!))
      } else if (active.has(source)) low.set(category, Math.min(low.get(category)!, indices.get(source)!))
    }
    if (low.get(category) !== indices.get(category)) return
    const component: string[] = []
    let member: string
    do {
      member = stack.pop()!
      active.delete(member)
      component.push(member)
    } while (member !== category)
    ordered.push(...component.sort(compare))
  }
  for (const category of categories.sort(compare)) if (!indices.has(category)) visit(category)
  return ordered
}

/** Return one canvas.apply batch; empty selection means organize all outputs. */
export function arrangeCanvas(nodes: NodeView[], selectedIds?: ReadonlySet<string>, locale: Locale = 'zh-CN'): { ops: CanvasOp[], groups: OrganizationGroup[], removedFrames: { nodeId: string; title: string }[] } {
  const m = messagesFor(controlMessages, locale)
  const categoryOf = (node: NodeView) => node.category ?? m.organizationUncategorized
  const otherUncategorized = messagesFor(controlMessages, locale === 'en' ? 'zh-CN' : 'en').organizationUncategorized
  const selected = selectedIds?.size ? selectedIds : undefined
  const visible = nodes.filter(node => node.purpose !== 'working')
  const items = visible.filter(node => node.kind !== 'frame' && (!selected || selected.has(node.nodeId)))
  const byCategory = new Map<string, NodeView[]>()
  for (const node of items) {
    const category = categoryOf(node)
    byCategory.set(category, [...(byCategory.get(category) ?? []), node])
  }
  const byId = new Map(visible.map(node => [node.nodeId, node]))
  const dependencies = new Map([...byCategory.keys()].map(category => [category, new Set<string>()]))
  for (const node of items) {
    for (const id of [...(node.inputs ?? []), ...node.slots.flatMap(slot => slot.source?.inputNodeIds ?? [])]) {
      const source = byId.get(id)
      if (!source || source.kind === 'frame') continue
      const category = categoryOf(source)
      if (category !== categoryOf(node) && byCategory.has(category)) dependencies.get(categoryOf(node))!.add(category)
    }
  }
  const frames = visible.filter(node => node.kind === 'frame').sort((a, b) => compare(a.nodeId, b.nodeId))
  const usedIds = new Set(nodes.map(node => node.nodeId))
  let frameIndex = 0
  const groups = categoryOrder([...byCategory.keys()], dependencies).map(category => {
    const members = byCategory.get(category)!.sort((a, b) => compare(a.nodeId, b.nodeId))
    // After switching languages, reuse the other language's uncategorized frame without claiming a frame assigned to an existing category.
    const frame = frames.find(node => node.frame?.title === category)
      ?? (category === m.organizationUncategorized && !byCategory.has(otherUncategorized) ? frames.find(node => node.frame?.title === otherUncategorized) : undefined)
    const width = Math.ceil(Math.max(320, ...members.map(node => node.w)))
    const height = Math.max(...members.map(node => node.h))
    const columns = members.length < 4 ? 1 : 2
    const w = Math.max(frame?.w ?? FRAME_MIN_SIZE.w, columns * width + (columns - 1) * NODE_GAP + 2 * PADDING)
    let frameId = frame?.nodeId
    if (!frameId) {
      do { frameId = `organize-frame-${frameIndex++}` } while (usedIds.has(frameId))
      usedIds.add(frameId)
    }
    return {
      category, members, frame, width, height, columns,
      frameId,
      anchored: !!selected && !!frame && frameMembers(frame.nodeId, nodes).some(node => !selected.has(node.nodeId)),
      w,
      h: Math.max(frame?.h ?? w, FRAME_MIN_SIZE.h, HEADER + Math.ceil(members.length / columns) * (height + NODE_GAP) - NODE_GAP + PADDING),
    }
  })
  const targets = new Set(groups.map(group => group.frameId))
  const itemIds = new Set(items.map(node => node.nodeId))
  const movingTargets = new Set(groups.filter(group => !group.anchored).map(group => group.frameId))
  const removable = new Map<string, boolean>()
  const emptied = (frameId: string, visiting = new Set<string>()): boolean => {
    if (targets.has(frameId) || visiting.has(frameId)) return false
    if (removable.has(frameId)) return removable.get(frameId)!
    const path = new Set([...visiting, frameId])
    const members = frameMembers(frameId, nodes)
    const moved = members.some(node => itemIds.has(node.nodeId) || movingTargets.has(node.nodeId))
    const empty = (!selected || moved) && members.every(node => itemIds.has(node.nodeId)
      || node.kind === 'frame' && node.purpose !== 'working' && (movingTargets.has(node.nodeId) || emptied(node.nodeId, path)))
    removable.set(frameId, empty)
    return empty
  }
  const removedFrames = frames.filter(frame => emptied(frame.nodeId)).map(frame => ({ nodeId: frame.nodeId, title: frame.frame?.title ?? frame.nodeId }))
  const removals: CanvasOp[] = removedFrames.map(frame => ({ op: 'node.delete', nodeId: frame.nodeId }))
  if (!groups.length) {
    if (removals.length > 200) throw new RangeError(m.organizationLimit(formatter(locale).number(removals.length)))
    return { ops: removals, groups: [], removedFrames }
  }

  const movableFrames = new Set(groups.filter(group => !group.anchored).map(group => group.frameId))
  const fixed = visible.filter(node => node.kind === 'frame' ? !movableFrames.has(node.nodeId) : !itemIds.has(node.nodeId))
  const origin = {
    x: Math.round(Math.min(...items.map(node => node.x), ...groups.flatMap(group => group.frame ? [group.frame.x] : []))),
    y: Math.round(Math.min(...items.map(node => node.y), ...groups.flatMap(group => group.frame ? [group.frame.y] : []))),
  }
  const placements = new Map<string, Rect>()
  const layouts = new Map<string, Rect>()
  const ancestors = (frame: NodeView) => {
    const ids = new Set<string>()
    let id = frame.frameId
    while (id && !ids.has(id) && id !== frame.nodeId) {
      ids.add(id)
      id = byId.get(id)?.frameId
    }
    return ids
  }
  const pack = (group: typeof groups[number], x: number, y: number, obstacles: Rect[]) => {
    let cell = 0
    let bottom = y + group.h - PADDING
    for (const node of group.members) {
      let position: Rect
      for (;;) {
        const column = cell % group.columns
        position = {
          x: x + PADDING + column * (group.width + NODE_GAP),
          y: y + HEADER + Math.floor(cell / group.columns) * (group.height + NODE_GAP),
          w: group.width, h: node.h,
        }
        const collisions = obstacles.filter(obstacle => overlaps(position, obstacle))
        if (!collisions.length) break
        const nextRow = Math.ceil((Math.max(...collisions.map(rect => rect.y + rect.h + NODE_GAP)) - y - HEADER) / (group.height + NODE_GAP))
        cell = Math.max(Math.floor(cell / group.columns) + 1, nextRow) * group.columns + column
      }
      placements.set(node.nodeId, position)
      obstacles.push(position)
      bottom = Math.max(bottom, position.y + position.h)
      cell++
    }
    layouts.set(group.frameId, { x, y, w: group.w, h: Math.max(group.h, bottom + PADDING - y) })
  }
  // With partial selection, original frames cannot take unselected members along; arrange them in place first, then find space for other partitions.
  for (const group of groups.filter(group => group.anchored)) {
    const parents = ancestors(group.frame!)
    pack(group, group.frame!.x, group.frame!.y, [
      ...fixed.filter(node => node.nodeId !== group.frameId && !parents.has(node.nodeId)),
      ...[...layouts].filter(([id]) => !parents.has(id)).map(([, rect]) => rect), ...placements.values(),
    ])
  }
  const affectedParents = new Set(groups.filter(group => group.anchored).flatMap(group => [...ancestors(group.frame!)]))
  if (affectedParents.size) {
    const membership = new Map(groups.filter(group => group.anchored).flatMap(group => group.members.map(node => [node.nodeId, group.frameId] as const)))
    const prospective = visible.map(node => ({ ...node, ...layouts.get(node.nodeId), ...placements.get(node.nodeId), frameId: membership.get(node.nodeId) ?? node.frameId }))
    for (const op of growFrames(prospective)) if (affectedParents.has(op.nodeId)) {
      layouts.set(op.nodeId, { x: op.x!, y: op.y!, w: op.w!, h: op.h! })
    }
  }
  let cursor = origin.x
  for (const group of groups.filter(group => !group.anchored)) {
    const bounds = { x: cursor, y: origin.y, w: group.w, h: group.h }
    const obstacles = [...fixed, ...layouts.values()]
    for (;;) {
      const collisions = obstacles.filter(obstacle => overlaps(bounds, obstacle))
      if (!collisions.length) break
      bounds.x = Math.ceil(Math.max(...collisions.map(rect => rect.x + rect.w + NODE_GAP)))
    }
    pack(group, bounds.x, bounds.y, [])
    cursor = bounds.x + bounds.w + NODE_GAP
  }
  const ops: CanvasOp[] = []
  for (const group of groups) {
    const rect = layouts.get(group.frameId)!
    if (!group.frame) ops.push({ op: 'frame.create', tempId: group.frameId, title: group.category, ...rect })
    else if (['x', 'y', 'w', 'h'].some(key => rect[key as keyof Rect] !== group.frame![key as keyof Rect])) {
      ops.push({ op: 'node.layout', nodeId: group.frameId, ...rect })
    }
  }
  for (const node of frames) {
    if (groups.some(group => group.frameId === node.nodeId)) continue
    const rect = layouts.get(node.nodeId)
    if (rect) ops.push({ op: 'node.layout', nodeId: node.nodeId, ...rect })
  }
  // Place frames first and write node positions last; the server computes frameId from final center points.
  for (const group of groups) for (const node of group.members) {
    const { x, y, w } = placements.get(node.nodeId)!
    if (node.x !== x || node.y !== y || node.w !== w) ops.push({ op: 'node.layout', nodeId: node.nodeId, x, y, w })
  }
  ops.push(...removals)
  if (ops.length > 200) throw new RangeError(m.organizationLimit(formatter(locale).number(ops.length)))
  return { ops, removedFrames, groups: groups.map(group => ({ category: group.category, frameId: group.frameId,
    nodeIds: group.members.map(node => node.nodeId), ...layouts.get(group.frameId)! })) }
}
