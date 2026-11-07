import { CloseIcon, PlayIcon, ChevronDownIcon } from '@vis/ui-kit'
import type { ReactNode } from 'react'

export function SessionIcon({ kind }: { kind: 'text' | 'image' | 'video' | 'audio' | 'script' | 'timeline' | 'previz' | 'scene' | 'play' | 'chevron' | 'close' }) {
  if (kind === 'close') return <CloseIcon />
  if (kind === 'play') return <PlayIcon />
  if (kind === 'chevron') return <ChevronDownIcon />
  const paths: Record<typeof kind, ReactNode> = {
    text: <path d="M5 5h14M12 5v14M8 19h8" />,
    script: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 14h18M9 9v11" /></>,
    previz: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m6 16 4-5 3 3 3-6 3 8" /></>,
    scene: <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3ZM4 7.5l8 4.5 8-4.5M12 12v9" />,
    timeline: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M10 4v6M15 10v5M8 15v5" /></>,
    image: <><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9" cy="9" r="1.5" /><path d="m4 16 5-5 4 4 3-3 4 4" /></>,
    audio: <path d="M9 18V5l12-2v13M9 8l12-2M9 18c0 2-6 4-6 1s6-4 6-1Zm12-2c0 2-6 4-6 1s6-4 6-1Z" />,
    video: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3Z" /></>,
  }
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>
}
