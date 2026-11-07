import type { WheelEvent } from 'react'

export function canScroll(selected: boolean, position: number, viewport: number, content: number, delta: number, zooming = false) {
  return selected && !zooming && content > viewport && (delta < 0 ? position > 0 : delta > 0 && position + viewport < content - 1)
}

/** Update nowheel during capture so React Flow's native listener takes over panning at boundaries. */
export function nodeWheel(event: WheelEvent<HTMLElement>, selected: boolean, horizontal = false) {
  const element = event.currentTarget
  const x = horizontal || Math.abs(event.deltaX) > Math.abs(event.deltaY)
  const delta = horizontal ? event.deltaX || event.deltaY : x ? event.deltaX : event.deltaY
  const consume = canScroll(selected, x ? element.scrollLeft : element.scrollTop, x ? element.clientWidth : element.clientHeight, x ? element.scrollWidth : element.scrollHeight, delta, event.ctrlKey)
  element.classList.toggle('nowheel', consume)
  if (consume && horizontal && !event.deltaX) element.scrollLeft += delta
}
