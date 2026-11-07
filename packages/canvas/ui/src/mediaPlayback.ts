const positions = new Map<string, number>()
const elements = new Map<string, Set<HTMLMediaElement>>()

export function mediaPositionMs(src: string): number {
  const active = [...(elements.get(src) ?? [])].at(-1)
  return Math.max(0, Math.round((active?.currentTime ?? positions.get(src) ?? 0) * 1000))
}

/** Snapshot on unmount: operation panels replace the player that held the current position. */
export function trackMedia(src: string, element: HTMLMediaElement): () => void {
  const group = elements.get(src) ?? new Set<HTMLMediaElement>()
  group.add(element)
  elements.set(src, group)
  return () => {
    positions.delete(src)
    positions.set(src, element.currentTime)
    if (positions.size > 100) positions.delete(positions.keys().next().value!)
    group.delete(element)
    if (!group.size) elements.delete(src)
  }
}

export function pauseMedia(src: string): void {
  for (const element of elements.get(src) ?? []) element.pause()
}
