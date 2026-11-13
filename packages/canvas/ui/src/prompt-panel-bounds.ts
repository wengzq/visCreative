import { useLayoutEffect, type RefObject } from 'react'

/** The prompt panel can grow after history arrives; keep its footer clear of fixed canvas controls. */
export function usePromptPanelBounds(root: RefObject<HTMLDialogElement | null>, enabled: boolean): void {
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    element.style.translate = ''
    if (!enabled) return
    const canvas = element.closest('.react-flow')
    const toolbar = element.closest('.react-flow__node-toolbar')
    if (!canvas || !toolbar) return
    const host = canvas.closest('[data-canvas-surface]') ?? canvas.parentElement
    const obstacles = [...(host?.querySelectorAll('[data-canvas-obstacle]') ?? [])]
    const update = () => {
      element.style.translate = '0px 0px'
      const bounds = element.getBoundingClientRect()
      const area = canvas.getBoundingClientRect()
      const nodeId = toolbar.getAttribute('data-id')
      const cards = [...canvas.querySelectorAll<HTMLElement>('.react-flow__node:not(.react-flow__node-frame)')]
      const anchor = cards.find(card => card.getAttribute('data-id') === nodeId)?.getBoundingClientRect()
      const controls = [...canvas.querySelectorAll('.vis-node-version-strip, .vis-operations-toolbar, .vis-node-label, .vis-node-extend')]
      // Labels and handles of other cards are covered along with their card; only this node's controls and fixed canvas controls must stay clear.
      const ownControl = (target: Element) => { const card = target.closest('.react-flow__node'); return !card || card.getAttribute('data-id') === nodeId }
      const avoid = [...obstacles, ...controls].map(target => ({ rect: target.getBoundingClientRect(), weight: obstacles.includes(target) || ownControl(target) ? 100 : 2 }))
      // Off-screen cards can never overlap a candidate, which is always clamped inside the canvas.
      for (const card of cards) {
        const rect = card.getBoundingClientRect()
        if (rect.right > area.left && rect.left < area.right && rect.bottom > area.top && rect.top < area.bottom) avoid.push({ rect, weight: card.getAttribute('data-id') === nodeId ? 4 : 2 })
      }
      const clamp = (left: number, top: number) => ({
        left: Math.max(area.left + 8, Math.min(left, area.right - bounds.width - 8)),
        top: Math.max(area.top + 8, Math.min(top, area.bottom - bounds.height - 8)),
      })
      // Docked below, above, then beside the card; equal costs keep the earlier one.
      const attached = [clamp(bounds.left, bounds.top)]
      if (anchor) {
        attached.push(clamp(bounds.left, anchor.top - bounds.height - 16))
        attached.push(clamp(anchor.left - bounds.width - 16, anchor.top), clamp(anchor.right + 16, anchor.top))
      }
      const candidates = [...attached]
      for (const left of [area.left + 8, area.right - bounds.width - 8]) {
        for (const top of [bounds.top, area.top + 8, area.bottom - bounds.height - 8]) candidates.push(clamp(left, top))
      }
      const overlap = (left: number, top: number, rect: DOMRect) => Math.max(0, Math.min(left + bounds.width, rect.right + 8) - Math.max(left, rect.left - 8))
        * Math.max(0, Math.min(top + bounds.height, rect.bottom + 8) - Math.max(top, rect.top - 8))
      // Stay attached to the selected card whenever a side keeps it, its controls and fixed canvas controls clear, choosing the side
      // that covers the least of neighbouring cards. Only then search the canvas for free space, which may carry the panel far away.
      const blocked = ({ left, top }: { left: number; top: number }) => avoid.some(item => item.weight > 2 && overlap(left, top, item.rect) > 0)
      const score = ({ left, top }: { left: number; top: number }) => avoid.reduce((sum, item) => sum + overlap(left, top, item.rect) * item.weight, 0)
        + Math.hypot(left - bounds.left, top - bounds.top)
      const clear = attached.filter(candidate => !blocked(candidate))
      const best = (clear.length ? clear : candidates).map(candidate => ({ candidate, cost: score(candidate) })).reduce((best, item) => item.cost < best.cost ? item : best).candidate
      element.style.translate = `${best.left - bounds.left}px ${best.top - bounds.top}px`
    }
    // React Flow rewrites the toolbar style on every pan or zoom frame; coalesce those into one layout pass per frame.
    let frame = 0
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; update() }) }
    const resize = new ResizeObserver(schedule)
    for (const target of [element, canvas, ...obstacles]) resize.observe(target)
    const movement = new MutationObserver(schedule)
    movement.observe(toolbar, { attributes: true, attributeFilter: ['style'] })
    const nodeLayer = canvas.querySelector('.react-flow__nodes')
    if (nodeLayer) movement.observe(nodeLayer, { childList: true })
    update()
    return () => { cancelAnimationFrame(frame); resize.disconnect(); movement.disconnect(); element.style.translate = '' }
  }, [root, enabled])
}
