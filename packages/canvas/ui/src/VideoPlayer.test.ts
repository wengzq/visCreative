import type { ReactElement, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VideoPlayer } from './VideoPlayer'

const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, dirty: false,
  effects: [] as (() => void)[],
  cleanups: new Map<number, (() => void) | void>(),
}))

// Exercise the component's effects without adding a DOM implementation to the unit suite.
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial
    return [hooks.values[index], (value: unknown) => {
      const next = typeof value === 'function' ? value(hooks.values[index]) : value
      if (!Object.is(hooks.values[index], next)) { hooks.values[index] = next; hooks.dirty = true }
    }]
  },
  useReducer: (reducer: (state: unknown, event: unknown) => unknown, initial: unknown, initialize: (value: unknown) => unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.values)) hooks.values[index] = initialize(initial)
    return [hooks.values[index], (event: unknown) => {
      const next = reducer(hooks.values[index], event)
      if (next !== hooks.values[index]) { hooks.values[index] = next; hooks.dirty = true }
    }]
  },
  useRef: (current: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.values)) hooks.values[index] = { current }
    return hooks.values[index]
  },
  useEffect: (effect: () => (() => void) | void, dependencies?: unknown[]) => {
    const index = hooks.cursor++
    const previous = hooks.values[index] as unknown[] | undefined
    if (dependencies && previous && dependencies.every((value, i) => Object.is(value, previous[i]))) return
    hooks.values[index] = dependencies
    hooks.effects.push(() => { hooks.cleanups.get(index)?.(); hooks.cleanups.set(index, effect()) })
  },
}))

vi.mock('@vis/ui-kit', async importOriginal => ({
  ...await importOriginal<typeof import('@vis/ui-kit')>(),
  useMessages: (dictionary: { en: unknown }) => dictionary.en,
}))

function elements(value: ReactNode): ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(elements)
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  return [value as ReactElement<any>, ...elements((value as ReactElement<any>).props.children)]
}

let tree: ReactElement<any>[]
let props: Parameters<typeof VideoPlayer>[0]
let listeners: Map<string, (event?: unknown) => void>
let intersection: (entries: { isIntersecting: boolean }[]) => void
let preload: { onload: (() => void) | null; onerror: (() => void) | null; src: string }
let video: { paused: boolean; currentTime: number; play: ReturnType<typeof vi.fn<() => Promise<void>>>; pause: ReturnType<typeof vi.fn<() => void>> }
let root: { closest(): unknown; matches(): boolean; contains(): boolean; addEventListener(name: string, handler: (event?: unknown) => void): void; removeEventListener(name: string): void }

function render() {
  let iterations = 0
  do {
    hooks.cursor = 0
    hooks.dirty = false
    tree = elements(VideoPlayer(props))
    tree[0]!.props.ref.current = root
    const player = tree.find(element => element.type === 'video')
    // The component's video ref is always its first ref, even while no element exists.
    const videoRef = hooks.values[0] as { current: unknown }
    videoRef.current = player ? video : null
    for (const effect of hooks.effects.splice(0)) effect()
    if (++iterations > 20) throw new Error('Component effects did not settle')
  } while (hooks.dirty)
}

beforeEach(() => {
  vi.useFakeTimers()
  hooks.values = []
  hooks.effects = []
  hooks.cleanups.clear()
  listeners = new Map()
  props = { src: '/assets/video', posterSrc: '/posters/video', compact: true }
  root = {
    closest: () => root, matches: () => false, contains: () => false,
    addEventListener: (name, handler) => { listeners.set(name, handler) }, removeEventListener: name => { listeners.delete(name) },
  }
  video = {
    paused: true, currentTime: 0,
    play: vi.fn(async () => { video.paused = false; tree.find(element => element.type === 'video')!.props.onPlay() }),
    pause: vi.fn(() => {
      if (video.paused) return
      video.paused = true
      tree.find(element => element.type === 'video')?.props.onPause()
    }),
  }
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn(), activeElement: null })
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('Node', class {})
  vi.stubGlobal('Image', class { onload = null; onerror = null; src = ''; constructor() { preload = this } })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersection) { intersection = callback }
    observe() {}
    disconnect() {}
  })
})

