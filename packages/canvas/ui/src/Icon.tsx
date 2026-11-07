import type { NodeView } from '@vis/protocol'
import type { ReactNode } from 'react'

type IconKind = NodeView['kind'] | 'download' | 'organize' | 'document' | 'upload' | 'plus' | 'fit' | 'map' | 'generate' | 'close' | 'play' | 'pause' | 'volume' | 'muted' | 'loop' | 'fullscreen' | 'exitFullscreen'
export function Icon({ kind, size = 20 }: { kind: IconKind; size?: number }) {
  const paths: Record<IconKind, ReactNode> = {
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" />,
    organize: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    document: <><path d="M14 3H5v18h14V8Z M14 3v5h5M8 12h8M8 16h8" /></>,
    // 0023: a table, for the storyboard
    script: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 14h18M9 9v11" /></>,
    // 0024: stacked tracks with clips
    scene: <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3ZM4 7.5l8 4.5 8-4.5M12 12v9" />,
    previz: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m6 16 4-5 3 3 3-6 3 8M8 4v3M16 17v3" /></>,
    timeline: <><rect x="3" y="6" width="7" height="5" rx="1" /><rect x="12" y="6" width="9" height="5" rx="1" /><rect x="6" y="14" width="13" height="4" rx="1" /><path d="M9 2h6l-3 3Zm3 3v16" /></>,
    play: <path d="m8 5 11 7-11 7Z" />,
    pause: <path d="M8 5v14M16 5v14" />,
    volume: <><path d="M11 5 6 9H3v6h3l5 4Z" /><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></>,
    muted: <><path d="M11 5 6 9H3v6h3l5 4Z" /><path d="m16 9 6 6m0-6-6 6" /></>,
    loop: <path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3" />,
    fullscreen: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
    exitFullscreen: <path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5" />,
    text: <path d="M5 5h14M12 5v14M8 19h8" />,
    image: <><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9" cy="9" r="1.5" /><path d="m4 16 5-5 4 4 3-3 4 4" /></>,
    audio: <path d="M9 18V5l12-2v13M9 8l12-2M9 18c0 2-6 4-6 1s6-4 6-1Zm12-2c0 2-6 4-6 1s6-4 6-1Z" />,
    video: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3Z" /></>,
    frame: <path d="M7 3v18M17 3v18M3 7h18M3 17h18" />,
    upload: <path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    fit: <path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M8 12h8m-4-4v8" />,
    map: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 16 4-6 3 3 3-5" /></>,
    generate: <path d="M12 19V5m-6 6 6-6 6 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  }
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>
}

