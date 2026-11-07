export type VideoLifecycle = {
  active: boolean
  visible: boolean
  hovered: boolean
  focused: boolean
  selected: boolean
  playing: boolean
  pendingPlay: boolean
  frameReady: boolean
  posterReady: boolean
  fallback: boolean
}

export type VideoLifecycleEvent =
  | { type: 'hover' | 'focus' | 'select' | 'visibility' | 'playing'; value: boolean }
  | { type: 'play' | 'pause' | 'frame' | 'poster' | 'posterSlow' | 'fallback' | 'idle' }
  | { type: 'reset'; poster: boolean; selected: boolean }

export const VIDEO_IDLE_DELAY = 3000
export const POSTER_WAIT_DELAY = 1500

export function initialVideoLifecycle(poster: boolean, selected = false): VideoLifecycle {
  return { active: !poster || selected, visible: true, hovered: false, focused: false, selected, playing: false, pendingPlay: false, frameReady: false, posterReady: false, fallback: !poster }
}

/** Previews share one queue, so a poster can lag far behind: releasing before it loads would leave an empty node. */
export function shouldReleaseVideo(state: VideoLifecycle): boolean {
  return state.active && state.posterReady && !state.fallback && !state.hovered && !state.focused && !state.selected && !state.playing && !state.pendingPlay
}

export function videoLifecycle(state: VideoLifecycle, event: VideoLifecycleEvent): VideoLifecycle {
  switch (event.type) {
    case 'reset': return {
      ...initialVideoLifecycle(event.poster, event.selected),
      visible: state.visible,
      hovered: state.hovered,
      focused: state.focused,
      active: state.visible && (!event.poster || event.selected || state.hovered || state.focused),
    }
    case 'hover':
    case 'focus':
    case 'select': {
      const field = event.type === 'hover' ? 'hovered' : event.type === 'focus' ? 'focused' : 'selected'
      return { ...state, [field]: event.value, active: state.active || (state.visible && event.value) }
    }
    case 'visibility': return event.value
      ? { ...state, visible: true, active: state.active || state.fallback || state.hovered || state.focused || state.selected }
      : { ...state, visible: false, active: false, playing: false, pendingPlay: false, frameReady: false }
    case 'play': return state.visible ? { ...state, active: true, pendingPlay: true } : state
    case 'pause': return { ...state, playing: false, pendingPlay: false }
    case 'playing': return { ...state, playing: event.value && state.visible, pendingPlay: false }
    case 'frame': return state.active ? { ...state, frameReady: true } : state
    case 'poster': return { ...state, posterReady: true }
    case 'posterSlow': return state.visible && !state.posterReady ? { ...state, active: true } : state
    case 'fallback': return { ...state, fallback: true, active: state.visible }
    case 'idle': return shouldReleaseVideo(state) ? { ...state, active: false, frameReady: false } : state
  }
}
