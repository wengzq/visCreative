export function PlayerIcon({ kind }: { kind: 'play' | 'pause' | 'previous' | 'next' | 'fullscreen' | 'back' | 'audio' | 'more' | 'panel' }) {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'play' ? <path d="m5 3 8 5-8 5Z" /> : null}
    {kind === 'pause' ? <path d="M5 3v10M11 3v10" /> : null}
    {kind === 'previous' ? <path d="M3 3v10m9-10L5 8l7 5Z" /> : null}
    {kind === 'next' ? <path d="M13 3v10M4 3l7 5-7 5Z" /> : null}
    {kind === 'fullscreen' ? <path d="M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4" /> : null}
    {kind === 'back' ? <path d="m7 3-5 5 5 5M2 8h12" /> : null}
    {kind === 'audio' ? <path d="M6 12V3l7-1v9M6 6l7-1M6 12c0 3-4 3-4 1s4-3 4-1Zm7-1c0 3-4 3-4 1s4-3 4-1Z" /> : null}
    {kind === 'more' ? <><circle cx="3" cy="8" r=".6" /><circle cx="8" cy="8" r=".6" /><circle cx="13" cy="8" r=".6" /></> : null}
    {kind === 'panel' ? <><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M6 2v12" /></> : null}
  </svg>
}
