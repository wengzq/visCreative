import { beforeEach, expect, it, vi } from 'vitest'
import { VideoPoster } from './VideoPoster'

const state = vi.hoisted(() => ({ failed: null as string | null }))

vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: () => [state.failed, (value: string) => { state.failed = value }],
}))

beforeEach(() => { state.failed = null })

it('renders an image with the requested presentation and load callback', () => {
  const onLoad = vi.fn()
  const style = { objectFit: 'cover' as const }
  const result = VideoPoster({ src: '/assets/video', posterSrc: '/posters/video', className: 'thumbnail', style, onLoad })
  expect(result.type).toBe('img')
  expect(result.props).toMatchObject({ src: '/posters/video', alt: '', draggable: false, className: 'thumbnail', style })
  result.props.onLoad()
  expect(onLoad).toHaveBeenCalledOnce()
})

it('falls back to the original video thumbnail on error and retries a new poster URL', () => {
  const props = { src: '/assets/video', posterSrc: '/posters/video', onLoad: vi.fn() }
  VideoPoster(props).props.onError()
  const fallback = VideoPoster(props)
  expect(fallback.type).toBe('video')
  expect(fallback.props).toMatchObject({ src: '/assets/video#t=0.001', preload: 'metadata', muted: true, playsInline: true })
  fallback.props.onLoadedData()
  expect(props.onLoad).toHaveBeenCalledOnce()
  expect(VideoPoster({ ...props, src: '/assets/new', posterSrc: '/posters/new' }).type).toBe('img')
})

it('supports a host without a poster URL through the video fallback', () => {
  const result = VideoPoster({ src: '/assets/video' })
  expect(result.type).toBe('video')
  expect(result.props.src).toBe('/assets/video#t=0.001')
})


it('preserves metadata seeking and media-kind fallback for timeline clips whose source node was deleted', () => {
  const onError = vi.fn()
  const onLoadedMetadata = vi.fn()
  const props = { src: '/assets/frozen-image', posterSrc: '/posters/frozen-image', onError, onLoadedMetadata }
  VideoPoster(props).props.onError()
  expect(onError).not.toHaveBeenCalled()
  const fallback = VideoPoster(props)
  fallback.props.onLoadedMetadata({ currentTarget: { currentTime: 0 } })
  expect(onLoadedMetadata).toHaveBeenCalledOnce()
  fallback.props.onError()
  expect(onError).toHaveBeenCalledOnce()
})