afterEach(() => {
  for (const cleanup of hooks.cleanups.values()) cleanup?.()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Compact VideoPlayer', () => {
  it('starts with a poster and no video, and reports the poster load', () => {
    props.onLoadedData = vi.fn()
    render()
    expect(tree.filter(element => element.type === 'video')).toHaveLength(0)
    tree.find(element => element.type === 'img')!.props.onLoad()
    expect(props.onLoadedData).toHaveBeenCalledOnce()
  })

  it.each(['pointerenter', 'focusin'])('mounts from %s on the containing node and keeps the poster until a frame arrives', event => {
    render()
    listeners.get(event)!()
    render()
    const player = tree.find(element => element.type === 'video')!
    expect(player.props.preload).toBe('metadata')
    expect(player.props.className).toBe('is-loading')
    expect(tree.some(element => element.type === 'img')).toBe(true)
    player.props.onLoadedData()
    render()
    expect(tree.some(element => element.type === 'img')).toBe(false)
    expect(tree.find(element => element.type === 'video')!.props.className).toBeUndefined()
  })

  it('mounts while selected and releases after deselection and three idle seconds', () => {
    props.selected = true
    render()
    preload.onload!()
    render()
    expect(tree.some(element => element.type === 'video')).toBe(true)
    props.selected = false
    render()
    vi.advanceTimersByTime(2999)
    render()
    expect(tree.some(element => element.type === 'video')).toBe(true)
    vi.advanceTimersByTime(1)
    render()
    expect(tree.some(element => element.type === 'video')).toBe(false)
  })

  it('plays on the first click while initially unmounted and survives hover loss', () => {
    render()
    preload.onload!()
    render()
    tree.find(element => element.props['aria-label'] === 'Play')!.props.onClick()
    render()
    expect(video.play).toHaveBeenCalledOnce()
    listeners.get('pointerleave')!()
    render()
    vi.advanceTimersByTime(4000)
    render()
    expect(tree.some(element => element.type === 'video')).toBe(true)
    video.pause()
    render()
    vi.advanceTimersByTime(3000)
    render()
    expect(tree.some(element => element.type === 'video')).toBe(false)
  })

  it('pauses and unmounts immediately when it leaves the viewport, even while selected and playing', () => {
    props.selected = true
    render()
    tree.find(element => element.props['aria-label'] === 'Play')!.props.onClick()
    render()
    intersection([{ isIntersecting: false }])
    render()
    expect(video.paused).toBe(true)
    expect(tree.some(element => element.type === 'video')).toBe(false)
    expect(tree.some(element => element.type === 'img')).toBe(true)
  })

  it('keeps the video until a slow poster loads, then releases it', () => {
    props.selected = true
    render()
    tree.find(element => element.type === 'video')!.props.onLoadedData()
    props.selected = false
    render()
    vi.advanceTimersByTime(10_000)
    render()
    expect(tree.some(element => element.type === 'video')).toBe(true)
    preload.onload!()
    render()
    vi.advanceTimersByTime(3000)
    render()
    expect(tree.some(element => element.type === 'video')).toBe(false)
    expect(tree.some(element => element.type === 'img')).toBe(true)
  })

  it('mounts the video when the poster is slow, and when it returns on screen before the poster', () => {
    render()
    expect(tree.some(element => element.type === 'video')).toBe(false)
    vi.advanceTimersByTime(1500)
    render()
    expect(tree.some(element => element.type === 'video')).toBe(true)
    intersection([{ isIntersecting: false }])
    render()
    expect(tree.some(element => element.type === 'video')).toBe(false)
    intersection([{ isIntersecting: true }])
    render()
    vi.advanceTimersByTime(1500)
    render()
    expect(tree.some(element => element.type === 'video')).toBe(true)
  })

  it('uses a live video if the poster fails and keeps it until it goes offscreen', () => {
    render()
    tree.find(element => element.type === 'img')!.props.onError()
    render()
    expect(tree.some(element => element.type === 'video')).toBe(true)
    vi.advanceTimersByTime(4000)
    render()
    expect(tree.some(element => element.type === 'video')).toBe(true)
    intersection([{ isIntersecting: false }])
    render()
    expect(tree.some(element => element.type === 'video')).toBe(false)
  })
})

it('keeps the full player mounted and starts it automatically', () => {
  props.compact = false
  render()
  expect(tree.some(element => element.type === 'video')).toBe(true)
  expect(tree.some(element => element.type === 'img')).toBe(false)
  expect(video.play).toHaveBeenCalledOnce()
  intersection([{ isIntersecting: false }])
  render()
  expect(tree.some(element => element.type === 'video')).toBe(true)
  expect(video.paused).toBe(false)
})
